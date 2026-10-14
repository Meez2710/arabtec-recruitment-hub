// BOARD DEMO golden path, driven through the real UI with trusted CDP input
// (Input.dispatchMouseEvent / Input.insertText). One stage per run; ids carried
// in gp_state.json. Console errors and HTTP >= 400 responses are recorded.
// Usage: node gp.mjs <stage>   (env: OUT=evidence dir, DEMO_PW, BASE)
import fs from 'node:fs';
import { openChrome } from './cdp.mjs';
const B = process.env.BASE || 'http://localhost:4410';
const OUT = process.env.OUT; const PW = process.env.DEMO_PW;
const STATE = new URL('./gp_state.json', import.meta.url);
const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE)) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
const stage = process.argv[2];
const c = await openChrome(9340 + Math.floor(Math.random() * 50));
const log = { stage, steps: [], consoleErrors: [], httpErrors: [] };
const step = (s, extra) => { log.steps.push(extra ? { s, ...extra } : { s }); console.log('·', s, extra ? JSON.stringify(extra) : ''); };

// --- trusted input helpers ---------------------------------------------------
const center = (sel) => c.ev(`const el = (${sel}); if (!el) return null; el.scrollIntoView({ block: 'center' }); await wait(200);
  const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
async function clickAt(p) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await c.sleep(450);
}
// Find a visible clickable element by its exact (trimmed) text, optionally inside a container selector.
const byText = (text, within = 'document', tags = 'button,a,[role=tab],[role=button],label') =>
  `[...(${within === 'document' ? 'document' : `document.querySelector(${JSON.stringify(within)})`}).querySelectorAll(${JSON.stringify(tags)})].filter(e => e.offsetParent !== null && !e.disabled).find(e => e.textContent.replace(/\\s+/g, ' ').trim() === ${JSON.stringify(text)})`;
async function click(text, within, opts = {}) {
  const deadline = Date.now() + (opts.timeout || 8000); let p = null;
  while (Date.now() < deadline && !(p = await center(byText(text, within, opts.tags)))) await c.sleep(250);
  if (!p) { await dump(`missing "${text}"`); throw new Error(`no clickable "${text}"${within ? ' in ' + within : ''}`); }
  await clickAt(p); step(`click "${text}"`);
}
async function clickSel(sel, label) {
  const p = await center(`document.querySelector(${JSON.stringify(sel)})`);
  if (!p) { await dump(`missing ${sel}`); throw new Error('no element ' + sel); }
  await clickAt(p); step(`click ${label || sel}`);
}
// Focus a field by its visible label (inside .field) and type with real key input.
async function type(label, value, within = 'document') {
  const sel = `[...(${within === 'document' ? 'document' : `document.querySelector(${JSON.stringify(within)})`}).querySelectorAll('.field')].filter(f => f.offsetParent !== null).find(f => (f.querySelector('label')?.textContent || '').replace(/\\s+/g, ' ').trim().replace(/ \\*$/, '') === ${JSON.stringify(label)})?.querySelector('input,textarea')`;
  const p = await center(sel);
  if (!p) { await dump(`missing field "${label}"`); throw new Error('no field ' + label); }
  await clickAt(p);
  await c.ev(`const el = document.activeElement; if (el && 'select' in el) el.select(); return 1;`);
  await c.send('Input.insertText', { text: String(value) });
  step(`type "${label}"`);
}
// Selects need the value set; do it the way React listens (native setter + change).
async function choose(label, matcher, within = 'document') {
  const r = await c.ev(`const f = [...(${within === 'document' ? 'document' : `document.querySelector(${JSON.stringify(within)})`}).querySelectorAll('.field')].filter(f => f.offsetParent !== null).find(f => (f.querySelector('label')?.textContent || '').replace(/\\s+/g, ' ').trim().replace(/ \\*$/, '') === ${JSON.stringify(label)});
    const s = f?.querySelector('select'); if (!s) return null;
    const m = ${JSON.stringify(matcher)}; const o = [...s.options].find(o => o.value && (o.text === m || o.value === m || o.text.includes(m))) || (m === '*first' ? [...s.options].find(o => o.value) : null);
    if (!o) return { options: [...s.options].map(o => o.text) };
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, o.value); s.dispatchEvent(new Event('change', { bubbles: true })); return { chose: o.text };`);
  if (!r || !r.chose) { await dump(`select "${label}"`); throw new Error(`cannot choose ${matcher} in ${label}: ${JSON.stringify(r)}`); }
  await c.sleep(300); step(`choose "${label}" = ${r.chose}`);
}
async function shot(name) { await c.sleep(600); await c.shot(`${OUT}/gp-${name}.png`); step(`screenshot gp-${name}.png`); }
async function dump(why) {
  const d = await c.ev(`return { why: ${JSON.stringify(why)}, h1: document.querySelector('h1')?.textContent, modal: document.querySelector('.modal')?.textContent?.slice(0, 300),
    buttons: [...document.querySelectorAll('button,[role=tab]')].filter(b => b.offsetParent !== null).map(b => b.textContent.trim()).filter(Boolean).slice(0, 80),
    fields: [...document.querySelectorAll('.field label')].filter(l => l.offsetParent !== null).map(l => l.textContent.trim()) };`).catch(() => null);
  log.dump = d; console.log('DUMP', JSON.stringify(d));
}
async function loginUI(email, { screenshot } = {}) {
  await c.go(B + '/'); await c.ev(`localStorage.clear(); return 1;`); await c.go(B + '/');
  if (screenshot) await shot(screenshot);
  await clickSel('input[type=email]', 'email'); await c.send('Input.insertText', { text: email });
  await clickSel('input[type=password]', 'password'); await c.send('Input.insertText', { text: PW });
  await click('Sign in');
  await c.ev(`await until(() => !document.querySelector('input[type=password]') && document.querySelector('h1'), 15000); return 1;`);
  await c.sleep(1200); step(`signed in as ${email}`);
}
const open = async (hash) => { await c.ev(`location.hash = ${JSON.stringify(hash)}; return 1;`); await c.sleep(1800); step(`open #${hash}`); };
const toast = () => c.ev(`return [...document.querySelectorAll('.toast, [role=status]')].map(t => t.textContent.trim()).filter(Boolean).slice(-2);`);
const api = (p) => c.ev(`const r = await fetch(${JSON.stringify(p)}, { headers: { Authorization: 'Bearer ' + localStorage.getItem('arabtec_token') } }); return { status: r.status, json: await r.json().catch(() => null) };`);

