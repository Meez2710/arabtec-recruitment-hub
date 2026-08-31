// Branded email templates (C2.2). Plain, table-based HTML that renders reliably
// in Outlook/Gmail/mobile. Every template returns { subject, html }.
//
// PALETTE. These values track the approved design system (see
// frontend/public/arabtec-design-system.css) so an email does not look like a
// different product from the app that sent it. Red is the brand rule only;
// green is the one interactive colour. They are literals rather than CSS
// variables because mail clients do not support custom properties.
const BRAND = '#D01827';   // brand rule / critical
const GREEN = '#00664F';   // the single interactive colour
const INK = '#1A1A1A';
const MUT = '#6F6A64';
const CANVAS = '#F4F5F7';
const LINE = '#E4E4E4';

function shell(title, bodyHtml) {
  // The charset declaration is not optional. Without it a mail client guesses,
  // and every non-ASCII character in the product — the em-dashes and middots in
  // this copy, and far more importantly an Arabic candidate or project name —
  // arrives as mojibake. offerLetterHtml already declared one; nothing else did.
  return `<!doctype html><html dir="ltr"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title></head>
  <body style="margin:0;padding:0;background:${CANVAS};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CANVAS};padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;border:1px solid ${LINE};">
        <tr><td style="height:3px;background:${BRAND};font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td style="padding:18px 28px 10px;border-bottom:1px solid ${LINE};">
          <span style="color:${INK};font-weight:bold;font-size:16px;letter-spacing:.5px;">ARABTEC</span>
          <span style="color:${MUT};font-size:16px;"> &nbsp;Recruitment</span>
        </td></tr>
        <tr><td style="padding:28px 28px 8px;">
          <h1 style="margin:0 0 14px;font-size:20px;color:${INK};">${title}</h1>
          ${bodyHtml}
        </td></tr>
        <tr><td style="padding:18px 28px 26px;color:${MUT};font-size:12px;line-height:1.5;">
          This is an automated message from Arabtec Recruitment. Please do not reply directly unless invited to.
        </td></tr>
      </table>
      <div style="color:${MUT};font-size:11px;font-family:Arial,sans-serif;padding-top:12px;">© Arabtec Construction</div>
    </td></tr>
  </table></body></html>`;
}
const p = (t) => `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:${INK};">${t}</p>`;

// ---- Templates ----

// 1. Application received (acknowledgement when a candidate applies)
export function applicationReceived({ candidateName, position }) {
  const name = candidateName || 'there';
  return {
    subject: `We’ve received your application${position ? ' — ' + position : ''}`,
    html: shell('Application received', [
      p(`Dear ${name},`),
      p(`Thank you for applying${position ? ` for the <strong>${position}</strong> role` : ''} at Arabtec. We’ve received your application and our recruitment team will review it.`),
      p(`If your profile matches the requirements, we’ll be in touch about the next steps. We appreciate your interest in joining Arabtec.`),
      p('Kind regards,<br/>Arabtec Recruitment Team'),
    ].join('')),
  };
}

// 2. Rejection (respectful decline — screening or post-interview)
export function rejection({ candidateName, position }) {
  const name = candidateName || 'there';
  return {
    subject: `Update on your application${position ? ' — ' + position : ''}`,
    html: shell('Application update', [
      p(`Dear ${name},`),
      p(`Thank you for your interest${position ? ` in the <strong>${position}</strong> role` : ''} at Arabtec and for the time you invested in your application.`),
      p(`After careful consideration, we won’t be moving forward with your application at this time. This decision doesn’t reflect on your abilities, and we encourage you to apply for future roles that match your experience.`),
      p(`We wish you every success in your career.`),
      p('Kind regards,<br/>Arabtec Recruitment Team'),
    ].join('')),
  };
}

// 3. Interview invitation
export function interviewInvite({ candidateName, position, dateText, mode, locationOrLink }) {
  const name = candidateName || 'there';
  const where = mode === 'online'
    ? `Online${locationOrLink ? ` — join link: <a href="${locationOrLink}" style="color:${BRAND};">${locationOrLink}</a>` : ''}`
    : (locationOrLink || 'Details to follow');
  return {
    subject: `Interview invitation${position ? ' — ' + position : ''}`,
    html: shell('You’re invited to an interview', [
      p(`Dear ${name},`),
      p(`We’re pleased to invite you to an interview${position ? ` for the <strong>${position}</strong> role` : ''} at Arabtec.`),
      `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 14px;font-size:14px;color:${INK};">
        ${dateText ? `<tr><td style="padding:4px 12px 4px 0;color:${MUT};">When</td><td style="padding:4px 0;"><strong>${dateText}</strong></td></tr>` : ''}
        <tr><td style="padding:4px 12px 4px 0;color:${MUT};">Where</td><td style="padding:4px 0;">${where}</td></tr>
      </table>`,
      p(`Please reply to confirm your attendance. If the time doesn’t suit you, let us know and we’ll arrange an alternative.`),
      p('Kind regards,<br/>Arabtec Recruitment Team'),
    ].join('')),
  };
}

