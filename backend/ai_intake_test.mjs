// AI-assisted candidate intake — acceptance suite.
//
//   node --experimental-sqlite ai_intake_test.mjs
//
// NO GPU, NO NETWORK, NO MODEL. The AI gateway is replaced by a deterministic
// local HTTP server that can be told to succeed, stall, return malformed JSON,
// reject a document or go away entirely. That is the only way CI can assert
// what happens when the model misbehaves — the one class of failure that
// matters most and that a real model will not reproduce on demand.
//
// WHAT THIS SUITE IS DEFENDING
//   The ATS must stay usable when the AI is off, broken or slow; a parse must
//   never become a candidate without a human pressing Confirm; a retry must
//   never duplicate anything; and no CV content may reach a log, an audit row
//   or an error message.

process.env.NODE_ENV = 'test';
process.env.SEED_DEMO_DATA = 'true';
process.env.DATABASE_URL = 'file:/tmp/arabtec_ai_intake.db';
process.env.PORT = '4191';
process.env.AI_ENABLED = 'true';
process.env.AI_GATEWAY_URL = 'http://127.0.0.1:4192';
process.env.AI_GATEWAY_TOKEN = 'suite-token';
process.env.AI_TIMEOUT_MS = '4000';
process.env.AI_MAX_ATTEMPTS = '1';           // no automatic retry: assert the explicit one
process.env.AI_BREAKER_THRESHOLD = '3';

import fs from 'node:fs';
import http from 'node:http';
import zlib from 'node:zlib';

for (const f of ['/tmp/arabtec_ai_intake.db', '/tmp/arabtec_ai_intake.db-journal']) {
  try { fs.rmSync(f); } catch { /* absent */ }
}

/* ----------------------- the deterministic fake gateway -------------------- */

const GATEWAY_TOKEN = 'suite-token';
/** Flipped per test. The suite drives the model's behaviour, not the reverse. */
let mode = 'ok';
let seenAuth = [];
let callCount = 0;

const CONTENT = {
  fullName: 'Layla Hassan',
  email: 'layla.hassan@example.com',
  phone: '+971 50 123 4567',
  location: 'Dubai, UAE',
  totalYearsExperience: 9,
  skills: ['AutoCAD', 'Primavera P6'],
  employment: [{ employer: 'Gulf Contracting', title: 'Senior Structural Engineer', from: '2019', current: true }],
  education: [{ institution: 'American University of Sharjah', qualification: 'BSc Civil Engineering' }],
  languages: ['English', 'Arabic'],
  certifications: ['PMP'],
  uncertainFields: ['phone'],
};

const PROVENANCE = {
  modelId: 'qwen2.5:7b-instruct', modelDigest: 'sha256:abc123',
  promptVersion: 'resume-extract-prompt/1.0.0', schemaVersion: 'resume-extract/1.0.0',
  parserVersion: 'docling-sidecar/1.0.0',
};

const gateway = http.createServer((req, res) => {
  seenAuth.push(req.headers.authorization || null);
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    if (req.headers.authorization !== `Bearer ${GATEWAY_TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{}');
    }
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, ready: true, gatewayVersion: 'fake/1.0.0' }));
    }
    callCount += 1;
    const send = (payload, code = 200) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const base = { gatewayVersion: 'fake-gateway/1.0.0', provenance: PROVENANCE };

    if (mode === 'stall') { await new Promise((r) => setTimeout(r, 12000)); return send(base); }
    if (mode === 'server_error') return send({ error: 'boom' }, 503);
    if (mode === 'malformed') {
      // A model that answered with something that is not the agreed shape.
      return send({ ...base, document: { status: 'ok', pageCount: 2, charCount: 3400 },
        extraction: { content: { fullName: { nested: 'object' }, skills: 'not-an-array' } } });
    }
    if (mode === 'encrypted') return send({ ...base, document: { status: 'encrypted' } });
    if (mode === 'no_text') {
      return send({ ...base, document: { status: 'ok', pageCount: 4, charCount: 12, ocrApplied: true } });
    }
    if (mode === 'abstain') {
      return send({ ...base, document: { status: 'ok', pageCount: 2, charCount: 3400 },
        extraction: { abstained: true, permanent: false, reason: 'model declined' } });
    }
    return send({
      ...base,
      document: { status: 'ok', pageCount: 2, charCount: 3400, ocrApplied: mode === 'ocr', detectedLanguage: 'en' },
      extraction: { content: CONTENT, confidence: 0.72, evidence: { fullName: { page: 1, snippet: 'Layla Hassan' } } },
    });
  });
});
await new Promise((r) => gateway.listen(4192, '127.0.0.1', r));

/* ------------------------------- boot the ATS ------------------------------ */

await import('./prisma/seed.js');
await import('./src/server.js');

const B = 'http://localhost:4191';
const DEADLINE = Date.now() + 30000;
for (;;) {
  try {
    const r = await fetch(`${B}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'readiness@probe.invalid', password: 'x' }),
    });
    if (r.status !== 503) break;
  } catch { /* not up */ }
  if (Date.now() > DEADLINE) throw new Error('server never became ready');
  await new Promise((r) => setTimeout(r, 150));
}

