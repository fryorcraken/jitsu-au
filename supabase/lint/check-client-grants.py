#!/usr/bin/env python3
"""Fail when a table in `public` grants anon/authenticated more than it should.

Why this exists
---------------
Supabase's bootstrap runs

    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT ALL ON TABLES TO anon, authenticated, service_role;

so every table created in `public` starts with all eight privileges (SELECT,
INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN) for both client
roles, whether or not any migration asked for that.

GRANT only ever ADDS a privilege. There is no form of it that replaces or
narrows what a role already holds, so a migration writing

    GRANT SELECT ON public.t TO authenticated;   -- "reads only"

grants a privilege the role already had. The line reads like a restriction in
review and does nothing; only REVOKE narrows. Every table in this schema sat
fully open to both client roles for that reason until
20260728120000 (calendar) and 20260728140000 (everything else) revoked them.

CI could not see it. The vendored Splinter lints 0026/0027 only ever test
`has_table_privilege(role, oid, 'SELECT')`, so surviving INSERT/UPDATE/DELETE
grants pass clean, and `supabase db lint` does not look at ACLs at all. The only
source of truth is the live database, so this script asks it — the same shape of
check, and the same reason for existing, as check-migration-drift.py.

Direction of the check
----------------------
This is an allowlist, not a diff: any (table, role, privilege) the live database
holds and the expected file does not is a failure. A grant listed as expected
but missing live is reported as a note, never fatal — the app losing a privilege
it expected shows up as a broken page, whereas an unexpected grant is exactly
the silent state this guards.

That asymmetry matters for new tables: one created with the defaults left in
place appears here as eight unexpected grants per role, which is the point.

Usage
-----
    check-client-grants.py GRANTS_CSV [--expected FILE]
    check-client-grants.py --selftest

GRANTS_CSV is a headerless three-column CSV of `table,grantee,privilege` from:

    psql "$DB_URL" --csv --tuples-only -f supabase/lint/client-grants.sql

(`supabase/lint/client-grants.sql`, the one copy of the query; README.md and
supabase-lint.yml both run that file.)

A COLUMN grant comes back with the column in brackets after the table,
`profiles(archived_at)`, and is matched against the expected file the same way
(`profiles(archived_at):authenticated:UPDATE`). Table ACLs alone could not see
one: `GRANT UPDATE (col) ON t TO authenticated` writes `pg_attribute.attacl` and
leaves `pg_class.relacl` empty, so a table this check reported as fully closed
could hand a member the one column that matters. `profiles.archived_at` is the
case that made it worth closing: a member able to write it could restore
themselves, or archive somebody else, through an owner-update RLS policy that
exists today but is unreachable only because no grant reaches it.

Read `pg_class.relacl` and `pg_attribute.attacl`, NOT
`information_schema.role_table_grants`, for two
reasons. The information_schema views only show grants where the current user is
the grantor, the grantee, or a member of the grantee role, so the least-privilege
reader role in README.md sees an empty set there — the check would pass while the
schema was wide open. And they omit MAINTAIN entirely, under-reporting by one
privilege on Postgres 17+. `pg_class`, `pg_attribute` and `pg_roles` are
world-readable.

A header row (`relname,rolname,privilege_type`, which an SQL console's CSV
export adds and `psql --tuples-only` does not) is skipped rather than read as a
grant.

`service_role` is deliberately out of scope: it bypasses RLS by design and every
server function depends on it holding full privileges.
"""

import argparse
import csv
import io
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_EXPECTED = Path(__file__).resolve().parent / "client-grants-expected.txt"

CLIENT_ROLES = ("anon", "authenticated")

# client-grants.sql's column names, as a console export writes them.
HEADER = ("relname", "rolname", "PRIVILEGE_TYPE")


def parse_grants(text):
    """{(table, grantee, privilege)} as held by the live database."""
    out = set()
    for row in csv.reader(io.StringIO(text)):
        if len(row) < 3:
            continue
        table, grantee, privilege = (row[0].strip(), row[1].strip(), row[2].strip().upper())
        if (table, grantee, privilege) == HEADER:
            continue
        if table and grantee and privilege:
            out.add((table, grantee, privilege))
    return out


def parse_expected(text):
    """{(table, grantee, privilege)} the app is allowed to hold.

    One `table:grantee:privilege` per line; `#` comments and blanks ignored.
    """
    out = set()
    for lineno, line in enumerate(text.splitlines(), 1):
        entry = line.split("#", 1)[0].strip()
        if not entry:
            continue
        parts = [p.strip() for p in entry.split(":")]
        if len(parts) != 3 or not all(parts):
            raise ValueError(f"line {lineno}: expected `table:grantee:privilege`, got {entry!r}")
        table, grantee, privilege = parts
        if grantee not in CLIENT_ROLES:
            raise ValueError(f"line {lineno}: grantee must be one of {CLIENT_ROLES}, got {grantee!r}")
        out.add((table, grantee, privilege.upper()))
    return out


def unexpected(live, expected):
    """Grants the live database holds that the expected file does not list."""
    return sorted(live - expected)


def absent(live, expected):
    """Expected grants the live database does not hold. Reported, never fatal."""
    return sorted(expected - live)


def fmt(grant):
    table, grantee, privilege = grant
    return f"{table}: {privilege} to {grantee}"