// 4. Offer letter — formal job offer with salary breakdown
export function offerSent({ candidateName, position, salary, allowances, offerDate, totalSalary }) {
  const name = candidateName || 'there';
  const pos = position || 'the role';
  const date = offerDate || new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const basicSalary = salary ? Number(salary).toLocaleString() : '—';
  const allowanceAmount = allowances ? Number(allowances).toLocaleString() : '—';
  const total = totalSalary || (salary || 0) + (allowances || 0);
  const totalFormatted = Number(total).toLocaleString();

  return {
    subject: `Job Offer — ${pos} — Arabtec Construction`,
    html: shell('Job Offer Letter', [
      `<p style="margin:0 0 4px;font-size:12px;color:${MUT};">Ref: HR/ATS/OFFER</p>`,
      `<p style="margin:0 0 4px;font-size:12px;color:${MUT};">Date: ${date}</p>`,
      `<div style="margin:20px 0;"></div>`,
      p(`Dear <strong>${name}</strong>,`),
      p(`Following the successful completion of your interviews, we are pleased to offer you the position of <strong>${pos}</strong> at Arabtec Construction.`),
      p(`This offer is subject to the terms and conditions outlined below:`),
      `<div style="background:#f9f9f9;border:1px solid #e7eaee;border-radius:8px;padding:20px;margin:16px 0;">`,
      `<h3 style="margin:0 0 14px;font-size:15px;color:${INK};">Compensation Details</h3>`,
      `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;color:${INK};width:100%;">`,
        `<tr><td style="padding:6px 8px;color:${MUT};width:160px;">Basic Salary</td><td style="padding:6px 8px;font-weight:700;">${basicSalary} EGP</td></tr>`,
        `<tr><td style="padding:6px 8px;color:${MUT};">Allowances</td><td style="padding:6px 8px;font-weight:700;">${allowanceAmount} EGP</td></tr>`,
        `<tr><td colspan="2" style="padding:10px 0 6px;"><hr style="border:none;border-top:1px solid #d5d8dc;margin:0;" /></td></tr>`,
        `<tr><td style="padding:6px 8px;color:${INK};font-size:15px;"><strong>Total Monthly Package</strong></td><td style="padding:6px 8px;font-weight:700;font-size:15px;color:${BRAND};">${totalFormatted} EGP</td></tr>`,
      `</table>`,
      `</div>`,
      p(`This offer is valid for 7 working days from the date of this letter.`),
      p(`To accept this offer, please sign and return a copy of this letter to the HR department.`),
      p(`We look forward to welcoming you to the Arabtec team.`),
      `<p style="margin:20px 0 0;font-size:14px;line-height:1.6;color:${INK};">Sincerely,<br/><strong>Human Resources Department</strong><br/>Arabtec Construction</p>`,
    ].join('')),
  };
}

