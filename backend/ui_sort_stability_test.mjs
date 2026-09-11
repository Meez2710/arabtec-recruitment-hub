// Regression contract: sorting the Candidates table must never remove the table
// from the tree.
//
// The bug: CandidatesPage.load() opened with `setCandidates(null)`, and the
// render branch `!candidates ? <ListSkeleton/>` swapped the whole table for a
// skeleton on EVERY refetch — including a sort. The table unmounted, the
// skeleton painted, then the table remounted. That is the flash the user saw.
//
// These checks drive the real component with the production React/Babel, hold a
// query open, and assert the <table> and its rows are still mounted while the
// request is in flight.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const publicDir = fileURLToPath(new URL('../frontend/public/', import.meta.url));
const window = new EventTarget();
window.location = { hash: '', pathname: '/', search: '', reload() {} };
window.history = { replaceState() {} };
const document = Object.assign(new EventTarget(), { getElementById: () => ({}), activeElement: null });
const ctx = vm.createContext({
  window, document, Event, CustomEvent, URLSearchParams, console,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
  ReactDOM: { createRoot: () => ({ render() {} }) },
  fetch() { throw new Error('sort stability tests must not use the network'); },
});
ctx.self = ctx;
vm.runInContext(fs.readFileSync(publicDir + 'vendor/react.production.min.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync(publicDir + 'vendor/babel.min.js', 'utf8'), ctx);
for (const file of ['email-settings.jsx', 'org-structure.jsx', 'app.jsx']) {
  const source = fs.readFileSync(publicDir + file, 'utf8');
  vm.runInContext(ctx.Babel.transform(source, { presets: ['react'] }).code, ctx, { filename: file });
}
const get = (expression) => vm.runInContext(expression, ctx);
const React = ctx.React;

let nextId = 0;
function mount(Component, initialProps = {}) {
  let slots = [], cursor = 0, effects = [], props = initialProps;
  const same = (a, b) => a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const memo = (fn, deps) => { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { value: fn(), deps }; return slots[i].value; };
  const dispatcher = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial }; return [slots[i].value, (v) => { slots[i].value = typeof v === 'function' ? v(slots[i].value) : v; }]; },
    useRef(initial) { return memo(() => ({ current: initial }), []); },
    useId() { return memo(() => `test-${++nextId}`, []); },
    useMemo: memo, useCallback: (fn, deps) => memo(() => fn, deps),
    useContext: (context) => context._currentValue,
    useEffect(fn, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) effects.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); },
  };
  return {
    render(next = props) {
      props = next; cursor = 0; effects = [];
      React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current = dispatcher;
      let tree; try { tree = Component(props); } finally { React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current = null; }
      effects.forEach((run) => run()); return tree;
    },
    dispose() { slots.forEach((slot) => slot?.cleanup?.()); },
  };
}
// Walks children AND any element-bearing prop. CandidatesPage hands its view
// toggle to <PageHead actions={...}> and its search box to <FilterToolbar
// search={...}>, so a children-only walk never reaches either.
const isElement = (v) => v && typeof v === 'object' && ('type' in v || Array.isArray(v));
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object') return [];
  const out = [tree];
  for (const [key, value] of Object.entries(tree.props || {})) {
    if (key === 'children') { out.push(...nodes(value)); continue; }
    if (isElement(value)) out.push(...nodes(value));
  }
  return out;
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (tree == null || typeof tree === 'boolean') return '';
  if (typeof tree !== 'object') return String(tree);
  let out = text(tree.props?.children);
  for (const [key, value] of Object.entries(tree.props || {})) {
    if (key !== 'children' && isElement(value)) out += text(value);
  }
  return out;
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const tables = (tree) => nodes(tree).filter((n) => n.type === 'table');
const bodyRows = (tree) => {
  const tbody = nodes(tree).find((n) => n.type === 'tbody');
  return tbody ? nodes(tbody.props?.children).filter((n) => n.type === 'tr') : [];
};
const skeletons = (tree) => nodes(tree).filter((n) => typeof n.type === 'function'
  && (n.type.name === 'ListSkeleton' || n.type.name === 'Skeleton'));
// The driver does not deep-render, so SortTh / ViewToggle / Empty arrive as
// unrendered component elements. Drive them through the props the page gave them.
const byName = (tree, name) => nodes(tree).filter((n) => typeof n.type === 'function' && n.type.name === name);
const showTable = (tree) => byName(tree, 'ViewToggle')[0].props.onChange('table');
const sortHeaders = (tree) => byName(tree, 'SortTh');
const clickSort = (tree, i = 0) => { const h = sortHeaders(tree)[i]; h.props.onSort(h.props.col); return h; };
const busyCard = (tree) => nodes(tree).find((n) => n.props?.className?.includes?.('table-busy'));

