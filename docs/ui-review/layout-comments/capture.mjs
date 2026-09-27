// usage: node capture.mjs <port> <outdir> <backendDir>
import { chromium } from process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs';
const [port, out, bdir] = process.argv.slice(2);
const B = `http://127.0.0.1:${port}`;
const { adminToken } = await import(bdir + '/test-support/admin-session.mjs');
const token = await adminToken(B);
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
const have = await (await fetch(B + '/api/candidates?pageSize=1', { headers: H })).json();
if (!have.total && !(have.candidates || []).length) {
  const people = [['Omar Haddad', 'Quantity Surveyor', 'Dubai'], ['Layla Nasser', 'Site Engineer', 'Riyadh'], ['Youssef Kamal', 'Planning Engineer', 'Cairo'], ['Sara Mansour', 'QA/QC Engineer', 'Abu Dhabi'], ['Hassan Farouk', 'MEP Coordinator', 'Riyadh'], ['Nour Adel', 'Document Controller', 'Cairo']];
  for (const [fullName, currentPosition, location] of people) await fetch(B + '/api/candidates', { method: 'POST', headers: H, body: JSON.stringify({ fullName, currentPosition, location, email: fullName.toLowerCase().replace(' ', '.') + '@example.com', yearsExperience: 8 }) });
}
const fs = await import('node:fs'); fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const shots = [
  ['talent-pool', '#candidates'], ['users', '#users'], ['cv-intake', '#cvIntake'], ['interviews', '#interviews'], ['offers', '#offers'], ['control', '#control'],
];
const metrics = {};
for (const [w, h, dsf, tag] of [[1440, 900, 1, '1440'], [1152, 720, 1.25, '1440-zoom125'], [390, 844, 2, '390'], [640, 450, 2, '1280-zoom200']]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dsf });
  await ctx.addInitScript((t) => localStorage.setItem('arabtec_token', t), token);
  const page = await ctx.newPage();
  for (const [name, hash] of shots) {
    if (tag !== '1440' && !['talent-pool', 'cv-intake', 'users'].includes(name)) continue;
    await page.goto(B + '/' + hash); await page.waitForSelector('.page-head', { timeout: 30000 }).catch(() => {}); await page.waitForTimeout(1500);
    await page.screenshot({ path: `${out}/${name}-${tag}.png` });
    if (name === 'talent-pool') {
      metrics[tag] = await page.evaluate(() => [...document.querySelectorAll('.page-head .btn, .tp-actions .btn, .page-head .seg-tab')].filter((b) => b.offsetParent).map((b) => { const r = b.getBoundingClientRect(); return `${b.textContent.trim().slice(0, 22)}: ${Math.round(r.width)}x${Math.round(r.height)}`; }));
    }
  }
  if (tag === '1440' && process.env.EXTRAS) {
    const clickShot = async (hash, label, name) => {
      await page.goto(B + '/' + hash); await page.waitForSelector('.page-head', { timeout: 30000 }).catch(() => {}); await page.waitForTimeout(1200);
      const b = page.locator('button', { hasText: label }).first();
      if (await b.count()) { await b.click(); await page.waitForTimeout(1200); }
      await page.screenshot({ path: `${out}/${name}-1440.png` });
    };
    await clickShot('#interviews', 'Schedule interview', 'interview-create-modal');
    await clickShot('#offers', 'Create offer', 'offer-create-modal');
    await clickShot('#control', 'Knowledge lines', 'control-knowledge-lines');
    await clickShot('#users', 'Create User', 'user-create-modal');
  }
  await ctx.close();
}
fs.writeFileSync(`${out}/button-metrics.json`, JSON.stringify(metrics, null, 2));
console.log(JSON.stringify(metrics, null, 1));
await browser.close();
