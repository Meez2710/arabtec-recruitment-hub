// Before/after layout verification in real WebKit (Safari engine) and Chromium.
// Synthetic data only (throwaway SQLite servers). Usage: node verify.mjs <outDir>
import { webkit, chromium, devices } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2];
const SERVERS = { before: 'http://localhost:4441', after: 'http://localhost:4440' };
const WIDTHS = [320, 390, 640, 1024, 1440];
const PW = process.env.PW;

const profiles = [];
for (const [ename, engine] of [['webkit', webkit], ['chromium', chromium]]) {
  for (const w of WIDTHS) profiles.push({ ename, engine, label: `${w}`, ctx: { viewport: { width: w, height: w <= 640 ? 844 : 900 } } });
}
// Safari on iPhone: WebKit with the iPhone 13 device profile (390x664 CSS, dpr 3, touch, mobile UA).
profiles.push({ ename: 'webkit', engine: webkit, label: 'iphone13', ctx: { ...devices['iPhone 13'] } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(page, base) {
  // Sign-in happens ONCE per server (see SESSIONS); every profile reuses that
  // session, so the app's login rate limiter is never tripped. `.shell` exists
  // only when signed in, so a refused login fails loudly instead of measuring
  // the sign-in page.
  await page.goto(base + '/');
  await page.waitForSelector('.shell', { timeout: 20000 });
  await sleep(800);
}
async function go(page, hash) {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await sleep(1300);
}

// Geometry measured in the page.
const MEASURE = () => {
  const W = document.documentElement.clientWidth;
  const m = document.querySelector('main');
  const clipAnc = (el) => { for (let p = el.parentElement; p; p = p.parentElement) { const ox = getComputedStyle(p).overflowX; if (ox !== 'visible') return p; } return null; };
  const hidden = (el) => { const r = el.getBoundingClientRect(); if (r.right > W + 1 || r.left < -1) return true; const a = clipAnc(el); if (!a) return false; const ar = a.getBoundingClientRect(); return r.right > ar.right + 1 || r.left < ar.left - 1; };
  const head = [...document.querySelectorAll('main .page-head-actions > *')];
  const rows = [...document.querySelectorAll('main table.talent-pool-table tbody tr')];
  const pool = rows.map((tr) => {
    const td = tr.cells[0].getBoundingClientRect();
    const btns = [...tr.querySelectorAll('.pool-id-actions .icon-btn')].map((b) => b.getBoundingClientRect());
    return { clipPx: btns.length ? Math.max(0, Math.round(Math.max(...btns.map((b) => b.right)) - td.right)) : null, x: btns.length ? Math.round(btns[0].left - td.left) : null, n: btns.length };
  });
  return {
    viewport: W,
    mainScrollWidth: m.scrollWidth,
    mainOverflowX: getComputedStyle(m).overflowX,
    headerActions: head.length,
    headerActionsHidden: head.filter(hidden).map((e) => (e.innerText || e.getAttribute('aria-label') || '').trim().slice(0, 24)),
    poolRows: pool.length,
    poolMaxClipPx: pool.length ? Math.max(...pool.map((p) => p.clipPx ?? 0)) : null,
    poolActionXs: [...new Set(pool.map((p) => p.x).filter((x) => x !== null))],
    toolbarControlHeights: [...new Set([...document.querySelectorAll('main .toolbar input:not([type=checkbox]), main .toolbar select')].filter((e) => e.getClientRects().length).map((e) => `${e.tagName.toLowerCase()}${Math.round(e.getBoundingClientRect().height)}`))],
    headerActionHeights: [...new Set(head.filter((e) => e.matches('.btn, .upload-cta, .view-toggle')).map((e) => Math.round(e.getBoundingClientRect().height)))],
    headerActionTops: [...new Set(head.map((e) => Math.round(e.getBoundingClientRect().top)))].length,
  };
};
const MEASURE_DIALOG = () => {
  const d = document.querySelector('[role=dialog]'); if (!d) return { open: false };
  const head = d.querySelector('.modal-head').getBoundingClientRect();
  const close = d.querySelector('[aria-label="Close dialog"]').getBoundingClientRect();
  const hitHead = document.elementFromPoint(head.left + 20, head.top + head.height / 2);
  const hitClose = document.elementFromPoint(close.left + close.width / 2, close.top + close.height / 2);
  const ctl = [...d.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=file]), select')].filter((e) => e.getClientRects().length);
  const hs = (sel) => [...new Set(ctl.filter((e) => e.matches(sel)).map((e) => Math.round(e.getBoundingClientRect().height)))];
  return { open: true, titleVisible: d.contains(hitHead), closeTappable: !!(hitClose && hitClose.closest('[aria-label="Close dialog"]')), inputHeights: hs('input'), selectHeights: hs('select'), host: d.parentElement.parentElement.className || d.parentElement.parentElement.tagName };
};

const SESSIONS = {};
{
  const b = await chromium.launch();
  for (const [phase, base] of Object.entries(SERVERS)) {
    const c = await b.newContext(); const pg = await c.newPage();
    await pg.goto(base + '/');
    await pg.fill('input[type=email]', 'admin@arabtec.com');
    await pg.fill('input[type=password]', PW);
    await pg.keyboard.press('Enter');
    await pg.waitForSelector('.shell', { timeout: 20000 });
    SESSIONS[phase] = await c.storageState();
    await c.close();
  }
  await b.close();
}

const results = [];
for (const p of profiles) {
  const browser = await p.engine.launch();
  for (const [phase, base] of Object.entries(SERVERS)) {
    const ctx = await browser.newContext({ ...p.ctx, storageState: SESSIONS[phase] });
    const page = await ctx.newPage();
    const dir = path.join(OUT, p.ename, phase); fs.mkdirSync(dir, { recursive: true });
    const rec = { engine: p.ename, profile: p.label, phase };
    try {
      await login(page, base);
      // Talent Pool header
      await go(page, 'candidates');
      rec.talentPoolHeader = await page.evaluate(MEASURE);
      await page.screenshot({ path: path.join(dir, `${p.label}-talentpool-header.png`) });
      // Talent Pool table
      const tableBtn = page.locator('main .view-toggle button, main .view-toggle [role=tab]').filter({ hasText: /^Table$/ });
      if (await tableBtn.count()) { await tableBtn.first().click(); await sleep(900); }
      const tbl = page.locator('main table.talent-pool-table');
      if (await tbl.count()) {
        await tbl.first().scrollIntoViewIfNeeded();
        rec.talentPoolTable = await page.evaluate(MEASURE);
        await page.screenshot({ path: path.join(dir, `${p.label}-talentpool-table.png`) });
      }
      // Add manually dialog
      await page.evaluate(() => window.scrollTo(0, 0));
      const add = page.locator('main button', { hasText: 'Add manually' });
      if (await add.count()) {
        await add.first().click(); await sleep(900);
        rec.dialog = await page.evaluate(MEASURE_DIALOG);
        await page.screenshot({ path: path.join(dir, `${p.label}-add-dialog.png`) });
        await page.keyboard.press('Escape'); await sleep(400);
      }
      // Hiring Requests and Interviews headers
      for (const r of ['requests', 'interviews']) {
        await go(page, r);
        rec[r] = await page.evaluate(MEASURE);
        await page.screenshot({ path: path.join(dir, `${p.label}-${r}.png`) });
      }
    } catch (e) { rec.error = String(e).slice(0, 300); }
    results.push(rec);
    await ctx.close();
  }
  await browser.close();
  process.stdout.write(`${p.ename}/${p.label} done\n`);
}
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
console.log('wrote', path.join(OUT, 'results.json'));
