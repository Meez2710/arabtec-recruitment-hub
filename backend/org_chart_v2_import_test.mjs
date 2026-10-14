// Organization Structure v2: browser-side import/export + sheet rules, run in node.
// A SMALL SYNTHETIC .vsdx is built here with JSZip (invented names only); the real reference file is never used.
// The scripts under test are plain browser files, evaluated in a vm context with xmldom standing in for DOMParser.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.resolve(here, '../frontend/public');
const req = createRequire(import.meta.url);
const { DOMParser } = req('@xmldom/xmldom');
const JSZip = req('jszip');

let passed = 0;
const failures = [];
const check = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL  ${name}\n        ${e.message}`); }
};

const ctx = { DOMParser, JSZip, console, Blob, btoa, unescape, encodeURIComponent };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(pub, 'org-vsdx-import.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(pub, 'org-export-v2.js'), 'utf8'), ctx);
const V = ctx.ArabtecOrgVsdx;

/* --------------------------- the synthetic .vsdx ---------------------------- */

const NS = "xmlns='http://schemas.microsoft.com/office/visio/2012/main' xmlns:r='http://schemas.openxmlformats.org/officeDocument/2006/relationships'";
const c = (n, v) => `<Cell N='${n}' V='${v}'/>`;
const xf = (px, py, w, h) => c('PinX', px) + c('PinY', py) + c('Width', w) + c('Height', h) + c('LocPinX', w / 2) + c('LocPinY', h / 2);
const chars = `<Section N='Character'><Row IX='0'>${c('Color', '#000000')}</Row><Row IX='1'>${c('Color', '#000000')}</Row><Row IX='2'>${c('Color', '#ff0000')}</Row></Section>`;
const belt = (id, px, py, w, h, title, text) =>
  `<Shape ID='${id}' Type='Group' Master='19'>${xf(px, py, w, h)}${chars}<Text>${text}</Text><Shapes><Shape ID='${id}1' Type='Group' MasterShape='6'><Text><cp IX='0'/>${title}\n</Text></Shape></Shapes></Shape>`;
const PH = 11.69291338582677, PWI = 16.53543307086614;
// two boxes (a manager and a team below), one bent connector glued Bottom -> Top, a band, a date, a foreign logo, a text panel
const page1 = `<?xml version='1.0'?><PageContents ${NS}><Shapes>
${belt(10, 8, 9, 1.125, 0.5, 'Site Manager', `<cp IX='0'/>X1\n<cp IX='1'/>- Rana Idris - Deputy\n<cp IX='1'/>- Karim Zaki - Sr.\n<cp IX='2'/>- Omar Fahmy 30/10\n<cp IX='1'/>Hala Nour\n<cp IX='1'/>- Layla El-Sayed\n`)}
${belt(11, 7.5625, 6.5, 1.125, 0.4, 'QA Team', ` \n`)}
${belt(12, 4, 6.5, 1.125, 0.4, 'Shared Role', `X0.34\n`)}
${belt(13, 12, 6.5, 1.125, 0.4, 'Crew', `X5 zati\n`)}
${belt(14, 12, 4, 1.125, 0.4, 'Tail Team', ` & Annex Team\n`)}
<Shape ID='20' Type='Shape' Master='15'>${c('PinX', 7.78125)}${c('PinY', 7.725)}${c('Width', -0.4375)}${c('Height', -2.05)}${c('LocPinX', -0.21875)}${c('LocPinY', -1.025)}${c('BeginX', 8)}${c('BeginY', 8.75)}${c('EndX', 7.5625)}${c('EndY', 6.7)}
<Section N='Geometry' IX='0'><Row T='LineTo' IX='2'>${c('Y', -1)}</Row><Row T='LineTo' IX='3'>${c('X', -0.4375)}${c('Y', -1)}</Row><Row T='LineTo' IX='4'>${c('X', -0.4375)}${c('Y', -2.05)}</Row></Section></Shape>
<Shape ID='21' Type='Shape' Master='15'>${c('PinX', 8)}${c('PinY', 8)}${c('Width', 0)}${c('Height', -1)}${c('BeginX', 8)}${c('BeginY', 8.75)}${c('EndX', 3.4375)}${c('EndY', 6.5)}</Shape>
<Shape ID='30' Type='Shape'>${xf(PWI / 2, 11.2, 16, 0.7)}<Text>\nHarbor Site\nProject Organizational Chart \n</Text></Shape>
<Shape ID='31' Type='Shape'>${xf(PWI / 2, 0.4, 16, 0.37)}</Shape>
<Shape ID='32' Type='Shape'>${xf(15.5, 0.76, 1.49, 0.37)}<Text>Date: 04/10/2026\n</Text></Shape>
<Shape ID='33' Type='Foreign'>${xf(15.8, 10.1, 0.8, 0.77)}</Shape>
<Shape ID='34' Type='Shape'>${xf(11, 6, 6, 3)}<Text>1. First Person - Role One\n\n2. Second Person - Role Two\n</Text></Shape>
</Shapes><Connects>
<Connect FromSheet='20' FromCell='BeginX' FromPart='9' ToSheet='10' ToCell='Connections.Bottom.X' ToPart='103'/>
<Connect FromSheet='20' FromCell='EndX' FromPart='12' ToSheet='11' ToCell='Connections.Top.X' ToPart='100'/>
<Connect FromSheet='21' FromCell='BeginX' FromPart='9' ToSheet='10' ToCell='PinX' ToPart='3'/>
<Connect FromSheet='21' FromCell='EndX' FromPart='12' ToSheet='12' ToCell='Connections.Left.X' ToPart='101'/>
</Connects></PageContents>`;
const page2 = `<?xml version='1.0'?><PageContents ${NS}><Shapes>${belt(40, 5, 5, 1.125, 0.4, 'Second Page Role', `X2\n- Mona Adel\n`)}</Shapes></PageContents>`;
const pages = `<?xml version='1.0'?><Pages ${NS}><Page ID='0' NameU='Page-1' Name='Project'><PageSheet>${c('PageWidth', PWI)}${c('PageHeight', PH)}</PageSheet><Rel r:id='rId1'/></Page><Page ID='4' NameU='QA' Name='QA'><PageSheet>${c('PageWidth', PWI)}${c('PageHeight', PH)}</PageSheet><Rel r:id='rId2'/></Page></Pages>`;
const rels = `<?xml version='1.0'?><Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'><Relationship Id='rId2' Type='x' Target='page2.xml'/><Relationship Id='rId1' Type='x' Target='page1.xml'/></Relationships>`;
const masters = `<?xml version='1.0'?><Masters ${NS}><Master ID='15' NameU='Dynamic connector'/><Master ID='19' NameU='Executive Belt'/></Masters>`;

