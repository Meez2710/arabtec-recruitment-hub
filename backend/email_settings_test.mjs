// Real settings HTTP + persisted configuration; dry-run or fake SMTP only.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
process.env.DATABASE_URL = `file:/tmp/ats-mail-settings-${process.pid}-${crypto.randomUUID()}.db`;
process.env.PORT = String(5200 + process.pid % 200);
process.env.NODE_ENV = 'test';
process.env.SEED_ADMIN_PASSWORD = 'Bootstrap#Mail1';
process.env.SEED_DEMO_DATA = 'true';
process.env.SMTP_TRANSPORT = 'json';
process.env.SMTP_USER = 'career@example.com';
process.env.SMTP_PASS = 'environment-password';
process.env.MICROSOFT_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
await import('./prisma/seed.js');
await import('./src/server.js');
const { waitForReady } = await import('./test-support/wait-ready.mjs');
const { adminToken } = await import('./test-support/admin-session.mjs');
const base = `http://localhost:${process.env.PORT}`;
await waitForReady(base);
const token = await adminToken(base, { bootstrap: 'Bootstrap#Mail1' });
const { SystemSettings } = await import('./src/lib/models.js');
const { all } = await import('./src/lib/db.js');
const request = async (method, path, body, auth = token) => {
  const r = await fetch(base + '/api/' + path, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer ' + auth } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let bodyOut; try { bodyOut = JSON.parse(text); } catch { bodyOut = {}; }
  return { status: r.status, body: bodyOut };
};
let checks = 0;
const check = (name, condition) => { assert.ok(condition, name); checks++; console.log('PASS', name); };
try {
  const initial = await request('GET', 'settings/email');
  check('dedicated email settings exists', initial.status === 200 && initial.body.settings);
  check('environment secret never returned', !JSON.stringify(initial).includes('environment-password') && initial.body.settings.passwordSource === 'environment');
  const login = await request('POST', 'auth/login', { email: 'recruiter@arabtec.com', password: 'Arabtec@123' }, null);
  const recruit = login.body.token;
  for (const [method, path, data] of [['GET','settings/email'], ['PUT','settings/email',{fromName:'Changed'}], ['POST','settings/email/test',{to:'test@example.com'}]]) {
    check(method + ' settings requires admin', (await request(method, path, data, recruit)).status === 403);
  }
  const secret = 'private-mail-password-123';
  const save = await request('PUT', 'settings/email', { provider:'smtp', host:'smtp.example.com', port:587, encryption:'starttls', user:'career@example.com', from:'career@example.com', fromName:'Arabtec Careers', replyTo:'reply@example.com', password:secret });
  check('save succeeds', save.status === 200);
  check('save never echoes secret', !JSON.stringify(save).includes(secret));
  const stored = JSON.stringify(all('SELECT * FROM system_setting'));
  check('password encrypted in database', !stored.includes(secret));
  const { effectiveMailSettings } = await import('./src/lib/mail-settings.js');
  check('transport receives saved credential', effectiveMailSettings().pass === secret);
  await request('PUT', 'settings/email', { fromName:'Recruitment Team' });
  check('omitted password retained', effectiveMailSettings().pass === secret && effectiveMailSettings().fromName === 'Recruitment Team');
  const unchanged = JSON.stringify(all('SELECT * FROM system_setting'));
  check('empty password rejected', (await request('PUT', 'settings/email', {password:''})).status === 400);
  const test = await request('POST','settings/email/test', {settings:{host:'preview.example.com',password:'temporary-secret'},to:'test@example.com'});
  check('draft test uses dry-run', test.status === 200 && test.body.provider === 'dry-run');
  check('successful draft test persists nothing', unchanged === JSON.stringify(all('SELECT * FROM system_setting')));
  check('invalid test rejected', (await request('POST','settings/email/test',{settings:{port:0},to:'test@example.com'})).status === 400);
  check('failed test persists nothing', unchanged === JSON.stringify(all('SELECT * FROM system_setting')));
  const nodemailer = (await import('nodemailer')).default;
  const originalTransport = nodemailer.createTransport;
  let used = null;
  nodemailer.createTransport = options => ({verify:async()=>{used=options; const e=new Error('Authentication failed'); e.response='535 Authentication rejected: '+secret; throw e;},close(){}});
  delete process.env.SMTP_TRANSPORT;
  const failedDraft = await request('POST','settings/email/test',{settings:{provider:'smtp',host:'draft.example.com',port:465,encryption:'tls'}});
  process.env.SMTP_TRANSPORT='json';nodemailer.createTransport=originalTransport;
  check('SMTP tests actual draft transport and TLS', used?.host==='draft.example.com' && used?.secure===true && used?.auth?.pass===secret);
  check('SMTP failure is actionable and redacted', failedDraft.status===502 && failedDraft.body.error.includes('535') && !failedDraft.body.error.includes(secret));
  check('SMTP connection failure preserves settings', unchanged===JSON.stringify(all('SELECT * FROM system_setting')));
  check('invalid recipient rejected', (await request('POST','settings/email/test',{to:'bad\r\nBcc:someone@example.com'})).status === 400);
  SystemSettings.upsert('smtp_password', 'legacy-secret');
  const generic = await request('GET','settings/system');
  check('generic settings excludes credentials and internal mail store', !JSON.stringify(generic).includes('legacy-secret') && !JSON.stringify(generic).includes('v1.') && !JSON.stringify(generic).includes(secret));
  check('generic settings cannot overwrite internal mail store', (await request('PUT','settings/system',{settings:{email_configuration:'{}'}})).status === 400);
  const audit = JSON.stringify(all('SELECT * FROM audit_log'));
  check('audits exclude all password values', ![secret,'temporary-secret','legacy-secret'].some(x=>audit.includes(x)));
  const { sendMail } = await import('./src/lib/mailer.js');
  check('existing send API works after settings update', (await sendMail({to:'test@example.com',subject:'Test',html:'Test'})).ok);
  // A stale fallback secret must not break an independent provider or recovery.
  process.env.MICROSOFT_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  check('dry-run survives unreadable SMTP fallback', (await sendMail({to:'test@example.com',subject:'Test',html:'Test'})).ok);
  check('Graph can be selected without decrypting SMTP fallback', (await request('PUT','settings/email',{provider:'graph'})).status===200);
  check('Graph draft test in dry-run does not decrypt SMTP fallback', (await request('POST','settings/email/test',{settings:{provider:'graph'}})).status===200);
  check('replacement can recover unreadable prior credential', (await request('PUT','settings/email',{provider:'smtp',password:'replacement-secret'})).status===200);
  check('replacement decrypts using current key', effectiveMailSettings().pass==='replacement-secret');
  const key = process.env.MICROSOFT_TOKEN_ENCRYPTION_KEY;
  delete process.env.MICROSOFT_TOKEN_ENCRYPTION_KEY;
  const beforeNoKey=JSON.stringify(all('SELECT * FROM system_setting'));
  check('missing encryption key refuses password save', (await request('PUT','settings/email',{password:'not-saved'})).status===400);
  check('missing-key refusal persists nothing',beforeNoKey===JSON.stringify(all('SELECT * FROM system_setting')));
  process.env.MICROSOFT_TOKEN_ENCRYPTION_KEY=key;
  console.log(`EMAIL SETTINGS: ${checks} checks passed`);
  process.exit(0);
} catch(e) { console.error(e); process.exit(1); }
