// READ-ONLY aggregate dry run for the CV-viewer fix (8b148cd). Prints counts only.
// Mirrors lib/candidate-cv.js: resume_path wins; else a cv document row of the
// candidate, bytes from an intake with the same hash linked to THAT candidate;
// another candidate linked to the same hash => ambiguous; none => unlinked.
const { Client } = require('/opt/arabtec-ats/backend/node_modules/pg');
const crypto = require('crypto');
(async () => {
  const ssl = process.env.PG_NO_SSL === 'true' ? false : undefined;
  const c = new Client({ connectionString: process.env.DATABASE_URL, ...(ssl === false ? { ssl: false } : {}) });
  await c.connect();
  await c.query('BEGIN TRANSACTION READ ONLY');
  const one = async (q, p = []) => Number((await c.query(q, p)).rows[0].n);
  const out = {};
  out.candidates = await one('SELECT COUNT(*) n FROM candidate');
  out.withResumePath = await one('SELECT COUNT(*) n FROM candidate WHERE resume_path IS NOT NULL');
  out.resumePathBlobMissing = await one('SELECT COUNT(*) n FROM candidate c WHERE c.resume_path IS NOT NULL AND NOT EXISTS (SELECT 1 FROM file_blob b WHERE b.stored_name=c.resume_path)');
  out.noResumeButCvDoc = await one(`SELECT COUNT(DISTINCT c.id) n FROM candidate c JOIN candidate_document d ON d.candidate_id=c.id AND d.doc_type='cv' WHERE c.resume_path IS NULL`);
  out.noCvAtAll = await one(`SELECT COUNT(*) n FROM candidate c WHERE c.resume_path IS NULL AND NOT EXISTS (SELECT 1 FROM candidate_document d WHERE d.candidate_id=c.id AND d.doc_type='cv')`);
  // Per CV document row of candidates without resume_path.
  const docs = (await c.query(`SELECT d.id, d.candidate_id, d.file_hash FROM candidate_document d JOIN candidate c ON c.id=d.candidate_id
                               WHERE d.doc_type='cv' AND c.resume_path IS NULL`)).rows;
  const st = { rows: docs.length, no_hash: 0, ambiguous: 0, unlinked: 0, resolvable: 0, blobMissing: 0, hashMismatch: 0, bytesVerified: 0 };
  const candResolvable = new Set();
  for (const d of docs) {
    if (!d.file_hash) { st.no_hash++; continue; }
    const ins = (await c.query('SELECT id, stored_name, candidate_id FROM candidate_intake WHERE file_hash=$1 AND stored_name IS NOT NULL ORDER BY id DESC', [d.file_hash])).rows;
    if (ins.some((r) => r.candidate_id != null && Number(r.candidate_id) !== Number(d.candidate_id))) { st.ambiguous++; continue; }
    const mine = ins.filter((r) => Number(r.candidate_id) === Number(d.candidate_id));
    if (!mine.length) { st.unlinked++; continue; }
    st.resolvable++;
    const b = (await c.query('SELECT data FROM file_blob WHERE stored_name=$1', [mine[0].stored_name])).rows[0];
    if (!b) { st.blobMissing++; continue; }
    if (crypto.createHash('sha256').update(b.data).digest('hex') !== d.file_hash) { st.hashMismatch++; continue; }
    st.bytesVerified++; candResolvable.add(Number(d.candidate_id));
  }
  out.cvDocRows = st;
  out.candidatesThatWillShowACv = candResolvable.size;
  await c.query('ROLLBACK');
  await c.end();
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.error('DRY-RUN ERROR:', e.code || '', String(e.message).replace(/postgres(ql)?:\/\/\S+/g, '[redacted]')); process.exit(1); });
