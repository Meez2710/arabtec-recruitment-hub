// Proves the production-safe branding migration changes only the known legacy
// red action default and never overwrites an administrator-selected color.
import fs from 'node:fs';

const dbPath = '/tmp/arabtec_branding_migration.db';
for (const suffix of ['', '-journal', '-shm', '-wal']) {
  try { fs.rmSync(dbPath + suffix); } catch {}
}
process.env.DATABASE_URL = `file:${dbPath}`;

const { ensureSchema } = await import('./src/lib/schema.js');
const { run, get } = await import('./src/lib/db.js');

ensureSchema();
run('INSERT INTO branding_setting (key,value) VALUES (?,?)', ['button_color', '#d2232a']);
ensureSchema();
const migrated = get('SELECT value FROM branding_setting WHERE key=?', ['button_color'])?.value;

run('UPDATE branding_setting SET value=? WHERE key=?', ['#005a46', 'button_color']);
ensureSchema();
const preserved = get('SELECT value FROM branding_setting WHERE key=?', ['button_color'])?.value;

let failed = 0;
function check(name, condition) {
  if (condition) console.log(`  ✓ ${name}`);
  else { failed++; console.error(`  ✗ ${name}`); }
}
check('legacy red action default migrates to green', migrated === '#008064');
check('administrator-selected action color is preserved', preserved === '#005a46');
console.log(`\n=== BRANDING MIGRATION: ${2 - failed} passed, ${failed} failed ===\n`);
process.exit(failed ? 1 : 0);
