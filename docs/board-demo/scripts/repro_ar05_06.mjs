import { openChrome, tokenFor } from './cdp.mjs';
const B = process.env.BASE || 'http://localhost:4400'; const OUT = process.env.OUT;
const c = await openChrome();
const token = await tokenFor(B, 'interviewer@arabtec.com', process.env.DEMO_PW);
const out = {};
try {
  await c.size(768, 1024); await c.go(B + '/'); await c.ev(`localStorage.setItem('arabtec_token', ${JSON.stringify(token)}); return 1;`);
  await c.go(B + '/#interviews/1'); await c.send('Page.reload'); await c.sleep(3000);
  out.tablet = await c.ev(`(await until(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Open assessment'))).click();
    await until(() => document.querySelector('.assess-doc')); await wait(800);
    const ed = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Edit technical evaluation'); if (ed) { ed.click(); await wait(400); }
    const head = document.querySelector('.assess-drawer .modal-head').getBoundingClientRect();
    const bar = document.querySelector('.mtopbar')?.getBoundingClientRect();
    const closeBtn = document.querySelector('[aria-label="Close assessment"]').getBoundingClientRect();
    const hit = document.elementFromPoint(closeBtn.left + closeBtn.width / 2, closeBtn.top + closeBtn.height / 2);
    const row = [...document.querySelectorAll('.assess-table tbody tr')].find(r => r.querySelector('.assess-seg'));
    const seg = row?.querySelector('.assess-seg')?.getBoundingClientRect(); const notesCell = row?.querySelector('.assess-notes')?.getBoundingClientRect();
    return { headTop: head.top, barBottom: bar ? bar.bottom : null, closeClickable: !!hit && !!hit.closest('[aria-label="Close assessment"]'),
      segRight: seg?.right, notesLeft: notesCell?.left, segOverlapsNotes: !!(seg && notesCell && seg.right > notesCell.left + 1) };`);
  await c.shot(OUT + '/ar05-tablet-768.png');
  // AR-06: unsaved notes across the 900px shell breakpoint.
  await c.size(1280, 900); await c.send('Page.reload'); await c.sleep(3500);
  out.resize = await c.ev(`(await until(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Open assessment'))).click();
    await until(() => document.querySelector('.assess-doc')); await wait(600);
    const sec = [...document.querySelectorAll('.assess-sec')].find(s => s.textContent.startsWith('Technical Assessment'));
    const edit = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Edit technical evaluation'); if (edit) { edit.click(); await wait(300); }
    const ta = sec.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, 'UNSAVED RESIZE PROBE'); ta.dispatchEvent(new Event('input', { bubbles: true })); await wait(300);
    return { typed: sec.querySelector('textarea').value };`);
  await c.size(768, 1024); await c.sleep(1500);
  out.afterResize = await c.ev(`const drawerOpen = !!document.querySelector('.assess-doc');
    let reopened = null;
    if (!drawerOpen) { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Open assessment'); if (b) { b.click(); await until(() => document.querySelector('.assess-doc')); await wait(600); } }
    const sec = [...document.querySelectorAll('.assess-sec')].find(s => s.textContent.startsWith('Technical Assessment'));
    const ta = sec?.querySelector('textarea'); const txt = sec?.querySelector('.assess-notes-text');
    return { drawerStayedOpen: drawerOpen, notesNow: ta ? ta.value : (txt ? txt.textContent : null), restoredNote: !!document.querySelector('[data-restored]') };`);
  // AR-01 in the real UI: the interviewer's Talent Pool and a direct link to an unrelated candidate.
  await c.go(B + '/#candidates'); await c.send('Page.reload'); await c.sleep(3500);
  out.ar01 = await c.ev(`await wait(1500); const body = document.body.innerText;
    const direct = await fetch('/api/candidates/2', { headers: { Authorization: 'Bearer ' + localStorage.getItem('arabtec_token') } });
    return { seesBasma: body.includes('Basma Second'), seesAssigned: body.includes('Ali'), directStatus: direct.status };`);
  await c.shot(OUT + '/ar01-interviewer-talent-pool.png');
  // AR-07: the real popup document (a blob of the preview HTML) must not run script.
  await c.size(1280, 900);
  out.csp = await c.ev(`const r = await fetch('/api/assessments/application/1/preview', { headers: { Authorization: 'Bearer ' + localStorage.getItem('arabtec_token') } });
    const html = await r.text(); const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const f = document.createElement('iframe'); f.src = url; document.body.appendChild(f); await new Promise(res => f.onload = res);
    const d = f.contentDocument; const s = d.createElement('script'); s.textContent = 'window.__canary = 1'; d.body.appendChild(s); await wait(300);
    const blocked = f.contentWindow.__canary !== 1; f.remove();
    return { metaCsp: /<meta http-equiv="Content-Security-Policy"/.test(html), canaryBlocked: blocked };`);
} catch (e) { out.error = e.message; }
console.log(JSON.stringify(out, null, 1));
await c.close();