// 4b. Printable offer letter HTML (for generating PDF via browser print)
export function offerLetterHtml({
  // --- recruiter inputs -----------------------------------------------------
  refNo,                 // e.g. 26/HR/DM/XX-off/0000
  offerDate,             // document date; validity counts from here
  titlePrefix,           // Eng. | Mr. | Ms. | Dr.
  candidateName,         // full name as it should appear
  firstName,             // salutation only; derived from candidateName if absent
  position,
  currency,              // EGP unless the offer says otherwise
  components,            // [{ label, amount, footnote }] — the salary breakdown
  totalNet,              // stated total; recomputed from components when absent
  probationPeriod,       // "Three months" unless negotiated
  validityDays,          // the offer expires this many days after offerDate
  // --- legacy call shape ----------------------------------------------------
  salary, allowances, offerNo,
}) {
  // The letter is Arabtec's own, transcribed from signed originals: the same
  // nine numbered terms in the same order, the same undertaking on page two, the
  // same signature block. Only the values below are variable — everything else
  // is the company's standing wording and must not drift per-recruiter.
  const ref = refNo || offerNo || '—';
  const dt = offerDate ? new Date(offerDate) : new Date();
  const date = isNaN(dt) ? '—' : dt.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const name = candidateName || '—';
  const first = firstName || String(name).split(/\s+/)[0] || '—';
  const prefix = titlePrefix || '';
  const pos = position || '—';
  const cur = currency || 'EGP';
  const days = validityDays == null ? 5 : validityDays;
  const probation = probationPeriod || 'Three months';

  // Older callers passed a flat salary + allowances. Keep them working rather
  // than have the preview break the moment this template gained a breakdown.
  const rows = Array.isArray(components) && components.length
    ? components
    : [
        { label: 'Basic Salary', amount: salary },
        ...(allowances ? [{ label: 'Others', amount: allowances, footnote: true }] : []),
      ].filter((r) => r.amount != null);

  const money = (n) => (n == null || n === '' || isNaN(Number(n))
    ? '—'
    : Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const total = totalNet != null ? totalNet : rows.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
  const anyFootnote = rows.some((r) => r.footnote);

  const componentRows = rows.map((r) => `
      <tr>
        <td class="c-label">${r.label}${r.footnote ? '<sup>*</sup>' : ''}</td>
        <td class="c-cur">${cur}</td>
        <td class="c-amt">${money(r.amount)}</td>
      </tr>`).join('');

  const term = (n, label, body) => `
      <tr>
        <td class="t-no">${n}.</td>
        <td class="t-label">${label}</td>
        <td class="t-body">${body}</td>
      </tr>`;

  return `<!doctype html><html dir="ltr" lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Offer of Employment — ${name}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Times New Roman',Georgia,serif;color:#1a1a1a;font-size:12.5px;line-height:1.55;
       background:#fff;max-width:760px;margin:0 auto;padding:34px 46px}
  .rule{height:3px;background:#d2232a;margin-bottom:6px}
  .head{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;margin-bottom:26px}
  .mark{font-family:Arial,Helvetica,sans-serif;font-size:21px;font-weight:700;color:#d2232a;letter-spacing:-.5px}
  .entity{font-family:Arial,Helvetica,sans-serif;font-size:10.5px;color:#1a1a1a;text-align:right;line-height:1.5}
  .meta{font-size:11.5px;margin-bottom:22px}
  .to{font-weight:700;font-size:13.5px;margin-bottom:14px}
  .lead{margin-bottom:16px}
  table{width:100%;border-collapse:collapse}
  .terms td{vertical-align:top;padding:5px 0}
  .t-no{width:22px}
  .t-label{width:150px;font-weight:700;padding-right:10px}
  .comp{margin:6px 0 4px}
  .comp td{padding:2px 0}
  .c-label{padding-left:0}
  .c-cur{width:52px;text-align:left}
  .c-amt{width:110px;text-align:right;padding-right:40%}
  .total .t-label,.total .t-body{font-weight:700;font-size:13.5px}
  .note{margin-top:18px}
  .foot-note{margin-top:14px;font-size:11.5px}
  .pagemark{margin-top:26px;font-size:11px;font-style:italic}
  .contact{margin-top:22px;padding-top:8px;border-top:1px solid #d9d9d9;
           font-family:Arial,Helvetica,sans-serif;font-size:9.5px;color:#444;
           display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}
  h2{font-family:Arial,Helvetica,sans-serif;font-size:13px;margin:0 0 10px;text-decoration:underline}
  .undertaking li{margin:0 0 10px 16px;list-style:square}
  .sig{margin-top:36px}
  .sig-row{margin-bottom:16px}
  .sig-line{display:inline-block;min-width:280px;border-bottom:1px dotted #555;height:14px}
  .accepted{font-style:italic;margin:22px 0 26px}
  .pagebreak{page-break-before:always;break-before:page}
  @media print{body{padding:16px 22px}.pagebreak{page-break-before:always}}
</style></head><body>

<div class="rule"></div>
<div class="head">
  <div class="mark">arabtec</div>
  <div class="entity">شركة أرابتك مصر للتنمية العقارية ش.م.م<br>Arabtec Egypt for Real Estate Development S.A.E.</div>
</div>

<div class="meta">Re ${ref}<br>Date: ${date}</div>

<div class="to">${prefix ? prefix + ' ' : ''}${name}</div>
<p class="lead">Dear ${first},</p>
<p class="lead">We are pleased to confirm our offer of employment to you on the following terms and conditions:</p>

<table class="terms">
  ${term(1, 'Position', pos)}
  ${term(2, 'Total Monthly Salary (Net)',
    `<strong>${cur} &nbsp;${money(total)}</strong>
     <table class="comp">${componentRows}</table>`)}
  ${term(3, 'Sponsorship',
    'Arabtec Egypt will act as your sponsor in the country of employment. As your employer, we shall be fully '
    + 'responsible for your proper employment and residence documents. However, any fees incurred on '
    + 'authentication and/or verification of your documents, or the regularization of your documents as required '
    + 'and requested by the government authorities will be borne by you.')}
  ${term(4, 'Working Hours', 'As per the Labour Law of Egypt.')}
  ${term(5, 'Leave entitlement', 'As per the Labour Law of Egypt.')}
  ${term(6, 'Probation Period', probation + '.')}
  ${term(7, 'Gratuity', 'As per the Labour Law of Egypt.')}
  ${term(8, 'Transferability', "Your service is transferable to any of the Company's locations at any time as the business demands.")}
  ${term(9, 'Laws Applicable',
    'The rules of the Labour Act or Guidelines in the country of employment will apply to any matter which is '
    + 'not mentioned in this document.')}
</table>

<p class="note">This Offer of Employment is valid for ${days} days from the document date.</p>
<p class="note">Please note that the above terms and conditions are in accordance with the employment pre-requisites in
existing Egypt Labour and Immigration Laws.</p>
${anyFootnote ? '<p class="foot-note">Others* Includes after duty hours allowance if required</p>' : ''}
<p class="pagemark">/Page 1 of 2</p>

<div class="contact">
  <span>ص.ب ٥٩٥ مصر الجديدة، القاهرة، ج.م.ع &nbsp;·&nbsp; P.O. Box 595, Heliopolis, Cairo, A.R.E.</span>
  <span>Tel (+202)24159266 &nbsp;|&nbsp; Fax (+202)24159267</span>
  <span>www.arabtec-construction.com &nbsp;|&nbsp; info@arabtecegy.com</span>
</div>

<div class="pagebreak"></div>
<div class="rule"></div>
<div class="head">
  <div class="mark">arabtec</div>
  <div class="entity">شركة أرابتك مصر للتنمية العقارية ش.م.م<br>Arabtec Egypt for Real Estate Development S.A.E.</div>
</div>
<div class="meta">Re ${ref}<br>/Page 2 of 2</div>

<h2>EMPLOYEE UNDERTAKING</h2>
<ul class="undertaking">
  <li><strong>CONFIDENTIALITY.</strong> You will adhere to the strict Confidentiality Policy of Arabtec
    Construction — Egypt Branch. Arabtec maintains its intellectual and proprietary rights to all Company
    information, such as but not limited to trade secrets, I.T. systems/software, records and data bases,
    business plans and project drawings, designs and strategies. The information and procedures set down in the
    Quality Management Systems manual will not be copied, distributed or made accessible to any person/entity
    outside the Company. Any proven infraction shall be grounds for suspension or dismissal.</li>
  <li><strong>COMPLIANCE.</strong> You will comply with the Company's rules and regulations as set down in the
    Quality Management Systems manual.</li>
  <li><strong>TRAINING WAIVER.</strong> You are hereby advised that during your tenure with Arabtec, you may be
    nominated to attend external training courses, the cost of which will be borne by the Company. Should you
    leave the Company within 12 months of completing the training course (due to resignation or termination),
    you will reimburse the Company 100% of the course fee. Should you leave the Company after 12 months and
    within 24 months of completing the course, you will reimburse the Company 50% of the course fee.</li>
  <li><strong>CONFLICT OF INTEREST.</strong> As an Employee, you shall be obliged to declare and avoid all
    possible conflict of interests with that of Arabtec Construction — Egypt Branch. Failure to do so will:
    <ul style="margin-top:6px">
      <li style="list-style:'- ';margin-left:14px">Make this Agreement null and void.</li>
      <li style="list-style:'- ';margin-left:14px">Result in the immediate termination of your employment with the Company.</li>
      <li style="list-style:'- ';margin-left:14px">Prompt the Company to initiate legal proceedings against you, applying the relevant laws of the country of employment.</li>
    </ul></li>
  <li>If the above terms and conditions are acceptable to you, please sign and return a copy of this letter to
    the office of the undersigned.</li>
</ul>

<p style="margin-top:26px">For Arabtec Egypt For Real Estate Development S.A.E</p>
<p style="margin-top:30px;border-top:1px solid #333;display:inline-block;padding-top:4px;min-width:170px">HR Director</p>

<p class="accepted">The above terms and conditions are accepted.</p>
<div class="sig">
  <div class="sig-row">Signature: <span class="sig-line"></span></div>
  <div class="sig-row">Name: <span class="sig-line"></span></div>
  <div class="sig-row">Date: <span class="sig-line"></span></div>
</div>

<div class="contact">
  <span>ص.ب ٥٩٥ مصر الجديدة، القاهرة، ج.م.ع &nbsp;·&nbsp; P.O. Box 595, Heliopolis, Cairo, A.R.E.</span>
  <span>Tel (+202)24159266 &nbsp;|&nbsp; Fax (+202)24159267</span>
  <span>www.arabtec-construction.com &nbsp;|&nbsp; info@arabtecegy.com</span>
</div>
</body></html>`;
}

export function passwordReset({ fullName, resetUrl, expiresMinutes = 60 }) {
  const name = fullName ? fullName.split(' ')[0] : 'there';
  return {
    subject: 'Reset your Arabtec Recruitment Hub password',
    html: shell('Reset your password', [
      p(`Hi ${name},`),
      p('We received a request to reset the password for your Arabtec Recruitment Hub account.'),
      `<p style="margin:22px 0;">
         <a href="${resetUrl}"
            style="background:${INK};color:#ffffff;text-decoration:none;padding:12px 22px;
                   border-radius:8px;font-size:14px;font-weight:bold;display:inline-block;">
           Choose a new password
         </a>
       </p>`,
      p(`This link expires in <strong>${expiresMinutes} minutes</strong> and can be used only once.`),
      p('If you did not request this, you can safely ignore this email — your password has not changed.'),
      `<p style="margin:18px 0 0;font-size:12px;line-height:1.6;color:${MUT};word-break:break-all;">
         If the button does not work, paste this link into your browser:<br>${resetUrl}
       </p>`,
    ].join('')),
  };
}

export function testEmail() {
  return {
    subject: 'Arabtec Recruitment — test email',
    html: shell('Email is working', [
      p('This is a test message from the Arabtec Recruitment Hub.'),
      p('If you received this, the mailbox connection is set up correctly and the system can now send emails to candidates.'),
    ].join('')),
  };
}

/* ============================================================================
   INTERNAL NOTIFICATIONS — staff, not candidates.
   These carry a request or offer reference and a short "what to do next" line.
   They deliberately do NOT carry salary: an internal alert lands in more inboxes
   than the record itself is visible to, and the app already gates salary behind
   offer.salary_view. Anyone entitled to the figure sees it on the record.
   ========================================================================== */

/** A compact reference block: ticket, role, project. Used by every request mail. */
function refBlock(rows) {
  const cells = rows
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `
      <tr>
        <td style="padding:5px 0;font-size:12px;color:${MUT};width:132px;">${k}</td>
        <td style="padding:5px 0;font-size:13px;color:${INK};font-weight:bold;">${v}</td>
      </tr>`).join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 16px;width:100%;
    background:${CANVAS};border-radius:12px;padding:12px 14px;">${cells}</table>`;
}

