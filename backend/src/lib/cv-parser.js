// CV Parser — heuristic + optional Claude AI extraction.
// Ported from flask-ats/services/cv_parser.py for the arabtec-recruitment-hub.
//
// Two engines:
//   - heuristic (default, offline): regex rules tuned for MENA candidates.
//   - claude (optional): if ANTHROPIC_API_KEY is set, uses Claude to extract
//     structured JSON. Falls back to heuristic on error.
//
// Returns: { full_name, email, phone, years_experience, role_applied, raw_text, extraction_status }

import fs from 'node:fs';
import path from 'node:path';

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;
const YEARS_RE = /(\d{1,2})\s*\+?\s*(?:years?|yrs?)\s+(?:of\s+)?experience/i;

const NAME_STOP = new Set([
  'curriculum vitae', 'resume', 'cv', 'professional overview', 'profile',
  'summary', 'professional summary', 'contact', 'contacts', 'personal details',
  'personal information', 'objective', 'career objective', 'experience',
  'work experience', 'education', 'skills', 'references', 'portfolio', 'about',
  'about me', 'overview',
]);

const PHONE_LABEL_RE = /(?:phone|mobile|mob|tel|cell|whatsapp|contact)\s*[:#]?\s*([+()\d][\d()\s.\-]{6,}\d)/i;
const PHONE_ANY_RE = /(\+?\d[\d()\s.\-]{7,}\d)/;

// --- Text extraction -------------------------------------------------------------

export function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  try {
    if (ext === '.pdf') {
      return extractPdfText(filePath);
    }
    if (ext === '.docx' || ext === '.doc') {
      return extractDocxText(filePath);
    }
    return fs.readFileSync(filePath, 'utf-8').trim();
  } catch {
    return '';
  }
}

function extractPdfText(filePath) {
  try {
    const { execSync } = require('node:child_process');
    return execSync(`python3 -c "
import sys
try:
    import pdfplumber
    with pdfplumber.open(sys.argv[1]) as pdf:
        text = '\\n'.join((p.extract_text() or '') for p in pdf.pages)
    print(text.strip())
except Exception as e:
    print('', file=sys.stderr)
    sys.exit(0)
" "${filePath}"`, { encoding: 'utf-8', timeout: 15000, maxBuffer: 5 * 1024 * 1024 }).trim();
  } catch {
    return '';
  }
}

function extractDocxText(filePath) {
  try {
    const { execSync } = require('node:child_process');
    return execSync(`python3 -c "
import sys
try:
    from docx import Document
    doc = Document(sys.argv[1])
    text = '\\n'.join(p.text for p in doc.paragraphs)
    print(text.strip())
except Exception:
    sys.exit(0)
" "${filePath}"`, { encoding: 'utf-8', timeout: 10000, maxBuffer: 5 * 1024 * 1024 }).trim();
  } catch {
    return '';
  }
}

// --- Phone extraction (MENA + international) -------------------------------------

function cleanDigits(s) {
  return s.replace(/\D/g, '');
}

export function extractPhone(text) {
  if (!text) return null;
  // Prefer lines explicitly labeled phone/mobile
  for (const m of text.matchAll(new RegExp(PHONE_LABEL_RE.source, 'gi'))) {
    const d = cleanDigits(m[1]);
    if (d.length >= 9 && d.length <= 15) return m[1].trim();
  }
  // Scan all phone-like runs
  for (const m of text.matchAll(new RegExp(PHONE_ANY_RE.source, 'g'))) {
    const raw = m[1];
    const d = cleanDigits(raw);
    if (d.length < 9 || d.length > 15) continue;
    if (d.length <= 8) continue; // skip year ranges
    return raw.trim();
  }
  return null;
}

// --- Name guessing ---------------------------------------------------------------

function looksLikeName(line) {
  const low = line.toLowerCase().trim(' :.-');
  if (NAME_STOP.has(low)) return false;
  if (NAME_STOP.has(low.replace(/[:\-.]/g, '').trim())) return false;
  if (/[0-9@]/.test(line)) return false;
  const words = line.split(/\s+/);
  if (words.length < 2 || words.length > 5) return false;
  const letters = [...line].filter(c => /[a-zA-Z\u0600-\u06FF]/.test(c)).length;
  return letters >= Math.max(4, line.length - words.length - 2);
}

function collapseSpacedCaps(line) {
  if (/^(?:[A-Z]\s+){3,}[A-Z]?\.?$/.test(line.trim())) {
    return line.replace(/\s+/g, '');
  }
  return line;
}

function guessName(text, filename) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    const cand = collapseSpacedCaps(lines[i]);
    if (looksLikeName(cand)) {
      return cand.toUpperCase() === cand ? toTitleCase(cand) : cand;
    }
  }
  // Fallback to filename
  const stem = path.basename(filename, path.extname(filename))
    .replace(/\b(cv|resume|final|updated|revamped)\b/gi, ' ')
    .replace(/[_\-.]+/g, ' ');
  return stem.split(/\s+/).filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ').trim() || 'Unknown Candidate';
}

function toTitleCase(str) {
  return str.replace(/\w\S*/g, txt => txt.charAt(0).toUpperCase() + txt.slice(1).toLowerCase());
}

// --- Heuristic parser ------------------------------------------------------------

export function heuristicParse(text, filename) {
  const email = EMAIL_RE.exec(text);
  const phone = extractPhone(text);
  const years = YEARS_RE.exec(text);
  return {
    full_name: guessName(text, filename || ''),
    email: email ? email[0] : null,
    phone: phone ? phone.replace(/[()\s.\-]/g, '') : null,
    years_experience: years ? parseInt(years[1], 10) : null,
    role_applied: null,
    raw_text: text,
    extraction_status: text ? 'partial' : 'failed',
  };
}

// --- Claude parser (optional) ----------------------------------------------------

export async function claudeParse(text, filename) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey || !text) return heuristicParse(text, filename);

  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });
    const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
    const msg = await client.messages.create({
      model,
      max_tokens: 512,
      system: 'Extract candidate details from this CV. Respond with ONLY a JSON object: {full_name, email, phone, years_experience (integer or null), role_applied}. Phone numbers are Egyptian (MENA region).',
      messages: [{ role: 'user', content: text.slice(0, 12000) }],
    });
    const raw = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON in Claude response');
    const data = JSON.parse(raw.slice(start, end + 1));
    return {
      full_name: data.full_name || guessName(text, filename),
      email: data.email || null,
      phone: data.phone || null,
      years_experience: data.years_experience || null,
      role_applied: data.role_applied || null,
      raw_text: text,
      extraction_status: 'done',
    };
  } catch {
    return heuristicParse(text, filename);
  }
}

// --- Top-level entry -------------------------------------------------------------

export async function parse(filePath) {
  const filename = path.basename(filePath);
  const text = extractText(filePath);
  if ((process.env.ANTHROPIC_API_KEY || '').trim()) {
    return claudeParse(text, filename);
  }
  return heuristicParse(text, filename);
}

// Synchronous wrapper for non-Claude (heuristic-only) parsing, useful when
// async is not available (e.g. in the sync codebase pattern).
export function parseSync(filePath) {
  const filename = path.basename(filePath);
  const text = extractText(filePath);
  return heuristicParse(text, filename);
}