const zip = new JSZip();
zip.file('visio/pages/pages.xml', pages);
zip.file('visio/pages/_rels/pages.xml.rels', rels);
zip.file('visio/masters/masters.xml', masters);
zip.file('visio/pages/page1.xml', page1);
zip.file('visio/pages/page2.xml', page2);
const buf = await zip.generateAsync({ type: 'arraybuffer' });
const out = await V.parse(buf);
const p1 = out.payload.pages[0], p2 = out.payload.pages[1];
const byTitle = (pg, t) => pg.boxes.find((b) => b.title === t);
const J = (x) => JSON.parse(JSON.stringify(x));
const peopleOf = (pg, key) => pg.importPeople.filter((x) => x.boxKey === key);

/* ---------------------------------- parser ---------------------------------- */

await check('pages come from pages.xml in order, with names and A3 paper', () => {
  assert.equal(out.payload.pages.length, 2);
  assert.deepEqual([p1.name, p2.name], ['Project', 'QA']);
  assert.equal(p1.paper, 'A3');
});
await check('band text becomes the two page titles and Date: becomes the page date; foreign shapes and the footer are ignored', () => {
  assert.equal(p1.title1, 'Harbor Site');
  assert.equal(p1.title2, 'Project Organizational Chart');
  assert.equal(p1.date, '04/10/2026');
  assert.equal(p1.boxes.filter((b) => b.kind !== 'text').length, 5);
});
await check('belt boxes: title from the first sub-shape, count line, zati, fractional shares, "& ... Team" joins the title', () => {
  const m = byTitle(p1, 'Site Manager');
  assert.equal(m.kind, 'role'); assert.equal(m.planned, 1); assert.equal(m.shared, false);
  assert.equal(byTitle(p1, 'Crew').zati, true);
  assert.equal(byTitle(p1, 'Crew').planned, 5);
  const f = byTitle(p1, 'Shared Role');
  assert.equal(f.planned, 1); assert.equal(f.shared, true); assert.equal(f.countLabel, 'X0.34');
  assert.equal(byTitle(p1, 'QA Team').kind, 'team');
  assert.equal(byTitle(p1, 'Tail Team & Annex Team').kind, 'team');
});
await check('box position and width come from the file (flip Y, points)', () => {
  const m = byTitle(p1, 'Site Manager');
  assert.equal(Math.round(m.w), 81);
  assert.equal(Math.round(m.x), Math.round((8 - 0.5625) * 72));
  assert.equal(Math.round(m.y), Math.round((PH - 9 - 0.25) * 72));
});
await check('people: dash lines, a bare name line, suffix split at the last spaced dash, unspaced hyphen kept', () => {
  const m = byTitle(p1, 'Site Manager');
  const list = peopleOf(p1, m.key);
  assert.deepEqual(J(list.map((x) => x.personName)), ['Rana Idris', 'Karim Zaki', 'Omar Fahmy', 'Hala Nour', 'Layla El-Sayed']);
  assert.deepEqual(J(list.map((x) => x.suffix)), ['Deputy', 'Sr.', null, null, null]);
  assert.deepEqual(J(list.map((x) => x.sortOrder)), [0, 1, 2, 3, 4]);
});
await check('a red character run marks a joiner and the trailing dd/mm becomes the date in the page year', () => {
  const m = byTitle(p1, 'Site Manager');
  const j = peopleOf(p1, m.key).find((x) => x.personName === 'Omar Fahmy');
  assert.equal(j.status, 'joining');
  assert.equal(j.effectiveDate, '2026-10-30');
  assert.equal(peopleOf(p1, m.key).filter((x) => x.status === 'joining').length, 1);
  assert.equal(out.stats.joiners, 1);
});
await check('connectors with Connects become parent links with sides and interior route points', () => {
  const mgr = byTitle(p1, 'Site Manager'), qa = byTitle(p1, 'QA Team'), sh = byTitle(p1, 'Shared Role');
  assert.equal(qa.parentKey, mgr.key);
  assert.equal(sh.parentKey, mgr.key);
  const l1 = p1.links.find((l) => l.childKey === qa.key);
  assert.equal(l1.fromSide, 'bottom'); assert.equal(l1.toSide, 'top');
  assert.equal(l1.points.length, 2, 'two interior bends');
  // first bend is straight below the start, in page points
  assert.equal(Math.round(l1.points[0].x), Math.round(8 * 72));
  const l2 = p1.links.find((l) => l.childKey === sh.key);
  assert.equal(l2.toSide, 'left'); assert.equal(l2.fromSide, 'bottom', 'a PinX glue falls back to the nearest side');
  assert.equal(p1.boxes.find((b) => b.key === mgr.key).parentKey, undefined);
  assert.equal(out.stats.links, 2);
});
await check('a plain rectangle with text and no master becomes a text box', () => {
  const t = p1.boxes.find((b) => b.kind === 'text');
  assert.ok(t && /First Person - Role One/.test(t.text));
});
await check('page 2 parses on its own and keys are unique across the file', () => {
  assert.equal(byTitle(p2, 'Second Page Role').planned, 2);
  const keys = out.payload.pages.flatMap((p) => p.boxes.map((b) => b.key));
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(out.people.length, 6);
});
await check('a file that is not a Visio drawing is refused in plain words', async () => {
  const z = new JSZip(); z.file('hello.txt', 'hi');
  await assert.rejects(() => V.parse(buf.slice(0, 20)), /not a Visio drawing/);
  await assert.rejects(async () => V.parse(await z.generateAsync({ type: 'arraybuffer' })), /not a Visio drawing/);
});
await check('parsePerson edge cases', () => {
  const P = V.parsePerson;
  assert.deepEqual({ ...P('- Ali Hassan- Sr') }, { name: 'Ali Hassan', suffix: 'Sr', day: null, month: null });
  assert.equal(P('Ahmed El-Desouki').suffix, null);
  assert.equal(P('Name – Site Superintendent 15/10').suffix, 'Site Superintendent');
  assert.equal(P('Name – Site Superintendent 15/10').day, 15);
});

