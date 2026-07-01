// Password policy (C1.3). One place that decides what a valid password is, so the
// rule is identical for self-service change, admin reset, and any future flow.
//
// Policy: min length (configurable via system setting password_min_length, default 8),
// and at least three of four character classes (lower, upper, digit, symbol). Rejects
// a small set of obviously-weak passwords. Not a crypto function — just input policy.
const COMMON = new Set([
  'password', 'password1', 'passw0rd', '12345678', '123456789', 'qwerty123',
  'admin123', 'letmein1', 'welcome1', 'arabtec123', 'changeme1',
]);

export function validatePassword(pw, { minLength = 8 } = {}) {
  const s = String(pw || '');
  if (s.length < minLength) return { ok: false, error: `Password must be at least ${minLength} characters.` };
  if (s.length > 200) return { ok: false, error: 'Password is too long.' };
  if (COMMON.has(s.toLowerCase())) return { ok: false, error: 'That password is too common. Choose something less guessable.' };
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].reduce((n, re) => n + (re.test(s) ? 1 : 0), 0);
  if (classes < 3) {
    return { ok: false, error: 'Password must include at least three of: lowercase, uppercase, number, symbol.' };
  }
  return { ok: true };
}
