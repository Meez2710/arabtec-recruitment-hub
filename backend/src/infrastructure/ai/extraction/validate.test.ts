// Regression coverage for the deterministic validation rules — specifically
// the LABEL_LIMITS widening. A real CV routinely exceeds the original, tighter
// limits without being the run-on-sentence failure those limits exist to catch.

import { describe, expect, it } from 'vitest';
import { crossValidate, validateField } from './validate.js';

const wordCountOf = (value: string): number => value.split(/\s+/).filter(Boolean).length;

describe('validateField — location', () => {
  it('accepts a real multi-part MENA street address', () => {
    // The exact shape that motivated the widening: building number, street,
    // district/square, city, country — 11 words, previously capped at 10.
    const address = '5- Abn El Moataz Street, EL Hegaz Square, Heliopolis, Cairo, Egypt';
    expect(validateField('location', address)).toEqual({ state: 'validated' });
  });

  it('still rejects an address-length wall of text', () => {
    const notAnAddress = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ');
    const result = validateField('location', notAnAddress);
    expect(result.state).toBe('invalid');
  });
});

describe('validateField — labels widened for real names and titles', () => {
  it('accepts a full name with several given/family parts', () => {
    expect(validateField('fullName', 'Ahmed Mohamed Abdel Rahman El-Sayed'))
      .toEqual({ state: 'validated' });
  });

  it('accepts a qualified construction job title', () => {
    expect(validateField('currentPosition', 'Senior Project Manager — Façade & MEP'))
      .toEqual({ state: 'validated' });
  });

  it('still rejects an unsplit sentence in a title field', () => {
    // 15 words — comfortably past the widened 12-word ceiling for a label.
    const sentence = 'Quantity Surveyor working at Pyramid Cost Consultants since early 2021, promoted twice and now leads the team';
    expect(wordCountOf(sentence)).toBeGreaterThan(12);
    expect(validateField('currentPosition', sentence).state).toBe('invalid');
  });
});

describe('crossValidate — independent of LABEL_LIMITS', () => {
  it('still catches an unsplit sentence written into both company and title', () => {
    const text = 'Quantity Surveyor at Pyramid Cost Consultants';
    const conflicts = crossValidate(new Map([
      ['currentCompany', text],
      ['currentPosition', text],
    ]));
    expect(conflicts).toEqual([{
      field: 'currentCompany',
      note: 'the employer and the job title are the same text, so the pair was not separated',
    }]);
  });
});
