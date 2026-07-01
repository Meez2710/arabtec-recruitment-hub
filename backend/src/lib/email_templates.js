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

// 4. Offer sent
export function offerSent({ candidateName, position }) {
  const name = candidateName || 'there';
  return {
    subject: `Your offer from Arabtec${position ? ' — ' + position : ''}`,
    html: shell('We’d like to offer you a role', [
      p(`Dear ${name},`),
      p(`Congratulations — following your interviews, we’re delighted to offer you${position ? ` the <strong>${position}</strong> role` : ' a role'} at Arabtec.`),
      p(`Our recruitment team will share the full offer details with you shortly. Please review them and let us know if you have any questions.`),
      p(`We’re excited about the possibility of you joining us.`),
      p('Kind regards,<br/>Arabtec Recruitment Team'),
    ].join('')),
  };
}

// Simple test email (used by the admin “send test” button).
export function testEmail() {
  return {
    subject: 'Arabtec Recruitment — test email',
    html: shell('Email is working', [
      p('This is a test message from the Arabtec Recruitment Hub.'),
      p('If you received this, the mailbox connection is set up correctly and the system can now send emails to candidates.'),
    ].join('')),
  };
}
