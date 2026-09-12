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

  // Filters return to page 1 too — through the setFilters wrapper now, not the
  // reset effect. The block at the end of this file holds that to one request.
  startCounting();
  const search = byName(tree, 'FilterToolbar')[0].props.search;
  search.props.onChange({ target: { value: 'zzz' } });
  tree = settle(page, 3);
  assert.equal(pageOf(sent[sent.length - 1]), '1', 'a filter change still goes back to page 1');
  page.dispose();
});


/* ---------------------------------------------------------------------------
   Sort-header dimensional stability.

   The caret used to render nothing while a column was unsorted and leaned on
   the stylesheet alone to hold its gap open. Every state now renders a 16px
   icon, and the states differ only by which glyph and how strongly it is drawn.
   ------------------------------------------------------------------------ */

// sortHeaders() yields unrendered <SortTh> elements. SortTh is a pure,
// hook-free function component, so calling it gives the real <th> it produces —
// which is what these checks are about.
const SortTh = get('SortTh');
const renderHeader = (element) => SortTh(element.props);
const renderedHeaders = (tree) => sortHeaders(tree).map(renderHeader);
const caretOf = (header) => nodes(header).find((n) => n.props?.className === 'sort-caret');
const labelOf = (header) => nodes(header).find((n) => n.props?.className === 'sort-label');
const iconOf = (header) => nodes(caretOf(header)).find((n) => typeof n.type === 'function' && n.type.name === 'Icon');
// Every property that could move something if it varied between states.
const geometry = (header) => {
  const caret = caretOf(header);
  return JSON.stringify({
    thClass: header.props.className.replace(' active', ''),   // `active` is colour only
    thStyle: header.props.style ?? null,
    caretClass: caret.props.className,
    caretStyle: caret.props.style ?? null,
    iconSize: iconOf(header).props.size,
    labelText: text(labelOf(header)),
  });
};
async function tableAt(user) {
  const page = mount(get('CandidatesPage'), { user, onNavigate() {} });
  page.render();
  pending.resolve(['Alpha', 'Beta']);
  await flush();
  let tree = page.render();
  showTable(tree);
  return { page, tree: page.render() };
}

await check('an unsorted header renders the neutral state with its icon present', async () => {
  totalPages = 1;
  const { page, tree } = await tableAt(user);
  const neutral = sortHeaders(tree).filter((h) => h.props.sort.by !== h.props.col).map(renderHeader);
  assert.ok(neutral.length > 0, 'there are unsorted columns to check');
  for (const header of neutral) {
    assert.equal(header.props['aria-sort'], 'none');
    const caret = caretOf(header);
    assert.ok(caret, 'the caret container exists while unsorted');
    assert.equal(caret.props['data-sort'], 'none');
    const icon = iconOf(header);
    assert.ok(icon, 'the neutral state still renders an icon — the box is occupied, not empty');
    assert.equal(icon.props.name, 'sortNeutral');
    assert.equal(icon.props.size, 16);
    assert.ok(text(labelOf(header)).length > 0, 'the label is present');
  }
  page.dispose();
});

await check('neutral, ascending and descending are dimensionally identical', async () => {
  totalPages = 1;
  const { page } = await tableAt(user);
  let tree = page.render();

  const col = sortHeaders(tree)[0].props.col;
  const pick = (t) => renderHeader(sortHeaders(t).find((h) => h.props.col === col));

  const atNeutral = geometry(pick(tree));
  assert.equal(pick(tree).props['aria-sort'], 'none');
  assert.equal(iconOf(pick(tree)).props.name, 'sortNeutral');

  clickSort(tree);
  tree = settle(page);
  const atAscending = geometry(pick(tree));
  assert.equal(pick(tree).props['aria-sort'], 'ascending');
  assert.equal(iconOf(pick(tree)).props.name, 'chevronUp');
  pending.resolve(['Alpha', 'Beta']); await flush(); tree = page.render();

  clickSort(tree);
  tree = settle(page);
  const atDescending = geometry(pick(tree));
  assert.equal(pick(tree).props['aria-sort'], 'descending');
  assert.equal(iconOf(pick(tree)).props.name, 'chevronDown');
  pending.resolve(['Beta', 'Alpha']); await flush();

  // Nothing that occupies space differs between the three states.
  assert.equal(atNeutral, atAscending, 'neutral and ascending occupy identical geometry');
  assert.equal(atAscending, atDescending, 'ascending and descending occupy identical geometry');
  page.dispose();
});

await check('sorting one column does not disturb its neighbours', async () => {
  totalPages = 1;
  const { page } = await tableAt(user);
  let tree = page.render();
  const target = sortHeaders(tree)[0].props.col;
  const others = () => sortHeaders(page.render()).filter((h) => h.props.col !== target).map(renderHeader);
  const before = others().map(geometry);

  clickSort(tree);
  tree = settle(page);
  const after = others().map(geometry);
  assert.deepEqual(after, before, 'neighbouring headers are untouched by another column becoming sorted');
  assert.equal(others().every((h) => h.props['aria-sort'] === 'none'), true, 'only one column claims a direction');
  pending.resolve(['Alpha', 'Beta']); await flush();
  page.dispose();
});

