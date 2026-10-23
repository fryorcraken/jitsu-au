-- Every privilege `anon` and `authenticated` hold in `public`, as
-- `table,grantee,privilege`, for check-client-grants.py. The one copy of this
-- query: supabase-lint.yml runs it against the migration replay, and README.md
-- has it run by hand against the live database, so the two results compare.
--
-- Read from the catalogs, never information_schema: those views hide grants the
-- connecting role is not party to, and omit MAINTAIN. pg_class and pg_attribute
-- are world-readable, so aclexplode() gives the true ACL whoever connects.
--
-- Two halves, because Postgres keeps two ACLs. `GRANT UPDATE (col) ON t` lands
-- in pg_attribute.attacl and leaves pg_class.relacl untouched, so reading the
-- table ACL alone reports a table as closed while one column is writable. A
-- column grant is reported as `table(column)`.
SELECT c.relname, r.rolname, a.privilege_type
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) a
  JOIN pg_roles r ON r.oid = a.grantee
 WHERE n.nspname = 'public' AND c.relkind = 'r'
   AND r.rolname IN ('anon', 'authenticated')
UNION ALL
SELECT c.relname || '(' || att.attname || ')', r.rolname, a.privilege_type
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute att
    ON att.attrelid = c.oid AND att.attnum > 0 AND NOT att.attisdropped
  CROSS JOIN LATERAL aclexplode(att.attacl) a
  JOIN pg_roles r ON r.oid = a.grantee
 WHERE n.nspname = 'public' AND c.relkind = 'r'
   AND r.rolname IN ('anon', 'authenticated')
 ORDER BY 1, 2, 3;
