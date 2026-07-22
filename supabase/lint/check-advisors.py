#!/usr/bin/env python3
"""Evaluate Supabase advisor (Splinter) findings and gate CI on them.

Reads the CSV output of `supabase/lint/splinter.sql` (run against the local
database in CI) and decides whether the build should fail.

The CSV is produced with psql in tuples-only CSV mode (no header), so the
column order is fixed (see FIELDS below). Any line that is not a well-formed
finding row — e.g. a stray `SET`/`DO` command tag from the multi-statement
lint file — is skipped defensively.

Policy (overridable via env vars so the threshold lives in the workflow, not
in code):

  FAIL_CATEGORIES  comma-separated advisor categories that block the build
                   (default: "SECURITY"). Use "SECURITY,PERFORMANCE" to also
                   gate on performance, or "" to never fail (report-only).
  FAIL_LEVELS      comma-separated severities that block, matched against the
                   above categories (default: "WARN,ERROR"). Splinter emits
                   ERROR, WARN and INFO.

Every finding is printed grouped by severity so non-blocking ones (e.g.
performance INFO) stay visible in the logs; only findings matching BOTH a
failing category and a failing level flip the exit code to 1.

Usage: check-advisors.py <findings.csv>
"""

from __future__ import annotations

import csv
import os
import sys

# Column order emitted by supabase/lint/splinter.sql.
FIELDS = [
    "name",
    "title",
    "level",
    "facing",
    "categories",
    "description",
    "detail",
    "remediation",
    "metadata",
    "cache_key",
]

VALID_LEVELS = {"ERROR", "WARN", "INFO"}
LEVEL_ORDER = {"ERROR": 0, "WARN": 1, "INFO": 2}


def parse_categories(raw: str) -> list[str]:
    """Turn a Postgres text-array literal like '{SECURITY,PERFORMANCE}' into a list."""
    inner = raw.strip().strip("{}")
    if not inner:
        return []
    return [part.strip().strip('"').upper() for part in inner.split(",") if part.strip()]


def load_findings(path: str) -> list[dict]:
    findings: list[dict] = []
    with open(path, newline="", encoding="utf-8") as fh:
        for record in csv.reader(fh):
            if len(record) != len(FIELDS):
                continue  # stray command tag / blank line
            row = dict(zip(FIELDS, record))
            level = row["level"].strip().upper()
            if level not in VALID_LEVELS:
                continue  # header row or noise
            row["_level"] = level
            row["_categories"] = parse_categories(row["categories"])
            findings.append(row)
    return findings


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(f"usage: {argv[0]} <findings.csv>", file=sys.stderr)
        return 2

    fail_categories = {
        c.strip().upper()
        for c in os.environ.get("FAIL_CATEGORIES", "SECURITY").split(",")
        if c.strip()
    }
    fail_levels = {
        l.strip().upper()
        for l in os.environ.get("FAIL_LEVELS", "WARN,ERROR").split(",")
        if l.strip()
    }

    findings = load_findings(argv[1])

    if not findings:
        print("✅ Supabase advisors: no findings.")
        return 0

    blocking = [
        row
        for row in findings
        if row["_level"] in fail_levels and (fail_categories & set(row["_categories"]))
    ]

    # Report every finding, most severe first, so nothing is hidden.
    findings.sort(key=lambda r: (LEVEL_ORDER.get(r["_level"], 9), r["name"]))
    print(f"Supabase advisors: {len(findings)} finding(s).\n")
    for row in findings:
        marker = "❌" if row in blocking else "•"
        cats = ",".join(row["_categories"]) or "-"
        print(f"{marker} [{row['_level']}/{cats}] {row['name']}")
        detail = row["detail"].strip()
        if detail:
            print(f"    {detail}")
        remediation = row["remediation"].strip()
        if remediation:
            print(f"    fix: {remediation}")
    print()

    gate = (
        f"categories={{{','.join(sorted(fail_categories)) or '(none)'}}} "
        f"levels={{{','.join(sorted(fail_levels)) or '(none)'}}}"
    )
    if blocking:
        print(f"❌ {len(blocking)} blocking advisor finding(s) [{gate}].")
        return 1

    print(f"✅ No blocking advisor findings [{gate}].")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
