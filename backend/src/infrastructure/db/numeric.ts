// numeric(14,2) <-> number.
//
// THIS FILE EXISTS BECAUSE OF A SPECIFIC BUG (Step 3, risk R2).
//
// `node-postgres` returns PostgreSQL `numeric` as a STRING, deliberately — the
// type is arbitrary-precision and JavaScript's number is not, so the driver
// refuses to lose precision silently on your behalf. Drizzle passes that string
// straight through.
//
// `CompensationLine.amount` is `number`. Without an explicit conversion the
// values typecheck (TypeScript believes drizzle's declared type) and then
// `totalNet` computes `"12500.00" + "3000.00"` = `"12500.003000.00"`. Every
// offer letter in the system would carry a nonsense figure and nothing would
// throw.
//
// Money stays `numeric` in storage — it is exact and float is not. The
// conversion is here, in one place, tested.

/** Largest value representable exactly. numeric(14,2) can exceed it; we refuse to guess. */
const MAX_SAFE_MINOR_UNITS = Number.MAX_SAFE_INTEGER;

export class MoneyPrecisionError extends Error {
  constructor(raw: string) {
    super(`Monetary value ${raw} cannot be represented exactly as a JavaScript number.`);
    this.name = 'MoneyPrecisionError';
  }
}

/**
 * Storage -> domain.
 *
 * Throws rather than rounding. A silently rounded salary is worse than a failed
 * read: the read can be fixed, a wrong number on a signed offer letter cannot.
 */
export const toNumber = (raw: string | number | null): number => {
  if (raw === null) return 0;
  if (typeof raw === 'number') return raw;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new MoneyPrecisionError(raw);

  // numeric(14,2) has at most 2 decimals, so scaling by 100 gives an integer.
  // If that integer is beyond exact representation the value cannot round-trip.
  const minorUnits = Math.round(parsed * 100);
  if (Math.abs(minorUnits) > MAX_SAFE_MINOR_UNITS) throw new MoneyPrecisionError(raw);

  return parsed;
};

/**
 * Domain -> storage.
 *
 * Always emits exactly 2 decimals so the stored text is canonical and a
 * round-trip is byte-stable. `toFixed` is safe here: the value has already been
 * validated as within exact range on the way in, and the aggregate rejects
 * non-finite amounts.
 */
export const toNumericString = (value: number): string => {
  if (!Number.isFinite(value)) throw new MoneyPrecisionError(String(value));
  return value.toFixed(2);
};
