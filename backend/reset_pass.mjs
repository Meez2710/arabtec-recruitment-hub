import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';

const db = new DatabaseSync('/Users/moutazadly/Downloads/arabtec-recruitment-hub/backend/data/arabtec.db');
const hash = bcrypt.hashSync('Admin@12345', 10);
db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE email = ?').run(hash, 'admin@arabtec.com');
console.log('Admin password reset successfully to Admin@12345');