def expected_display(path):
    """Repo-relative path when possible — a custom --expected may sit outside."""
    try:
        return path.relative_to(REPO_ROOT)
    except ValueError:
        return path


def selftest():
    live = parse_grants(
        "relname,rolname,privilege_type\n"
        "user_roles,authenticated,SELECT\n"
        "user_roles,authenticated,INSERT\n"
        "calendar_events,anon,SELECT\n"
        ",,\n"
        "profiles,anon,DELETE\n"
        "profiles(archived_at),authenticated,UPDATE\n"
    )
    assert live == {
        ("user_roles", "authenticated", "SELECT"),
        ("user_roles", "authenticated", "INSERT"),
        ("calendar_events", "anon", "SELECT"),
        ("profiles", "anon", "DELETE"),
        ("profiles(archived_at)", "authenticated", "UPDATE"),
    }, live

    expected = parse_expected(
        "# comment\n\nuser_roles:authenticated:SELECT\ncalendar_events:anon:SELECT  # public schedule\n"
    )
    assert expected == {
        ("user_roles", "authenticated", "SELECT"),
        ("calendar_events", "anon", "SELECT"),
    }, expected

    # The two the fixture holds beyond the allowlist, and nothing else. INSERT on
    # user_roles is the real defect this guards: the migration granted SELECT
    # only, but Supabase's default INSERT survived and the table's manager RLS
    # policy made it a usable privilege-escalation path.
    #
    # The column grant is the other half: a table whose relacl is empty can
    # still hand a client role one column, and that must fail like any other.
    assert unexpected(live, expected) == [
        ("profiles", "anon", "DELETE"),
        ("profiles(archived_at)", "authenticated", "UPDATE"),
        ("user_roles", "authenticated", "INSERT"),
    ], unexpected(live, expected)

    # A deliberate column grant is listed the way it is reported.
    assert parse_expected("profiles(phone):authenticated:update\n") == {
        ("profiles(phone)", "authenticated", "UPDATE")
    }

    # A clean database has nothing unexpected.
    assert unexpected(expected, expected) == []

    # A missing grant is a note, not a failure.
    assert absent(set(), expected) == sorted(expected)
    assert absent(live, expected) == []

    # Lowercase privileges from a hand-written file still match the live CSV.
    assert parse_expected("waivers:anon:select\n") == {("waivers", "anon", "SELECT")}

    for bad in ("user_roles:authenticated", "a:b:c:d", "user_roles:postgres:SELECT", "a::SELECT"):
        try:
            parse_expected(bad)
        except ValueError:
            pass
        else:  # pragma: no cover
            raise AssertionError(f"expected {bad!r} to be rejected")

    print("check-client-grants.py self-test passed")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("grants_csv", nargs="?", help="CSV of table,grantee,privilege from the live DB")
    parser.add_argument("--expected", default=str(DEFAULT_EXPECTED))
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()

    if args.selftest:
        return selftest()
    if not args.grants_csv:
        parser.error("grants_csv is required unless --selftest is given")

    live = parse_grants(Path(args.grants_csv).read_text())
    expected_path = Path(args.expected)
    try:
        expected = parse_expected(expected_path.read_text())
    except FileNotFoundError:
        print(f"Expected-grants file not found: {expected_path}", file=sys.stderr)
        return 1
    except ValueError as exc:
        print(f"{expected_display(expected_path)}: {exc}", file=sys.stderr)
        return 1

    # An empty result is far more likely to be a broken query or a role that
    # cannot see the ACL than a schema with no client grants at all — and it
    # would pass, silently, forever. `information_schema.role_table_grants` is
    # filtered to grants involving the current user, so a least-privilege reader
    # sees nothing there; read pg_class.relacl instead (client-grants.sql).
    if not live and expected:
        print(
            "The grant query came back empty while grants are expected — check the\n"
            "connection, and that you ran supabase/lint/client-grants.sql, which reads\n"
            "pg_class.relacl and pg_attribute.attacl rather than\n"
            "information_schema, which hides grants the connecting role is not party to.",
            file=sys.stderr,
        )
        return 1

    extra = unexpected(live, expected)
    print(
        f"{len(live)} client grants live, {len(expected)} expected, {len(extra)} unexpected."
    )

    missing = absent(live, expected)
    if missing:
        print("\nNote: expected grants the live database does not hold (app may be broken):")
        for grant in missing:
            print(f"  {fmt(grant)}")

    if not extra:
        return 0

    print("\nThese privileges are granted to a client role and should not be:")
    for grant in extra:
        print(f"  {fmt(grant)}")
    print(
        "\nSupabase grants ALL on every table in `public` to anon and authenticated by\n"
        "default, and GRANT cannot take a privilege away — only REVOKE can. A new table\n"
        "therefore arrives fully open, and a migration that GRANTs a narrower set does\n"
        "NOT close it. Add to the migration:\n"
        "\n"
        "    REVOKE ALL ON public.<table> FROM anon, authenticated;\n"
        "\n"
        "followed by only the privileges the browser client genuinely uses. A line\n"
        "naming `table(column)` is a COLUMN grant, which REVOKE ALL on the table also\n"
        "removes; `REVOKE <privilege> (<column>) ON public.<table> FROM <role>;` is the\n"
        "narrow form. If a grant\n"
        "listed above is deliberate, add it to\n"
        f"{expected_display(expected_path)} with a note saying which client code needs it.\n"
        "See docs/database-changes.md.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