/** The one call-to-action button. Green: it is the interactive colour. */
function cta(label, url) {
  if (!url) return '';
  return `<p style="margin:18px 0 4px;">
    <a href="${url}" style="background:${GREEN};color:#ffffff;text-decoration:none;
       padding:12px 22px;border-radius:999px;font-size:14px;font-weight:bold;
       display:inline-block;font-family:Arial,Helvetica,sans-serif;">${label}</a></p>`;
}

export function requestSubmitted({ ticketNo, title, project, headcount, requesterName, appUrl }) {
  return {
    subject: `Approval needed — ${ticketNo} ${title}`,
    html: shell('A hiring request needs your approval', [
      p(`<strong>${requesterName || 'A colleague'}</strong> submitted a hiring request and it is waiting on a decision.`),
      refBlock([['Request', ticketNo], ['Position', title], ['Project', project],
        ['Headcount', headcount], ['Raised by', requesterName]]),
      p('Sourcing cannot start until this is approved.'),
      cta('Review the request', appUrl),
    ].join('')),
  };
}

export function requestApproved({ ticketNo, title, project, headcount, approverName, appUrl }) {
  return {
    subject: `Approved — ${ticketNo} ${title}`,
    html: shell('Hiring request approved', [
      p(`<strong>${ticketNo} — ${title}</strong> has been approved${approverName ? ` by ${approverName}` : ''}. Sourcing can begin.`),
      refBlock([['Request', ticketNo], ['Position', title], ['Project', project], ['Headcount', headcount]]),
      cta('Open the request', appUrl),
    ].join('')),
  };
}

