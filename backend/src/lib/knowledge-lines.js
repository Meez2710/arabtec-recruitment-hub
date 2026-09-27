// Owner-edited knowledge lines (Control Center → Knowledge lines).
//
// Stored as the system setting `knowledge_lines`: plain text, one entry per
// line, `Quote — Author` with an optional third field `— topic`. An empty value
// means "use the bundled list" (frontend/public/knowledge-lines.js). The same
// rules as the bundled list apply, and ui_knowledge_lines_test.mjs guards both:
// a quote of 160 characters or fewer, an attribution, no duplicates.
// app.jsx carries the same parser (parseKnowledgeText) for the live preview.
export const KNOWLEDGE_LINES_KEY = 'knowledge_lines';
export const KNOWLEDGE_MAX_QUOTE = 160;
export const KNOWLEDGE_MAX_LINES = 500;

export function parseKnowledgeLines(text) {
  const lines = []; const errors = [];
  const seen = new Set();
  String(text ?? '').split(/\r?\n/).forEach((raw, i) => {
    const row = raw.trim();
    if (!row) return;
    const parts = row.split(/\s+[—–]\s+/);
    const q = (parts[0] || '').trim();
    const by = (parts[1] || '').trim();
    const t = (parts[2] || '').trim().toLowerCase() || undefined;
    const n = i + 1;
    if (!by) { errors.push(`Line ${n}: add the author after an em dash ( — ).`); return; }
    if (q.length < 3) { errors.push(`Line ${n}: the quote is empty.`); return; }
    if (q.length > KNOWLEDGE_MAX_QUOTE) { errors.push(`Line ${n}: the quote is ${q.length} characters; keep it to ${KNOWLEDGE_MAX_QUOTE}.`); return; }
    const key = q.toLowerCase();
    if (seen.has(key)) { errors.push(`Line ${n}: this quote is already on the list.`); return; }
    seen.add(key);
    lines.push(t ? { q, by, t } : { q, by });
  });
  if (lines.length > KNOWLEDGE_MAX_LINES) errors.push(`Keep the list to ${KNOWLEDGE_MAX_LINES} lines (got ${lines.length}).`);
  return { lines, errors };
}