await check('no state carries a font-size, font-weight or transform of its own', async () => {
  totalPages = 1;
  const { page } = await tableAt(user);
  let tree = page.render();
  const forbidden = ['fontSize', 'fontWeight', 'padding', 'margin', 'transform', 'border', 'borderWidth'];
  const inspect = (t, state) => {
    for (const header of renderedHeaders(t)) {
      const style = header.props.style || {};
      const caretStyle = caretOf(header).props.style || {};
      for (const key of forbidden) {
        assert.equal(key in style, false, `${state}: sort header must not set inline ${key}`);
        assert.equal(key in caretStyle, false, `${state}: caret must not set inline ${key}`);
      }
    }
  };
  inspect(tree, 'neutral');
  clickSort(tree); tree = settle(page);
  inspect(tree, 'ascending');
  pending.resolve(['Alpha', 'Beta']); await flush(); tree = page.render();
  clickSort(tree); tree = settle(page);
  inspect(tree, 'descending');
  pending.resolve(['Beta', 'Alpha']); await flush();
  page.dispose();
});

await check('the header stays clickable while the table body is busy', async () => {
  totalPages = 1;
  const { page } = await tableAt(user);
  let tree = page.render();

  clickSort(tree);
  tree = settle(page);
  assert.ok(busyCard(tree), 'the body is in its busy state');

  // The control is still live: it has a handler, is still focusable, and the
  // busy class lives on the card, never on the header.
  const header = renderedHeaders(tree)[0];
  assert.equal(typeof header.props.onClick, 'function', 'the click handler is still attached while busy');
  assert.equal(header.props.tabIndex, '0', 'the header is still focusable while busy');
  assert.equal(header.props.className.includes('table-busy'), false, 'the header itself is never dimmed');

  // And clicking it again really does drive another sort.
  startCounting();
  clickSort(tree, 1);
  tree = settle(page);
  assert.equal(sent.length, 1, 'sorting while busy issues its request');
  assert.equal(renderedHeaders(tree)[1].props['aria-sort'], 'ascending', 'the second column took the sort');
  page.dispose();
});

await check('label and click target are shared by the whole header', async () => {
  totalPages = 1;
  const { page } = await tableAt(user);
  const tree = page.render();
  for (const header of renderedHeaders(tree)) {
    assert.equal(typeof header.props.onClick, 'function', 'one handler covers label and icon');
    assert.equal(typeof header.props.onKeyDown, 'function', 'keyboard activation is available');
    assert.match(header.props.title, /^Sort by /);
    assert.equal(caretOf(header).props['aria-hidden'], 'true', 'the glyph is decorative; aria-sort carries the state');
    assert.ok(labelOf(header), 'the label keeps its own element');
  }
  page.dispose();
});


/* ---------------------------------------------------------------------------
   Candidates table column-width stability (Task 3.3).

   This harness does not lay out a document, so it cannot measure a rendered
   column. What it CAN prove is the structural contract that makes the widths
   stable, and that nothing about it varies with sort or busy state:

     - the table opts into the scoped fixed layout (`candidates-table`)
     - every column is NAMED with data-col, so a width cannot be reassigned by
       position when the secondary columns are hidden
     - that naming, and the table's class list, are identical in all sort
       states and while busy
     - long-text cells carry the `title` that makes truncation readable

   Real pixel geometry needs a browser; the widths themselves live in
   claude-system.css and are asserted there as a stylesheet contract below.
   ------------------------------------------------------------------------ */
import fsCols from 'node:fs';
const candidatesCss = fsCols.readFileSync(publicDir + 'claude-system.css', 'utf8');

const tableNode = (tree) => nodes(tree).find((n) => n.type === 'table');
const headerCells = (tree) => {
  const thead = nodes(tree).find((n) => n.type === 'thead');
  return nodes(thead).filter((n) => n.type === 'th' || (typeof n.type === 'function' && n.type.name === 'SortTh'));
};
// data-col for a plain <th>, or the `col` prop a <SortTh> will render as one.
const colKey = (n) => (n.type === 'th' ? n.props['data-col'] : n.props.col);
const colOrder = (tree) => headerCells(tree).map(colKey);