export function requestRejected({ ticketNo, title, project, reason, approverName, appUrl }) {
  return {
    subject: `Not approved — ${ticketNo} ${title}`,
    html: shell('Hiring request not approved', [
      p(`<strong>${ticketNo} — ${title}</strong> was not approved${approverName ? ` by ${approverName}` : ''}.`),
      refBlock([['Request', ticketNo], ['Position', title], ['Project', project]]),
      // The reason is the whole point of this email — never send it without one.
      reason
        ? `<p style="margin:0 0 12px;padding:12px 14px;border-left:3px solid ${BRAND};
             background:#FCEEEF;font-size:14px;line-height:1.6;color:${INK};">
             <strong style="display:block;margin-bottom:4px;">Reason</strong>${reason}</p>`
        : p('No reason was recorded.'),
      p('You can revise the request and submit it again.'),
      cta('Open the request', appUrl),
    ].join('')),
  };
}

export function requestAssigned({ ticketNo, title, project, headcount, targetDate, appUrl }) {
  return {
    subject: `Assigned to you — ${ticketNo} ${title}`,
    html: shell('You are now the recruiter on a request', [
      p(`<strong>${ticketNo} — ${title}</strong> is yours to fill.`),
      refBlock([['Request', ticketNo], ['Position', title], ['Project', project],
        ['Headcount', headcount], ['Target joining', targetDate]]),
      cta('Start sourcing', appUrl),
    ].join('')),
  };
}