// --- error capture -----------------------------------------------------------
await c.send('Log.enable').catch(() => {});
const flush = () => {
  for (const e of c.events.splice(0)) {
    if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') log.consoleErrors.push(e.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300));
    if (e.method === 'Runtime.exceptionThrown') log.consoleErrors.push('EXCEPTION ' + (e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text).slice(0, 300));
    if (e.method === 'Network.responseReceived' && e.params.response.status >= 400) log.httpErrors.push(`${e.params.response.status} ${e.params.response.url.replace(B, '')}`);
  }
};

try {
  await c.size(1440, 900);
  const stages = (await import('./gp_stages.mjs')).default;
  await stages[stage]({ c, st, save, step, click, clickSel, clickAt, center, type, choose, shot, dump, loginUI, open, toast, api, B });
  save(); log.ok = true;
} catch (e) { log.ok = false; log.error = String(e.stack || e).slice(0, 600); try { await c.shot(`${OUT}/gp-FAIL-${stage}.png`); } catch {} }
finally { flush(); await c.close(); }
fs.writeFileSync(`${OUT}/gp-${stage}.json`, JSON.stringify(log, null, 1));
console.log(JSON.stringify({ stage, ok: log.ok, error: log.error, consoleErrors: log.consoleErrors, httpErrors: log.httpErrors }, null, 1));
process.exit(log.ok ? 0 : 1);