await check('the candidates table opts into the scoped fixed-width layout', async () => {
  totalPages = 1;
  const { page, tree } = await tableAt(user);
  const table = tableNode(tree);
  assert.ok(table, 'the table is rendered');
  assert.match(table.props.className, /\bcandidates-table\b/, 'the table carries its scoped class');
  // The strategy is scoped: fixed layout is applied to this table, not globally.
  assert.match(candidatesCss, /table\.candidates-table\s*\{[^}]*table-layout:\s*fixed/,
    'fixed layout is scoped to .candidates-table');
  assert.equal(/^table\.table\s*,[^{]*\{[^}]*table-layout:\s*fixed/m.test(candidatesCss), false,
    'fixed layout is NOT applied to every table');
  page.dispose();
});

await check('every column is named, so widths cannot be reassigned by position', async () => {
  totalPages = 1;
  const { page, tree } = await tableAt(user);
  const keys = colOrder(tree);
  assert.equal(keys.length, 9, 'all nine columns are present');
  assert.deepEqual(keys, ['select', 'name', 'position', 'university', 'graduation',
                          'location', 'request', 'stage', 'cv']);
  for (const key of keys) {
    assert.ok(key, 'no column is left unnamed');
    assert.match(candidatesCss, new RegExp(`th\\[data-col="${key}"\\][^}]*width:`),
      `column "${key}" has an intentional width`);
  }
  // Named, not positional: no nth-child sizing for this table.
  assert.equal(/\.candidates-table[^{]*nth-child\([0-9]+\)[^{]*\{[^}]*width:/.test(candidatesCss), false,
    'widths are keyed by name, not by column position');
  page.dispose();
});

await check('the widths are not equal thirds — they reflect each column purpose', () => {
  const width = (key) => {
    const m = candidatesCss.match(new RegExp(`th\\[data-col="${key}"\\]\\s*\\{\\s*width:\\s*([0-9.]+)%`));
    assert.ok(m, `column "${key}" declares a percentage width`);
    return Number(m[1]);
  };
  const w = Object.fromEntries(['select', 'name', 'position', 'university', 'graduation',
    'location', 'request', 'stage', 'cv'].map((k) => [k, width(k)]));
  assert.equal(Object.values(w).reduce((a, b) => a + b, 0), 100, 'the nine widths sum to 100%');
  assert.ok(new Set(Object.values(w)).size > 3, 'the columns are not simply divided equally');
  // Content-driven columns get the room; single-glyph columns stay compact.
  assert.ok(w.name > w.location, 'the identity column is wider than a plain text column');
  assert.ok(w.name > w.stage && w.position > w.stage, 'long text beats a single chip');
  assert.ok(w.select < w.graduation, 'the checkbox is the narrowest column');
  assert.ok(w.graduation < w.university, 'a four-digit year is narrower than a university name');
});

await check('sorting does not change the column strategy', async () => {
  totalPages = 1;
  const { page } = await tableAt(user);
  let tree = page.render();
  const snapshot = (t) => JSON.stringify({
    tableClass: tableNode(t).props.className,
    columns: colOrder(t),
  });

  const atNeutral = snapshot(tree);
  clickSort(tree);
  tree = settle(page);
  const whileBusy = snapshot(tree);
  assert.ok(busyCard(tree), 'the body really is busy at this point');
  pending.resolve(['Zebediah Ferdinand Alexandrovich', 'Al']); await flush(); tree = page.render();
  const atAscending = snapshot(tree);

  clickSort(tree);
  tree = settle(page);
  pending.resolve(['Al', 'Zebediah Ferdinand Alexandrovich']); await flush(); tree = page.render();
  const atDescending = snapshot(tree);

  assert.equal(atNeutral, whileBusy, 'the busy state does not alter the column configuration');
  assert.equal(atNeutral, atAscending, 'sorting ascending does not alter it');
  assert.equal(atAscending, atDescending, 'sorting descending does not alter it');
  page.dispose();
});

await check('wildly different name lengths do not change the column configuration', async () => {
  totalPages = 1;
  const page = mount(get('CandidatesPage'), { user, onNavigate() {} });
  page.render();
  pending.resolve(['Al']);
  await flush();
  let tree = page.render();
  showTable(tree);
  tree = page.render();
  const before = JSON.stringify({ cls: tableNode(tree).props.className, cols: colOrder(tree) });

  // A refetch whose content is far longer than before.
  clickSort(tree); tree = settle(page);
  pending.resolve(['Bartholomew Maximilian Fitzgerald-Wellington III', 'X']);
  await flush(); tree = page.render();
  const after = JSON.stringify({ cls: tableNode(tree).props.className, cols: colOrder(tree) });
  assert.equal(before, after, 'content length cannot influence the column strategy');
  page.dispose();
});

await check('long values truncate with a title rather than escaping the cell', async () => {
  totalPages = 1;
  const page = mount(get('CandidatesPage'), { user, onNavigate() {} });
  page.render();
  pending.resolve(['Bartholomew Maximilian Fitzgerald-Wellington III']);
  await flush();
  let tree = page.render();
  showTable(tree);
  tree = page.render();

  const named = nodes(tree).find((n) => n.props?.className === 'idcell-name');
  assert.ok(named, 'the name has its own truncating element');
  assert.equal(named.props.title, 'Bartholomew Maximilian Fitzgerald-Wellington III',
    'the full name is available as a tooltip');
  // The stylesheet is what actually truncates it.
  assert.match(candidatesCss, /\.candidates-table \.idcell-name[\s\S]{0,400}?text-overflow:\s*ellipsis/,
    'the name truncates with an ellipsis');
  assert.match(candidatesCss, /\.candidates-table[\s\S]{0,600}?white-space:\s*nowrap/,
    'truncating runs stay on one line');
  // Font size is never used as a fitting mechanism.
  assert.equal(/\.candidates-table[^{]*\{[^}]*font-size:/.test(candidatesCss), false,
    'no candidates-table rule changes font-size to make content fit');
  page.dispose();
});

await check('overflow is owned by the table wrapper, not the page', async () => {
  totalPages = 1;
  const { page, tree } = await tableAt(user);
  const wrap = nodes(tree).find((n) => n.props?.className === 'table-wrap');
  assert.ok(wrap, 'the table sits inside a local overflow wrapper');
  assert.ok(nodes(wrap).some((n) => n.type === 'table'), 'the table is inside that wrapper');
  assert.match(candidatesCss, /\.table-wrap[^{]*\{[^}]*overflow-x:\s*auto/,
    'the wrapper owns horizontal overflow');
  // A min-width belongs to the table, so the WRAPPER scrolls — never the page.
  assert.match(candidatesCss, /table\.candidates-table\s*\{[^}]*min-width:\s*\d+px/,
    'the table declares the width below which its wrapper scrolls');
  assert.equal(/\.candidates-table[^{]*\{[^}]*(100vw|position:\s*fixed)/.test(candidatesCss), false,
    'nothing in the strategy can create page-level overflow');
  page.dispose();
});

await check('the phone card layout releases the fixed widths', () => {
  const phone = candidatesCss.slice(candidatesCss.indexOf('@media (max-width: 640px)',
    candidatesCss.indexOf('17. CANDIDATES TABLE')));
  assert.match(phone, /table\.candidates-table\s*\{[^}]*table-layout:\s*auto/,
    'below 640px the rows stack as cards, so fixed columns are released');
  assert.match(phone, /table\.candidates-table\s*\{[^}]*min-width:\s*0/,
    'and the min-width is dropped so a card can be as narrow as the screen');
});


/* ---------------------------------------------------------------------------
   The secondary-column breakpoint (Task 3.4).

   Nine columns need 1020px of wrapper, and the wrapper gets viewport - 330px,
   so they stop fitting below 1350px. The product-wide rule only stepped the
   secondary columns aside at 1200px, which left a 1280px laptop scrolling ~70px
   with all nine still on screen. The candidates table now drops them at 1349px.

   Pixel geometry was verified in a real browser against the production
   stylesheets; what is asserted here is the structural contract that produces
   it, since this harness lays out no document.
   ------------------------------------------------------------------------ */

// The breakpoint block that belongs to this table.
const candidatesBreakpoint = (() => {
  const at = candidatesCss.indexOf('17. CANDIDATES TABLE');
  const section = candidatesCss.slice(at);
  const m = section.match(/@media \(max-width: (\d+)px\) and \(min-width: 641px\) \{([\s\S]*?)\n\}/);
  assert.ok(m, 'the candidates table declares a scoped secondary-column breakpoint');
  return { max: Number(m[1]), body: m[2] };
})();

await check('the candidates secondary columns step aside above the 1280 laptop', () => {
  assert.ok(candidatesBreakpoint.max > 1280,
    `the breakpoint must be above 1280 to clear that laptop, got ${candidatesBreakpoint.max}`);
  assert.ok(candidatesBreakpoint.max < 1440,
    `1440 must keep all nine columns, got ${candidatesBreakpoint.max}`);
  // Derived, not guessed: nine columns need the declared min-width, and the
  // wrapper gets viewport - 330px, so the breakpoint sits just under that sum.
  const nine = Number(candidatesCss.match(/table\.candidates-table \{[\s\S]*?min-width:\s*(\d+)px/)[1]);
  assert.equal(candidatesBreakpoint.max, nine + 330 - 1,
    `the breakpoint should be (${nine} + 330 - 1); change one and the other must follow`);
  assert.match(candidatesBreakpoint.body, /\[data-priority="secondary"\][^;]*display:\s*none/,
    'it reuses the existing data-priority mechanism rather than a new model');
  assert.match(candidatesBreakpoint.body, /min-width:\s*860px/,
    'and drops to the seven-column floor with them');
});

await check('the breakpoint is scoped — the product-wide 1200px rule is untouched', () => {
  assert.match(candidatesBreakpoint.body, /\.candidates-table \[data-priority="secondary"\]/,
    'the hide rule names this table');
  // The shared rule that every other responsive table relies on still sits at 1200.
  assert.match(candidatesCss,
    /@media \(max-width: 1200px\) and \(min-width: 641px\) \{\s*\.responsive-table \[data-priority="secondary"\] \{ display: none; \}/,
    'the product-wide secondary-column breakpoint is still 1200px');
});

await check('only University and Graduation are ever hidden; the operational columns stay', async () => {
  totalPages = 1;
  const { page, tree } = await tableAt(user);
  const cells = headerCells(tree);
  const secondary = cells.filter((n) => (n.type === 'th' ? n.props['data-priority'] : n.props.priority) === 'secondary');
  assert.deepEqual(secondary.map(colKey), ['university', 'graduation'],
    'exactly the two reference columns are marked secondary');
  // The columns an operator works from are never marked hideable.
  for (const key of ['select', 'name', 'position', 'location', 'request', 'stage', 'cv']) {
    const cell = cells.find((n) => colKey(n) === key);
    assert.ok(cell, `column "${key}" exists`);
    assert.notEqual((cell.type === 'th' ? cell.props['data-priority'] : cell.props.priority), 'secondary',
      `"${key}" must stay visible at every table width`);
  }
  page.dispose();
});


/* ---------------------------------------------------------------------------
   CV and Stage hold a FIXED-SIZE control (Task 3.3C).

   Everything above sizes columns for text, which can truncate. These two
   cannot: the CV cell holds a "Download" text button and Stage holds a status
   chip, and a button cannot be given an ellipsis. Both were sized on the wrong
   assumption and were clipped at every table width.

   The numbers below were MEASURED IN A REAL BROWSER against the production
   stylesheets — these assertions do not prove pixel fit and are not pretending
   to. What they prove is that the declared percentages still yield at least the
   measured requirement at the narrowest width each regime permits, so a later
   rebalance cannot quietly re-break it. Pixel fit itself was verified at 1440,
   1366, 1280, 1200, 1024, 768 and 390.
   ------------------------------------------------------------------------ */
const MEASURED = {
  downloadButton: 84,   // .btn.btn-ghost.btn-sm reading "Download"
  widestStageChip: 82,  // "Screening" — the longest of New / Screening / Fit / Unfit
  cellPadding: 24,      // td padding-left + padding-right
};
// Read a number out of the stylesheet, or report WHICH rule went missing.
// A bare match()[1] would throw at module scope and take the rest of the suite
// down with it, turning a removed rule into a crash instead of a verdict.
const num = (re, what) => {
  const m = candidatesCss.match(re);
  if (!m) { missingRules.push(what); return NaN; }
  return Number(m[1]);
};
const missingRules = [];
const pct = (key) => num(
  new RegExp(`th\\[data-col="${key}"\\]\\s*\\{ width: ([0-9.]+)%`), `${key} width`);
const nineColFloor = num(
  /table\.candidates-table \{[\s\S]*?min-width:\s*(\d+)px/, 'nine-column min-width');
// Read the DECLARATION, not the media condition — `(min-width: 641px)` in the
// query would otherwise be mistaken for the floor.
const sevenColFloor = num(
  /\.table-wrap > table\.candidates-table \{\s*min-width:\s*(\d+)px/,
  'seven-column min-width floor (.table-wrap > table.candidates-table)');

await check('every rule these guards depend on is present', () => {
  assert.deepEqual(missingRules, [], `missing from claude-system.css: ${missingRules.join(', ')}`);
});

await check('CV and Stage are allocated enough for their controls in the nine-column regime', () => {
  const needCv = MEASURED.downloadButton + MEASURED.cellPadding;      // 108
  const needStage = MEASURED.widestStageChip + MEASURED.cellPadding;  // 106
  const at = (key) => (pct(key) / 100) * nineColFloor;                // all nine visible
  assert.ok(at('cv') >= needCv,
    `CV gets ${Math.round(at('cv'))}px at the ${nineColFloor}px floor but the Download button needs ${needCv}px`);
  assert.ok(at('stage') >= needStage,
    `Stage gets ${Math.round(at('stage'))}px but the widest chip needs ${needStage}px`);
});

await check('CV and Stage are allocated enough once the secondary columns are hidden', () => {
  // With University and Graduation gone their share is redistributed, so each
  // remaining column's effective share is its percentage over the visible sum.
  const visibleSum = 100 - pct('university') - pct('graduation');
  const at = (key) => (pct(key) / visibleSum) * sevenColFloor;
  assert.ok(at('cv') >= MEASURED.downloadButton + MEASURED.cellPadding,
    `CV gets ${Math.round(at('cv'))}px at the ${sevenColFloor}px seven-column floor`);
  assert.ok(at('stage') >= MEASURED.widestStageChip + MEASURED.cellPadding,
    `Stage gets ${Math.round(at('stage'))}px at the ${sevenColFloor}px seven-column floor`);
});

await check('the seven-column floor outranks the product-wide min-width reset', () => {
  // `.table-wrap .responsive-table { min-width: 0 }` is two classes. A floor
  // written as `table.candidates-table` (one class + one element) loses to it,
  // which is exactly how the table compressed to 734px and clipped the button.
  assert.match(candidatesCss, /\.table-wrap > table\.candidates-table \{[^}]*min-width:\s*\d+px/,
    'the floor is declared with enough specificity to survive the product-wide reset');
  // And it must stay inside the min-width:641px block, or it would also win
  // against the phone card mode that deliberately releases the floor.
  assert.match(candidatesBreakpoint.body, /\.table-wrap > table\.candidates-table/,
    'the floor lives inside the 641px-and-up breakpoint, so card mode still releases it');
});

await check('no operational column was starved to pay for CV and Stage', () => {
  // Each of these was measured readable at the widths in the report; the guard
  // is that none of them falls back below the share it had when measured.
  const floors = { name: 20, position: 16, location: 11, request: 12, select: 4 };
  for (const [key, min] of Object.entries(floors)) {
    assert.ok(pct(key) >= min, `${key} must keep at least ${min}%, has ${pct(key)}%`);
  }
  // Secondary columns paid, but Graduation could not: 6% is only just enough
  // for a four-digit year at the nine-column floor.
  assert.ok(pct('graduation') >= 6, 'Graduation keeps the 6% a four-digit year needs');
  assert.ok(pct('university') >= 9, 'University keeps enough to be a useful truncating column');
});

/* ---------------------------------------------------------------------------
   One query change must cost exactly one request — for EVERY control.

   The sort header was fixed first (above). `filters`, `screenTab` and
   `pageSize` had the same defect for the same reason: `page` was reset by an
   effect watching them, so the reset landed in a SECOND render. The first
   render already carried the new query but the OLD page, so from page 3 a
   filter change sent

     /candidates?q=nadia&page=3&pageSize=50&sort=created&dir=desc
     /candidates?q=nadia&page=1&pageSize=50&sort=created&dir=desc

   — two requests, the first of them asking for a page that need not exist
   under the new filter.

   The reset now happens in the same event handler as the change, through the
   setFilters / setScreenTab / setPageSize wrappers, so React batches both into
   one render carrying the final intended query.
   ------------------------------------------------------------------------ */

const paramOf = (query, key) => new URLSearchParams(query.slice(query.indexOf('?') + 1)).get(key);

// Render, answer whatever the page asked for, and repeat until it stops asking.
// Mounting with `initialFilters` legitimately costs two round trips (the state
// initialiser, then the prop-sync effect), so the setup must not assume one.
async function quiesce(p) {
  let tree = p.render();
  for (let i = 0; i < 8 && pending; i++) {
    const inFlight = pending; pending = null;
    inFlight.resolve(['Alpha', 'Beta']);
    await flush();
    tree = p.render();
  }
  return tree;
}

// A mounted CandidatesPage sitting on `target`, reached through the real pager.
async function candidatesAtPage(target, { initialFilters, view = 'table', pickTab } = {}) {
  totalPages = 5;
  const p = mount(get('CandidatesPage'), { user, onNavigate() {}, initialFilters });
  let tree = await quiesce(p);
  showTable(tree);                       // the pager exists in every view but pipeline
  tree = await quiesce(p);
  // Any tab has to be chosen BEFORE walking to the page: choosing one is itself
  // a query change, so it returns to page 1 and would undo the walk.
  if (pickTab) {
    screenTabs(tree).find((b) => text(b).startsWith(pickTab)).props.onClick();
    tree = await quiesce(p);
    assert.equal(paramOf(sent[sent.length - 1], 'screeningStatus'), pickTab.toLowerCase(),
      `the ${pickTab} tab really was selected`);
  }
  if (target > 1) {
    byName(tree, 'Pager')[0].props.onPage(target);
    tree = await quiesce(p);
    assert.equal(pageOf(sent[sent.length - 1]), String(target), `the pager really moved to page ${target}`);
  }
  if (view !== 'table') {
    byName(tree, 'ViewToggle')[0].props.onChange(view);
    tree = await quiesce(p);
  }
  return { p, tree };
}

const searchBox = (tree) => byName(tree, 'FilterToolbar')[0].props.search;
const screenTabs = (tree) => nodes(tree).filter((n) => n.type === 'button' && n.props?.className?.includes?.('seg-tab'));

await check('a filter change from page 3 sends one request, and it asks for page 1', async () => {
  const { p, tree } = await candidatesAtPage(3);
  startCounting();
  searchBox(tree).props.onChange({ target: { value: 'nadia' } });
  const after = settle(p, 3);
  assert.equal(sent.length, 1,
    `one filter change must send one request, sent ${sent.length}: ${sent.join(' | ')}`);
  assert.equal(pageOf(sent[0]), '1', `the single request asks for page 1, not the stale page 3: ${sent[0]}`);
  assert.equal(paramOf(sent[0], 'q'), 'nadia', 'and it carries the new filter');
  assert.equal(tables(after).length, 1, 'the table stayed mounted');
  assert.equal(skeletons(after).length, 0, 'no skeleton replaced the table');
  p.dispose();
});

await check('every secondary filter input behaves the same from page 3', async () => {
  const probe = await candidatesAtPage(1);
  const count = nodes(byName(probe.tree, 'FilterToolbar')[0]).filter((n) => n.type === 'input').length;
  probe.p.dispose();
  assert.ok(count >= 6, `the toolbar still offers its inputs (found ${count})`);
  for (let i = 0; i < count; i++) {
    const { p, tree } = await candidatesAtPage(3);
    const input = nodes(byName(tree, 'FilterToolbar')[0]).filter((n) => n.type === 'input')[i];
    const what = input.props.placeholder || `input #${i + 1}`;
    startCounting();
    input.props.onChange({ target: { value: '7' } });
    settle(p, 3);
    assert.equal(sent.length, 1, `“${what}” must send one request, sent ${sent.length}: ${sent.join(' | ')}`);
    assert.equal(pageOf(sent[0]), '1', `“${what}” must return to page 1: ${sent[0]}`);
    p.dispose();
  }
});

await check('a screen-tab change from page 4 sends one request, and it asks for page 1', async () => {
  const { p, tree } = await candidatesAtPage(4);
  const tabs = screenTabs(tree);
  assert.equal(tabs.length, 5, 'all five screen tabs are on the page');
  const screening = tabs.find((b) => text(b).startsWith('Screening'));
  startCounting();
  screening.props.onClick();
  const after = settle(p, 3);
  assert.equal(sent.length, 1,
    `one tab click must send one request, sent ${sent.length}: ${sent.join(' | ')}`);
  assert.equal(pageOf(sent[0]), '1', `the single request asks for page 1, not the stale page 4: ${sent[0]}`);
  assert.equal(paramOf(sent[0], 'screeningStatus'), 'screening', 'and it carries the new tab');
  assert.equal(tables(after).length, 1, 'the table stayed mounted');
  p.dispose();
});

await check('changing the page size sends one request, with the new size and page 1', async () => {
  const { p, tree } = await candidatesAtPage(3);
  startCounting();
  byName(tree, 'Pager')[0].props.onPageSize(25);
  settle(p, 3);
  assert.equal(sent.length, 1,
    `one page-size change must send one request, sent ${sent.length}: ${sent.join(' | ')}`);
  assert.equal(paramOf(sent[0], 'pageSize'), '25', 'the request carries the new page size');
  assert.equal(pageOf(sent[0]), '1', `page 3 of fifty-row pages is not page 3 of twenty-five-row pages: ${sent[0]}`);
  p.dispose();
});

await check('clearing one filter chip sends one request, for page 1 without that filter', async () => {
  const { p, tree } = await candidatesAtPage(3, { initialFilters: { q: 'nadia' } });
  assert.equal(paramOf(sent[sent.length - 1], 'q'), 'nadia', 'the filter really was applied');
  const chip = nodes(tree).find((n) => /^Remove .* filter$/.test(n.props?.['aria-label'] || ''));
  assert.ok(chip, 'an active filter shows a chip with a remove button');
  startCounting();
  chip.props.onClick();
  settle(p, 3);
  assert.equal(sent.length, 1,
    `clearing one filter must send one request, sent ${sent.length}: ${sent.join(' | ')}`);
  assert.equal(pageOf(sent[0]), '1', `the single request asks for page 1: ${sent[0]}`);
  assert.equal(paramOf(sent[0], 'q'), null, 'and the filter is gone');
  p.dispose();
});

await check('clear-all sends one request, for page 1 with nothing set', async () => {
  // A filter AND a tab to undo, and back out on page 3 when it is undone.
  const { p, tree } = await candidatesAtPage(3, { initialFilters: { q: 'nadia' }, pickTab: 'New' });
  let t = tree;
  assert.equal(paramOf(sent[sent.length - 1], 'screeningStatus'), 'new', 'the tab survived the walk to page 3');
  const clearAll = nodes(t).find((n) => n.type === 'button' && text(n) === 'Clear all');
  assert.ok(clearAll, 'the chips row offers Clear all');
  startCounting();
  clearAll.props.onClick();
  t = settle(p, 3);
  assert.equal(sent.length, 1,
    `clear-all must send one request, sent ${sent.length}: ${sent.join(' | ')}`);
  assert.equal(pageOf(sent[0]), '1', `the single request asks for page 1: ${sent[0]}`);
  assert.equal(paramOf(sent[0], 'q'), null, 'the filter is gone');
  assert.equal(paramOf(sent[0], 'screeningStatus'), null, 'the tab is back to All');
  p.dispose();
});

await check('the pipeline view search box resets the page like any other filter', async () => {
  const { p, tree } = await candidatesAtPage(3, { view: 'pipeline' });
  const pipeline = byName(tree, 'TalentPipeline')[0];
  assert.ok(pipeline && pipeline.props.setQ, 'the pipeline owns a search box that writes filters.q');
  startCounting();
  pipeline.props.setQ('nadia');
  settle(p, 3);
  assert.equal(sent.length, 1,
    `the pipeline search must send one request, sent ${sent.length}: ${sent.join(' | ')}`);
  assert.equal(pageOf(sent[0]), '1', `the single request asks for page 1: ${sent[0]}`);
  assert.equal(paramOf(sent[0], 'q'), 'nadia');
  p.dispose();
});

await check('paging itself is NOT reset — the one query change that keeps its page', async () => {
  const { p, tree } = await candidatesAtPage(1);
  startCounting();
  byName(tree, 'Pager')[0].props.onPage(4);
  settle(p, 3);
  assert.equal(sent.length, 1, `one pager click must send one request, sent ${sent.length}: ${sent.join(' | ')}`);
  assert.equal(pageOf(sent[0]), '4', 'the pager still reaches the page it was asked for');
  p.dispose();
});

/* ---------------------------------------------------------------------------
   Coverage. The controls are discovered from the rendered tree rather than
   listed by hand, so a filter added tomorrow is swept without anyone having to
   remember this file: it appears in the enumeration and must reset the page
   like the rest. Both views are swept, because the toolbar, the tabs, the
   chips and the pager live outside pipeline view and the pipeline's own search
   box lives inside it.
   ------------------------------------------------------------------------ */

// Everything on the page that changes the SERVER query. `onPage` is excluded
// on purpose: paging is the one query change that must keep its page, and it
// has its own check above.
function queryControls(tree) {
  const found = [];
  const toolbar = byName(tree, 'FilterToolbar')[0];
  if (toolbar) {
    for (const el of nodes(toolbar).filter((n) => n.type === 'input' && n.props?.onChange)) {
      found.push({ what: `filter input “${el.props.placeholder || '(unnamed)'}”`,
        fire: () => el.props.onChange({ target: { value: '7' } }) });
    }
  }
  for (const el of screenTabs(tree)) {
    found.push({ what: `screen tab “${text(el)}”`, fire: () => el.props.onClick() });
  }
  for (const el of nodes(tree).filter((n) => /^Remove .* filter$/.test(n.props?.['aria-label'] || ''))) {
    found.push({ what: `chip “${el.props['aria-label']}”`, fire: () => el.props.onClick() });
  }
  for (const el of nodes(tree).filter((n) => n.type === 'button' && (text(n) === 'Clear all' || text(n) === 'Clear'))) {
    found.push({ what: `“${text(el)}” button`, fire: () => el.props.onClick() });
  }
  const pager = byName(tree, 'Pager')[0];
  if (pager) found.push({ what: 'page size', fire: () => pager.props.onPageSize(25) });
  const pipeline = byName(tree, 'TalentPipeline')[0];
  if (pipeline && pipeline.props.setQ) found.push({ what: 'pipeline search', fire: () => pipeline.props.setQ('nadia') });
  return found;
}

await check('EVERY query-changing control on the page returns to page 1 in exactly one request', async () => {
  const swept = [];
  for (const view of ['table', 'pipeline']) {
    const opts = { view, initialFilters: { q: 'nadia' } };   // a live filter, so the chips exist
    const probe = await candidatesAtPage(3, opts);
    const menu = queryControls(probe.tree);
    probe.p.dispose();
    assert.ok(menu.length > 0, `${view} view exposes no query-changing control — the sweep found nothing to check`);

    for (let i = 0; i < menu.length; i++) {
      const { p, tree } = await candidatesAtPage(3, opts);
      const controls = queryControls(tree);
      assert.equal(controls.length, menu.length, 'the control list is stable across mounts');
      assert.equal(controls[i].what, menu[i].what, 'the control list is in a stable order');
      startCounting();
      controls[i].fire();
      settle(p, 3);
      const trace = sent.join(' | ') || '(no request at all)';
      assert.equal(sent.length, 1,
        `${view} view — ${controls[i].what} must send exactly one request, sent ${sent.length}: ${trace}`);
      assert.equal(pageOf(sent[0]), '1',
        `${view} view — ${controls[i].what} did not return to page 1: ${trace}`);
      p.dispose();
      swept.push(`${view}/${controls[i].what}`);
    }
  }
  assert.ok(swept.length >= 14, `the sweep should reach every control; it reached ${swept.length}`);
  console.log(`      swept ${swept.length}: ${swept.join(', ')}`);
});

await check('the page reset cannot be bypassed — each raw setter has exactly one caller', async () => {
  const source = fs.readFileSync(publicDir + 'app.jsx', 'utf8');
  const start = source.indexOf('function CandidatesPage(');
  const end = source.indexOf('\nfunction ', start + 1);
  assert.ok(start > 0 && end > start, 'CandidatesPage was located in the source');
  const code = source.slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');

  for (const raw of ['setFiltersRaw', 'setScreenTabRaw', 'setPageSizeRaw']) {
    const hits = code.match(new RegExp(`\\b${raw}\\b`, 'g')) || [];
    assert.equal(hits.length, 2,
      `${raw} must appear exactly twice — its useState declaration and its one wrapper — found ${hits.length}. ` +
      'Calling a raw setter anywhere else skips the page reset.');
    const caller = code.split('\n').find((line) => line.includes(raw) && !line.includes('useState'));
    assert.match(caller, /setPage\(1\)/,
      `the only caller of ${raw} must return to page 1 in the same handler: ${caller.trim()}`);
  }
  assert.ok(!/useEffect\(\(\)\s*=>\s*\{\s*setPage\(1\)/.test(code),
    'the page reset must not go back into an effect — that is the two-request bug');
  assert.match(code, /onPage=\{setPage\}/, 'the pager still gets the raw setPage: paging must not reset itself');
});

console.log(`\n=== UI SORT STABILITY: ${passed} passed, ${failed} failed ===`);
if (failed) process.exit(1);
