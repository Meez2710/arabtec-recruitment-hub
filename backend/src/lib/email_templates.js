// Branded email templates (C2.2). Plain, table-based HTML that renders reliably
// in Outlook/Gmail/mobile. Every template returns { subject, html }.
// Keep copy simple and professional; the brand accent is Arabtec red (#d2232a).

const BRAND = '#d2232a';
const INK = '#1a1a1a';
const MUT = '#5b6166';

function shell(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f6f3ec;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f3ec;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:10px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">
        <tr><td style="background:${INK};padding:18px 28px;">
          <span style="color:${BRAND};font-weight:bold;font-size:16px;letter-spacing:.5px;">ARABTEC</span>
          <span style="color:#ffffff;font-size:16px;"> &nbsp;Recruitment</span>
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
export function offerLetterHtml({ candidateName, position, salary, allowances, offerDate, offerNo }) {
  const name = candidateName || '—';
  const pos = position || '—';
  const date = offerDate || new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const ref = offerNo || `HR/ATS/${Date.now()}`;
  const basicSalary = salary ? Number(salary).toLocaleString() : '—';
  const allowanceAmount = allowances ? Number(allowances).toLocaleString() : '—';
  const total = (salary || 0) + (allowances || 0);
  const totalFormatted = Number(total).toLocaleString();

  return `<!doctype html><html dir="ltr"><head><meta charset="UTF-8">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Times New Roman',Georgia,serif;color:#1a1a1a;max-width:700px;margin:0 auto;padding:40px 50px}
  .letterhead{border-bottom:3px solid #d2232a;padding-bottom:16px;margin-bottom:28px}
  .logo{font-size:22px;font-weight:700;color:#1a1a1a}.logo span{color:#d2232a}
  .ref{font-size:11px;color:#666;margin-top:4px}
  h1{font-size:20px;font-weight:400;margin:24px 0 20px;letter-spacing:.3px}
  p{font-size:14px;line-height:1.8;margin-bottom:12px}
  .comp-table{width:100%;border:1px solid #ddd;border-collapse:collapse;margin:20px 0;font-size:14px}
  .comp-table td{padding:10px 14px;border-bottom:1px solid #eee}
  .comp-table .label{color:#555;width:200px}
  .comp-table .value{font-weight:700}
  .comp-table .total-row td{font-size:15px;padding:12px 14px}
  .comp-table .total-row .value{color:#d2232a}
  .sign-section{margin-top:50px}
  .sign-line{display:inline-block;width:220px;border-top:1px solid #999;margin-top:40px;padding-top:6px;font-size:12px;color:#666}
  .footer{margin-top:60px;font-size:11px;color:#999;border-top:1px solid #eee;padding-top:16px}
  @media print{body{padding:20px 30px}}
</style></head><body>
<div class="letterhead">
  <div class="logo"><span>Arabtec</span> Construction</div>
  <div class="ref">Ref: ${ref} &nbsp;|&nbsp; Date: ${date}</div>
</div>
<h1>Job Offer Letter</h1>
<p>Dear <strong>${name}</strong>,</p>
<p>Following the successful completion of your interviews and assessments, we are pleased to offer you the position of <strong>${pos}</strong> at Arabtec Construction. This offer is extended based on your qualifications, experience, and the potential contribution you will bring to our organization.</p>
<p>The terms of your employment are as follows:</p>
<table class="comp-table"><tbody>
  <tr><td class="label">Position</td><td class="value">${pos}</td></tr>
  <tr><td class="label">Basic Monthly Salary</td><td class="value">${basicSalary} EGP</td></tr>
  <tr><td class="label">Monthly Allowances</td><td class="value">${allowanceAmount} EGP</td></tr>
  <tr class="total-row"><td class="label"><strong>Total Monthly Package</strong></td><td class="value"><strong>${totalFormatted} EGP</strong></td></tr>
</tbody></table>
<p>This offer is valid for a period of <strong>7 working days</strong> from the date of this letter. The commencement date will be confirmed upon acceptance.</p>
<p>To indicate your acceptance, please sign and return a copy of this letter to the Human Resources Department.</p>
<p>We are confident that you will make a valuable contribution to Arabtec Construction and look forward to welcoming you on board.</p>
<p>Sincerely,</p>
<p style="margin-top:8px;"><strong>Human Resources Department</strong><br>Arabtec Construction</p>
<div class="sign-section">
  <div class="sign-line">Accepted by: ${name}</div>
  <div class="sign-line" style="margin-left:40px;">Date: _______________</div>
</div>
<div class="footer">
  Arabtec Construction &nbsp;|&nbsp; This letter is computer-generated and does not require a physical signature to be valid.
</div>
</body></html>`;
}// Simple test email (used by the admin “send test” button).
export function testEmail() {
  return {
    subject: 'Arabtec Recruitment — test email',
    html: shell('Email is working', [
      p('This is a test message from the Arabtec Recruitment Hub.'),
      p('If you received this, the mailbox connection is set up correctly and the system can now send emails to candidates.'),
    ].join('')),
  };
}