/** Hold / resume / cancel / close / reopen all share one shape. */
export function requestStatusChanged({ ticketNo, title, project, statusLabel, reason, actorName, appUrl }) {
  return {
    subject: `${statusLabel} — ${ticketNo} ${title}`,
    html: shell(`Hiring request ${String(statusLabel || '').toLowerCase()}`, [
      p(`<strong>${ticketNo} — ${title}</strong> is now <strong>${statusLabel}</strong>${actorName ? ` (${actorName})` : ''}.`),
      refBlock([['Request', ticketNo], ['Position', title], ['Project', project], ['Status', statusLabel]]),
      reason ? p(`<strong>Reason:</strong> ${reason}`) : '',
      cta('Open the request', appUrl),
    ].join('')),
  };
}

export function offerPendingApproval({ offerNo, candidateName, position, ticketNo, appUrl }) {
  return {
    subject: `Offer approval needed — ${offerNo}`,
    html: shell('An offer needs your approval', [
      p(`An offer is waiting on your decision before it can be sent to the candidate.`),
      refBlock([['Offer', offerNo], ['Candidate', candidateName], ['Position', position], ['Request', ticketNo]]),
      p('Salary and terms are on the offer record, visible to those entitled to see them.'),
      cta('Review the offer', appUrl),
    ].join('')),
  };
}

export function offerApproved({ offerNo, candidateName, position, approverName, appUrl }) {
  return {
    subject: `Offer approved — ${offerNo} ${candidateName}`,
    html: shell('Offer approved', [
      p(`The offer for <strong>${candidateName}</strong> has been approved${approverName ? ` by ${approverName}` : ''} and can now be sent.`),
      refBlock([['Offer', offerNo], ['Candidate', candidateName], ['Position', position]]),
      cta('Send the offer', appUrl),
    ].join('')),
  };
}

/** Accepted / declined. `accepted` drives the wording and the accent. */
export function offerOutcome({ offerNo, candidateName, position, ticketNo, accepted, joiningDate, reason, appUrl }) {
  const good = !!accepted;
  return {
    subject: `${good ? 'Offer accepted' : 'Offer declined'} — ${candidateName}`,
    html: shell(good ? 'Offer accepted' : 'Offer declined', [
      p(good
        ? `<strong>${candidateName}</strong> accepted the offer${position ? ` for ${position}` : ''}.`
        : `<strong>${candidateName}</strong> declined the offer${position ? ` for ${position}` : ''}. The seat is still open.`),
      refBlock([['Offer', offerNo], ['Candidate', candidateName], ['Position', position],
        ['Request', ticketNo], [good ? 'Joining' : 'Reason', good ? joiningDate : reason]]),
      p(good
        ? 'Joining formalities follow. The seat is reserved against the request until the candidate joins.'
        : 'Consider re-opening sourcing or advancing another shortlisted candidate.'),
      cta('Open the request', appUrl),
    ].join('')),
  };
}
