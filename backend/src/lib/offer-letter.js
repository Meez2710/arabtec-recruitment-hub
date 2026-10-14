// ============================================================================
// Arabtec offer of employment — ONE model, three outputs.
//
// Source of truth for the fixed text and layout: the three signed originals
// supplied by the owner (two-page letters on the Arabtec Egypt for Real Estate
// Development letterhead, July 2026). They are identical except for the fields
// listed in VARIABLE FIELDS below; everything else here is transcribed
// verbatim, including the originals' own spelling ("regularizartion",
// "will:.") — contractual wording is not ours to correct.
// See docs/audits/2026-10-05-workflow/FINDINGS.md (offer template section).
//
// VARIABLE FIELDS (and only these):
//   reference   Re {YY}/HR/DM/MH-ofr/{NNNNN} — YY from the offer year, NNNNN from
//               the offer number; "HR/DM/MH-ofr" is constant in all three
//   date        the document date, DD/MM/YYYY (issue date once sent)
//   addressee   title prefix (Mr./Eng./…) + full name
//   salutation  "Dear {first name},"
//   position    the position title
//   salary      currency, total (net), and the component rows: Basic Salary,
//               Accommodation, Transportation, Others*, Area Allowance* — a row
//               appears only when it has an amount
//   footnotes   "Others*" and "Area Allowance *" lines, each only when its row
//               is present
//   validity    "valid for N days from the document date" — N follows the
//               offer's expiry date; 5 (as in every original) when none is set
//
// letterModel() resolves those values once; letterHtml() and offerEmail()
// only render a model, so the preview, the issued letter and the candidate
// email cannot disagree. Every variable value is HTML-escaped.
// ============================================================================

export const SALARY_COMPONENTS = [
  { key: 'basic', label: 'Basic Salary' },
  { key: 'accommodation', label: 'Accommodation' },
  { key: 'transportation', label: 'Transportation' },
  { key: 'others', label: 'Others', star: 'Others*' },
  { key: 'area_allowance', label: 'Area Allowance', star: 'Area Allowance*' },
];
export const TITLE_PREFIXES = ['Mr.', 'Ms.', 'Mrs.', 'Eng.', 'Dr.'];
export const DEFAULT_VALIDITY_DAYS = 5;
// Owner decision Q-03: probation is fixed at three months (one place to change later).
export const PROBATION_PERIOD = 'Three months.';

const FOOTNOTES = {
  others: 'Others* Includes after duty hours allowance if required',
  area_allowance: 'Area Allowance *  is linked to service outside Cairo, hence, allowance will be stopped if you returned to Cairo',
};

