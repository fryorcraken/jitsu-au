-- Every privilege `anon` and `authenticated` hold on a table in `public`, as
-- `table,grantee,privilege`, for check-client-grants.py. The one copy of this
-- query: supabase-lint.yml runs it against the migration replay, and README.md
-- has it run by hand against the live database, so the two results compare.
--
-- Tables only (relkind 'r'): views, materialized views and partitioned tables
-- are not read. None exists in `public` today; the first one should widen this.
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
-- A grant to PUBLIC (grantee oid 0, which has no pg_roles row) is held by both
-- client roles, so it is reported too, as grantee `PUBLIC`, and is never
-- expected. An inner join on pg_roles would drop it silently.
SELECT c.relname, coalesce(r.rolname, 'PUBLIC') AS rolname, a.privilege_type
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) a
  LEFT JOIN pg_roles r ON r.oid = a.grantee
 WHERE n.nspname = 'public' AND c.relkind = 'r'
   AND (a.grantee = 0 OR r.rolname IN ('anon', 'authenticated'))
UNION ALL
SELECT c.relname || '(' || att.attname || ')', coalesce(r.rolname, 'PUBLIC'), a.privilege_type
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute att
    ON att.attrelid = c.oid AND att.attnum > 0 AND NOT att.attisdropped
  CROSS JOIN LATERAL aclexplode(att.attacl) a
  LEFT JOIN pg_roles r ON r.oid = a.grantee
 WHERE n.nspname = 'public' AND c.relkind = 'r'
   AND (a.grantee = 0 OR r.rolname IN ('anon', 'authenticated'))
 ORDER BY 1, 2, 3;
