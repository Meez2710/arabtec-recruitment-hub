import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('/Users/moutazadly/Downloads/arabtec-recruitment-hub/backend/data/arabtec.db');
db.prepare('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE email = ?').run('admin@arabtec.com');
console.log('Account unlocked successfully.');