export const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Stored JSON → { basic: 13000, … } with only finite, non-negative numbers. */
export function parseComponents(raw) {
  if (!raw) return null;
  let obj = raw;
  if (typeof raw === 'string') { try { obj = JSON.parse(raw); } catch { return null; } }
  if (!obj || typeof obj !== 'object') return null;
  const out = {};
  for (const { key } of SALARY_COMPONENTS) {
    const n = obj[key];
    if (n === null || n === undefined || n === '') continue;
    const v = Number(n);
    if (Number.isFinite(v) && v >= 0) out[key] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Validate components sent by the form. Returns { value } (null clears them)
 * or { error }. Unknown keys are refused rather than dropped, so a typo in a
 * client cannot silently lose a contractual amount.
 */
export function normaliseComponents(input) {
  if (input === null) return { value: null };
  if (typeof input !== 'object' || Array.isArray(input)) return { error: 'Salary components must be an object of amounts.' };
  const known = new Set(SALARY_COMPONENTS.map((c) => c.key));
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (!known.has(k)) return { error: `Unknown salary component "${k}".` };
    if (v === null || v === undefined || v === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return { error: `${SALARY_COMPONENTS.find((c) => c.key === k).label} must be a number of zero or more.` };
    out[k] = Math.round(n * 100) / 100;
  }
  if (!Object.keys(out).length) return { value: null };
  if (out.basic == null) return { error: 'Basic Salary is required when salary components are entered.' };
  return { value: out };
}

export const componentsTotal = (c) => (c ? Math.round(Object.values(c).reduce((a, b) => a + b, 0) * 100) / 100 : null);

/** OFR-2026-00007 → "26/HR/DM/MH-ofr/00007" (the originals' reference form). */
export function letterReference(offerNo, fallbackDay) {
  const m = /^OFR-(\d{4})-(\d+)$/.exec(String(offerNo || ''));
  const year = m ? m[1] : String(fallbackDay || letterDay()).slice(0, 4);
  const seq = m ? m[2].padStart(5, '0').slice(-5) : '00000';
  return `${year.slice(-2)}/HR/DM/MH-ofr/${seq}`;
}

// Dates on the letter are CAIRO calendar days, whatever the server's clock
// (production runs on UTC: a letter sent at 01:00 in Cairo must carry that
// day's date, not the previous one). Days are handled as calendar values —
// 'YYYY-MM-DD' strings and day counts — never via local-time Date arithmetic,
// which shifts a day east or west of UTC. OFFER_LETTER_TZ overrides the zone.
const LETTER_TZ = process.env.OFFER_LETTER_TZ || 'Africa/Cairo';
/** The calendar day (YYYY-MM-DD) of an instant in the letter's time zone. */
export function letterDay(instant = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: LETTER_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(instant)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
const dayNumber = (day) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(day ?? '')); return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000 : NaN; };
/** day + n days, as YYYY-MM-DD. */
export function addDays(day, n) { return new Date((dayNumber(day) + n) * 86400000).toISOString().slice(0, 10); }
/** Whole calendar days from a to b (both YYYY-MM-DD). */
export const daysBetween = (a, b) => dayNumber(b) - dayNumber(a);
const ddmmyyyy = (day) => { const [y, m, d] = day.split('-'); return `${d}/${m}/${y}`; };

/** Whole days from the document day to the expiry date (null when no expiry). */
export function validityDays(documentDay, expiryDate) {
  if (!expiryDate) return null;
  const n = daysBetween(documentDay, String(expiryDate).slice(0, 10));
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve every variable once.
 * @param offer      offer row (snake_case, as stored)
 * @param candidate  candidate row
 * @param asOf       the document date when the offer is not sent yet (default now)
 */
export function letterModel(offer, candidate, { asOf = new Date() } = {}) {
  const issued = Boolean(offer.sent_at);
  const documentDay = letterDay(issued ? offer.sent_at : asOf);
  const name = (candidate?.full_name || '').trim();
  const first = (offer.salutation_name || '').trim() || name.split(/\s+/)[0] || '';
  const components = parseComponents(offer.salary_components);
  const currency = offer.currency || 'EGP';
  const rows = components
    ? SALARY_COMPONENTS.filter((c) => components[c.key] != null).map((c) => ({ key: c.key, label: c.star || c.label, amount: components[c.key] }))
    : (offer.salary_offered != null ? [{ key: 'basic', label: 'Basic Salary', amount: offer.salary_offered }] : []);
  const total = components ? componentsTotal(components) : (offer.salary_offered ?? null);
  const days = validityDays(documentDay, offer.expiry_date);
  return {
    issued,
    offerNo: offer.offer_no,
    reference: letterReference(offer.offer_no, documentDay),
    date: ddmmyyyy(documentDay),
    documentDay,
    titlePrefix: offer.title_prefix || '',
    fullName: name,
    firstName: first,
    position: offer.position_title || '',
    currency,
    rows,
    total,
    validityDays: days == null ? DEFAULT_VALIDITY_DAYS : days,
    expiryDate: offer.expiry_date || null,
    footnotes: rows.filter((r) => FOOTNOTES[r.key]).map((r) => FOOTNOTES[r.key]),
    // Facts the preview surfaces (screen only) so a reviewer sees a problem
    // before the candidate does. None of them changes the letter's wording.
    warnings: [
      ...(name ? [] : ['The candidate has no name on record.']),
      ...(offer.position_title ? [] : ['No position title is set.']),
      ...(rows.length ? [] : ['No salary is set.']),
      ...(components ? [] : (offer.salary_offered != null ? ['No salary breakdown is entered, so the letter shows the whole amount as Basic Salary.'] : [])),
      ...(days != null && days < 1 ? ['The expiry date is not after the document date.'] : []),
      ...(offer.title_prefix ? [] : ['No title (Mr./Eng./…) is set for the addressee.']),
    ],
  };
}

/**
 * A model for an offer that is still being typed (Create offer, live preview).
 * Nothing is saved; missing values stay empty so letterHtml can show them as
 * fields to fill. The reference number is assigned on save.
 */
export function draftModel(input = {}, candidate = null, { asOf = new Date() } = {}) {
  const n = normaliseComponents(input.salaryComponents === undefined ? null : input.salaryComponents);
  const comps = n.error ? null : n.value;
  const row = {
    offer_no: null, sent_at: null,
    title_prefix: TITLE_PREFIXES.includes(input.titlePrefix) ? input.titlePrefix : '',
    salutation_name: input.salutationName || '',
    position_title: input.positionTitle || '',
    currency: input.currency || 'EGP',
    salary_components: comps ? JSON.stringify(comps) : null,
    salary_offered: comps ? componentsTotal(comps) : null,
    expiry_date: input.expiryDate || null,
  };
  const cand = candidate || (input.candidateName ? { full_name: String(input.candidateName) } : null);
  const m = letterModel(row, cand, { asOf });
  // Every standard row stays visible while typing, so the form reads as a
  // letter with blanks; Others and Area Allowance appear once entered.
  const have = new Set(m.rows.map((r) => r.key));
  const base = SALARY_COMPONENTS.filter((c) => ['basic', 'accommodation', 'transportation'].includes(c.key) || have.has(c.key));
  m.rows = base.map((c) => ({ key: c.key, label: c.star || c.label, amount: comps && comps[c.key] != null ? comps[c.key] : null }));
  m.reference = null;
  m.draft = true;
  m.warnings = n.error ? [n.error] : [];
  return m;
}

const money = (n) => (n == null || !Number.isFinite(Number(n)) ? '' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const daysText = (n) => `${n} ${n === 1 ? 'day' : 'days'}`;

// The mark from /arabtec-logo.svg, inline so the letter has no external asset.
const MARK = '<svg class="mark" viewBox="0 0 600 396" aria-hidden="true"><g transform="translate(0,396) scale(0.05,-0.05)" fill="#d7262f"><path d="M3798 7844 l-172 -5 -167 -245 c-142 -209 -416 -606 -803 -1164 -101 -146 -358 -519 -1176 -1710 -268 -390 -525 -764 -570 -830 -45 -66 -131 -192 -191 -280 -59 -88 -115 -169 -124 -180 -8 -11 -80 -115 -160 -231 -80 -116 -172 -249 -205 -296 -33 -47 -80 -119 -104 -159 l-44 -74 -1 -1295 -1 -1295 959 0 958 0 117 165 c64 91 148 210 186 266 39 56 178 257 310 447 132 191 253 366 269 389 189 275 361 522 421 603 40 55 280 400 532 766 252 366 600 870 774 1120 173 250 340 490 371 534 30 44 165 239 299 434 l244 355 0 1340 0 1340 -775 6 c-426 3 -853 2 -947 -1z"/><path d="M6496 7805 c-34 -137 -4 -2620 33 -2676 21 -32 260 -374 532 -759 271 -385 559 -794 640 -910 81 -115 282 -401 448 -634 344 -484 516 -729 665 -945 171 -247 364 -522 576 -822 378 -534 430 -609 485 -689 30 -44 89 -127 132 -185 l78 -105 923 5 922 5 5 1282 5 1281 -394 579 c-216 318 -430 629 -475 692 -44 62 -207 299 -361 525 -274 404 -535 781 -897 1301 -100 143 -254 367 -342 497 -179 264 -285 419 -519 755 -88 126 -232 336 -321 468 -89 132 -184 269 -210 305 l-49 65 -933 0 c-873 0 -935 -2 -943 -35z"/></g></svg>';
const LOGO = `<div class="logo">${MARK}<div class="wordmark">arabtec</div></div>`;
const FOOTER = `<div class="footer">
    <div class="f-cols">
      <div class="f-addr"><div dir="rtl" lang="ar">صندوق بريد 595, مصر الجديدة, القاهرة. ج.م.ع</div><div>P.O. Box 595, Heliopolis, Cairo, A.R.E.</div></div>
      <div class="f-tel"><div>|&nbsp; Tel (+202)24146760</div><div>|&nbsp; Tel (+202)24146761</div></div>
      <div class="f-web"><div><a href="mailto:info@arabtecegy.com">info@arabtecegy.com</a></div><div><a href="https://www.arabtec-construction.com">www.arabtec-construction.com</a></div></div>
    </div>
    <div class="f-rule"></div>
  </div>`;

/** The two-page letter, A4, as the originals. `screenNotes` adds a screen-only banner. */
export function letterHtml(m, { screenNotes = true, placeholders = false } = {}) {
  // In a draft, an empty variable is drawn as a labelled blank to fill in.
  const v = (value, label) => (value === null || value === undefined || value === ''
    ? (placeholders ? `<span class="ph">${esc(label)}</span>` : '')
    : esc(value));
  const amt = (n, label) => (n == null ? (placeholders ? `<span class="ph">${esc(label)}</span>` : '') : money(n));
  const ref = m.reference ? esc(m.reference) : (placeholders ? `${esc(String(m.documentDay).slice(2, 4))}/HR/DM/MH-ofr/<span class="ph">assigned on save</span>` : '');
  const addressee = `${m.titlePrefix ? esc(m.titlePrefix) : v('', 'Title')} ${v(m.fullName, 'Candidate full name')}`.trim();
  const comps = m.rows.map((r) => `<tr><td class="c-l">${esc(r.label)}</td><td class="c-c">${esc(m.currency)}</td><td class="c-a">${amt(r.amount, 'amount')}</td></tr>`).join('');
  const t = (n, label, body, bold = false) => `<tr><td class="t-n">${n}.</td><td class="t-l${bold ? ' b' : ''}">${label}</td><td class="t-b">${body}</td></tr>`;
  const banner = m.draft ? '' : screenNotes ? `<div class="screen-only banner">
    <strong>${m.issued ? `Issued letter — ${esc(m.offerNo)}` : `Preview — ${esc(m.offerNo)} is not issued yet`}</strong>
    ${m.issued ? '' : '<span>The date shown is today; the issued letter carries the date it is sent.</span>'}
    ${m.warnings.length ? `<ul>${m.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    <button type="button" onclick="window.print()">Print / save as PDF</button>
  </div>` : '';
  return `<!doctype html><html lang="en" dir="ltr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Job Offer — ${esc(m.fullName || m.offerNo || 'draft')}</title>
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #e9ebee; font-family: 'Times New Roman', Times, serif; color: #111; font-size: 10.5pt; line-height: 1.32; }
  .page { position: relative; width: 210mm; height: 297mm; margin: 8mm auto; background: #fff; padding: 22mm 18mm 0 17mm; display: flex; flex-direction: column; overflow: hidden; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; }
  .logo { width: 30mm; }
  .mark { display: block; width: 25mm; height: auto; margin-left: 1mm; }
  .wordmark { font-family: 'Gill Sans', 'Gill Sans MT', Calibri, 'Segoe UI', Arial, sans-serif; font-size: 19pt; color: #555; letter-spacing: .3px; line-height: 1; margin-top: -1mm; }
  .entity { text-align: right; padding-top: 7mm; }
  .entity .ar { font-family: 'Traditional Arabic', 'Geeza Pro', 'Arial', sans-serif; font-size: 13pt; }
  .entity .en { font-size: 10.5pt; }
  .meta { font-size: 9pt; margin-top: 1mm; }
  .addressee { font-weight: bold; font-size: 11pt; margin-top: 15mm; }
  .p { margin-top: 4.5mm; }
  table { border-collapse: collapse; }
  .terms { width: 100%; margin-top: 4mm; }
  .terms td { vertical-align: top; padding: 1.2mm 0; }
  .t-n { width: 5mm; }
  .t-l { width: 50mm; }
  .t-l.b { font-weight: bold; font-size: 11pt; }
  .pos { padding-left: 6mm; font-size: 11pt; }
  .total { font-weight: bold; font-size: 11pt; padding-left: 12mm; }
  .total span { display: inline-block; width: 13mm; }
  .comp { margin: 1mm 0 0 5mm; }
  .comp td { padding: .2mm 0; }
  .c-l { width: 61mm; }
  .c-c { width: 12mm; }
  .c-a { width: 22mm; text-align: right; }
  .notes { margin-top: 9mm; }
  .notes p + p { margin-top: 1mm; }
  .fnotes { margin-top: 4mm; }
  .pagemark { text-align: right; margin-top: 2mm; font-size: 9.5pt; }
  .grow { flex: 1; }
  .footer { margin: 0 -18mm 0 -17mm; padding: 0 0 9mm; }
  .f-cols { display: flex; gap: 8mm; padding: 0 30mm 3mm 26mm; font-size: 7.5pt; color: #222; }
  .f-cols .f-addr { width: 62mm; } .f-cols .f-addr [dir=rtl] { text-align: right; font-size: 9pt; }
  .f-cols .f-tel { width: 38mm; } .f-cols a { color: #1f5fbf; }
  .f-rule { height: 1.2mm; background: #d7262f; margin: 0 4mm; }
  .p2 .meta { margin-top: 0; }
  .undertaking { margin-top: 11mm; padding-left: 4mm; font-size: 10pt; text-align: justify; }
  .undertaking h2 { font-size: 10.5pt; font-weight: bold; text-decoration: underline; margin-bottom: 2mm; }
  .undertaking .u { margin-top: 4mm; } .undertaking .u:first-of-type { margin-top: 0; }
  .undertaking .u::before { content: '\\25AA'; margin-right: 1mm; font-size: 8pt; }
  .undertaking .k { text-decoration: underline; }
  .undertaking .dash { margin-left: 0; }
  .for { margin-top: 8mm; padding-left: 4mm; }
  .sig-line { margin-top: 14mm; width: 38mm; border-top: 1px solid #111; }
  .accepted { font-style: italic; margin: 8mm 0 0 98mm; }
  .accept-block { margin: 6mm 0 0 78mm; }
  .accept-block div { display: flex; align-items: flex-end; margin-top: 3.5mm; }
  .accept-block span { width: 20mm; text-align: right; padding-right: 6mm; }
  .accept-block i { flex: 1; border-bottom: 1px dotted #333; height: 4mm; }
  .ph { display: inline-block; min-width: 18mm; padding: 0 1.5mm; border-bottom: 1px dashed #b07a00; background: #fff6dd; color: #8a5a00; font-family: Arial, sans-serif; font-size: 8pt; font-weight: normal; font-style: normal; line-height: 1.5; }
  .banner { max-width: 210mm; margin: 8mm auto 0; padding: 12px 16px; background: #fff; border: 1px solid #cfd4da; border-radius: 8px; font-family: Arial, sans-serif; font-size: 13px; line-height: 1.5; display: grid; gap: 4px; }
  .banner ul { margin: 4px 0 0 18px; color: #8a5a00; }
  .banner button { justify-self: start; margin-top: 6px; height: 40px; padding: 0 16px; border-radius: 8px; border: 1px solid #1d6b4a; background: #1d6b4a; color: #fff; font: inherit; cursor: pointer; }
  @media print { body { background: #fff; } .page { margin: 0; box-shadow: none; } .screen-only { display: none !important; } }
  @media screen { .page { box-shadow: 0 1px 3px rgba(0,0,0,.18); } }
</style></head><body>
${banner}
<section class="page p1">
  <div class="head">
    <div>${LOGO}<div class="meta">Re ${ref}<br>Date: ${esc(m.date)}</div></div>
    <div class="entity"><div class="ar" dir="rtl" lang="ar">أرابتك مصر للتنمية العقارية ش.م.م</div><div class="en">Arabtec Egypt for Real Estate Development S.A.E.</div></div>
  </div>
  <div class="addressee">${addressee}</div>
  <p class="p">Dear ${v(m.firstName, 'First name')},</p>
  <p class="p">We are pleased to confirm our offer of employment to you on the following terms and conditions:</p>
  <table class="terms">
    ${t(1, 'Position', `<div class="pos">${v(m.position, 'Position')}</div>`, true)}
    ${t(2, 'Total Monthly Salary (Net)', `<div class="total"><span>${esc(m.currency)}</span>${amt(m.total, 'total')}</div>`, true)}
    <tr><td></td><td colspan="2"><table class="comp">${comps}</table></td></tr>
    ${t(3, 'Sponsorship', 'Arabtec Egypt will act as your sponsor in the country of employment. As your employer, we shall be fully responsible for your proper employment and residence documents. However, any fees incurred on authentication and /or verification of your documents, or the regularizartion of your documents as required and requested by the government authorities will be borne by you.')}
    ${t(4, 'Working Hours', 'As per the Labour Law of Egypt.')}
    ${t(5, 'Leave entitlement', 'As per the Labour Law of Egypt.')}
    ${t(6, 'Probation Period', esc(PROBATION_PERIOD))}
    ${t(7, 'Gratuity', 'As per the Labour Law of Egypt.')}
    ${t(8, 'Transferability', "Your service is transferable to any of the Company's locations at any time as the business demands.")}
    ${t(9, 'Laws Applicable', 'The rules of the Labour Act or Guidelines in the country of employment will apply to any matter which is not mentioned in this document.')}
  </table>
  <div class="notes">
    <p>This Offer of Employment is valid for ${daysText(m.validityDays)} from the document date.</p>
    <p>Please note that the above terms and conditions are valid only if all your documents are in accordance with the employment pre-requisites in existing Egypt Labour and Immigration Laws.</p>
  </div>
  ${m.footnotes.length ? `<div class="fnotes">${m.footnotes.map((f) => `<p>${esc(f)}</p>`).join('')}</div>` : ''}
  <div class="pagemark">/Page 1 of 2</div>
  <div class="grow"></div>
  ${FOOTER}
</section>
<section class="page p2">
  <div class="head"><div>${LOGO}<div class="meta">/Page 2 of 2<br>Re ${ref}</div></div></div>
  <div class="undertaking">
    <h2>EMPLOYEE UNDERTAKING</h2>
    <p class="u"><span class="k">CONFIDENTIALITY</span>. You will adhere to the strict Confidentiality Policy of Arabtec Construction- Egypt Branch. Arabtec maintains its intellectual and proprietary rights to all Company information, such as but not limited to trade secrets, I.T. systems/ software, records and data bases, business plans and project drawings, designs and strategies. The information and procedures set down in the Quality Management Systems manual will not be copied, distributed or made accessible to any person/ entity outside the Company. Any proven infraction shall be grounds for suspension or dismissal.</p>
    <p class="u"><span class="k">COMPLIANCE</span>. You will comply with the Company’s rules and regulations as set down in the Quality Management Systems manual.</p>
    <p class="u"><span class="k">TRAINING</span> <span class="k">WAIVER</span>. You are hereby advised that during your tenure with Arabtec, you may be nominated to attend external training courses, the cost of which will be borne by the Company. Should you leave the Company within 12 months of completing the training course (due to resignation or termination), you will reimburse the Company 100% of the course fee. Should you leave the Company after 12 months and within 24 months of completing the course, you will reimburse the Company 50% of the course fee.</p>
    <p class="u"><span class="k">CONFLICT</span> <span class="k">OF</span> <span class="k">INTEREST</span>. As an Employee, you shall be obliged to declare and avoid all possible conflict of interests with that of Arabtec Construction- Egypt Branch. Failure to do so will:.<br>
      <span class="dash">- Make this Agreement null and void.</span><br>
      <span class="dash">- Result in the immediate termination of your employment with the Company.</span><br>
      <span class="dash">- Prompt the Company to initiate legal proceedings against you, applying the relevant laws of the country of employment.</span></p>
    <p class="u">If the above terms and conditions are acceptable to you, please sign and return a copy of this letter to the office of the undersigned.</p>
  </div>
  <p class="for">For Arabtec Egypt For Real Estate Development S.A.E</p>
  <div class="sig-line"></div>
  <div>Human Resources Director</div>
  <p class="accepted">The above terms and conditions are accepted.</p>
  <div class="accept-block">
    <div><span>Signature:</span><i></i></div>
    <div><span>Name:</span><i></i></div>
    <div><span>Date:</span><i></i></div>
  </div>
  <div class="grow"></div>
  ${FOOTER}
</section>
</body></html>`;
}

/**
 * The candidate email: the same model, so every value matches the letter;
 * the full letter rides along as an attachment the candidate can print.
 */
export function offerEmail(m) {
  const addressee = esc([m.titlePrefix, m.fullName].filter(Boolean).join(' '));
  const rows = m.rows.map((r) => `<tr><td style="padding:2px 16px 2px 0;">${esc(r.label)}</td><td style="padding:2px 8px 2px 0;">${esc(m.currency)}</td><td style="padding:2px 0;text-align:right;">${money(r.amount)}</td></tr>`).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><title>Job Offer</title></head>
<body style="margin:0;padding:24px;background:#f4f5f7;font-family:'Times New Roman',Times,serif;color:#111;font-size:15px;line-height:1.45;">
<div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #d9dde2;padding:28px 32px;">
  <p style="margin:0;font-size:13px;">Re ${esc(m.reference)}<br>Date: ${esc(m.date)}</p>
  <p style="margin:20px 0 0;font-weight:bold;">${addressee}</p>
  <p style="margin:14px 0 0;">Dear ${esc(m.firstName)},</p>
  <p style="margin:14px 0 0;">We are pleased to confirm our offer of employment to you on the following terms and conditions:</p>
  <p style="margin:14px 0 0;"><strong>Position:</strong> ${esc(m.position)}</p>
  <p style="margin:8px 0 0;"><strong>Total Monthly Salary (Net):</strong> ${esc(m.currency)} ${money(m.total)}</p>
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 0 16px;font-size:15px;">${rows}</table>
  <p style="margin:14px 0 0;">This Offer of Employment is valid for ${daysText(m.validityDays)} from the document date.</p>
  <p style="margin:6px 0 0;">Please note that the above terms and conditions are valid only if all your documents are in accordance with the employment pre-requisites in existing Egypt Labour and Immigration Laws.</p>
  ${m.footnotes.map((f) => `<p style="margin:6px 0 0;font-size:13px;">${esc(f)}</p>`).join('')}
  <p style="margin:14px 0 0;">The full offer letter, including the Employee Undertaking, is attached. If the above terms and conditions are acceptable to you, please sign and return a copy of this letter to the office of the undersigned.</p>
  <p style="margin:18px 0 0;">For Arabtec Egypt For Real Estate Development S.A.E<br>Human Resources Director</p>
</div></body></html>`;
  return { subject: `Job Offer — ${m.position || 'Arabtec'} — Re ${m.reference}`, html };
}
