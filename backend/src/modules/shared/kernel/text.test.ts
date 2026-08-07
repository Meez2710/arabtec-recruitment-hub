// Text normalization — the failures here are the silent ones.

import { describe, expect, it } from 'vitest';
import {
  comparisonKey, emailMatchKey, normalizeDigits, normalizeEmail,
  normalizePhone, normalizeText,
} from './text.js';

describe('digit normalization', () => {
  it('converts Arabic-Indic digits to ASCII', () => {
    expect(normalizeDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789');
  });

  it('converts Eastern Arabic-Indic (Persian/Urdu) digits to ASCII', () => {
    expect(normalizeDigits('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789');
  });

  it('leaves every non-digit character untouched', () => {
    // Mixed script must survive: only the numerals change.
    expect(normalizeDigits('أحمد ٠١٠٠ Ahmed 0100')).toBe('أحمد 0100 Ahmed 0100');
  });
});

describe('safe text normalization', () => {
  it('strips invisible bidi marks that survive PDF extraction', () => {
    // These render identically and compare unequal — the whole problem.
    const contaminated = '‏Ahmed‎ Hassan‫';
    expect(normalizeText(contaminated)).toBe('Ahmed Hassan');
    expect(contaminated).not.toBe('Ahmed Hassan');
  });

  it('removes the Arabic tatweel, which is decorative elongation', () => {
    expect(normalizeText('مهنــــدس')).toBe('مهندس');
  });

  it('folds non-breaking and exotic spaces into ordinary ones', () => {
    expect(normalizeText('Ahmed Hassan Ali')).toBe('Ahmed Hassan Ali');
  });

  it('collapses runs and trims, but keeps line structure', () => {
    expect(normalizeText('  Ahmed   Hassan  \n   Site   Engineer  '))
      .toBe('Ahmed Hassan\nSite Engineer');
  });

  it('composes to NFC so decomposed and precomposed forms agree', () => {
    expect(normalizeText('José')).toBe(normalizeText('José'));
  });

  it('is idempotent', () => {
    const messy = ' ‏Ahmed ـHassan  ٠١٢ ';
    expect(normalizeText(normalizeText(messy))).toBe(normalizeText(messy));
  });

  it('does not fold letter variants — meaning is preserved', () => {
    // أحمد must NOT become احمد here. That is comparisonKey's job.
    expect(normalizeText('أحمد')).toBe('أحمد');
  });
});

describe('comparison keys', () => {
  it('collides the interchangeable Arabic alef spellings', () => {
    expect(comparisonKey('أحمد')).toBe(comparisonKey('احمد'));
    expect(comparisonKey('إبراهيم')).toBe(comparisonKey('ابراهيم'));
  });

  it('collides teh marbuta and yeh variants', () => {
    expect(comparisonKey('فاطمة')).toBe(comparisonKey('فاطمه'));
    expect(comparisonKey('يحيى')).toBe(comparisonKey('يحيي'));
  });

  it('ignores diacritics', () => {
    expect(comparisonKey('مُحَمَّد')).toBe(comparisonKey('محمد'));
  });

  it('folds Latin accents and case', () => {
    expect(comparisonKey('José García')).toBe(comparisonKey('jose garcia'));
  });

  it('does NOT merge genuinely different names', () => {
    expect(comparisonKey('أحمد حسن')).not.toBe(comparisonKey('أحمد حسين'));
    expect(comparisonKey('Ahmed Hassan')).not.toBe(comparisonKey('Ahmed Hussein'));
  });
});

describe('phone normalization', () => {
  it('makes an Arabic-Indic number matchable — the bug that hides duplicates', () => {
    // Written this way, a candidate is invisible to every digit-based rule.
    const arabic = normalizePhone('٠١٠٠١٢٣٤٥٦٧');
    const latin = normalizePhone('01001234567');
    expect(arabic.matchKey).not.toBeNull();
    expect(arabic.matchKey).toBe(latin.matchKey);
  });

  it('matches the same number across international spellings', () => {
    const keys = ['+20 100 123 4567', '00201001234567', '01001234567', '(010) 0123-4567']
      .map((p) => normalizePhone(p).matchKey);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).not.toBeNull();
  });

  it('preserves the raw value alongside the key', () => {
    const p = normalizePhone('+20 100 123 4567');
    expect(p.raw).toBe('+20 100 123 4567');
    expect(p.digits).toBe('201001234567');
  });

  it('returns a null key when there are too few digits to be a number', () => {
    expect(normalizePhone('12345').matchKey).toBeNull();
    expect(normalizePhone('n/a').matchKey).toBeNull();
  });

  it('does not collide two different numbers', () => {
    expect(normalizePhone('01001234567').matchKey)
      .not.toBe(normalizePhone('01001234568').matchKey);
  });
});

describe('email normalization', () => {
  it('lowercases the domain but preserves local-part case', () => {
    expect(normalizeEmail('Ahmed.Hassan@Example.COM')).toBe('Ahmed.Hassan@example.com');
  });

  it('removes stray whitespace introduced by extraction', () => {
    expect(normalizeEmail(' ahmed @ example.com ')).toBe('ahmed@example.com');
  });

  it('produces a fully lowercased key for duplicate detection only', () => {
    expect(emailMatchKey('Ahmed.Hassan@Example.COM')).toBe('ahmed.hassan@example.com');
  });

  it('leaves a malformed value alone rather than inventing structure', () => {
    expect(normalizeEmail('not-an-email')).toBe('not-an-email');
  });
});
