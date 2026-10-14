// CV side panel — the paths cv_viewer_ingest_test.mjs does not cover (12 Oct 2026).
//
// (Ingested candidates' own CVs: cv_viewer_ingest_test.mjs.)
// A file posted in a request thread (thread CVs) opens in the side panel:
//    a Word file renders as HTML (`?as=html`) under the SAME permission check
//    as the raw file; it no longer opens a blob URL in a new browser tab.
// Synthetic people and files only.
import { suiteDatabaseUrl } from './test-support/suite-db.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arabtec-cvpanel-'));
process.env.DATABASE_URL = suiteDatabaseUrl('file:' + path.join(TMP, 'cvpanel.db'));
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.PORT = process.env.CV_PANEL_TEST_PORT || '4389';
process.env.SEED_DEMO_DATA ||= 'true';
process.env.SMTP_TRANSPORT = 'json';
process.env.MICROSOFT_TOKEN_ENCRYPTION_KEY ||= 'c'.repeat(64);
const { ADMIN_BOOTSTRAP_PASSWORD } = await import('./test-support/admin-session.mjs');
process.env.SEED_ADMIN_PASSWORD ||= ADMIN_BOOTSTRAP_PASSWORD;
await import('./prisma/seed.js');
await import('./src/server.js');
const { waitForReady } = await import('./test-support/wait-ready.mjs');
const B = 'http://localhost:' + process.env.PORT;
await waitForReady(B);
const db = await import('./src/lib/db.js');
const { storeFile } = await import('./src/lib/upload.js');
const { createIntake } = await import('./src/lib/intake-store.js');
const { ingestIntake } = await import('./src/lib/cv-intake/auto-ingest.js');
const { Posts } = await import('./src/lib/models.js');

let pass = 0, fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (ok ? '' : ' ' + x)); ok ? pass++ : fail++; };
const login = async (e) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: e, password: 'Arabtec@123' }) })).json()).token;
const get = (p, token) => fetch(B + '/api' + p, { headers: { Authorization: 'Bearer ' + token } });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const F = (field, value, confidence = 0.92) => ({ field, value, confidence });
const pdfBytes = (tag) => Buffer.from(`%PDF-1.4\n% synthetic CV ${tag}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`);
let n = 0;
function intakeFor(bytes, fileName, fields, mimeType = 'application/pdf') {
  n += 1;
  const stored = storeFile(fileName, bytes);
  return createIntake({ storedName: stored.storedName, fileName, mimeType,
    fileHash: sha(bytes), origin: 'mailbox.microsoft', modelId: 'test-model', documentId: `panel-doc-${n}`, generation: null, fields, createdBy: 1 });
}
const person = (name, email, phone) => [F('fullName', name), F('email', email), F('phone', phone), F('currentPosition', 'Site Engineer'), F('yearsExperience', 6), F('location', 'Cairo, Egypt')];
async function minimalDocx(text) {
  const JSZip = (await import('jszip')).default;
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return z.generateAsync({ type: 'nodebuffer' });
}

