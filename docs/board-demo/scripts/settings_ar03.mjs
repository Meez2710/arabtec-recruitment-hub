// AR-03 in the real browser, as system admin: hide Final Recommendation for the
// Technical Interviewer; its default-visible justification must show unticked
// and locked; save, reload, re-check; restore defaults.
import fs from 'node:fs';
import { openChrome } from './cdp.mjs';
const B = 'http://localhost:4400'; const OUT = process.env.OUT;
const tokens = JSON.parse(fs.readFileSync(new URL('./tokens.json', import.meta.url)));
const c = await openChrome(9337); const out = {};
const state = `const box = (l) => document.querySelector('input[aria-label="' + l + '"]');
  const s = (l) => { const b = box(l); return b ? { checked: b.checked, disabled: b.disabled, title: b.title || null } : null; };
  return { finalView: s('Technical Interviewer: view Final Recommendation'),
    justView: [...document.querySelectorAll('input[aria-label^="Technical Interviewer: view "]')].filter(b => /Technical.*Justification/i.test(b.getAttribute('aria-label'))).map(b => ({ label: b.getAttribute('aria-label'), checked: b.checked, disabled: b.disabled, title: b.title || null })),
    saveDisabled: [...document.querySelectorAll('button')].find(b => /Save changes|Saving/.test(b.textContent))?.disabled,
    alert: document.querySelector('[role=alert]')?.textContent || null };`;
try {
  await c.size(1440, 1000); await c.go(B + '/'); await c.ev(`localStorage.setItem('arabtec_token', ${JSON.stringify(tokens.admin)}); return 1;`);
  await c.go(B + '/#assessmentPolicy'); await c.send('Page.reload'); await c.sleep(3500);
  await c.ev(`await until(() => document.querySelector('.assess-pol-table')); return 1;`);
  out.before = await c.ev(state);
  await c.ev(`document.querySelector('input[aria-label="Technical Interviewer: view Final Recommendation"]').click(); await wait(1500); return 1;`);
  out.afterToggleUnsaved = await c.ev(state);
  await c.shot(OUT + '/ar03-settings-hidden-unsaved.png');
  out.saveResp = await c.ev(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save changes').click(); await wait(1500); return document.body.innerText.includes('Assessment permissions saved');`);
  // full page load via the deep link (the app clears the hash after routing)
  await c.go('about:blank'); await c.go(B + '/#assessmentPolicy'); await c.sleep(1500);
  await c.ev(`await until(() => document.querySelector('.assess-pol-table')); return 1;`);
  out.afterReload = await c.ev(state);
  out.serverEffective = await c.ev(`const r = await fetch('/api/assessments/policy', { headers: { Authorization: 'Bearer ' + localStorage.getItem('arabtec_token') } }); const j = await r.json(); const e = j.policy.effective.technical; return { final: e['assessment.finalRecommendation'], just: e['assessment.finalRecommendation.technicalJustification'] };`);
  // restore defaults through the UI
  await c.ev(`window.confirm = () => true; [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Restore defaults').click(); await wait(1500); return 1;`);
  out.afterRestore = await c.ev(state);
} catch (e) { out.error = String(e); } finally { await c.close(); }
console.log(JSON.stringify(out, null, 1));