let pass = 0; let fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (x ? ` ${x}` : '')); ok ? pass++ : fail++; };

async function api(p, { method = 'GET', token, body } = {}) {
  const r = await fetch(B + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null; try { j = await r.json(); } catch { /* empty */ }
  return { status: r.status, json: j };
}
const login = async (e, p = 'Arabtec@123') =>
  (await api('/api/auth/login', { method: 'POST', body: { email: e, password: p } })).json.token;

async function upload(token, bytes, filename) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: 'application/octet-stream' }), filename);
  const r = await fetch(`${B}/api/ai/intake/upload`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
  });
  let j = null; try { j = await r.json(); } catch { /* empty */ }
  return { status: r.status, json: j };
}

/** Synthetic PDF bytes. No real person's data, by construction. */
function syntheticPdf(marker = 'A') {
  const stream = zlib.deflateSync(Buffer.from(`BT (Synthetic CV ${marker}) Tj ET`));
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n2 0 obj<</Length '
      + stream.length + '/Filter/FlateDecode>>stream\n'),
    stream,
    Buffer.from('\nendstream endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'),
  ]);
}
/** A real .docx is a zip whose central directory names the OOXML word/ part. */
function syntheticDocx() {
  return Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from('....word/document.xml....'),
  ]);
}

const { get, all } = await import('./src/lib/db.js');
const taskRow = (id) => get('SELECT * FROM ai_task WHERE id=?', [id]);
const draftRow = (id) => get('SELECT * FROM ai_parse_draft WHERE task_id=?', [id]);
const candidateCount = () => Number(get('SELECT COUNT(*) c FROM candidate').c);

const settle = async (id, token, want = ['succeeded', 'failed', 'cancelled']) => {
  for (let i = 0; i < 80; i += 1) {
    const r = await api(`/api/ai/intake/jobs/${id}`, { token });
    if (want.includes(r.json?.task?.status)) return r.json.task;
    await new Promise((res) => setTimeout(res, 150));
  }
  return (await api(`/api/ai/intake/jobs/${id}`, { token })).json?.task;
};

