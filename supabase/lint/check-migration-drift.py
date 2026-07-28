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
"Sequencing schema changes" in docs/database-changes.md), so a PR that adds a
migration is expected to have applied it already, and failing here is the point.

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
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MIGRATIONS = REPO_ROOT / "supabase" / "migrations"
DEFAULT_ALLOWLIST = Path(__file__).resolve().parent / "migration-drift-allowlist.txt"


def parse_rows(text):
    """[(version, name)] as recorded in the ledger, blanks dropped."""
    rows = []
    for row in csv.reader(io.StringIO(text)):
        if not row:
            continue
        version = row[0].strip()
        name = row[1].strip() if len(row) > 1 else ""
        if version or name:
            rows.append((version, name))
    return rows


def parse_applied(text):
    """(versions, names) recorded in the ledger."""
    rows = parse_rows(text)
    return {v for v, _ in rows if v}, {n for _, n in rows if n}


def parse_allowlist(text):
    """Migration stems (or bare versions) intentionally not applied yet."""
    out = set()
    for line in text.splitlines():
        entry = line.split("#", 1)[0].strip()
        if entry:
            out.add(entry)
    return out


def unapplied(stems, versions, names, allowed):
    """Migration stems present in the repo but absent from the ledger.

    The version key is only trusted when exactly ONE file carries that prefix.
    A ledger row records a single applied migration, so if two files share a
    prefix (easy to do here: the hand-written migrations use synthetic
    `YYYYMMDD000000` stamps, so a second migration authored the same day
    collides unless the author bumps the time) that one row cannot vouch for
    both. Counting it for both is a FALSE PASS — the exact failure this script
    exists to prevent — so an ambiguous prefix falls back to name-only
    matching and the unrecorded file is reported.
    """
    prefix_counts = Counter(stem.split("_", 1)[0] for stem in stems)
    missing = []
    for stem in stems:
        version = stem.split("_", 1)[0]
        unambiguous = prefix_counts[version] == 1
        if stem in names or (unambiguous and version in versions):
            continue
        if stem in allowed or (unambiguous and version in allowed):
            continue
        missing.append(stem)
    return missing


def migration_stems(directory):
    return sorted(p.stem for p in Path(directory).glob("*.sql"))


def orphan_rows(rows, stems):
    """Ledger rows that match no file on disk.

    Not drift in the direction this script guards (nothing is unapplied), but it
    means the repo can no longer rebuild the live schema from scratch — the
    migration was deleted or renamed here after it ran. Reported, never fatal.
    A row matches a file by either ledger key, the same way `unapplied` does.
    """
    stem_set = set(stems)
    prefixes = {stem.split("_", 1)[0] for stem in stems}
    return sorted(
        f"{version or '?'} ({name})" if name else str(version)
        for version, name in rows
        if name not in stem_set and version not in prefixes
    )


def allowlist_display(path):
    """Repo-relative path when possible — a custom --allowlist may sit outside."""
    try:
        return path.relative_to(REPO_ROOT)
    except ValueError:
        return path


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

    # Two files sharing a version prefix: one ledger row cannot vouch for both,
    # so the unrecorded one must still be reported. Counting it applied would be
    # a false pass — the failure mode this whole script exists to prevent.
    dup = ["20260801000000_add_column", "20260801000000_add_index"]
    dup_versions, dup_names = parse_applied("20260801000000,add_column\n")
    assert unapplied(dup, dup_versions, dup_names, set()) == dup, unapplied(
        dup, dup_versions, dup_names, set()
    )
    # Both are only cleared once each is recorded under its own name.
    _, both = parse_applied("20260801000000,add_column\n20260801000001,20260801000000_add_index\n")
    assert unapplied(dup, set(), both, set()) == ["20260801000000_add_column"]

    assert parse_allowlist("# comment\n\n20260101000000_drop_thing # waiting on deploy\n") == {
        "20260101000000_drop_thing"
    }

    # Orphans: a row matches a file by EITHER key, so neither a Lovable-style
    # row (name = full stem) nor a hand-applied row (version = prefix, name =
    # just the slug) may be reported. Only a row matching no file at all is.
    orphan_fixture = parse_rows(
        "20260719055502,20260719055459_08b2585f\n"  # Lovable form -> matches by name
        "20260721120000,waiver_approval\n"  # hand-applied form -> matches by version
        "20260722131547,20260722131544_3de60949\n"  # no file on disk -> orphan
    )
    assert orphan_rows(
        orphan_fixture, ["20260719055459_08b2585f", "20260721120000_waiver_approval"]
    ) == ["20260722131547 (20260722131544_3de60949)"]

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

    rows = parse_rows(Path(args.applied_csv).read_text())
    versions = {v for v, _ in rows if v}
    names = {n for _, n in rows if n}
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

    orphans = orphan_rows(rows, stems)
    if orphans:
        print("\nNote: ledger rows with no matching migration file (deleted or renamed here?):")
        for row in orphans:
            print(f"  {row}")

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
        f"{allowlist_display(allowlist_path)} with a note, and remove it once applied.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
