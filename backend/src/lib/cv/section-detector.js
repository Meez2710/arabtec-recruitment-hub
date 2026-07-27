// SectionDetector — normalises the many ways CVs label their blocks into a small
// set of canonical section names, so EntityParser can scope searches instead of
// scanning whole documents.
//
// Works regardless of capitalisation, punctuation, or decoration (===, ---, ▪).

import { HEADING_TERMS } from './dictionaries.js';

// Arabic diacritics + tatweel are decorative; strip them so "الخِبْرَات" matches "الخبرات".
const ARABIC_DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;
// Normalise the Arabic letter variants that CVs use interchangeably.
function foldArabic(s) {
  return String(s)
    .replace(ARABIC_DIACRITICS, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[ؤئ]/g, 'ء');
}

// Latin fold: strip accents so "expérience" matches "experience" and
// "Persönliche" matches "personliche".
function foldLatin(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss').replace(/ẞ/g, 'ss');
}

export function foldHeading(s) {
  return foldArabic(foldLatin(String(s || '').toLowerCase()))
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// term -> canonical section, built once. Longest terms are checked first so
// "work experience" wins over "experience".
const TERM_INDEX = (() => {
  const pairs = [];
  for (const [canonical, terms] of Object.entries(HEADING_TERMS)) {
    for (const t of terms) pairs.push([foldHeading(t), canonical]);
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  return pairs;
})();

/** Strip decoration so "=== WORK EXPERIENCE ===" and "Work Experience:" both match. */
function cleanHeading(line) {
  return String(line || '')
    .replace(/[│|▪●•*_=~#]+/g, ' ')
    .replace(/^[\s\-–—]+|[\s\-–—:.]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function headingFor(line) {
  const raw = cleanHeading(line);
  if (!raw || raw.length > 60) return null;
  const folded = foldHeading(raw);
  if (!folded) return null;
  if (folded.split(' ').length > 5) return null;
  if (/[.!?]$/.test(raw) && raw.split(/\s+/).length > 3) return null;
  for (const [term, canonical] of TERM_INDEX) {
    if (folded === term) return canonical;
  }
  return null;
}

/**
 * @returns {{
 *   order: string[],
 *   sections: Record<string,string>,
 *   sectionLines: Record<string,string[]>,
 *   lines: string[],
 *   headerLines: string[]
 * }}
 * `header` always holds everything before the first recognised heading — where the
 * name and contact block normally sit.
 */
export function detectSections(text) {
  const rawLines = String(text || '').split(/\r?\n/);
  const sectionLines = { header: [] };
  const order = ['header'];
  let current = 'header';

  for (const raw of rawLines) {
    const h = headingFor(raw);
    if (h) {
      current = h;
      if (!sectionLines[current]) { sectionLines[current] = []; order.push(current); }
      continue;                                        // heading itself is dropped
    }
    (sectionLines[current] ||= []).push(raw);
  }

  const sections = {};
  for (const k of Object.keys(sectionLines)) {
    sections[k] = sectionLines[k].join('\n').trim();
    sectionLines[k] = sectionLines[k].map((l) => l.trim()).filter(Boolean);
  }

  return {
    order,
    sections,
    sectionLines,
    lines: rawLines.map((l) => l.trim()).filter(Boolean),
    headerLines: sectionLines.header || [],
  };
}

export function sectionText(detected, name) {
  return (detected && detected.sections && detected.sections[name]) || '';
}
export function sectionLines(detected, name) {
  return (detected && detected.sectionLines && detected.sectionLines[name]) || [];
}
export const CANONICAL_SECTIONS = Object.keys(HEADING_TERMS);
