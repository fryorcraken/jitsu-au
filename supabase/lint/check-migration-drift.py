#!/usr/bin/env python3
"""Fail when a migration file in supabase/migrations/ has never been applied.

Why this exists
---------------
Nothing in this project's pipeline runs `supabase/migrations/*.sql`. Lovable
applies only the SQL its own agent writes, and records it in the live
`supabase_migrations.schema_migrations` ledger; a migration file that arrives
through a GitHub push is inert until somebody applies it by hand. Three of them
sat unapplied for a week, which is why production raised
`column waivers.approval_status does not exist` while the migration adding that
column was sitting in the repo, reviewed and merged.

The repo cannot detect that on its own — the only source of truth for "is this
live?" is the database. So CI reads the ledger and compares it to the files.

Matching
--------
A file `<version>_<slug>.sql` counts as applied when the ledger holds either:
  * a row whose `name` is the full `<version>_<slug>` stem — how Lovable's own
    migrations are recorded; their `version` column is a *different* timestamp
    from the filename prefix, so the name is the only reliable key; or
  * a row whose `version` is `<version>` — the standard Supabase CLI form, and
    how hand-applied migrations are recorded.

Ordering
--------
Additive migrations must be applied BEFORE the code that uses them merges (see
"Sequencing schema changes" in CLAUDE.md), so a PR that adds a migration is
expected to have applied it already, and failing here is the point.

The exception is the contract phase of an expand/contract change: a migration
that drops something must land AFTER the code that stopped using it deploys.
List those in `migration-drift-allowlist.txt` while they wait, and remove the
entry once applied.

Usage
-----
    check-migration-drift.py APPLIED_CSV [--migrations DIR] [--allowlist FILE]
    check-migration-drift.py --selftest

APPLIED_CSV is a headerless two-column CSV of `version,name` from:

    psql "$DB_URL" --csv --tuples-only -c \
      "SELECT version, coalesce(name, '') FROM supabase_migrations.schema_migrations"
"""

import argparse
import csv
import io
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MIGRATIONS = REPO_ROOT / "supabase" / "migrations"
DEFAULT_ALLOWLIST = Path(__file__).resolve().parent / "migration-drift-allowlist.txt"


def parse_applied(text):
    """(versions, names) recorded in the ledger."""
    versions, names = set(), set()
    for row in csv.reader(io.StringIO(text)):
        if not row:
            continue
        version = row[0].strip()
        name = row[1].strip() if len(row) > 1 else ""
        if version:
            versions.add(version)
        if name:
            names.add(name)
    return versions, names


def parse_allowlist(text):
    """Migration stems (or bare versions) intentionally not applied yet."""
    out = set()
    for line in text.splitlines():
        entry = line.split("#", 1)[0].strip()
        if entry:
            out.add(entry)
    return out


def unapplied(stems, versions, names, allowed):
    """Migration stems present in the repo but absent from the ledger."""
    missing = []
    for stem in stems:
        version = stem.split("_", 1)[0]
        if stem in names or version in versions:
            continue
        if stem in allowed or version in allowed:
            continue
        missing.append(stem)
    return missing


def migration_stems(directory):
    return sorted(p.stem for p in Path(directory).glob("*.sql"))


def selftest():
    versions, names = parse_applied(
        "20260719055502,20260719055459_08b2585f\n20260721120000,waiver_approval\n,\n"
    )
    assert versions == {"20260719055502", "20260721120000"}, versions
    assert names == {"20260719055459_08b2585f", "waiver_approval"}, names

    # Lovable's rows match on name (their version column is a different stamp).
    assert unapplied(["20260719055459_08b2585f"], versions, names, set()) == []
    # Hand-applied rows match on the filename's version prefix.
    assert unapplied(["20260721120000_waiver_approval"], versions, names, set()) == []
    # An unrecorded file is drift — this is the case that shipped the outage.
    assert unapplied(["20260721000000_template_acks"], versions, names, set()) == [
        "20260721000000_template_acks"
    ]
    # ...unless it is an allowlisted contract-phase migration, by stem or version.
    assert unapplied(["20260721000000_template_acks"], versions, names, {"20260721000000"}) == []
    assert (
        unapplied(["20260721000000_template_acks"], versions, names, {"20260721000000_template_acks"})
        == []
    )

    assert parse_allowlist("# comment\n\n20260101000000_drop_thing # waiting on deploy\n") == {
        "20260101000000_drop_thing"
    }

    print("check-migration-drift.py self-test passed")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("applied_csv", nargs="?", help="CSV of version,name from the live ledger")
    parser.add_argument("--migrations", default=str(DEFAULT_MIGRATIONS))
    parser.add_argument("--allowlist", default=str(DEFAULT_ALLOWLIST))
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()

    if args.selftest:
        return selftest()
    if not args.applied_csv:
        parser.error("applied_csv is required unless --selftest is given")

    versions, names = parse_applied(Path(args.applied_csv).read_text())
    allowlist_path = Path(args.allowlist)
    allowed = parse_allowlist(allowlist_path.read_text()) if allowlist_path.exists() else set()
    stems = migration_stems(args.migrations)

    if not stems:
        print(f"No migrations found in {args.migrations}", file=sys.stderr)
        return 1
    if not versions and not names:
        print("The migration ledger came back empty — check the connection.", file=sys.stderr)
        return 1

    missing = unapplied(stems, versions, names, allowed)
    print(f"{len(stems)} migration files, {len(missing)} not applied to the live database.")

    if not missing:
        return 0

    print("\nThese migrations exist in the repo but have never run against the live database:")
    for stem in missing:
        print(f"  supabase/migrations/{stem}.sql")
    print(
        "\nCommitting a migration does NOT apply it — nothing in this pipeline runs\n"
        "supabase/migrations/*.sql. Apply each one against the live database (the\n"
        "Lovable project's SQL access), record it in supabase_migrations.schema_migrations,\n"
        "and re-run. If a migration is the contract (destructive) phase of an\n"
        "expand/contract change and must land after the code deploys, add it to\n"
        f"{allowlist_path.relative_to(REPO_ROOT)} with a note, and remove it once applied.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
