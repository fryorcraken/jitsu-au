-- Every privilege `anon` and `authenticated` hold on a table in `public`, as
-- `table,grantee,privilege`, for check-client-grants.py. The one copy of this
-- query: supabase-lint.yml runs it against the migration replay, and README.md
-- has it run by hand against the live database, so the two results compare.
--
-- Every relation a client could be granted: tables, partitioned tables, views,
-- materialized views and foreign tables. Supabase's default privileges grant
-- ALL on each of them to both client roles, and a view that is not
-- security_invoker reads as its owner, past RLS, so an open view is as bad as
-- an open table.
--
-- Read from the catalogs, never information_schema: those views hide grants the
-- connecting role is not party to, and omit MAINTAIN. pg_class and pg_attribute
-- are world-readable, so aclexplode() gives the true ACL whoever connects.
--
-- Two halves, because Postgres keeps two ACLs. `GRANT UPDATE (col) ON t` lands
-- in pg_attribute.attacl and leaves pg_class.relacl untouched, so reading the
-- table ACL alone reports a table as closed while one column is writable. A
-- column grant is reported as `table(column)`.
--
-- Two kinds of grant reach a client role without naming it, and both are
-- reported, under their own grantee name, which the expected file can never
-- list, so either always fails:
--   * PUBLIC (grantee oid 0, no pg_roles row), held by every role. An inner
--     join on pg_roles would drop it silently.
--   * a role that anon or authenticated is a member of, e.g. after
--     `GRANT reporting TO authenticated`. pg_has_role(..., 'MEMBER') follows
--     membership transitively, and is true for the role itself too.
SELECT c.relname, coalesce(r.rolname, 'PUBLIC') AS rolname, a.privilege_type
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) a
  LEFT JOIN pg_roles r ON r.oid = a.grantee
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
   AND CASE WHEN a.grantee = 0 THEN true
            ELSE pg_has_role('anon', a.grantee, 'MEMBER')
              OR pg_has_role('authenticated', a.grantee, 'MEMBER') END
UNION ALL
SELECT c.relname || '(' || att.attname || ')', coalesce(r.rolname, 'PUBLIC'), a.privilege_type
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute att
    ON att.attrelid = c.oid AND att.attnum > 0 AND NOT att.attisdropped
  CROSS JOIN LATERAL aclexplode(att.attacl) a
  LEFT JOIN pg_roles r ON r.oid = a.grantee
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
   AND CASE WHEN a.grantee = 0 THEN true
            ELSE pg_has_role('anon', a.grantee, 'MEMBER')
              OR pg_has_role('authenticated', a.grantee, 'MEMBER') END
 ORDER BY 1, 2, 3;
