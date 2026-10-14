// CV viewer after automatic ingestion — end to end (production fix, 12 Oct 2026).
//
// Production 2beef22: auto-ingest created the candidate and kept the CV only as
// a candidate_document row + the intake's stored file; candidate.resume_path
// stayed empty, so hasResume was false, the profile said "No résumé on file"
// and GET /candidates/:id/resume returned 404. Every View-CV entry point
// depends on that route.
//
// Each case runs the real path: bytes stored -> intake -> ingestIntake() ->
// HTTP GET through the real router (auth, router.param scope, permissions).
// Synthetic people and files only.
import { suiteDatabaseUrl } from './test-support/suite-db.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arabtec-cvview-'));
process.env.DATABASE_URL = suiteDatabaseUrl('file:' + path.join(TMP, 'cvview.db'));
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.PORT = process.env.CV_VIEW_TEST_PORT || '4388';
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
const { CandidateDocuments } = await import('./src/lib/models.js');

let pass = 0, fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (ok ? '' : ' ' + x)); ok ? pass++ : fail++; };
const login = async (e) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: e, password: 'Arabtec@123' }) })).json()).token;
const get = (p, token) => fetch(B + '/api' + p, { headers: { Authorization: 'Bearer ' + token } });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const F = (field, value, confidence = 0.92) => ({ field, value, confidence });

// A real (tiny) PDF and a real DOCX-shaped zip are not needed for routing; the
// bytes only have to be distinct and verifiable. The DOCX case uses a valid
// minimal document so the HTML preview path runs for real.
const pdfBytes = (tag) => Buffer.from(`%PDF-1.4\n% synthetic CV ${tag}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`);
let n = 0;
function intakeFor(bytes, fileName, fields, mimeType = 'application/pdf') {
  n += 1;
  const storedName = storeFile(fileName, bytes);
  return createIntake({ storedName: storedName.storedName, fileName, mimeType,
    fileHash: sha(bytes), origin: 'mailbox.microsoft', modelId: 'test-model', documentId: `doc-${n}`, generation: null, fields, createdBy: 1 });
}
const person = (name, email, phone) => [F('fullName', name), F('email', email), F('phone', phone), F('currentPosition', 'Site Engineer'), F('yearsExperience', 6), F('location', 'Cairo, Egypt')];

