import fs from 'node:fs';

async function main() {
  const loginRes = await fetch('http://localhost:4000/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@arabtec.com', password: 'Admin@12345' })
  });
  const { token } = await loginRes.json();
  if (!token) throw new Error('Login failed');

  const res = await fetch('http://localhost:4001/api/v1/cv-intake', {
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + token }
  });
  const data = await res.text();
  console.log('GET response:', res.status, data);
}

main().catch(console.error);
