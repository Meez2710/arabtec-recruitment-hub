import { Pool } from 'pg';
const pool = new Pool({ connectionString: 'postgres://postgres:postgres@localhost:5432/arabtec_recruitment' });
async function check() {
  const res = await pool.query('SELECT id, email, password_hash, must_change_password FROM app_user LIMIT 5;');
  console.log(res.rows);
  process.exit(0);
}
check().catch(console.error);
