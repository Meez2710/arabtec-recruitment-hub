// CV Inbox Folder Watcher — real-time file detection + DeepSeek AI parsing.
//
// Watches a local folder for PDF/DOCX drops, extracts text via pdf-parse/mammoth,
// sends to DeepSeek API for structured extraction, then auto-creates candidates.
//
// Config via env vars:
//   CV_INBOX               — watched folder (default: ../../cv_inbox)
//   CV_WATCH_INTERVAL_MIN  — poll interval in minutes (default: 60, 0 = disabled)
//   DEEPSEEK_API_KEY       — DeepSeek or SiliconFlow API key
//   DEEPSEEK_MODEL         — model name (default: deepseek-chat)
//   DEEPSEEK_BASE_URL      — API base URL (change for SiliconFlow etc.)
//     DeepSeek:    https://api.deepseek.com/v1
//     SiliconFlow: https://api.siliconflow.cn/v1
//
// Controlled by feature flag: feature.folder_watcher

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_INBOX = path.resolve(__dirname, '../../cv_inbox');
const DEFAULT_INTERVAL_MIN = 60;
function apiConfig() {
  const key = process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_API_KEY || '';
  const base = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/$/, '');
  return { key, url: base + '/chat/completions', model: process.env.DEEPSEEK_MODEL || 'deepseek-chat' };
}

let watcherTimer = null;
let lastScanAt = null;
let lastScanResult = null;
let scanCount = 0;

export function getWatcherStatus() {
  const inboxDir = process.env.CV_INBOX || DEFAULT_INBOX;
  const exists = fs.existsSync(inboxDir);
  let fileCount = 0;
  if (exists) {
    try { fileCount = fs.readdirSync(inboxDir).filter(f =>
      ['.pdf','.docx','.doc'].includes(path.extname(f).toLowerCase())).length; } catch {}
  }
  return {
    running: watcherTimer !== null,
    engine: (process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_API_KEY) ? 'ai' : 'heuristic',
    intervalMin: parseInt(process.env.CV_WATCH_INTERVAL_MIN, 10) || DEFAULT_INTERVAL_MIN,
    inboxDir, inboxExists: exists, pendingFiles: fileCount,
    lastScanAt, lastScanResult, scanCount,
  };
}

// Extract text from PDF/DOCX/TXT
async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  try {
    if (ext === '.pdf') {
      const { PDFParse } = require('pdf-parse');
      const buf = new Uint8Array(fs.readFileSync(filePath));
      const p = new PDFParse(buf); await p.load();
      const r = await p.getText();
      return (r.text || '').trim();
    }
    if (ext === '.docx' || ext === '.doc') {
      const mammoth = require('mammoth');
      const r = await mammoth.extractRawText({ path: filePath });
      return (r.value || '').trim();
    }
    return fs.readFileSync(filePath, 'utf-8').trim();
  } catch { return ''; }
}

// DeepSeek API extraction with strict structured prompt
async function deepseekExtract(text) {
  const cfg = apiConfig();
  if (!cfg.key || !text) return null;

  const systemPrompt = `You are an expert ATS data extraction API. Extract the following from the provided resume text. You must return ONLY a valid JSON object matching this exact schema. Do not include markdown formatting or conversational text.

Schema:
{
  "full_name": "string",
  "email": "string",
  "phone": "string (ensure MENA formats like +20, +966, +971 are captured)",
  "years_experience": "number",
  "role_applied": "string"
}`;

  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.key}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text.slice(0, 12000) },
        ],
        temperature: 0,
        max_tokens: 500,
      }),
    });

    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content || '';
    // Extract JSON from response (strip any markdown fences)
    const json = raw.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();
    const start = json.indexOf('{'), end = json.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    return JSON.parse(json.slice(start, end + 1));
  } catch (e) {
    console.error('[watcher] DeepSeek API error:', e.message);
    return null;
  }
}