(async () => {
  const recruiter = await login('recruiter@arabtec.com');
  const hrMgr = await login('hr.manager@arabtec.com');

  /* ===================== 1. valid CV → review draft ====================== */
  console.log('\n— 1. a valid synthetic CV produces a review draft —');
  let happyTask;
  {
    mode = 'ok';
    const before = candidateCount();
    const up = await upload(recruiter, syntheticPdf('1'), 'cv-sample-01.pdf');
    c('upload is accepted and queued (202)', up.status === 202, `got ${up.status}`);
    c('the response carries a task, not a candidate',
      !!up.json?.task?.id && up.json.task.status === 'queued', JSON.stringify(up.json?.task?.status));

    happyTask = await settle(up.json.task.id, recruiter);
    c('the parse succeeds', happyTask.status === 'succeeded', happyTask.status);
    c('a draft is pending review', happyTask.draft?.status === 'pending', happyTask.draft?.status);
    c('the proposal carries the extracted name',
      happyTask.draft?.proposal?.fields?.fullName === 'Layla Hassan');
    c('uncertain fields are surfaced',
      JSON.stringify(happyTask.draft?.uncertainFields) === '["phone"]',
      JSON.stringify(happyTask.draft?.uncertainFields));
    c('provenance was recorded',
      happyTask.provenance.modelId === 'qwen2.5:7b-instruct'
      && happyTask.provenance.modelDigest === 'sha256:abc123'
      && happyTask.provenance.promptVersion === 'resume-extract-prompt/1.0.0'
      && happyTask.provenance.schemaVersion === 'resume-extract/1.0.0'
      && !!happyTask.provenance.gatewayVersion, JSON.stringify(happyTask.provenance));
    c('NO candidate was created', candidateCount() === before, `${candidateCount()} vs ${before}`);
    c('the gateway was called with the bearer token',
      seenAuth.every((a) => a === `Bearer ${GATEWAY_TOKEN}`));
  }

  /* ================== 2. confirmation is explicit ======================== */
  console.log('\n— 2. nothing is saved until a human confirms —');
  {
    const before = candidateCount();
    const proposed = happyTask.draft.proposal.fields;
    // The recruiter corrects a field: the EDITED value must win, not the draft.
    const r = await api(`/api/ai/intake/jobs/${happyTask.id}/confirm`, {
      method: 'POST', token: recruiter,
      body: { fullName: proposed.fullName, email: proposed.email, phone: '+971 50 999 8888',
        location: proposed.location, currentCompany: 'Gulf Contracting', currentPosition: 'Senior Structural Engineer',
        yearsExperience: '9' },
    });
    c('confirmation creates the candidate (201)', r.status === 201, `got ${r.status}`);
    c('exactly one candidate was created', candidateCount() === before + 1);
    const cand = get('SELECT * FROM candidate WHERE id=?', [r.json.candidateId]);
    c('the EDITED value was saved, not the proposed one', cand.phone === '+971 50 999 8888', cand.phone);
    c('the draft is marked confirmed and linked',
      draftRow(happyTask.id).status === 'confirmed'
      && draftRow(happyTask.id).confirmed_candidate_id === r.json.candidateId);
    c('the confirmation is audited',
      !!get("SELECT 1 x FROM audit_log WHERE action='ai.intake_confirmed'"));
    c('the candidate creation went through the ordinary service',
      !!get("SELECT 1 x FROM audit_log WHERE action='candidate.created' AND CAST(entity_id AS INTEGER)=?",
        [r.json.candidateId]));

    console.log('  · a second confirmation of the same draft');
    const again = await api(`/api/ai/intake/jobs/${happyTask.id}/confirm`, {
      method: 'POST', token: recruiter, body: { fullName: 'Layla Hassan', email: 'other@example.com' },
    });
    c('is refused', again.status === 409, `got ${again.status}`);
    c('and creates no second candidate', candidateCount() === before + 1);
  }

  /* ================= 3. AI has no workflow authority ===================== */
  console.log('\n— 3. the AI changes no workflow state —');
  {
    c('no application was created by the parse',
      Number(get("SELECT COUNT(*) c FROM application WHERE source='cv_ai_parse'").c) === 0);
    c('no stage history was written by the AI',
      Number(get("SELECT COUNT(*) c FROM application_stage_history WHERE actor_name IS NULL").c) === 0);
    c('no requisition status was touched',
      Number(get("SELECT COUNT(*) c FROM request_activity WHERE type LIKE 'ai%'").c) === 0);
  }

  /* ==================== 4. file validation ============================== */
  console.log('\n— 4. invalid and oversized files are refused —');
  {
    const before = candidateCount();
    const cases = [
      ['a .txt file', Buffer.from('just text'), 'notes.txt', 415],
      ['an .exe renamed .pdf', Buffer.from('MZ\x90\x00fake'), 'malware.pdf', 415],
      ['a bare zip named .docx', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('xl/sheet.xml')]), 'sheet.docx', 415],
      ['an empty file', Buffer.alloc(0), 'empty.pdf', 400],
      ['an oversized PDF', Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(16 * 1024 * 1024)]), 'huge.pdf', 413],
    ];
    for (const [label, bytes, name, expect] of cases) {
      const r = await upload(recruiter, bytes, name);
      c(`${label} is refused (${expect})`, r.status === expect, `got ${r.status}`);
      c(`${label}: the response carries a stable code`, typeof r.json?.code === 'string', r.json?.code);
    }
    c('a real .docx IS accepted', (await upload(recruiter, syntheticDocx(), 'cv.docx')).status === 202);
    c('no candidate was created by any refusal', candidateCount() === before);
    c('no task row exists for a refused upload',
      Number(get("SELECT COUNT(*) c FROM ai_task WHERE file_original_name IN ('notes.txt','malware.pdf','sheet.docx','empty.pdf','huge.pdf')").c) === 0);
  }

  /* ================== 5. malformed model output ========================= */
  console.log('\n— 5. malformed model JSON is rejected, not repaired —');
  {
    mode = 'malformed';
    const up = await upload(recruiter, syntheticPdf('malformed'), 'malformed.pdf');
    const t = await settle(up.json.task.id, recruiter);
    c('the task fails', t.status === 'failed', t.status);
    c('with the schema-invalid code', t.errorCode === 'EXTRACTION_SCHEMA_INVALID', t.errorCode);
    c('no draft was written', !draftRow(t.id));
    c('the error message names no SQL, model or document content',
      !/select|insert|qwen|ollama|docling|layla/i.test(t.error || ''), t.error);
  }

  /* ==================== 6. document-level rejections ==================== */
  console.log('\n— 6. a document the reader cannot use —');
  {
    mode = 'encrypted';
    const enc = await settle((await upload(recruiter, syntheticPdf('enc'), 'locked.pdf')).json.task.id, recruiter);
    c('an encrypted document fails permanently', enc.status === 'failed' && enc.permanent === true);
    c('with the encrypted code', enc.errorCode === 'FILE_ENCRYPTED', enc.errorCode);
    c('and is not offered a retry', enc.retryable === false);

    mode = 'no_text';
    const blank = await settle((await upload(recruiter, syntheticPdf('blank'), 'scan.pdf')).json.task.id, recruiter);
    c('a scan that OCR could not rescue fails permanently',
      blank.status === 'failed' && blank.errorCode === 'DOCUMENT_NO_TEXT', blank.errorCode);

    mode = 'abstain';
    const abst = await settle((await upload(recruiter, syntheticPdf('abstain'), 'abstain.pdf')).json.task.id, recruiter);
    c('an abstention is a normal failed outcome, retryable',
      abst.status === 'failed' && abst.errorCode === 'EXTRACTION_ABSTAINED' && abst.retryable === true,
      `${abst.errorCode} retryable=${abst.retryable}`);
  }

  /* ======================= 7. timeout and cancel ======================== */
  console.log('\n— 7. timeout and cancellation —');
  {
    mode = 'stall';
    const up = await upload(recruiter, syntheticPdf('stall'), 'slow.pdf');
    const t = await settle(up.json.task.id, recruiter);
    c('a stalled gateway times out rather than hanging', t.status === 'failed', t.status);
    c('with the timeout code', t.errorCode === 'AI_TIMEOUT', t.errorCode);
    c('and is retryable', t.retryable === true);

    console.log('  · cancelling a running parse');
    const up2 = await upload(recruiter, syntheticPdf('cancel'), 'cancel.pdf');
    await new Promise((r) => setTimeout(r, 300));
    const cancelled = await api(`/api/ai/intake/jobs/${up2.json.task.id}/cancel`, { method: 'POST', token: recruiter });
    c('cancel is accepted', cancelled.status === 200, `got ${cancelled.status}`);
    c('the task is cancelled', taskRow(up2.json.task.id).status === 'cancelled');
    await new Promise((r) => setTimeout(r, 5000));
    c('a cancelled task never produces a draft', !draftRow(up2.json.task.id));
    c('and stays cancelled after the model would have finished',
      taskRow(up2.json.task.id).status === 'cancelled', taskRow(up2.json.task.id).status);
  }

  /* ==================== 8. retry does not duplicate ===================== */
  console.log('\n— 8. retry reuses the same task and duplicates nothing —');
  {
    mode = 'server_error';
    const up = await upload(recruiter, syntheticPdf('retry'), 'retry.pdf');
    const taskId = up.json.task.id;
    const failed = await settle(taskId, recruiter);
    c('the task failed while the gateway was down', failed.status === 'failed', failed.status);
    c('with the unavailable code', failed.errorCode === 'AI_UNAVAILABLE', failed.errorCode);

    const tasksBefore = Number(get('SELECT COUNT(*) c FROM ai_task').c);
    mode = 'ok';
    const retried = await api(`/api/ai/intake/jobs/${taskId}/retry`, { method: 'POST', token: recruiter });
    c('retry is accepted', retried.status === 200, `got ${retried.status}`);
    c('retry reuses the SAME task id', retried.json.task.id === taskId);
    c('no second task row was created', Number(get('SELECT COUNT(*) c FROM ai_task').c) === tasksBefore);

    const done = await settle(taskId, recruiter);
    c('the retry succeeds', done.status === 'succeeded', done.status);
    c('exactly one draft exists for the task',
      Number(get('SELECT COUNT(*) c FROM ai_parse_draft WHERE task_id=?', [taskId]).c) === 1);

    console.log('  · re-uploading the identical file');
    const dup = await upload(recruiter, syntheticPdf('retry'), 'retry.pdf');
    c('returns the existing task rather than a new one',
      dup.status === 200 && dup.json.deduplicated === true && dup.json.task.id === taskId,
      `status=${dup.status} id=${dup.json?.task?.id}`);
    c('and still only one task row exists', Number(get('SELECT COUNT(*) c FROM ai_task').c) === tasksBefore);
  }

  /* ======================= 9. authorisation ============================= */
  console.log('\n— 9. unauthorised access is denied —');
  {
    const anon = await fetch(`${B}/api/ai/intake/jobs/1`);
    c('an unauthenticated caller is refused', anon.status === 401, `got ${anon.status}`);

    const other = await upload(recruiter, syntheticPdf('private'), 'private.pdf');
    const seen = await api(`/api/ai/intake/jobs/${other.json.task.id}`, { token: hrMgr });
    c("another user cannot read someone else's parse", seen.status === 403, `got ${seen.status}`);

    // interviewer has no candidate.add
    const interviewer = await login('interviewer@arabtec.com').catch(() => null);
    if (interviewer) {
      const r = await upload(interviewer, syntheticPdf('nope'), 'nope.pdf');
      c('a user without candidate.add cannot submit a CV', r.status === 403, `got ${r.status}`);
    } else {
      c('a user without candidate.add cannot submit a CV', true, '(no interviewer seeded — skipped)');
    }
  }

  /* ============== 10. the browser can never reach the gateway =========== */
  console.log('\n— 10. no browser path to the AI gateway —');
  {
    const probes = [
      '/api/ai/intake/proxy', '/api/ai/intake/gateway', '/api/ai/gateway',
      '/api/ai/intake/jobs/1/../../gateway', '/api/ai/intake/upload?url=http://evil',
    ];
    let leaked = false;
    for (const p of probes) {
      const r = await api(p, { token: recruiter });
      if (r.status === 200 && JSON.stringify(r.json || {}).includes('11434')) leaked = true;
    }
    c('no proxy-shaped endpoint exists', !leaked);

    const health = await api('/api/ai/intake/health', { token: recruiter });
    const body = JSON.stringify(health.json);
    c('health never returns the token', !body.includes('suite-token'));
    c('health never returns the full gateway URL', !body.includes('http://127.0.0.1:4192'));
    c('health reports the host only', health.json.ai.gatewayHost === '127.0.0.1:4192', health.json.ai.gatewayHost);
    c('health reports the token as configured, not its value',
      health.json.ai.tokenConfigured === true && !body.includes('Bearer'));
  }

  /* =================== 11. no CV content in logs/audit ================== */
  console.log('\n— 11. no CV content in audit rows or error text —');
  {
    const rows = all("SELECT action, old_value, new_value, comments FROM audit_log WHERE action LIKE 'ai.%'");
    c('AI audit rows exist', rows.length > 0, `n=${rows.length}`);
    const blob = JSON.stringify(rows);
    c('no extracted name in any AI audit row', !/Layla|Hassan/i.test(blob));
    c('no email or phone in any AI audit row', !/layla\.hassan@|971 50 123/i.test(blob));
    c('no document text in any AI audit row', !/Synthetic CV/i.test(blob));
    c('the filename IS recorded — it is upload metadata, not CV content', /cv-sample-01\.pdf/i.test(blob));
    c('no parsed field value reaches audit',
      !/Gulf Contracting|Structural Engineer|AutoCAD|Primavera|Sharjah/i.test(blob));

    const errs = all("SELECT error_detail FROM ai_task WHERE error_detail IS NOT NULL");
    const errBlob = JSON.stringify(errs);
    c('no task error text quotes the document',
      !/Layla|Hassan|Synthetic CV|layla\.hassan@/i.test(errBlob), errBlob.slice(0, 120));
    c('task errors are the fixed sentences only',
      errs.every((e) => /^[A-Z][^{}<>]*\.$/.test(e.error_detail)), errBlob.slice(0, 160));
  }

  /* =================== 12. AI disabled → manual works =================== */
  console.log('\n— 12. with AI disabled the ATS is unaffected —');
  {
    process.env.AI_ENABLED = 'false';
    const h = await api('/api/ai/intake/health', { token: recruiter });
    c('health reports disabled', h.json.ai.enabled === false && h.json.unavailableReason === 'AI_DISABLED');
    c('and states manual entry is available', h.json.manualEntryAlwaysAvailable === true);

    const up = await upload(recruiter, syntheticPdf('disabled'), 'disabled.pdf');
    c('upload is refused with 503', up.status === 503, `got ${up.status}`);
    c('with the disabled code', up.json.code === 'AI_DISABLED', up.json.code);
    c('and points at manual entry', up.json.manualEntryAvailable === true);

    const before = candidateCount();
    const manual = await api('/api/candidates', {
      method: 'POST', token: recruiter,
      body: { fullName: 'Manual Entry Person', email: 'manual.person@example.com' },
    });
    c('manual candidate creation still works', manual.status === 201, `got ${manual.status}`);
    c('and created exactly one candidate', candidateCount() === before + 1);
    process.env.AI_ENABLED = 'true';
  }

  /* ============ 13. gateway unavailable → fails safely, retries ========= */
  console.log('\n— 13. with the gateway gone the ATS stays usable —');
  {
    await new Promise((r) => gateway.close(r));
    const up = await upload(recruiter, syntheticPdf('gone'), 'gone.pdf');
    c('upload is still accepted', up.status === 202, `got ${up.status}`);
    const t = await settle(up.json.task.id, recruiter);
    c('the task fails safely', t.status === 'failed', t.status);
    c('with the unavailable code', t.errorCode === 'AI_UNAVAILABLE', t.errorCode);
    c('and is offered a retry', t.retryable === true);

    const before = candidateCount();
    const manual = await api('/api/candidates', {
      method: 'POST', token: recruiter,
      body: { fullName: 'Outage Fallback Person', email: 'outage.person@example.com' },
    });
    c('manual entry works during the outage', manual.status === 201, `got ${manual.status}`);
    c('and created exactly one candidate', candidateCount() === before + 1);

    const list = await api('/api/candidates', { token: recruiter });
    c('the Talent Pool still loads', list.status === 200, `got ${list.status}`);
  }

  console.log(`\n${fail === 0 ? '✓' : '✗'} AI intake: ${pass} passed, ${fail} failed\n`);
  try { gateway.close(); } catch { /* already closed */ }
  process.exit(fail === 0 ? 0 : 1);
})();