// A controllable stand-in for the candidates endpoint.
const api = get('api');
let pending = null;
let sent = [];                 // every /candidates query string, in order
let totalPages = 1;            // what the stubbed endpoint claims, so paging is reachable
function serveCandidates(names, query) {
  return { candidates: names.map((fullName, i) => ({ id: `c${i}-${fullName}`, fullName, links: [], tags: [] })),
           pagination: { total: names.length * totalPages, totalPages, hasMore: totalPages > 1 }, query };
}
api.get = (path) => {
  if (!path.startsWith('/candidates')) return Promise.resolve({ buttons: [], requests: [] });
  const query = path;
  sent.push(query);
  return new Promise((resolve, reject) => { pending = { resolve: (names) => resolve(serveCandidates(names, query)), reject, query }; });
};
// Everything a query carries, for counting and for asserting WHICH page was asked for.
const pageOf = (query) => new URLSearchParams(query.slice(query.indexOf('?') + 1)).get('page');
const dirOf = (query) => new URLSearchParams(query.slice(query.indexOf('?') + 1)).get('dir');
const sortOf = (query) => new URLSearchParams(query.slice(query.indexOf('?') + 1)).get('sort');
const startCounting = () => { sent = []; };
// Stands in for the render React schedules after a state change. Two of these
// after a click is what exposed the duplicate: the old code issued a request on
// each, for two different pages.
const settle = (page, n = 2) => { let t; for (let i = 0; i < n; i++) t = page.render(); return t; };

const user = { id: 'u1', fullName: 'Tester', permissions: ['candidate.view'] };