// Heuristic fallback parser
function heuristicParse(text, filename) {
  const emailRe = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;
  const yearsRe = /(\d{1,2})\s*\+?\s*(?:years?|yrs?)\s+(?:of\s+)?experience/i;
  const phoneRe = /(?:phone|mobile|mob|tel|cell|whatsapp|contact)\s*[:#]?\s*([+()\d][\d()\s.\-]{6,}\d)/i;

  const email = emailRe.exec(text);
  const years = yearsRe.exec(text);
  const phone = phoneRe.exec(text);

  const stem = path.basename(filename, path.extname(filename))
    .replace(/\b(cv|resume|final|updated)\b/gi, ' ').replace(/[_\-.]+/g, ' ');
  const name = stem.split(/\s+/).filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ').trim() || 'Unknown';

  return {
    full_name: name,
    email: email ? email[0] : null,
    phone: phone ? phone[1].replace(/[()\s.\-]/g, '') : null,
    years_experience: years ? parseInt(years[1], 10) : null,
    role_applied: null,
    extraction_status: text ? 'partial' : 'failed',
    engine: 'heuristic',
  };
}

// Parse a single CV file — DeepSeek first, fallback to heuristic
async function parseCV(filePath) {
  const filename = path.basename(filePath);
  const text = await extractText(filePath);
  if (!text) return { ...heuristicParse('', filename), extraction_status: 'failed' };

  if (process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_API_KEY) {
    const ai = await deepseekExtract(text);
    if (ai && ai.full_name) {
      return {
        full_name: ai.full_name,
        email: ai.email || null,
        phone: ai.phone || null,
        years_experience: typeof ai.years_experience === 'number' ? ai.years_experience : null,
        role_applied: ai.role_applied || null,
        extraction_status: 'done',
        engine: 'deepseek',
      };
    }
  }
  return heuristicParse(text, filename);
}

export function startWatcher() {
  if (watcherTimer) return;
  const intervalMin = parseInt(process.env.CV_WATCH_INTERVAL_MIN, 10) || DEFAULT_INTERVAL_MIN;
  if (intervalMin <= 0) return;

  const doScan = async () => {
    const inboxDir = process.env.CV_INBOX || DEFAULT_INBOX;
    if (!fs.existsSync(inboxDir)) return;

    try {
      const { Candidates, CandidateDocuments, CandidateActivity } = await import('./models.js');
      const { writeAudit } = await import('./audit.js');

      const files = fs.readdirSync(inboxDir).filter(f =>
        ['.pdf','.docx','.doc'].includes(path.extname(f).toLowerCase()));

      let imported = 0, skipped = 0;
      for (const file of files) {
        const filePath = path.join(inboxDir, file);
        try {
          const parsed = await parseCV(filePath);
          if (parsed.extraction_status === 'failed' || !parsed.full_name) { skipped++; continue; }
          if (parsed.email) {
            const dups = Candidates.findDuplicates({ email: parsed.email });
            if (dups.length) { skipped++; continue; }
          }

          const candidateNo = Candidates.nextNo();
          const created = Candidates.create({
            candidateNo, fullName: parsed.full_name,
            email: parsed.email, phone: parsed.phone,
            yearsExperience: parsed.years_experience,
            source: 'folder_drop',
            ownerRecruiterId: null, createdBy: null,
            resumeName: file, resumePath: filePath,
          });

          CandidateDocuments.add({
            candidateId: created.id, docType: 'cv',
            fileName: file, fileHash: null, uploadedBy: null,
          });

          CandidateActivity.add({
            candidateId: created.id, actorId: null, actorName: 'watcher',
            type: 'candidate_created',
            note: `${candidateNo} (${parsed.engine}: ${file})`,
          });

          try { writeAudit(null, { action: 'candidate.created', entityType: 'candidate',
            entityId: created.id, newValue: { candidateNo, fullName: created.full_name, engine: parsed.engine } }); } catch {}

          imported++;
        } catch { skipped++; }
      }

      lastScanAt = new Date().toISOString();
      lastScanResult = { imported, skipped };
      scanCount++;
      console.log(`[watcher] Scan #${scanCount}: ${imported} imported, ${skipped} skipped`);
    } catch (e) {
      console.error('[watcher] Scan error:', e.message);
    }
  };

  doScan();
  watcherTimer = setInterval(doScan, intervalMin * 60 * 1000);
  watcherTimer.unref?.();
}

export function stopWatcher() {
  if (watcherTimer) { clearInterval(watcherTimer); watcherTimer = null; }
}
