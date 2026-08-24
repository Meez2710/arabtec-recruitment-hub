// Regression coverage for widened evidence matching: a real CV is typed by
// hand, not proofread, so the hallucination gate needs to survive a spelling
// slip or a reformatted phone number without starting to accept invented text.

import { describe, expect, it } from 'vitest';
import { structureOf } from '../document/structure-builder.js';
import { locateDigits, locateValue } from './evidence-locator.js';

const docFrom = (text: string) => structureOf({ text, pages: [text], pageCount: 1 });

describe('locateValue — tolerant of a typed spelling slip', () => {
  it('finds a value even when one word is misspelled by a letter', () => {
    const structure = docFrom('Address: 5- Abn El Moataz Street, EL Hegaz Square\nHeliopolis, Cairo, Egypt');
    // The CV says "Moataz"; the extractor read it as "Moatz" — a single
    // dropped letter, the kind of slip that happens copying a street name.
    const hits = locateValue(structure, '5 Abn El Moatz Street, Heliopolis, Cairo, Egypt', { limit: 1 });
    expect(hits.length).toBeGreaterThan(0);
  });

  it('folds a common abbreviation onto the word it stands for', () => {
    const structure = docFrom('Address: 12 Tahrir St, Downtown, Cairo, Egypt');
    const hits = locateValue(structure, '12 Tahrir Street, Downtown, Cairo, Egypt', { limit: 1 });
    expect(hits.length).toBeGreaterThan(0);
  });

  it('does not match an unrelated short word just because it is short', () => {
    const structure = docFrom('Objective: seeking a role in structural engineering.');
    const hits = locateValue(structure, 'Ain Shams University', { limit: 1 });
    expect(hits).toEqual([]);
  });

  it('still finds a byte-exact value on the strongest tier', () => {
    const structure = docFrom('Ehab Sayed Sobeih');
    const hits = locateValue(structure, 'Ehab Sayed Sobeih', { limit: 1 });
    expect(hits[0]?.match).toBe('exact');
  });
});

describe('locateDigits — tolerant of a merged country/area code', () => {
  it('finds a phone number written with the country code merged into the area code', () => {
    // The real, malformed print: "(+2010) 00098205" — a human typo merging
    // "+20" and "010".
    const structure = docFrom('Contacts: : - (+2010) 00098205 - (+202) 26075919');
    const hits = locateDigits(structure, '201000098205');
    expect(hits.length).toBeGreaterThan(0);
  });

  it('falls back to the last 7 digits when the strict 9-digit tail does not align', () => {
    // Doc has "055-9876543" (stripped: 0559876543). A value whose last 9
    // digits were mis-normalized still shares the last 7 with the real
    // number — long enough to be specific, short enough to survive a
    // reformatting mismatch at the front of the number.
    const structure = docFrom('Phone: 055-9876543');
    const wanted = '129876543'; // last-9 does not appear verbatim; last-7 ("9876543") does.
    expect(structureContains(structure, wanted, 9)).toBe(false);
    const hits = locateDigits(structure, wanted);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('does not match a short, generic digit run against an unrelated number', () => {
    const structure = docFrom('Height: 114 m, Rooms: 510, Area: 7368 sqm');
    const hits = locateDigits(structure, '19995510000');
    expect(hits).toEqual([]);
  });
});

/** Sanity check inside the test itself: confirms the 9-digit tail truly fails. */
const structureContains = (
  structure: ReturnType<typeof docFrom>, digits: string, tailLen: number,
): boolean => structure.blocks.some((b) => b.text.replace(/\D/g, '').includes(digits.slice(-tailLen)));