try {
  const recruiter = await login('recruiter@arabtec.com');
  const hrMgr = await login('hr.manager@arabtec.com');
  const interviewer = await login('interviewer@arabtec.com');
  const actor = { id: 1, fullName: 'Synthetic Admin' };

  console.log('\n— 1. A thread file opens in the side panel, under the same permission —');
  const rmeta = await (await get('/requests/meta/form', hrMgr)).json();
  const created = await (await fetch(B + '/api/requests', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + hrMgr },
    body: JSON.stringify({ title: 'Site Engineer', justification: 'new_hire', projectId: rmeta.projects[0].id, departmentId: rmeta.departments[0].id, location: 'Cairo', headcount: 1, priority: 'normal' }) })).json();
  const reqRow = created.request;
  c('a hiring request was created for the thread', !!reqRow?.id, JSON.stringify(created).slice(0, 160));
  const docx = await minimalDocx('Synthetic Panel T — Site Engineer');
  const storedDocx = storeFile('Synthetic_T_CV.docx', docx);
  const postDocx = Posts.create({ requestId: reqRow.id, postType: 'cv', authorId: 1, authorName: 'Synthetic Admin', body: 'CV for review', filePath: storedDocx.storedName, fileName: 'Synthetic_T_CV.docx', payload: { candidateName: 'Synthetic Panel T' } });
  const storedPdf = storeFile('Synthetic_U_CV.pdf', pdfBytes('thread-U'));
  const postPdf = Posts.create({ requestId: reqRow.id, postType: 'cv', authorId: 1, authorName: 'Synthetic Admin', filePath: storedPdf.storedName, fileName: 'Synthetic_U_CV.pdf' });

  const h = await get(`/thread/post/${postDocx.id}/file?as=html`, hrMgr);
  const hj = await h.json().catch(() => ({}));
  c('a Word file in a thread renders as HTML for the panel (200)', h.status === 200 && typeof hj.html === 'string' && hj.html.includes('Synthetic Panel T'), `${h.status} ${JSON.stringify(hj).slice(0, 120)}`);
  const raw = await get(`/thread/post/${postPdf.id}/file`, hrMgr);
  c('a PDF in a thread is still served raw for the panel (200, application/pdf)', raw.status === 200 && /application\/pdf/.test(raw.headers.get('content-type') || ''), `${raw.status} ${raw.headers.get('content-type')}`);
  const pdfHtml = await get(`/thread/post/${postPdf.id}/file?as=html`, hrMgr);
  c('?as=html on a PDF is refused (415) — PDFs preview directly', pdfHtml.status === 415, `${pdfHtml.status}`);
  // `?as=html` adds no new access: for every role it answers exactly as the raw
  // file does (thread.js canView). Who may open which thread is covered by
  // thread_access_test.mjs (request-specific since 12 Oct).
  const roles = { interviewer, pm: await login('pm@arabtec.com'), hm: await login('hiring.manager@arabtec.com'), viewer: await login('viewer@arabtec.com') };
  const seen = [];
  for (const [role, tok] of Object.entries(roles)) {
    const a = (await get(`/thread/post/${postDocx.id}/file`, tok)).status;
    const b = (await get(`/thread/post/${postDocx.id}/file?as=html`, tok)).status;
    seen.push(`${role}:${a}/${b}`);
    c(`${role}: the Word preview is allowed exactly when the raw file is (${a} vs ${b})`, (a === 200) === (b === 200) && (a !== 403 || b === 403));
  }
  const unknownPost = await get('/thread/post/99999999/file?as=html', hrMgr);
  c('a post that does not exist is 404, before any rendering', unknownPost.status === 404, `${unknownPost.status}`);
  console.log('    role results (raw/html): ' + seen.join(', '));

  console.log('\n— 2. The compiled frontend opens thread files in the panel, not a new tab —');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const app = fs.readFileSync(path.join(here, '../frontend/public/app.jsx'), 'utf8');
  const viewPostFile = (app.match(/function viewPostFile\([^)]*\)\s*\{[\s\S]*?\n  \}/) || [''])[0];
  c('viewPostFile opens the document panel', /openDocumentPanel\(/.test(viewPostFile), viewPostFile.slice(0, 120));
  c('viewPostFile no longer calls api.download (blob URL in a new tab)', viewPostFile !== '' && !/api\.download\(/.test(viewPostFile));
  c('the document panel host is mounted once in the shell', (app.match(/<DocumentPanelHost \/>/g) || []).length === 1);
  const panel = (app.match(/function DocumentPanel\([\s\S]*?\n\}\n/) || [''])[0];
  c('the panel keeps Download as its own explicit action', /api\.download\(path, fileName \|\| 'file'\)/.test(panel));
  c('the panel is a keyboard dialog (role=dialog, Escape/Tab handled)', /role="dialog"/.test(panel) && /useDialogFocus\(onClose\)/.test(panel));
} catch (e) { console.error(e); fail++; }
finally {
  console.log(`\n=== CV SIDE PANEL: ${pass} passed, ${fail} failed ===\n`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}