try {
  const recruiter = await login('recruiter@arabtec.com');
  const hrMgr = await login('hr.manager@arabtec.com');
  const interviewer = await login('interviewer@arabtec.com');
  const actor = { id: 1, fullName: 'Synthetic Admin' };

  console.log('\n— 1. a CV that arrives by mail and is auto-ingested can be opened —');
  const bytesA = pdfBytes('A');
  const rA = await ingestIntake(intakeFor(bytesA, 'Synthetic_A_CV.pdf', person('Synthetic Person A', 'syn.a@example.invalid', '+201001110001')), actor);
  c('auto-ingest created the candidate', rA.outcome === 'CONVERTED' && !!rA.candidateId, JSON.stringify(rA).slice(0, 160));
  const candA = await (await get(`/candidates/${rA.candidateId}`, hrMgr)).json();
  c('the profile says a CV is on file, with its name', candA.candidate?.hasResume === true && candA.candidate?.resumeName === 'Synthetic_A_CV.pdf', JSON.stringify({ has: candA.candidate?.hasResume, name: candA.candidate?.resumeName }));
  const resA = await get(`/candidates/${rA.candidateId}/resume`, hrMgr);
  const gotA = Buffer.from(await resA.arrayBuffer());
  c('View/Download returns exactly the stored bytes (200)', resA.status === 200 && gotA.equals(bytesA), String(resA.status));
  const listed = await (await get('/candidates', hrMgr)).json();
  c('the Talent Pool list shows it has a CV too', (listed.candidates || []).find((x) => x.id === rA.candidateId)?.hasResume === true);
  c('no database write was needed to make it viewable (resume_path stays as ingested)', db.get('SELECT resume_path FROM candidate WHERE id=?', [rA.candidateId]).resume_path == null);

  console.log('\n— 2. an existing CV is never replaced by an ingested one —');
  const own = new FormData(); own.append('file', new Blob(['Synthetic own CV text'], { type: 'text/plain' }), 'Synthetic_Own.txt');
  const created = await (await fetch(B + '/api/candidates', { method: 'POST', headers: { Authorization: 'Bearer ' + recruiter, 'Content-Type': 'application/json' }, body: JSON.stringify({ fullName: 'Synthetic Person B', email: 'syn.b@example.invalid', phone: '+201001110002' }) })).json();
  const idB = created.candidate.id;
  await fetch(`${B}/api/candidates/${idB}/resume?parse=0`, { method: 'POST', headers: { Authorization: 'Bearer ' + recruiter }, body: own });
  const rB = await ingestIntake(intakeFor(pdfBytes('B-newer'), 'Synthetic_B_newer.pdf', person('Synthetic Person B', 'syn.b@example.invalid', '+201001110002')), actor);
  c('the newer CV matched the same person (no duplicate)', rB.candidateId === idB, JSON.stringify(rB).slice(0, 160));
  const resB = await get(`/candidates/${idB}/resume`, hrMgr);
  c('the CV the recruiter uploaded is still the one served', resB.status === 200 && (await resB.text()) === 'Synthetic own CV text');

  console.log('\n— 3. guards: provenance, ambiguity, integrity, access —');
  // Same bytes linked to ANOTHER person's intake: never served to this one.
  const bytesC = pdfBytes('C');
  const rC = await ingestIntake(intakeFor(bytesC, 'Synthetic_C_CV.pdf', person('Synthetic Person C', 'syn.c@example.invalid', '+201001110003')), actor);
  const other = await (await fetch(B + '/api/candidates', { method: 'POST', headers: { Authorization: 'Bearer ' + recruiter, 'Content-Type': 'application/json' }, body: JSON.stringify({ fullName: 'Synthetic Person D', email: 'syn.d@example.invalid', phone: '+201001110004' }) })).json();
  CandidateDocuments.add({ candidateId: other.candidate.id, docType: 'cv', fileName: 'copied.pdf', fileHash: sha(bytesC), fileSize: null, note: null, uploadedBy: null });
  const resD = await get(`/candidates/${other.candidate.id}/resume`, hrMgr);
  c('a hash match whose intake belongs to someone else is NOT served (404)', resD.status === 404 && rC.candidateId !== other.candidate.id, String(resD.status));
  c('…and that profile does not claim a CV', (await (await get(`/candidates/${other.candidate.id}`, hrMgr)).json()).candidate.hasResume === false);
  // Stored bytes that no longer match their recorded hash: refused, not served.
  const bytesE = pdfBytes('E');
  const intakeE = intakeFor(bytesE, 'Synthetic_E_CV.pdf', person('Synthetic Person E', 'syn.e@example.invalid', '+201001110005'));
  const rE = await ingestIntake(intakeE, actor);
  db.run('UPDATE file_blob SET data=? WHERE stored_name=?', [Buffer.from('tampered'), db.get('SELECT stored_name FROM candidate_intake WHERE id=?', [intakeE.id]).stored_name]);
  const resE = await get(`/candidates/${rE.candidateId}/resume`, hrMgr);
  c('bytes that no longer match the recorded hash are refused (409), not served', resE.status === 409, String(resE.status));
  // Access follows the existing candidate scope.
  c('an interviewer not assigned to the candidate cannot open it (403)', (await get(`/candidates/${rA.candidateId}/resume`, interviewer)).status === 403);

  // An intake that was never linked to anyone (not ingested): hash-only is not provenance.
  const bytesU = pdfBytes('U');
  intakeFor(bytesU, 'Synthetic_U_CV.pdf', person('Synthetic Person U', 'syn.u@example.invalid', '+201001110007')); // stays PENDING, candidate_id NULL
  const unl = await (await fetch(B + '/api/candidates', { method: 'POST', headers: { Authorization: 'Bearer ' + recruiter, 'Content-Type': 'application/json' }, body: JSON.stringify({ fullName: 'Synthetic Person V', email: 'syn.v@example.invalid', phone: '+201001110008' }) })).json();
  CandidateDocuments.add({ candidateId: unl.candidate.id, docType: 'cv', fileName: 'Synthetic_U_CV.pdf', fileHash: sha(bytesU), fileSize: null, note: null, uploadedBy: null });
  const vProf = (await (await get(`/candidates/${unl.candidate.id}`, hrMgr)).json()).candidate;
  c('an UNLINKED intake with a matching hash is not served (no hash-only fallback)', (await get(`/candidates/${unl.candidate.id}/resume`, hrMgr)).status === 404 && vProf.hasResume === false);
  const vDoc = vProf.documents.find((d) => d.doc_type === 'cv');
  const vRes = await get(`/candidates/${unl.candidate.id}/documents/${vDoc.id}/file`, hrMgr);
  c('…its document row is reported as an exception (unlinked), and its route refuses (409)', vDoc.cvViewable === false && vDoc.cvProblem === 'unlinked' && vRes.status === 409, `${vDoc.cvProblem} ${vRes.status}`);
  const dProf = (await (await get(`/candidates/${other.candidate.id}`, hrMgr)).json()).candidate;
  c('…a row whose bytes belong to another person is reported as ambiguous', dProf.documents.find((d) => d.doc_type === 'cv')?.cvProblem === 'ambiguous');

  console.log('\n— 3b. two versions with the SAME filename each open their own bytes —');
  const v1 = pdfBytes('S-v1'), v2 = pdfBytes('S-v2');
  const rS1 = await ingestIntake(intakeFor(v1, 'Same_Name_CV.pdf', person('Synthetic Person S', 'syn.s@example.invalid', '+201001110009')), actor);
  const rS2 = await ingestIntake(intakeFor(v2, 'Same_Name_CV.pdf', [...person('Synthetic Person S', 'syn.s@example.invalid', '+201001110009'), F('yearsExperience', 7)]), actor);
  c('the second file is the same person (newer CV, no duplicate)', rS2.candidateId === rS1.candidateId, JSON.stringify(rS2).slice(0, 140));
  const sProf = (await (await get(`/candidates/${rS1.candidateId}`, hrMgr)).json()).candidate;
  const sDocs = sProf.documents.filter((d) => d.doc_type === 'cv');
  c('both versions are listed and both can be opened', sDocs.length === 2 && sDocs.every((d) => d.cvViewable === true && d.file_name === 'Same_Name_CV.pdf'), JSON.stringify(sDocs.map((d) => [d.id, d.cvViewable])));
  const bodies = await Promise.all(sDocs.map(async (d) => Buffer.from(await (await get(`/candidates/${rS1.candidateId}/documents/${d.id}/file`, hrMgr)).arrayBuffer())));
  c('…each document id returns its own version (not the newest twice)', bodies.some((b) => b.equals(v1)) && bodies.some((b) => b.equals(v2)));
  c('…and the profile CV is the newest version', Buffer.from(await (await get(`/candidates/${rS1.candidateId}/resume`, hrMgr)).arrayBuffer()).equals(v2));
  c('another candidate\'s document id is refused on this candidate (404)', (await get(`/candidates/${rS1.candidateId}/documents/${vDoc.id}/file`, hrMgr)).status === 404);
  c('an unassigned interviewer cannot open a document either (403)', (await get(`/candidates/${rS1.candidateId}/documents/${sDocs[0].id}/file`, interviewer)).status === 403);

  console.log('\n— 4. Word CVs render in the panel through the same resolution —');
  // A minimal valid .docx, built here (jszip ships with mammoth) — no fixture file.
  const JSZip = (await import('jszip')).default;
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic Person W — Site Engineer</w:t></w:r></w:p></w:body></w:document>');
  const docx = await z.generateAsync({ type: 'nodebuffer' });
  const rW = await ingestIntake(intakeFor(docx, 'Synthetic_W_CV.docx', person('Synthetic Person W', 'syn.w@example.invalid', '+201001110006'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), actor);
  const html = await get(`/candidates/${rW.candidateId}/resume?as=html`, hrMgr);
  const hj = await html.json().catch(() => ({}));
  c('a DOCX CV is rendered as HTML for the side panel (200)', html.status === 200 && typeof hj.html === 'string' && hj.html.length > 0, `${html.status} ${JSON.stringify(hj).slice(0, 120)}`);
} catch (e) { console.error(e); fail++; }
finally {
  console.log(`\n=== CV VIEWER AFTER INGEST: ${pass} passed, ${fail} failed ===\n`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}
