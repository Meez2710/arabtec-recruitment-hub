// Text normalization — pure, provider-neutral, no I/O.
//
// WHY THIS EXISTS SEPARATELY FROM ANY PARSER
//
// Arabic CVs break several assumptions that Latin-only code makes silently:
//
//   - Arabic-Indic digits (٠١٢٣…) and Eastern Arabic-Indic digits (۰۱۲۳…) are
//     not ASCII digits. A phone number written "٠١٠٠١٢٣٤٥٦٧" matches no
//     [0-9] pattern, so it is invisible to every digit-based rule.
//   - The same name is spelled with interchangeable letters: أحمد / احمد,
//     يحيى / يحيي, فاطمة / فاطمه. Two spellings, one person.
//   - Extracted PDF text carries invisible bidi control marks (RLM/LRM/embedding
//     codes) that survive into stored values and break exact comparison.
//
// TWO KINDS OF NORMALIZATION, DELIBERATELY SEPARATE
//
//   `normalizeText`     — SAFE. Repairs encoding-level damage only: Unicode
//                         composition, invisible marks, whitespace, digits.
//                         Meaning is preserved, so it is safe on values that a
//                         human will read.
//
//   `comparisonKey`     — LOSSY. Folds letter variants and strips diacritics so
//                         two spellings collide. Suitable ONLY for matching,
//                         deduplication and search keys. It is NOT reversible
//                         and must never be stored as a candidate's name: it
//                         would merge people who are genuinely distinct in
//                         print and destroy the spelling the person uses.
//
// Nothing here is applied to a document before interpretation. Raw extracted
// text is preserved for evidence; normalization applies to extracted VALUES.

/* ------------------------------- digits ----------------------------------- */

/** U+0660–U+0669. Used across the Arab world. */
const ARABIC_INDIC_ZERO = 0x0660;
/** U+06F0–U+06F9. Persian/Urdu shaping of the same numerals. */
const EASTERN_ARABIC_INDIC_ZERO = 0x06f0;

/**
 * Convert Arabic-Indic and Eastern Arabic-Indic digits to ASCII.
 *
 * Digits only — every other character is untouched, so this is safe to run on
 * mixed Arabic/English text.
 */
export const normalizeDigits = (input: string): string => {
  let out = '';
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= ARABIC_INDIC_ZERO && code <= ARABIC_INDIC_ZERO + 9) {
      out += String(code - ARABIC_INDIC_ZERO);
    } else if (code >= EASTERN_ARABIC_INDIC_ZERO && code <= EASTERN_ARABIC_INDIC_ZERO + 9) {
      out += String(code - EASTERN_ARABIC_INDIC_ZERO);
    } else {
      out += char;
    }
  }
  return out;
};

/* --------------------------- invisible marks ------------------------------ */

/**
 * Bidi controls, zero-width characters, BOM, and the Arabic tatweel.
 *
 * These are invisible on screen and therefore the hardest class of bug to see:
 * two values look identical and compare unequal.
 */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u0640]/g;

/** Non-breaking and exotic spaces that a naive \s+ collapse would keep. */
const ODD_SPACES = /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/g;

/* ------------------------------ safe path --------------------------------- */

/**
 * Repair encoding-level damage without changing meaning.
 *
 * NFC composition, invisible marks removed, exotic spaces folded to U+0020,
 * runs collapsed, ends trimmed, Arabic-Indic digits converted to ASCII.
 *
 * Idempotent: `normalizeText(normalizeText(x)) === normalizeText(x)`.
 */
export const normalizeText = (input: string): string => normalizeDigits(
  input.normalize('NFC').replace(INVISIBLE, '').replace(ODD_SPACES, ' '),
).replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();

/* ------------------------------ lossy path -------------------------------- */

/** Harakat, tanwin, superscript alef and friends. Decorative in running text. */
const ARABIC_DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g;

/** Fold the Arabic letter variants CVs use interchangeably. */
const foldArabicLetters = (input: string): string => input
  .replace(/[أإآٱ]/g, 'ا') // أ إ آ ٱ → ا
  .replace(/ى/g, 'ي') // ى → ي
  .replace(/ة/g, 'ه') // ة → ه
  .replace(/[ؤئ]/g, 'ء'); // ؤ ئ → ء

/** Strip Latin accents so "Zoë"/"Zoe" and "José"/"Jose" collide. */
const foldLatin = (input: string): string => input
  .normalize('NFD').replace(/[\u0300-\u036F]/g, '')
  .replace(/ß/g, 'ss').replace(/[Øø]/g, 'o').replace(/[Ææ]/g, 'ae');

/**
 * A key for matching, deduplication and search — never for display or storage
 * as a candidate value.
 *
 * Lossy by design. Two distinct spellings of one name produce one key; that is
 * the point, and it is also why the original must be kept alongside it.
 */
export const comparisonKey = (input: string): string => foldArabicLetters(
  foldLatin(normalizeText(input).toLowerCase()).replace(ARABIC_DIACRITICS, ''),
).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/* ------------------------------- phones ----------------------------------- */

export interface NormalizedPhone {
  /** Exactly as extracted, after safe normalization only. Never discard this. */
  readonly raw: string;
  /** Digits only, leading `00` international prefix reduced to none. */
  readonly digits: string;
  /**
   * Last 9 significant digits, or null when there are too few.
   *
   * Nine is the comparison unit because it survives every spelling of the same
   * MENA number — "+20 100 123 4567", "00201001234567" and "01001234567" all
   * reduce to the same key, while remaining long enough not to collide across
   * different people.
   */
  readonly matchKey: string | null;
}

/**
 * Normalize a phone number for storage AND matching.
 *
 * Returns both forms because they answer different questions: `raw` is what the
 * CV said, `matchKey` is what duplicate detection compares. Collapsing them
 * loses the ability to show a recruiter the number as written.
 */
export const normalizePhone = (input: string): NormalizedPhone => {
  const raw = normalizeText(input);
  const digits = raw.replace(/\D/g, '').replace(/^00/, '');
  return {
    raw,
    digits,
    matchKey: digits.length >= 9 ? digits.slice(-9) : null,
  };
};

/* -------------------------------- emails ---------------------------------- */

/**
 * Lowercase the domain; leave the local part's case alone.
 *
 * Domains are case-insensitive by RFC 1035. Local parts are not — lowercasing
 * one is technically a different mailbox, even though most providers treat them
 * alike. Comparison keys may lowercase both; stored values should not.
 */
export const normalizeEmail = (input: string): string => {
  const cleaned = normalizeText(input).replace(/\s+/g, '');
  const at = cleaned.lastIndexOf('@');
  if (at <= 0 || at === cleaned.length - 1) return cleaned;
  return `${cleaned.slice(0, at)}@${cleaned.slice(at + 1).toLowerCase()}`;
};

/** Full-lowercase form for duplicate detection only. */
export const emailMatchKey = (input: string): string => normalizeEmail(input).toLowerCase();