let passed = 0, failed = 0;
async function check(name, run) {
  try { await run(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n      ${e.message}\n${e.stack.split('\n').slice(1,4).join('\n')}`); }
}

await check('initial render shows the skeleton, then the table', async () => {
  const page = mount(get('CandidatesPage'), { user, onNavigate() {} });
  let tree = page.render();
  assert.equal(tables(tree).length, 0, 'no table before the first result');
  assert.ok(skeletons(tree).length > 0, 'first load shows the skeleton');
  pending.resolve(['Alpha', 'Beta']);
  await flush();
  tree = page.render();
  showTable(tree);
  tree = page.render();
  assert.equal(tables(tree).length, 1, 'the table is mounted once rows exist');
  assert.equal(bodyRows(tree).length, 2);
  page.dispose();
});

await check('sorting keeps the table mounted and the rows visible while in flight', async () => {
  const page = mount(get('CandidatesPage'), { user, onNavigate() {} });
  page.render();
  pending.resolve(['Alpha', 'Beta', 'Gamma']);
  await flush();
  let tree = page.render();
  showTable(tree);
  tree = page.render();
  assert.equal(bodyRows(tree).length, 3, 'rows are on screen before sorting');

  // Click a sortable header.
  assert.ok(sortHeaders(tree).length > 0, 'sortable headers are present');
  clickSort(tree);

  // Mid-flight: this is the exact moment the old code painted a skeleton.
  // The first render re-runs the load effect (which flips busy on); the second
  // observes it, mirroring how React commits then re-renders on a state change.
  tree = page.render();
  assert.equal(skeletons(tree).length, 0, 'NO skeleton replaces the table during a sort');
  assert.equal(tables(tree).length, 1, 'table survives the render that starts the query');
  tree = page.render();
  assert.equal(tables(tree).length, 1, 'the table is STILL mounted during the sort');
  assert.equal(bodyRows(tree).length, 3, 'the previous rows are STILL visible during the sort');
  const card = busyCard(tree);
  assert.ok(card, 'the table carries the subtle busy state instead of unmounting');
  assert.equal(card.props['aria-busy'], true, 'busy state is announced to assistive tech');

  // The result arrives and the rows reorder in place.
  pending.resolve(['Gamma', 'Beta', 'Alpha']);
  await flush();
  tree = page.render();
  assert.equal(tables(tree).length, 1);
  assert.equal(bodyRows(tree).length, 3);
  assert.equal(busyCard(tree), undefined, 'busy clears when the result lands');
  page.dispose();
});

await check('repeated sorting never unmounts the table', async () => {
  const page = mount(get('CandidatesPage'), { user, onNavigate() {} });
  page.render();
  pending.resolve(['Alpha', 'Beta']);
  await flush();
  let tree = page.render();
  showTable(tree);
  tree = page.render();

  for (let i = 0; i < 6; i++) {
    clickSort(tree);
    tree = page.render();   // commits the sort, starts the query
    tree = page.render();   // the render React would schedule from that state change
    assert.equal(tables(tree).length, 1, `table stayed mounted on sort click ${i + 1}`);
    assert.equal(bodyRows(tree).length, 2, `rows stayed visible on sort click ${i + 1}`);
    assert.equal(skeletons(tree).length, 0, `no skeleton on sort click ${i + 1}`);
    pending.resolve(i % 2 ? ['Alpha', 'Beta'] : ['Beta', 'Alpha']);
    await flush();
    tree = page.render();
  }
  page.dispose();
});

await check('the sort direction cycles ascending then descending on the same column', async () => {
  const page = mount(get('CandidatesPage'), { user, onNavigate() {} });
  page.render();
  pending.resolve(['Alpha']);
  await flush();
  let tree = page.render();
  showTable(tree);
  tree = page.render();

  clickSort(tree);
  tree = page.render();
  assert.match(pending.query, /dir=asc/, 'first click sorts ascending');
  pending.resolve(['Alpha']); await flush(); tree = page.render();

  clickSort(tree);
  tree = page.render();
  assert.match(pending.query, /dir=desc/, 'second click on the same column sorts descending');
  const active = sortHeaders(tree).find((h) => h.props.sort.by === h.props.col);
  assert.equal(active.props.sort.dir, 'desc', 'the header reports the descending state');
  pending.resolve(['Alpha']); await flush();
  page.dispose();
});

await check('a stale response cannot overwrite a newer sort', async () => {
  const page = mount(get('CandidatesPage'), { user, onNavigate() {} });
  page.render();
  pending.resolve(['Alpha', 'Beta']);
  await flush();
  let tree = page.render();
  showTable(tree);
  tree = page.render();

  clickSort(tree, 0);
  tree = page.render();
  const first = pending;                       // query A, left hanging
  clickSort(tree, 1);
  tree = page.render();
  const second = pending;                      // query B, asked later

  second.resolve(['NEWEST']);                  // B answers first
  await flush();
  first.resolve(['STALE', 'STALE2']);          // A answers late
  await flush();
  tree = page.render();
  const rows = bodyRows(tree);
  assert.equal(rows.length, 1, 'the newest query owns the table');
  assert.match(text(rows[0]), /NEWEST/, 'the late stale response was discarded');
  page.dispose();
});

await check('a failed refetch still surfaces the error and a retry', async () => {
  const page = mount(get('CandidatesPage'), { user, onNavigate() {} });
  page.render();
  pending.resolve(['Alpha']);
  await flush();
  let tree = page.render();
  showTable(tree);
  tree = page.render();

  clickSort(tree);
  tree = page.render();
  pending.reject(new Error('Candidate service unavailable'));
  await flush();
  tree = page.render();
  const empty = byName(tree, 'Empty')[0];
  assert.ok(empty, 'the error state still renders');
  assert.match(empty.props.title, /Could not load candidates/);
  assert.match(empty.props.text, /Candidate service unavailable/, 'the server message is shown');
  assert.ok(nodes(empty.props.action).some((n) => n.type === 'button'), 'retry is still offered');
  page.dispose();
});


/* ---------------------------------------------------------------------------
   One sort action must cost exactly one request.

   `page` used to be reset by an effect watching `sort`, which put the reset in
   a SECOND render: the first already had the new sort but the old page. From
   page 3 that produced two requests — (new sort, page 3) then (new sort,
   page 1) — and the first asked for a page that may not exist under the new
   ordering. toggleSort now resets the page itself, in the same batched update.
   ------------------------------------------------------------------------ */

await check('sorting from page 1 issues exactly one request', async () => {
  totalPages = 1;
  const page = mount(get('CandidatesPage'), { user, onNavigate() {} });
  page.render();
  pending.resolve(['Alpha', 'Beta']);
  await flush();
  let tree = page.render();
  showTable(tree);
  tree = page.render();

  startCounting();
  clickSort(tree);
  tree = settle(page);
  assert.equal(sent.length, 1, `one sort click must send one request, sent ${sent.length}: ${sent.join(' | ')}`);
  assert.equal(pageOf(sent[0]), '1');
  assert.equal(tables(tree).length, 1, 'the table stayed mounted');
  page.dispose();
});

await check('sorting from page 3 issues one request, and it asks for page 1', async () => {
  totalPages = 3;
  const page = mount(get('CandidatesPage'), { user, onNavigate() {} });
  page.render();
  pending.resolve(['Alpha', 'Beta']);
  await flush();
  let tree = page.render();
  showTable(tree);
  tree = page.render();

  // Walk to page 3 through the real pager control.
  byName(tree, 'Pager')[0].props.onPage(3);
  tree = settle(page);
  pending.resolve(['Alpha', 'Beta']);
  await flush();
  tree = page.render();
  assert.equal(pageOf(sent[sent.length - 1]), '3', 'the pager really moved to page 3');

  startCounting();
  clickSort(tree);
  tree = settle(page);
  assert.equal(sent.length, 1,
    `sorting from page 3 must send one request, sent ${sent.length}: ${sent.join(' | ')}`);
  assert.equal(pageOf(sent[0]), '1', 'the single request asks for page 1, not the old page');
  assert.equal(tables(tree).length, 1, 'the table stayed mounted');
  assert.equal(skeletons(tree).length, 0, 'no skeleton replaced the table');
  page.dispose();
});

await check('the old page is never requested under the new sort', async () => {
  totalPages = 3;
  const page = mount(get('CandidatesPage'), { user, onNavigate() {} });
  page.render();
  pending.resolve(['Alpha', 'Beta']);
  await flush();
  let tree = page.render();
  showTable(tree);
  tree = page.render();
  byName(tree, 'Pager')[0].props.onPage(2);
  tree = settle(page);
  pending.resolve(['Alpha', 'Beta']);
  await flush();
  tree = page.render();

  const before = sortOf(sent[sent.length - 1]);
  startCounting();
  const header = clickSort(tree);
  tree = settle(page);
  const newSort = header.props.col;
  assert.notEqual(newSort, before, 'the test clicked a column that actually changes the sort');
  for (const query of sent) {
    assert.equal(pageOf(query), '1',
      `no request may carry the stale page: ${query}`);
  }
  assert.equal(sent.length, 1);
  page.dispose();
});

await check('ascending then descending still costs one request each and stays correct', async () => {
  totalPages = 1;
  const page = mount(get('CandidatesPage'), { user, onNavigate() {} });
  page.render();
  pending.resolve(['Alpha', 'Beta']);
  await flush();
  let tree = page.render();
  showTable(tree);
  tree = page.render();

  startCounting();
  clickSort(tree);
  tree = settle(page);
  assert.equal(sent.length, 1, 'first click: one request');
  assert.equal(dirOf(sent[0]), 'asc');
  pending.resolve(['Alpha', 'Beta']);
  await flush();
  tree = page.render();

  startCounting();
  clickSort(tree);
  tree = settle(page);
  assert.equal(sent.length, 1, 'second click: one request');
  assert.equal(dirOf(sent[0]), 'desc', 'direction still cycles asc then desc');
  const active = sortHeaders(tree).find((h) => h.props.sort.by === h.props.col);
  assert.equal(active.props.sort.dir, 'desc');
  pending.resolve(['Beta', 'Alpha']);
  await flush();
  tree = page.render();
  assert.equal(bodyRows(tree).length, 2, 'the latest data is on screen');
  assert.match(text(bodyRows(tree)[0]), /Beta/, 'the newest result won');
  page.dispose();
});

await check('changing a filter still returns to page 1', async () => {
  totalPages = 3;
  const page = mount(get('CandidatesPage'), { user, onNavigate() {} });
  page.render();
  pending.resolve(['Alpha']);
  await flush();
  let tree = page.render();
  showTable(tree);
  tree = page.render();
  byName(tree, 'Pager')[0].props.onPage(3);
  tree = settle(page);
  pending.resolve(['Alpha']);
  await flush();
  tree = page.render();
  assert.equal(pageOf(sent[sent.length - 1]), '3');

  // The reset effect still owns filters / screen tab / page size.
  startCounting();
  const search = byName(tree, 'FilterToolbar')[0].props.search;
  search.props.onChange({ target: { value: 'zzz' } });
  tree = settle(page, 3);
  assert.equal(pageOf(sent[sent.length - 1]), '1', 'a filter change still goes back to page 1');
  page.dispose();
});

console.log(`\n=== UI SORT STABILITY: ${passed} passed, ${failed} failed ===`);
if (failed) process.exit(1);