/* ------------------------------------- CSV ---------------------------------- */

await check('CSV: the prototype column mapping, delimiter sniffing, quoted fields and vacant rows', () => {
  const t = '﻿id;name;job title;department;reports_to_id\n1;"Mona, Adel";Project Manager;Site;\n2;Vacant;Site Engineer;Site;1\n';
  const r = ctx.ArabtecOrgCsv.parse(t);
  assert.equal(r.total, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(r.rows[0])), { id: '1', name: 'Mona, Adel', title: 'Project Manager', department: 'Site', reportsToId: '', reportsTo: '' });
  assert.equal(r.rows[1].name, '');
  assert.equal(r.rows[1].reportsToId, '1');
  assert.throws(() => ctx.ArabtecOrgCsv.parse('a,b\n1,2\n'), /Name or Title/);
  assert.throws(() => ctx.ArabtecOrgCsv.parse('name\n'), /no data rows/);
});

/* ------------------- sheet rules from the page (compiled jsx) ---------------- */

const babel = {};
vm.createContext(babel);
vm.runInContext(fs.readFileSync(path.join(pub, 'vendor/babel.min.js'), 'utf8'), babel);
const code = babel.Babel.transform(fs.readFileSync(path.join(pub, 'org-structure-v2.jsx'), 'utf8'), { presets: ['react'] }).code;
const jsxCtx = {
  React: { useState() {}, useEffect() {}, useMemo() {}, useRef() {}, useCallback() {} },
  document: { createElement: () => ({ getContext: () => ({ measureText: (t) => ({ width: String(t).length * 4.4 }) }) }) },
  console,
};
jsxCtx.window = jsxCtx;
vm.createContext(jsxCtx);
vm.runInContext(code, jsxCtx);
const SHEET = jsxCtx.ORG_CHART_V2;

