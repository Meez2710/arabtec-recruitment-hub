// Request-only erasure: deleting the request must never cascade into recruitment work.
// Both engines retain every child row; only the request_id reference becomes NULL.
import { all, get, exec, run, tx, driverKind, inTransaction } from './db.js';
export const REQUEST_LINK_TABLES = ['requisition_seat', 'request_approval', 'request_activity', 'application', 'interview', 'offer', 'ticket_post'];
const quote = value => '"' + value.replaceAll('"', '""') + '"';

export function migrateRequestDetachment() {
  if (driverKind() !== 'sqlite') {
    tx(() => {
      const links = all(`SELECT c.conname, c.confdeltype, t.relname AS table_name, a.attname AS column_name,
        cardinality(c.conkey) AS key_count
        FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
        JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
        WHERE c.contype='f' AND c.confrelid='recruitment_request'::regclass`);
      for (const link of links) {
        if (!REQUEST_LINK_TABLES.includes(link.table_name) || link.column_name !== 'request_id' || Number(link.key_count) !== 1) {
          throw new Error('Unexpected request dependency; refusing unsafe request-deletion migration.');
        }
        const table = quote(link.table_name), constraint = quote(link.conname);
        run(`ALTER TABLE ${table} ALTER COLUMN request_id DROP NOT NULL`);
        if (link.confdeltype === 'n') continue;
        run(`ALTER TABLE ${table} DROP CONSTRAINT ${constraint}`);
        run(`ALTER TABLE ${table} ADD CONSTRAINT ${constraint} FOREIGN KEY (request_id) REFERENCES recruitment_request(id) ON DELETE SET NULL`);
      }
      if (new Set(links.map(l => l.table_name)).size !== REQUEST_LINK_TABLES.length) throw new Error('Missing request dependency; refusing unsafe request-deletion migration.');
    });
    return;
  }
  if (inTransaction()) throw new Error('Request-deletion migration must run outside a SQLite transaction.');
  const tables = all("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  const pending = [];
  const found = new Set();
  for (const table of tables) {
    const refs = all(`PRAGMA foreign_key_list(${quote(table.name)})`).filter(f => f.table === 'recruitment_request');
    if (!refs.length) continue;
    if (!REQUEST_LINK_TABLES.includes(table.name) || refs.length !== 1 || refs[0].from !== 'request_id') throw new Error('Unexpected request dependency; refusing unsafe request-deletion migration.');
    found.add(table.name);
    const col = all(`PRAGMA table_info(${quote(table.name)})`).find(c => c.name === 'request_id');
    if (refs[0].on_delete === 'SET NULL' && !col.notnull) continue;
    pending.push(table);
  }
  if (found.size !== REQUEST_LINK_TABLES.length) throw new Error('Missing request dependency; refusing unsafe request-deletion migration.');
  if (!pending.length) return;
  // Rebuild atomically using SQLite's documented create/copy/drop/rename pattern.
  // Keep indices, triggers, IDs and AUTOINCREMENT high-water marks intact.
  exec('PRAGMA foreign_keys=OFF');
  try {
    tx(() => {
      for (const table of pending) {
        const original = quote(table.name), replacement = quote(table.name + '__request_detach');
        let ddl = table.sql.replace(/(\brequest_id\s+INTEGER)\s+NOT\s+NULL/i, '$1');
        ddl = ddl.replace(/(\brequest_id\s+INTEGER\s+REFERENCES\s+recruitment_request\s*\(id\)\s+ON\s+DELETE\s+)CASCADE/i, '$1SET NULL');
        if (!/request_id\s+INTEGER\s+REFERENCES\s+recruitment_request\s*\(id\)\s+ON\s+DELETE\s+SET\s+NULL/i.test(ddl)) throw new Error('Unrecognized request FK definition; refusing rebuild.');
        ddl = ddl.replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"[^"]+"|\w+)/i, `CREATE TABLE ${replacement}`);
        const objects = all("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL", [table.name]);
        const columns = all(`PRAGMA table_info(${original})`).map(c => quote(c.name)).join(',');
        const sequence = get('SELECT seq FROM sqlite_sequence WHERE name=?', [table.name]);
        exec(ddl);
        exec(`INSERT INTO ${replacement} (${columns}) SELECT ${columns} FROM ${original}`);
        exec(`DROP TABLE ${original}`);
        exec(`ALTER TABLE ${replacement} RENAME TO ${original}`);
        for (const object of objects) exec(object.sql);
        if (sequence) run('UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name=?', [sequence.seq, table.name]);
      }
      if (all('PRAGMA foreign_key_check').length) throw new Error('Foreign-key validation failed; request migration rolled back.');
    });
  } finally { exec('PRAGMA foreign_keys=ON'); }
}
