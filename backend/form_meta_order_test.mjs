// Recruitment team request (25 Oct 2026): the Hiring Manager list in the
// hiring request form is alphabetical. So are the other people lists the same
// endpoint serves, and the interviewer list of the scheduling form.
// Disposable SQLite DB.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arabtec-meta-order-'));
process.env.DATABASE_URL = 'file:' + path.join(TMP, 'meta.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.PORT = process.env.META_ORDER_TEST_PORT || '4641';
process.env.SEED_DEMO_DATA = 'true';
process.env.SMTP_TRANSPORT = 'json';
process.env.SEED_ADMIN_PASSWORD ||= 'MetaOrder#2026x';
await import('./prisma/seed.js');
await import('./src/server.js');
const { waitForReady } = await import('./test-support/wait-ready.mjs');
const db = await import('./src/lib/db.js');
const B = 'http://localhost:' + process.env.PORT;
await waitForReady(B);

let pass = 0, fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (ok ? '' : ' ' + x)); ok ? pass++ : fail++; };
async function api(p, { method = 'GET', token, body } = {}) {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
const sorted = (list) => list.every((x, i) => i === 0 || String(list[i - 1].name).localeCompare(String(x.name), undefined, { sensitivity: 'base' }) <= 0);

try {
  db.run('UPDATE users SET must_change_password=0');
  // Users whose creation order is the reverse of their alphabetical order, so a
  // list that merely preserves insertion order fails the check.
  for (const name of ['Zaid Youssef', 'Mona Adel', 'ahmed Bakr']) {
    db.run("INSERT INTO users (employee_no, full_name, email, password_hash, status, created_at, updated_at) VALUES (?,?,?,?,'active',datetime('now'),datetime('now'))",
      ['E-' + name.replace(/\W/g, ''), name, name.replace(/\W/g, '').toLowerCase() + '@arabtec.test', 'x']);
  }
  const token = (await api('/api/auth/login', { method: 'POST', body: { email: 'recruiter@arabtec.com', password: 'Arabtec@123' } })).json.token;
  const m = await api('/api/requests/meta/form', { token });
  c('form meta loads', m.status === 200, m.text);
  const hm = m.json.hiringManagers;
  c('hiring managers are alphabetical (case-insensitive)', sorted(hm), hm.map((x) => x.name).join(' | '));
  c('…and still include every user, not a filtered subset', hm.some((x) => x.name === 'ahmed Bakr') && hm.some((x) => x.name === 'Zaid Youssef'));
  c('recruiters list is alphabetical', sorted(m.json.recruiters));
  c('assignable recruiters list is alphabetical', sorted(m.json.assignableRecruiters));
  const iv = await api('/api/interviews/meta/form', { token });
  c('interviewer list is alphabetical', iv.status === 200 && sorted(iv.json.interviewers), iv.text.slice(0, 200));
} catch (e) { c('suite ran without throwing', false, e.stack || e.message); }
console.log(`\n=== FORM META ORDER: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