const role = (key, parentKey, extra = {}) => ({ key, kind: 'role', title: key, planned: 1, proposed: 0, shared: false, zati: false, parentKey: parentKey || null, x: 0, y: 0, w: 81, ...extra });
const person = (boxKey) => ({ boxKey, status: 'in_post', personName: 'Invented Person' });
const warn = (boxes, people) => SHEET.computeWarnings([{ boxes }], people);

await check('warnings: a manager with a single report no longer warns (the "fewer than 3" rule is gone)', () => {
  const w = warn([role('m'), role('a', 'm')], [person('m'), person('a')]);
  assert.equal(w.size, 0);
});
await check('warnings: team and text boxes are never evaluated, even as empty managers with many reports', () => {
  const kids = Array.from({ length: 15 }, (_, i) => role('k' + i, 'team'));
  const w = warn([{ ...role('team'), kind: 'team' }, ...kids, { ...role('note'), kind: 'text' }], kids.map((k) => person(k.key)));
  assert.equal(w.has('team'), false);
  assert.equal(w.has('note'), false);
});
await check('warnings: span above 12 report boxes (zati excluded), manager with nobody in post, layers above 6', () => {
  const kids = Array.from({ length: 13 }, (_, i) => role('k' + i, 'm'));
  const w = warn([role('m'), ...kids], kids.map((k) => person(k.key)));
  assert.ok(w.get('m').some((t) => /13 boxes/.test(t)));
  assert.ok(w.get('m').some((t) => /nobody in post/.test(t)));
  const zatiKids = Array.from({ length: 13 }, (_, i) => role('z' + i, 'm', { zati: true }));
  assert.equal(warn([role('m'), ...zatiKids], [person('m')]).has('m'), false, 'zati boxes do not count');
  const chain = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((k, i, all) => role(k, i ? all[i - 1] : null));
  const deep = warn(chain, chain.map((b) => person(b.key)));
  assert.ok(deep.get('g').some((t) => /layers/.test(t)));
  assert.equal(deep.has('f'), false);
});
await check('warnings: the no-one-in-post rule needs a child role box and planned >= 1', () => {
  const nobody = (boxes) => warn(boxes, boxes.filter((b) => b.parentKey).map((b) => person(b.key))).get('m');
  assert.ok(nobody([role('m'), role('a', 'm')]).some((t) => /nobody in post/.test(t)));
  assert.equal(nobody([role('m'), { ...role('t', 'm'), kind: 'team' }]), undefined, 'only a team below: no warning');
  assert.equal(nobody([role('m', null, { planned: 0 }), role('a', 'm')]), undefined, 'planned 0: no warning');
});
await check('auto-arrange has no logo obstacle: the first row starts at the top of the page', () => {
  const boxes = [role('root', null, { x: 600, y: 90 }), ...Array.from({ length: 20 }, (_, i) => role('c' + i, 'root', { x: i * 10, y: 200 }))];
  const page = { boxes, links: [] };
  const geo = new Map(boxes.map((b) => [b.key, { b, x: b.x, y: b.y, w: 81, h: 38, m: {} }]));
  const pos = SHEET.autoLayout(page, geo, null);
  assert.equal(pos.size, boxes.length);
  assert.equal(pos.get('root').y, 92);
});
await check('clean box model: title, meta with open count, names without dashes, suffix and joiner runs', () => {
  const m = SHEET.boxModel({ ...role('r'), title: 'Site Engineer', planned: 4, w: 240 }, [
    { personName: 'Ahmed', suffix: 'Sr.', status: 'in_post' },
    { personName: 'Mona', status: 'joining', effectiveDate: '2999-10-30' },
  ], '2026-10-04');
  const txt = m.rows.map((r) => r.runs.map((u) => u.t).join(''));
  assert.equal(txt[0], 'Site Engineer');
  assert.equal(txt[1], 'X4 · 2 open');
  assert.equal(txt[2], 'Ahmed – Sr.');
  assert.equal(txt[3], 'Mona · joins 30/10');
  assert.equal(m.rows[3].runs[0].tone, 'brand');
  assert.equal(m.rows[2].runs[1].tone, 'muted');
  assert.equal(m.h, m.rows.reduce((n, r) => n + r.lh, 0) + 12);
  const z = SHEET.boxModel({ ...role('z'), zati: true, planned: 5 }, [], '2026-10-04');
  assert.equal(z.rows[1].runs[0].t, 'X5 zati', 'zati never shows an open count');
  assert.equal(SHEET.boxModel({ ...role('t'), kind: 'team', title: 'Team' }, [], '2026-10-04').h, 20);
});

