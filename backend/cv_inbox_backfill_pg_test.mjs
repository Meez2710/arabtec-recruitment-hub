// Run real PostgreSQL dialect/transaction semantics without production data.
import assert from 'node:assert/strict';
process.env.DATABASE_URL='postgres://fixture:fixture@localhost/ats_test';
process.env.PG_ENGINE='pglite';
delete process.env.PG_DATA;
const {ensureSchema}=await import('./src/lib/schema.js');
const {run,get}=await import('./src/lib/db.js');
const {ROLES}=await import('./src/lib/permissions.js');
ensureSchema();
for(const [code,name,description] of ROLES)run('INSERT INTO role (code,name,description) VALUES (?,?,?)',[code,name,description]);
ensureSchema();
assert.ok(get("SELECT id FROM system_setting WHERE key='schema.backfill.cv_inbox_roles'"),'PostgreSQL backfill must commit its marker');
assert.equal(Number(get('SELECT COUNT(*) AS n FROM role_permission').n),20,'PostgreSQL must commit all 20 grants');
run("DELETE FROM role_permission WHERE role_id=(SELECT id FROM role WHERE code='recruiter') AND permission_id=(SELECT id FROM permission WHERE code='cv_intake.preview')");
ensureSchema();
assert.equal(Number(get('SELECT COUNT(*) AS n FROM role_permission').n),19,'Revocation survives PostgreSQL restart');
console.log('POSTGRES CV INBOX BACKFILL: passed');
process.exit(0);
