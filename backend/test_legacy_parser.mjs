import fs from 'node:fs';
import { getWatcherStatus } from './src/lib/cv-watcher.js';

// Since parseCV is not exported, we'll write a quick emulation of it based on cv-watcher.js
function heuristicParse(text, filename) {
  const emailRe = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;
  const yearsRe = /(\d{1,2})\s*\+?\s*(?:years?|yrs?)\s+(?:of\s+)?experience/i;
  const phoneRe = /(?:phone|mobile|mob|tel|cell|whatsapp|contact)\s*[:#]?\s*([+()\d][\d()\s.\-]{6,}\d)/i;

  const email = emailRe.exec(text);
  const years = yearsRe.exec(text);
  const phone = phoneRe.exec(text);

  const stem = filename.replace(/\b(cv|resume|final|updated)\b/gi, ' ').replace(/[_\-.]+/g, ' ');
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

const text = fs.readFileSync('test_cv.txt', 'utf8');
const result = heuristicParse(text, 'test_cv.txt');
console.log(JSON.stringify(result, null, 2));