/* ------------------------------------ export ---------------------------------- */

const run = (t, tone = 'ink', s = 8.5, w = 600) => ({ t, tone, s, w });
const model = {
  style: 'classic', name: 'Project', title1: 'Harbor Site', title2: 'Org chart', date: '04/10/2026',
  boxes: [
    { key: 'a', kind: 'role', x: 500, y: 100, w: 81, h: 29, lines: [{ t: 'Manager', red: false }, { t: '- Karim Zaki 30/10', red: true }], logical: [{ t: 'Manager', red: false }, { t: '- Karim Zaki 30/10', red: true }], left: false, dashed: false },
    { key: 'b', kind: 'role', x: 500, y: 200, w: 81, h: 29, lines: [{ t: 'Engineer', red: false }], logical: [{ t: 'Engineer', red: false }], left: false, dashed: true },
  ],
  lines: [{ key: 'b', parent: 'a', pts: [[540, 129], [540, 200]], fs: 'bottom', ts: 'top' }],
};
const cleanModel = {
  style: 'clean', name: 'Project', title1: 'Harbor Site', title2: 'Org chart', date: '04/10/2026',
  boxes: [
    { key: 'a', kind: 'role', x: 500, y: 100, w: 81, h: 40, rows: [{ runs: [run('Manager')], lh: 11, s: 8.5 }, { runs: [run('Karim Zaki', 'brand', 7.5, 500), run(' · joins 30/10', 'brand', 7, 400)], lh: 10, s: 7.5 }], left: false, dashed: false },
    { key: 'b', kind: 'role', x: 500, y: 200, w: 81, h: 29, rows: [{ runs: [run('Engineer')], lh: 11, s: 8.5 }], left: false, dashed: true },
    { key: 'c', kind: 'team', x: 700, y: 200, w: 81, h: 20, rows: [{ runs: [run('Team', 'soft', 8)], lh: 10, s: 8 }], center: true, left: false, dashed: false },
  ],
  lines: [{ key: 'b', parent: 'a', pts: [[540, 140], [540, 200]], fs: 'bottom', ts: 'top' }],
};
await check('Clean SVG: white page, left title, Updated date, thin light cards, no bands, logo or arrowheads, red only in joiner text', () => {
  const svg = ctx.ArabtecOrgExport.svgOf(cleanModel, null);
  assert.doesNotMatch(svg, /#860915|<image|stroke="#000"/);
  assert.match(svg, /x="24" y="38"[^>]*>Harbor Site/);
  assert.match(svg, /Updated 04 Oct 2026/);
  assert.match(svg, /rx="5\.5"/);
  assert.match(svg, /stroke-dasharray="3 2"/);
  assert.match(svg, /fill="#D01827">Karim Zaki/);
  assert.equal((svg.match(/#D01827/g) || []).length, 2, 'brand red appears only as text fill');
  assert.equal((svg.match(/ Z"/g) || []).length, 0, 'no arrowheads');
});
await check('Classic SVG keeps the Visio look (bands, black borders, arrowhead, red joiner) but has no logo', () => {
  const svg = ctx.ArabtecOrgExport.svgOf(model, null, 'classic');
  assert.match(svg, /fill="#860915"/);
  assert.match(svg, /Harbor Site/);
  assert.match(svg, /Date: 04\/10\/2026/);
  assert.match(svg, /fill="#E0161B">- Karim Zaki 30\/10/);
  assert.match(svg, /stroke-dasharray="3 2"/);
  assert.equal((svg.match(/ Z" fill="#000"/g) || []).length, 1, 'one arrowhead per connector');
  assert.doesNotMatch(svg, /<image/);
});
await check('Clean Visio: title and date shapes, rounded light cards, grey connector without arrows, red only as joiner text', async () => {
  const blob = await ctx.ArabtecOrgExport.vsdx([cleanModel], { title: 'Test' });
  const z = await JSZip.loadAsync(Buffer.from(await blob.arrayBuffer()));
  assert.equal(Object.keys(z.files).some((n) => /media|logo/.test(n)), false);
  const xml = await z.file('visio/pages/page1.xml').async('string');
  const dom = new DOMParser().parseFromString(xml, 'text/xml');
  assert.equal(dom.getElementsByTagName('Shape').length, 1 + 1 + 1 + 3, 'title, date, connector, three boxes');
  assert.doesNotMatch(xml, /#860915|Band\./);
  assert.match(xml, /N="EndArrow" V="0"/);
  assert.match(xml, /N="Rounding" V="0\.083333" U="IN"/);
  assert.match(xml, /N="LineColor" V="#D0D4DA"/);
  assert.match(xml, /Updated 04 Oct 2026/);
  assert.equal((xml.match(/N="Color" V="#D01827"/g) || []).length, 2);
  assert.equal(dom.getElementsByTagName('Connect').length, 2);
});
await check('Classic Visio: one page per chart page, A3 landscape, glued connectors with arrows, red joiner row, bands, no logo', async () => {
  const blob = await ctx.ArabtecOrgExport.vsdx([model, { ...model, name: 'QA' }], { title: 'Test', style: 'classic' });
  const z = await JSZip.loadAsync(Buffer.from(await blob.arrayBuffer()));
  const names = Object.keys(z.files);
  assert.ok(names.includes('visio/pages/page1.xml') && names.includes('visio/pages/page2.xml'));
  assert.equal(names.some((n) => /media|logo/.test(n)), false);
  const pagesXml = await z.file('visio/pages/pages.xml').async('string');
  assert.equal((pagesXml.match(/<Page /g) || []).length, 2);
  assert.match(pagesXml, /PageWidth" V="16\.5354/);
  const xml = await z.file('visio/pages/page1.xml').async('string');
  const dom = new DOMParser().parseFromString(xml, 'text/xml');
  assert.equal(dom.getElementsByTagName('Shape').length, 2 + 1 + 1 + 2, 'two bands, date, connector, two boxes');
  assert.equal(dom.getElementsByTagName('Connect').length, 2);
  assert.match(xml, /N="EndArrow" V="4"/);
  assert.match(xml, /ToCell="Connections\.X4" ToPart="103"/, 'glued to the bottom of the parent');
  assert.match(xml, /ToCell="Connections\.X1" ToPart="100"/, 'and the top of the child');
  assert.match(xml, /N="Color" V="#E0161B"/);
  assert.match(xml, /<cp IX="1"\/>- Karim Zaki 30\/10/);
});
await check('CSV export quotes fields and keeps a byte-order mark for Excel', async () => {
  const b = ctx.ArabtecOrgExport.csv([['Name', 'Note'], ['Zaki, Karim', 'said "hi"']]);
  const bytes = new Uint8Array(await b.arrayBuffer());
  assert.deepEqual([bytes[0], bytes[1], bytes[2]], [0xef, 0xbb, 0xbf]);
  const t = await b.text();
  assert.ok(t.startsWith('Name,Note'));
  assert.ok(t.includes('"Zaki, Karim","said ""hi"""'));
});

await check('CSV export guards formula injection: leading = + - @ tab CR get a single quote', async () => {
  const t = await ctx.ArabtecOrgExport.csv([['=1+1', '+SUM(A1)', '-2', '@cmd', '\tx', 'ok', 'a=b', '=HYPERLINK("u")']]).text();
  assert.ok(t.includes("'=1+1,'+SUM(A1),'-2,'@cmd,\"'\tx\"") || t.includes("'=1+1,'+SUM(A1),'-2,'@cmd,'\tx,ok,a=b,"), t);
  assert.ok(t.includes(`"'=HYPERLINK(""u"")"`), t);
  assert.ok(!/(^|,)[=+@]/.test(t.replace('﻿', '').split('\r\n')[0]), 'no cell starts with a formula character');
});

await check('Visio import: dotted master or non-solid LinePattern becomes a dotted link with fromKey; additional manager stays a reports link', async () => {
  const pg = `<?xml version='1.0'?><PageContents ${NS}><Shapes>
${belt(50, 8, 9, 1.125, 0.5, 'Top Role', `X1\n- Aya Salem\n`)}
${belt(51, 4, 6, 1.125, 0.4, 'Left Role', `X1\n`)}
${belt(52, 12, 6, 1.125, 0.4, 'Right Role', `X1\n`)}
${belt(53, 8, 3, 1.125, 0.4, 'Low Role', `X1\n`)}
<Shape ID='60' Type='Shape' Master='16'>${c('BeginX', 4)}${c('BeginY', 6)}${c('EndX', 8)}${c('EndY', 3)}</Shape>
<Shape ID='61' Type='Shape' Master='15'>${c('BeginX', 12)}${c('BeginY', 6)}${c('EndX', 8)}${c('EndY', 3)}${c('LinePattern', 2)}</Shape>
<Shape ID='62' Type='Shape' Master='17'>${c('BeginX', 8)}${c('BeginY', 9)}${c('EndX', 4)}${c('EndY', 6)}</Shape>
</Shapes><Connects>
<Connect FromSheet='60' FromCell='BeginX' ToSheet='51' ToCell='Connections.Bottom.X'/>
<Connect FromSheet='60' FromCell='EndX' ToSheet='53' ToCell='Connections.Top.X'/>
<Connect FromSheet='61' FromCell='BeginX' ToSheet='52' ToCell='Connections.Bottom.X'/>
<Connect FromSheet='61' FromCell='EndX' ToSheet='53' ToCell='Connections.Top.X'/>
<Connect FromSheet='62' FromCell='BeginX' ToSheet='50' ToCell='Connections.Bottom.X'/>
<Connect FromSheet='62' FromCell='EndX' ToSheet='51' ToCell='Connections.Top.X'/>
</Connects></PageContents>`;
  const z = new JSZip();
  z.file('visio/pages/pages.xml', `<?xml version='1.0'?><Pages ${NS}><Page ID='0' NameU='P' Name='P'><PageSheet>${c('PageWidth', PWI)}${c('PageHeight', PH)}</PageSheet><Rel r:id='rId1'/></Page></Pages>`);
  z.file('visio/pages/_rels/pages.xml.rels', `<?xml version='1.0'?><Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'><Relationship Id='rId1' Type='x' Target='page1.xml'/></Relationships>`);
  z.file('visio/masters/masters.xml', `<?xml version='1.0'?><Masters ${NS}><Master ID='15' NameU='Dynamic connector'/><Master ID='16' NameU='Dotted-line report'/><Master ID='17' NameU='Direct Additional Manager'/><Master ID='19' NameU='Executive Belt'/></Masters>`);
  z.file('visio/pages/page1.xml', pg);
  const r = await V.parse(await z.generateAsync({ type: 'arraybuffer' }));
  const pgx = r.payload.pages[0];
  const t = (n) => byTitle(pgx, n).key;
  const dotted = pgx.links.filter((l) => l.kind === 'dotted');
  assert.equal(dotted.length, 2);
  assert.ok(dotted.some((l) => l.fromKey === t('Left Role') && l.childKey === t('Low Role')));
  assert.ok(dotted.some((l) => l.fromKey === t('Right Role') && l.childKey === t('Low Role')));
  const rep = pgx.links.find((l) => l.kind === 'reports');
  assert.ok(rep && rep.childKey === t('Left Role') && !rep.fromKey);
  assert.equal(byTitle(pgx, 'Left Role').parentKey, t('Top Role'));
  assert.equal(byTitle(pgx, 'Low Role').parentKey, undefined, 'dotted lines do not set a parent');
});

await check('elapsed joiners count as in post for metrics and the manager-vacancy warning', () => {
  const boxes = [{ key: 'm', kind: 'role', planned: 1, proposed: 0 }, { key: 'c', kind: 'role', planned: 1, proposed: 0, parentKey: 'm' }];
  const mk = (d) => [{ boxKey: 'm', status: 'joining', effectiveDate: d }];
  const m = SHEET.computeMetrics([{ boxes }], mk('2026-01-01'), '2026-10-11');
  assert.equal(m.inPost, 1); assert.equal(m.joining, 0);
  const f = SHEET.computeMetrics([{ boxes }], mk('2026-12-01'), '2026-10-11');
  assert.equal(f.inPost, 0); assert.equal(f.joining, 1);
  assert.equal(SHEET.computeWarnings([{ boxes }], mk('2026-01-01'), '2026-10-11').has('m'), false);
  assert.equal(SHEET.computeWarnings([{ boxes }], mk('2026-12-01'), '2026-10-11').has('m'), true);
});

console.log(`\n${failures.length === 0 ? 'ALL PASS' : 'FAILURES'} — ${passed} passed, ${failures.length} failed`);
if (failures.length) console.log('failed:', failures.join(' | '));
process.exit(failures.length === 0 ? 0 : 1);
