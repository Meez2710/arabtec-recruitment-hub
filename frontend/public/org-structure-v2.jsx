/* Organization Structure v2 page (docs/org-chart/ORG_CHART_V2_PLAN.md sections 2 and 4).
   Registered as window.ArabtecOrgStructureV2Page; window.ArabtecOrgStructureV2Gate picks it only
   when the server flag org_chart_v2 is on, and falls back to the v1 page otherwise.
   The connector engine (routeOf / elbowPts / autoRoute / fixEnds / segment drag / end-dot reconnect /
   arrowHead) is ported from docs/org-chart/reference/prototype-org-chart-builder.html. */
(function () {
  const { useState, useEffect, useMemo, useRef, useCallback } = React;

  function api() { return window.ARABTEC_API; }

  /* ------------------------------ constants ------------------------------ */
  const PAGE_W = 1190, PAGE_H = 842;          // A3 landscape in points (world units)
  const SNAP = 4.5, PAD = 4.5, LH = 9.6, FS = 8, DEFAULT_W = 81;
  const MAROON = '#860915', JOIN_RED = '#E0161B';
  const BAND = { x: 14.4, w: 1161.2, hy: 25, hh: 52, fy: 801, fh: 28 };
  const GAPX = 12, GAPY = 24, COLGAP = 10, BUS = 10, TOP_Y = 92;
  const SIDES = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] };
  const BOX_FONT = 'Arial, "Liberation Sans", Helvetica, sans-serif';
  const HEAD_FONT = 'Calibri, Carlito, Arial, "Liberation Sans", sans-serif';
  // Soft-warning thresholds (plan section 4). No client-readable system_setting getter exists yet, so constants.
  const LIMITS = { spanMax: 12, spanMin: 3, layersMax: 6 };
  const ARRANGES = [['row', 'Row'], ['col-left', 'Column left'], ['col-right', 'Column right'], ['two-col', 'Two columns']];
  const SCOPE_LABEL = { project: 'Project charts', head_office: 'Head Office', department: 'Department charts' };
  const STATE_LABEL = { draft: 'Draft', pending_approval: 'Waiting for approval', published: 'Published', superseded: 'Superseded' };

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const near = (a, b) => Math.abs(a - b) < 0.5;
  const r1 = (n) => Math.round(n * 10) / 10;
  const snap = (n) => Math.round(n / SNAP) * SNAP;
  const uid = () => 'b' + Math.random().toString(36).slice(2, 8);
  const pad2 = (n) => String(n).padStart(2, '0');
  function ddmm(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? m[3] + '/' + m[2] : ''; }
  function ddmmyyyy(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? m[3] + '/' + m[2] + '/' + m[1] : ''; }
  const todayISO = () => { const d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); };
  function canManageChart(user) { return !!(user && user.permissions && user.permissions.includes('org_chart.manage')); }
  function isHrDirector(user) { return !!(user && user.roles && user.roles.includes('hr_director')); }
  function errText(e, fallback) { return (e && e.message) || fallback || 'Something went wrong. Please try again.'; }

  /* --------------------------- text measuring ---------------------------- */
  let mctx = null;
  const widthCache = new Map();
  function textW(s, bold) {
    const k = (bold ? 'b' : 'n') + s;
    let w = widthCache.get(k);
    if (w == null) {
      if (!mctx) mctx = document.createElement('canvas').getContext('2d');
      mctx.font = (bold ? 'bold ' : '') + FS + 'px ' + BOX_FONT;
      w = mctx.measureText(s).width;
      if (widthCache.size > 5000) widthCache.clear();
      widthCache.set(k, w);
    }
    return w;
  }
  function wrap(s, maxW, bold) {
    const out = [];
    let line = '';
    for (let word of String(s).split(/\s+/).filter(Boolean)) {
      while (textW(word, bold) > maxW && word.length > 1) {           // break a word that can never fit
        let n = word.length - 1;
        while (n > 1 && textW(word.slice(0, n), bold) > maxW) n--;
        if (line) { out.push(line); line = ''; }
        out.push(word.slice(0, n)); word = word.slice(n);
      }
      const t = line ? line + ' ' + word : word;
      if (line && textW(t, bold) > maxW) { out.push(line); line = word; } else line = t;
    }
    if (line || !out.length) out.push(line);
    return out;
  }

  /* ------------------------ box content (plan section 2) ------------------ */
  function countLine(b) {
    if (b.countLabel) return b.countLabel;
    if (!b.planned) return '';
    return 'X' + b.planned + (b.shared ? ' Shared' : '') + (b.zati ? ' zati' : '');
  }
  // One logical line per person: "- name" + " – suffix", joiners red with dd/mm until their date.
  function personLine(a, today) {
    const joining = a.status === 'joining' && (!a.effectiveDate || a.effectiveDate >= today);
    let t = '- ' + a.personName + (a.suffix ? ' – ' + a.suffix : '');
    if (joining && a.effectiveDate) t += ' ' + ddmm(a.effectiveDate);
    return { t, red: joining };
  }
  function boxModel(b, people, today) {
    const w = b.w || DEFAULT_W, inner = w - 2 * PAD, lines = [];
    const add = (t, red, bold) => wrap(t, inner, bold).forEach((l) => lines.push({ t: l, red: !!red }));
    if (b.kind === 'text') {
      String(b.text || '').split('\n').forEach((p) => (p.trim() ? add(p, false, false) : lines.push({ t: '', red: false })));
      if (!lines.length) lines.push({ t: '', red: false });
    } else {
      add(b.title || 'Untitled', false, true);
      if (b.kind === 'role') {
        const c = countLine(b);
        if (c) add(c, false, true);
        if (b.proposed > 0) add('Proposed X' + b.proposed, false, true);
        (people || []).forEach((a) => { const l = personLine(a, today); add(l.t, l.red, true); });
      }
    }
    return { w, h: lines.length * LH + 2 * PAD, lines, left: b.kind === 'text', dashed: b.kind === 'role' && b.proposed > 0 };
  }

  /* ------------------------------ geometry -------------------------------- */
  function buildGeo(page, peopleByBox, today) {
    const geo = new Map();
    for (const b of page.boxes) {
      const m = boxModel(b, peopleByBox.get(b.key), today);
      geo.set(b.key, { b, x: b.x, y: b.y, w: m.w, h: m.h, m });
    }
    return geo;
  }
  const anchor = (g, side) => {
    switch (side) {
      case 'top': return [g.x + g.w / 2, g.y];
      case 'left': return [g.x, g.y + g.h / 2];
      case 'right': return [g.x + g.w, g.y + g.h / 2];
      default: return [g.x + g.w / 2, g.y + g.h];
    }
  };
  function sideAt(g, pt) {
    const dx = (pt[0] - (g.x + g.w / 2)) / (g.w / 2), dy = (pt[1] - (g.y + g.h / 2)) / (g.h / 2);
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'bottom' : 'top');
  }
  function sideOfPt(g, pt) { // which side of g a route end touches
    let best = 'bottom', d = Infinity;
    for (const s of ['top', 'bottom', 'left', 'right']) { const a = anchor(g, s), dd = Math.hypot(a[0] - pt[0], a[1] - pt[1]); if (dd < d) { d = dd; best = s; } }
    return best;
  }

  /* --------------------- connector engine (from prototype) ---------------- */
  function simplifyPts(L) {
    const out = [];
    for (const q of L) { const t = out[out.length - 1]; if (t && near(t[0], q[0]) && near(t[1], q[1])) continue; out.push([q[0], q[1]]); }
    for (let i = out.length - 2; i >= 1; i--) {
      const a = out[i - 1], b = out[i], c = out[i + 1];
      if ((near(a[0], b[0]) && near(b[0], c[0])) || (near(a[1], b[1]) && near(b[1], c[1]))) out.splice(i, 1);
    }
    return out;
  }
  function autoRoute(S, sn, E, en) {
    const st = 9, S1 = [S[0] + sn[0] * st, S[1] + sn[1] * st], E1 = [E[0] + en[0] * st, E[1] + en[1] * st];
    const sv = sn[0] === 0, ev = en[0] === 0;
    let mid;
    if (sv && ev) { const my = (S1[1] + E1[1]) / 2; mid = [[S1[0], my], [E1[0], my]]; }
    else if (!sv && !ev) { const mx = (S1[0] + E1[0]) / 2; mid = [[mx, S1[1]], [mx, E1[1]]]; }
    else if (sv) mid = [[S1[0], E1[1]]]; else mid = [[E1[0], S1[1]]];
    return simplifyPts([S, S1, ...mid, E1, E]);
  }
  // keep a hand-drawn route attached when a box at either end moves
  function fixEnds(P, S, E) {
    const Q = P.map((q) => [q[0], q[1]]), k = Q.length;
    if (k < 2) return Q;
    if (near(Q[0][1], Q[1][1])) Q[0][0] = S[0]; else Q[0][1] = S[1];
    if (near(Q[k - 2][1], Q[k - 1][1])) Q[k - 1][0] = E[0]; else Q[k - 1][1] = E[1];
    return Q;
  }
  // default route of a reporting line: parent bottom-centre, bus in the gap, child top-centre.
  function elbowPts(p, c, arrange) {
    const x1 = p.x + p.w / 2, y1 = p.y + p.h, x2 = c.x + c.w / 2, y2 = c.y;
    const colSide = arrange === 'col-right' ? 'left' : arrange === 'col-left' ? 'right' : arrange === 'two-col' ? (x2 < x1 ? 'right' : 'left') : null;
    if (colSide && y2 > y1 + 4) {
      const ex = colSide === 'left' ? c.x : c.x + c.w, cy = c.y + c.h / 2;
      if ((colSide === 'left' && ex > x1 + 2) || (colSide === 'right' && ex < x1 - 2)) return [[x1, y1], [x1, cy], [ex, cy]];
    }
    if (y2 > y1 + 8) {
      const gap = y2 - y1, my = gap <= GAPY * 1.5 ? y1 + gap / 2 : y2 - GAPY / 2;
      return near(x1, x2) ? [[x1, y1], [x2, y2]] : [[x1, y1], [x1, my], [x2, my], [x2, y2]];
    }
    const right = c.x > p.x, sx = right ? p.x + p.w : p.x, ex = right ? c.x : c.x + c.w;
    const sy = p.y + p.h / 2, ey = c.y + c.h / 2, mx = (sx + ex) / 2;
    return [[sx, sy], [mx, sy], [mx, ey], [ex, ey]];
  }
  const isCustom = (L) => !!(L && ((L.points && L.points.length) || L.style === 'manual' || (L.fromSide && L.fromSide !== 'bottom') || (L.toSide && L.toSide !== 'top')));
  function routeOf(p, c, L, arrange, raw) {
    let fs, ts, pts;
    if (!isCustom(L)) {
      pts = elbowPts(p, c, arrange);
      fs = sideOfPt(p, pts[0]); ts = sideOfPt(c, pts[pts.length - 1]);
      return { pts, fs, ts, custom: false };
    }
    fs = L.fromSide || 'bottom'; ts = L.toSide || 'top';
    const S = anchor(p, fs), E = anchor(c, ts), lp = L.points && L.points.length >= 2 ? L.points.map((q) => [q.x, q.y]) : null;
    pts = lp ? [S, ...(raw ? lp : fixEnds(lp, S, E)), E] : autoRoute(S, SIDES[fs], E, SIDES[ts]);
    return { pts, fs, ts, custom: true };
  }
  function arrowHead(pts, size) {
    const E = pts[pts.length - 1];
    let A = pts[0];
    for (let i = pts.length - 2; i >= 0; i--) if (Math.hypot(E[0] - pts[i][0], E[1] - pts[i][1]) > 1) { A = pts[i]; break; }
    const ang = Math.atan2(E[1] - A[1], E[0] - A[0]), w = size * 0.4;
    const bx = E[0] - size * Math.cos(ang), by = E[1] - size * Math.sin(ang);
    return [E, [bx + w * Math.sin(ang), by - w * Math.cos(ang)], [bx - w * Math.sin(ang), by + w * Math.cos(ang)]];
  }
  const ptsD = (pts) => 'M' + pts.map((q) => r1(q[0]) + ',' + r1(q[1])).join(' L');

  /* All reporting lines of a page: { key (child), parent, route }. Hidden branches are skipped. */
  function pageLines(page, geo, hidden, rawKey) {
    const out = [];
    const linkOf = new Map(page.links.filter((l) => l.kind !== 'dotted').map((l) => [l.childKey, l]));
    for (const b of page.boxes) {
      if (hidden.has(b.key) || !b.parentKey) continue;
      const p = geo.get(b.parentKey), c = geo.get(b.key);
      if (!p || !c) continue;
      out.push({ key: b.key, parent: b.parentKey, route: routeOf(p, c, linkOf.get(b.key), p.b.arrange || null, rawKey === b.key) });
    }
    return out;
  }
  const setLink = (page, key, patch) => {
    let L = page.links.find((l) => l.childKey === key && l.kind !== 'dotted');
    if (!L) { L = { childKey: key, kind: 'reports', fromSide: 'bottom', toSide: 'top' }; page.links.push(L); }
    Object.assign(L, patch);
    for (const k of Object.keys(patch)) if (patch[k] === undefined) delete L[k];
    return L;
  };
  const resetLink = (page, key) => { page.links = page.links.filter((l) => !(l.childKey === key && l.kind !== 'dotted')); };

  /* ------------------------------- tree helpers --------------------------- */
  const childrenOf = (page, key) => page.boxes.filter((b) => b.parentKey === key);
  function descendants(page, key) {
    const out = new Set(), q = [key];
    while (q.length) { const k = q.pop(); for (const c of childrenOf(page, k)) if (!out.has(c.key)) { out.add(c.key); q.push(c.key); } }
    return out;
  }
  const wouldCycle = (page, key, newParent) => newParent === key || descendants(page, key).has(newParent);

  function shapeOf(pages) {
    const boxes = pages.flatMap((p) => p.boxes), byKey = new Map(boxes.map((b) => [b.key, b]));
    const kids = new Map();
    for (const b of boxes) if (b.parentKey && byKey.has(b.parentKey)) { if (!kids.has(b.parentKey)) kids.set(b.parentKey, []); kids.get(b.parentKey).push(b); }
    const depth = (k, seen = new Set()) => { const p = byKey.get(k).parentKey; return p && byKey.has(p) && !seen.has(p) ? 1 + depth(p, seen.add(p)) : 1; };
    let layers = 0, widest = 0;
    for (const b of boxes) layers = Math.max(layers, depth(b.key));
    for (const [, list] of kids) widest = Math.max(widest, list.filter((c) => !c.zati).length);
    return { layers, widest, kids, byKey };
  }
  function computeMetrics(pages, assignments) {
    const boxes = pages.flatMap((p) => p.boxes).filter((b) => b.kind === 'role');
    const by = new Map();
    for (const a of assignments) { if (!by.has(a.boxKey)) by.set(a.boxKey, []); by.get(a.boxKey).push(a); }
    let planned = 0, proposed = 0, open = 0, inPost = 0, joining = 0;
    for (const b of boxes) {
      const list = by.get(b.key) || [];
      const ip = list.filter((a) => a.status !== 'joining').length, jn = list.filter((a) => a.status === 'joining').length;
      planned += b.planned; proposed += b.proposed; inPost += ip; joining += jn;
      open += Math.max(0, b.planned - ip - jn);
    }
    const sh = shapeOf(pages);
    return { planned, inPost, joining, open, proposed, layers: sh.layers, widest: sh.widest };
  }
  function computeWarnings(pages, assignments) {
    const sh = shapeOf(pages), w = new Map();
    const add = (k, msg) => { if (!w.has(k)) w.set(k, []); w.get(k).push(msg); };
    for (const [k, list] of sh.kids) {
      const staff = list.filter((c) => !c.zati).length;
      if (staff > LIMITS.spanMax) add(k, 'Manages ' + staff + ' boxes (more than ' + LIMITS.spanMax + ').');
      else if (staff > 0 && staff < LIMITS.spanMin) add(k, 'Manages only ' + staff + (staff === 1 ? ' box' : ' boxes') + ' (fewer than ' + LIMITS.spanMin + ').');
      const b = sh.byKey.get(k);
      if (b.kind === 'role' && !assignments.some((a) => a.boxKey === k && a.status === 'in_post')) add(k, 'Manager box with nobody in post.');
    }
    for (const b of sh.byKey.values()) {
      let d = 1, p = b.parentKey, seen = new Set();
      while (p && sh.byKey.has(p) && !seen.has(p)) { d++; seen.add(p); p = sh.byKey.get(p).parentKey; }
      if (d > LIMITS.layersMax && !sh.kids.has(b.key)) add(b.key, 'More than ' + LIMITS.layersMax + ' layers deep.');
    }
    return w;
  }

  /* --------------------------------- auto layout -------------------------- */
  // Returns Map key -> {x,y}. keys=null: whole page. Otherwise: subtrees of the given roots keep their root in place.
  function autoLayout(page, geo, rootKeys) {
    const keySet = new Set(page.boxes.map((b) => b.key));
    const byKey = new Map(page.boxes.map((b) => [b.key, b]));
    const size = (k) => geo.get(k);
    const kidsOf = (k, mode) => {
      const list = page.boxes.filter((b) => b.parentKey === k);
      return list.sort(mode && mode.startsWith('col') ? (a, b) => a.y - b.y || a.x - b.x : (a, b) => a.x - b.x || a.y - b.y);
    };
    const AVAIL = BAND.w - 20;
    function block(key, inh) {
      const sz = size(key), own = byKey.get(key).arrange;
      const mode = own || (inh && inh.startsWith('col') ? inh : 'row');
      const ch = kidsOf(key, mode);
      if (!ch.length) return { items: [{ key, x: 0, y: 0 }], w: sz.w, h: sz.h, rl: 0 };
      const bs = ch.map((c) => block(c.key, mode.startsWith('col') ? mode : null));
      const items = [];
      let rootLeft = 0, cx = 0;
      const put = (b, x, y) => b.items.forEach((it) => items.push({ key: it.key, x: it.x + x, y: it.y + y }));
      if (mode === 'row') {
        const rows = [];
        let cur = [], cw = 0;
        bs.forEach((b) => { if (cur.length && cw + GAPX + b.w > AVAIL) { rows.push(cur); cur = []; cw = 0; } cur.push(b); cw += (cur.length > 1 ? GAPX : 0) + b.w; });
        if (cur.length) rows.push(cur);
        const rw = rows.map((r) => r.reduce((s, b) => s + b.w, 0) + GAPX * (r.length - 1));
        const maxW = Math.max(...rw);
        let y = sz.h + GAPY;
        rows.forEach((r, ri) => {
          let x = (maxW - rw[ri]) / 2;
          const centres = [];
          r.forEach((b) => { put(b, x, y); centres.push(x + b.rl + size(ch[bs.indexOf(b)].key).w / 2); x += b.w + GAPX; });
          if (ri === 0) cx = (centres[0] + centres[centres.length - 1]) / 2;
          y += Math.max(...r.map((b) => b.h)) + GAPY;
        });
        rootLeft = cx - sz.w / 2;
      } else {
        const left = [], right = [];
        if (mode === 'two-col') bs.forEach((b, i) => (i % 2 ? right : left).push(b));
        else (mode === 'col-left' ? left : right).push(...bs);
        const y0 = sz.h + GAPY;
        const stack = (list, dirRight) => {
          let y = y0;
          list.forEach((b) => {
            const csz = size(ch[bs.indexOf(b)].key);
            const x = dirRight ? BUS - b.rl : -BUS - (b.rl + csz.w);
            put(b, x, y);
            y += b.h + COLGAP;
          });
        };
        stack(left, false); stack(right, true);
        // a stacked child with its own row of reports is wider than its box: root-aligned columns keep the box edge on the bus line
        rootLeft = -sz.w / 2;
      }
      items.push({ key, x: rootLeft, y: 0 });
      const minX = Math.min(...items.map((i) => i.x));
      items.forEach((i) => { i.x -= minX; });
      let maxR = 0, maxB = 0;
      items.forEach((i) => { const s = size(i.key); maxR = Math.max(maxR, i.x + s.w); maxB = Math.max(maxB, i.y + s.h); });
      return { items, w: maxR, h: maxB, rl: rootLeft - minX };
    }
    const out = new Map();
    const topKeys = rootKeys
      ? rootKeys.filter((k) => { let p = byKey.get(k).parentKey; while (p && keySet.has(p)) { if (rootKeys.includes(p)) return false; p = byKey.get(p).parentKey; } return true; })
      : page.boxes.filter((b) => !b.parentKey || !keySet.has(b.parentKey)).sort((a, b) => a.x - b.x || a.y - b.y).map((b) => b.key);
    if (rootKeys) {
      topKeys.forEach((k) => {
        const g = size(k), bl = block(k, null);
        bl.items.forEach((it) => out.set(it.key, { x: r1(g.x + it.x - bl.rl), y: r1(g.y + it.y) }));
      });
      return out;
    }
    const blocks = topKeys.map((k) => block(k, null));
    const rows = [];
    let cur = [], cw = 0;
    blocks.forEach((b) => { if (cur.length && cw + GAPX * 2 + b.w > AVAIL) { rows.push(cur); cur = []; cw = 0; } cur.push(b); cw += (cur.length > 1 ? GAPX * 2 : 0) + b.w; });
    if (cur.length) rows.push(cur);
    let y = TOP_Y;
    rows.forEach((r) => {
      const tw = r.reduce((s, b) => s + b.w, 0) + GAPX * 2 * (r.length - 1);
      let x = PAGE_W / 2 - tw / 2;
      r.forEach((b) => { b.items.forEach((it) => out.set(it.key, { x: r1(x + it.x), y: r1(y + it.y) })); x += b.w + GAPX * 2; });
      y += Math.max(...r.map((b) => b.h)) + GAPY * 2;
    });
    return out;
  }

  /* ------------------------------- styles -------------------------------- */
  function injectStyles() {
    if (document.getElementById('org-structure-v2-css')) return;
    const el = document.createElement('style');
    el.id = 'org-structure-v2-css';
    el.textContent = `
      .ocv2-bar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:10px; }
      .ocv2-bar select, .ocv2-bar input { height:34px; font-size:12px; }
      .ocv2-seg { display:inline-flex; border:1px solid var(--line-strong); border-radius:8px; overflow:hidden; background:#fff; }
      .ocv2-seg button { border:0; background:#fff; padding:0 14px; min-height:33px; font-size:12px; cursor:pointer; color:var(--ink-soft, #4b5560); }
      .ocv2-seg button + button { border-left:1px solid var(--line-strong); }
      .ocv2-seg button[aria-pressed="true"] { background:var(--action-tint, #E6F4F0); color:var(--action-dark, #00664F); font-weight:700; }
      .ocv2-seg button:disabled { opacity:.45; cursor:not-allowed; }
      .ocv2-pill { display:inline-flex; align-items:center; gap:6px; height:26px; padding:0 10px; border-radius:999px; font-size:11px; font-weight:700; background:var(--action-tint, #E6F4F0); color:var(--action-dark, #00664F); border:1px solid var(--action-tint-bd, #B7DCD3); }
      .ocv2-pill.amber { background:#FFF4DB; color:#8a5a00; border-color:#f1d28a; }
      .ocv2-banner { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:10px 14px; margin-bottom:10px; background:#FFF8E6; border:1px solid #f1d28a; border-radius:10px; font-size:12px; }
      .ocv2-banner strong { font-size:13px; }
      .ocv2-grow { flex:1 1 auto; }
      .ocv2-metrics { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:10px; }
      .ocv2-metric { background:#fff; border:1px solid var(--line); border-radius:10px; padding:6px 12px; min-width:84px; }
      .ocv2-metric b { display:block; font-size:18px; line-height:22px; color:var(--text-strong, #1a1a1a); }
      .ocv2-metric span { font-size:10.5px; color:var(--muted, #6b7580); text-transform:uppercase; letter-spacing:.04em; }
      .ocv2-metric.warn b { color:#b45309; }
      .ocv2-layout { display:grid; grid-template-columns:minmax(0,1fr) 320px; gap:14px; align-items:start; }
      @media (max-width: 1100px) { .ocv2-layout { grid-template-columns:minmax(0,1fr); } }
      .ocv2-tools { display:flex; flex-wrap:wrap; gap:6px; align-items:center; padding:6px 8px; background:#fff; border:1px solid var(--line); border-bottom:0; border-radius:12px 12px 0 0; }
      .ocv2-tools .btn { min-height:30px; padding:0 10px; }
      .ocv2-tools .sep { width:1px; height:20px; background:var(--line-strong); margin:0 4px; }
      .ocv2-status { font-size:11px; color:var(--muted, #6b7580); }
      .ocv2-status.err { color:#b7000f; }
      .ocv2-stage { position:relative; overflow:hidden; background:#E4E6EA; border:1px solid var(--line); height:calc(100vh - 380px); min-height:460px; touch-action:none; user-select:none; outline:none; }
      .ocv2-stage.pan { cursor:grab; } .ocv2-stage.panning { cursor:grabbing; }
      .ocv2-world { position:absolute; left:0; top:0; transform-origin:0 0; will-change:transform; }
      .ocv2-world svg { display:block; max-width:none; max-height:none; overflow:visible; background:#fff; box-shadow:0 2px 14px rgba(26,26,26,.22); }
      .ocv2-tabs { display:flex; gap:2px; align-items:flex-end; padding:0 8px; background:#fff; border:1px solid var(--line); border-top:0; border-radius:0 0 12px 12px; overflow-x:auto; }
      .ocv2-tab { border:1px solid var(--line); border-top:0; background:var(--surface-2, #F4F5F7); padding:6px 14px; font-size:12px; cursor:pointer; border-radius:0 0 8px 8px; color:var(--ink-soft, #4b5560); white-space:nowrap; }
      .ocv2-tab[aria-selected="true"] { background:#fff; color:var(--text-strong, #1a1a1a); font-weight:700; box-shadow:0 2px 0 var(--action, #008064) inset; }
      .ocv2-box { cursor:pointer; }
      .ocv2-hit { fill:none; stroke:transparent; cursor:pointer; pointer-events:stroke; }
      .ocv2-menu { position:fixed; z-index:1200; min-width:210px; background:#fff; border:1px solid var(--line-strong); border-radius:10px; box-shadow:0 10px 30px rgba(26,26,26,.2); padding:6px; font-size:12px; }
      .ocv2-menu button { display:flex; width:100%; align-items:center; justify-content:space-between; gap:12px; border:0; background:transparent; padding:7px 10px; border-radius:6px; text-align:left; cursor:pointer; font-size:12px; color:var(--text-strong, #1a1a1a); }
      .ocv2-menu button:hover:not(:disabled) { background:var(--surface-2, #F4F5F7); }
      .ocv2-menu button:disabled { color:#9aa3ab; cursor:not-allowed; }
      .ocv2-menu hr { border:0; border-top:1px solid var(--line); margin:4px 0; }
      .ocv2-menu .sub { padding-left:12px; }
      .ocv2-panel { padding:14px; max-height:calc(100vh - 150px); overflow-y:auto; }
      .ocv2-panel h3 { margin:0 0 8px; font-size:14px; }
      .ocv2-panel .field { margin-bottom:10px; }
      .ocv2-panel .field label { display:block; font-size:11px; color:var(--muted, #6b7580); margin-bottom:3px; }
      .ocv2-panel .field input, .ocv2-panel .field select, .ocv2-panel .field textarea { width:100%; }
      .ocv2-two { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
      .ocv2-checks { display:flex; flex-wrap:wrap; gap:12px; margin-bottom:10px; font-size:12px; }
      .ocv2-checks label { display:flex; gap:6px; align-items:center; }
      .ocv2-ptabs { display:flex; gap:4px; margin-bottom:10px; }
      .ocv2-ptabs button { flex:1; border:1px solid var(--line-strong); background:#fff; border-radius:8px; min-height:30px; cursor:pointer; font-size:12px; }
      .ocv2-ptabs button[aria-pressed="true"] { background:var(--action-tint, #E6F4F0); border-color:var(--action, #008064); font-weight:700; }
      .ocv2-person { border:1px solid var(--line); border-radius:8px; padding:8px; margin-bottom:6px; background:#fff; }
      .ocv2-person.over { outline:2px dashed var(--action, #008064); }
      .ocv2-person .row { display:flex; gap:6px; align-items:center; margin-bottom:4px; }
      .ocv2-person input, .ocv2-person select { height:30px; font-size:12px; min-width:0; }
      .ocv2-person .grip { cursor:grab; color:var(--muted, #6b7580); user-select:none; padding:0 4px; }
      .ocv2-legend { font-size:12px; color:var(--ink-soft, #4b5560); line-height:1.7; }
      .ocv2-legend i { display:inline-block; width:14px; height:10px; border:1px solid #000; margin-right:6px; vertical-align:middle; }
      .ocv2-kbd { font-size:11px; color:var(--muted, #6b7580); line-height:1.8; }
      .ocv2-kbd kbd { background:var(--surface-2, #F4F5F7); border:1px solid var(--line-strong); border-radius:4px; padding:0 5px; font-size:10.5px; }
      .ocv2-compare { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
      @media (max-width: 1100px) { .ocv2-compare { grid-template-columns:1fr; } }
      .ocv2-compare .cap { font-size:12px; font-weight:700; margin:0 0 6px; }
      .ocv2-compare svg { width:100%; max-width:100%; height:auto; display:block; background:#fff; border:1px solid var(--line); }
      .ocv2-changes li { margin-bottom:4px; font-size:12px; }
      .ocv2-toast { position:fixed; left:50%; transform:translateX(-50%); bottom:20px; z-index:1300; background:#1a1a1a; color:#fff; padding:10px 14px; border-radius:10px; font-size:12px; max-width:360px; box-shadow:0 8px 24px rgba(0,0,0,.25); }
      .ocv2-toast.warn { background:#8a5a00; }
      .ocv2-list-row { display:block; width:100%; text-align:left; background:#fff; border:1px solid var(--line); border-radius:10px; padding:12px; margin-bottom:8px; min-height:44px; cursor:pointer; }
    `;
    document.head.appendChild(el);
  }

  /* ------------------------------- the sheet ------------------------------ */
  // Pure SVG of one A3 page in world units (points). Interaction is attached by the parent.
  function SheetSvg({ page, geo, lines, sel, selLine, warn, highlight, hidden, k, ui, dateFallback, interactive, width, height, style }) {
    const date = page.date || dateFallback || '';
    const hl = highlight || new Map();
    const HL = { added: '#1a9b4b', removed: '#d8232a', moved: '#e6a100' };
    const ink = '#000';
    return (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox={'0 0 ' + PAGE_W + ' ' + PAGE_H} width={width || PAGE_W} height={height || PAGE_H} style={style}
        data-sheet={interactive ? '1' : undefined} role="img" aria-label={(page.title1 || '') + ' ' + (page.title2 || '')}>
        <rect x="0" y="0" width={PAGE_W} height={PAGE_H} fill="#fff" />
        <rect x={BAND.x} y={BAND.hy} width={BAND.w} height={BAND.hh} fill={MAROON} stroke="#000" strokeWidth="0.75" />
        <text x={PAGE_W / 2} y={BAND.hy + 20} textAnchor="middle" fill="#fff" fontFamily={HEAD_FONT} fontWeight="bold" fontSize="18">{page.title1}</text>
        <text x={PAGE_W / 2} y={BAND.hy + 42} textAnchor="middle" fill="#fff" fontFamily={HEAD_FONT} fontWeight="bold" fontSize="18">{page.title2}</text>
        <rect x={BAND.x} y={BAND.fy} width={BAND.w} height={BAND.fh} fill={MAROON} stroke="#000" strokeWidth="0.75" />
        <image href="/arabtec-logo.svg" x="1078" y="84" width="90" height="69" preserveAspectRatio="xMaxYMin meet" />
        {date && <text x="1168" y="787" textAnchor="end" fontFamily={HEAD_FONT} fontSize="7" fill="#333">{'Date: ' + date}</text>}

        <g>
          {lines.map((L) => {
            const ok = highlight && hl.get(L.key);
            return (
              <g key={L.key}>
                <path d={ptsD(L.route.pts)} fill="none" stroke={selLine === L.key ? '#008064' : ink} strokeWidth={selLine === L.key ? 1.5 : 0.75} />
                <path d={'M' + arrowHead(L.route.pts, 5).map((q) => r1(q[0]) + ',' + r1(q[1])).join(' L') + ' Z'} fill={selLine === L.key ? '#008064' : ink} />
                {interactive && <path className="ocv2-hit" data-line={L.key} d={ptsD(L.route.pts)} strokeWidth={Math.max(6, 8 / k)} />}
              </g>
            );
          })}
        </g>

        {page.boxes.map((b) => {
          if (hidden && hidden.has(b.key)) return null;
          const g = geo.get(b.key), m = g.m, h = hl.get(b.key);
          const isSel = sel && sel.has(b.key);
          const stroke = h ? HL[h] : m.left ? '#b9bec5' : ink;
          const fam = { fontFamily: m.left ? HEAD_FONT : BOX_FONT, fontSize: FS, fontWeight: m.left ? 'normal' : 'bold' };
          const w = warn && warn.get(b.key);
          return (
            <g key={b.key} data-key={interactive ? b.key : undefined} className="ocv2-box" opacity={h === 'removed' && ui && ui.fadeRemoved ? 0.9 : 1}>
              <rect x={g.x} y={g.y} width={g.w} height={g.h} fill="#fff" stroke={stroke} strokeWidth={h ? 1.5 : 0.75} strokeDasharray={m.dashed ? '3 2' : null} />
              <text {...fam} fill="#000">
                {m.lines.map((l, i) => (
                  <tspan key={i} x={m.left ? g.x + PAD : g.x + g.w / 2} y={g.y + PAD + i * LH + 7.4} textAnchor={m.left ? 'start' : 'middle'} fill={l.red ? JOIN_RED : '#000'}>{l.t || ' '}</tspan>
                ))}
              </text>
              {isSel && <rect x={g.x - 2} y={g.y - 2} width={g.w + 4} height={g.h + 4} fill="none" stroke="#008064" strokeWidth={Math.max(1.2, 1.6 / k)} pointerEvents="none" />}
              {ui && ui.dropKey === b.key && <rect x={g.x - 3} y={g.y - 3} width={g.w + 6} height={g.h + 6} fill="rgba(0,128,100,.12)" stroke="#008064" strokeWidth="1.5" strokeDasharray="4 2" pointerEvents="none" />}
              {w && w.length > 0 && <circle cx={g.x + g.w - 2} cy={g.y + 2} r="3.5" fill="#f59e0b" stroke="#fff" strokeWidth="0.75"><title>{w.join(' ')}</title></circle>}
            </g>
          );
        })}

        {ui && ui.guides && ui.guides.map((gd, i) => (gd.x != null
          ? <line key={'g' + i} x1={gd.x} x2={gd.x} y1={0} y2={PAGE_H} stroke="#e0161b" strokeWidth={0.75 / Math.max(k, 0.5)} strokeDasharray="4 3" pointerEvents="none" />
          : <line key={'g' + i} y1={gd.y} y2={gd.y} x1={0} x2={PAGE_W} stroke="#e0161b" strokeWidth={0.75 / Math.max(k, 0.5)} strokeDasharray="4 3" pointerEvents="none" />))}
        {ui && ui.marquee && <rect x={ui.marquee.x} y={ui.marquee.y} width={ui.marquee.w} height={ui.marquee.h} fill="rgba(0,128,100,.08)" stroke="#008064" strokeWidth={1 / k} strokeDasharray={4 / k + ' ' + 3 / k} pointerEvents="none" />}
        {ui && ui.lineUi}
      </svg>
    );
  }

  /* Context / box menu. items: {label, onClick, disabled, title, sub:[...], checked, sep} */
  function Menu({ x, y, items, onClose }) {
    const ref = useRef(null);
    const [pos, setPos] = useState({ x, y });
    const [open, setOpen] = useState(null);
    useEffect(() => {
      const el = ref.current;
      if (el) { const r = el.getBoundingClientRect(); setPos({ x: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), y: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) }); }
      const down = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
      const key = (e) => { if (e.key === 'Escape') onClose(); };
      setTimeout(() => document.addEventListener('mousedown', down), 0);
      document.addEventListener('keydown', key);
      return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
    }, []);
    const row = (it, i, sub) => it.sep ? <hr key={i} /> : (
      <React.Fragment key={i}>
        <button type="button" className={sub ? 'sub' : ''} disabled={it.disabled} title={it.title || undefined} role="menuitem"
          onClick={() => { if (it.sub) setOpen(open === i ? null : i); else { onClose(); it.onClick && it.onClick(); } }}>
          <span>{it.checked ? '✓ ' : ''}{it.label}</span>{it.sub ? <span>{open === i ? '▾' : '▸'}</span> : null}
        </button>
        {it.sub && open === i && it.sub.map((s, j) => row(s, i + '.' + j, true))}
      </React.Fragment>
    );
    return <div className="ocv2-menu" role="menu" ref={ref} style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>{items.map((it, i) => row(it, i, false))}</div>;
  }

  function Modal({ title, children, onClose, footer }) {
    return (
      <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="modal" style={{ maxWidth: 520 }} role="dialog" aria-modal="true">
          <div className="modal-head"><h3>{title}</h3><button type="button" className="icon-btn" aria-label="Close dialog" onClick={onClose}>{'✕'}</button></div>
          <div className="modal-body">{children}</div>
          {footer && <div className="modal-foot">{footer}</div>}
        </div>
      </div>
    );
  }

  /* ------------------------------ side panel ------------------------------ */
  function Field({ label, children }) { return <div className="field"><label>{label}</label>{children}</div>; }

  function PeopleList({ chartId, box, people, boxes, canEdit, onChanged, onError }) {
    const [name, setName] = useState('');
    const [dragId, setDragId] = useState(null);
    const [overId, setOverId] = useState(null);
    const base = '/org/charts/' + chartId + '/assignments';
    const run = async (fn) => { try { await fn(); } catch (e) { onError(errText(e)); } await onChanged(); };
    const add = () => { const n = name.trim(); if (!n) return; setName(''); run(() => api().post(base, { boxKey: box.key, personName: n, status: 'in_post' })); };
    const upd = (a, patch) => run(() => api().put(base + '/' + a.id, patch));
    const drop = (target) => {
      const from = people.findIndex((p) => p.id === dragId), to = people.findIndex((p) => p.id === target.id);
      setDragId(null); setOverId(null);
      if (from < 0 || to < 0 || from === to) return;
      const list = people.slice(); const [m] = list.splice(from, 1); list.splice(to, 0, m);
      run(async () => { for (let i = 0; i < list.length; i++) if (list[i].sortOrder !== i * 10) await api().put(base + '/' + list[i].id, { sortOrder: i * 10 }); });
    };
    return (
      <div>
        {people.length === 0 && <p className="page-sub" style={{ margin: '0 0 8px' }}>Nobody assigned yet.</p>}
        {people.map((a) => (
          <div key={a.id + ':' + a.updatedAt} className={'ocv2-person' + (overId === a.id ? ' over' : '')} draggable={canEdit}
            onDragStart={() => setDragId(a.id)} onDragOver={(e) => { if (dragId) { e.preventDefault(); setOverId(a.id); } }}
            onDragEnd={() => { setDragId(null); setOverId(null); }} onDrop={(e) => { e.preventDefault(); drop(a); }}>
            <div className="row">
              {canEdit && <span className="grip" title="Drag to reorder" aria-hidden="true">{'≡'}</span>}
              <input aria-label="Name" defaultValue={a.personName} disabled={!canEdit} style={{ flex: 1 }}
                onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== a.personName) upd(a, { personName: v }); }}
                onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }} />
              {canEdit && <button type="button" className="btn btn-sm btn-ghost" aria-label={'Remove ' + a.personName} title="Remove from this box"
                onClick={() => run(() => api().del(base + '/' + a.id))}>{'✕'}</button>}
            </div>
            <div className="row">
              <select aria-label="Status" value={a.status} disabled={!canEdit} onChange={(e) => upd(a, { status: e.target.value })}>
                <option value="in_post">In post</option><option value="joining">Joining</option><option value="leaving">Leaving</option>
              </select>
              {a.status === 'joining' && <input type="date" aria-label="Joining date" value={a.effectiveDate || ''} disabled={!canEdit} onChange={(e) => upd(a, { effectiveDate: e.target.value || null })} />}
            </div>
            <div className="row">
              <input aria-label="Suffix" placeholder="Suffix (Sr., Deputy)" defaultValue={a.suffix || ''} disabled={!canEdit} style={{ flex: 1 }}
                onBlur={(e) => { const v = e.target.value.trim(); if (v !== (a.suffix || '')) upd(a, { suffix: v || null }); }} />
              <input aria-label="Share" type="number" min="0.05" max="1" step="0.05" defaultValue={a.share} disabled={!canEdit} style={{ width: 64 }} title="Share of this person on this chart (1 = full time)"
                onBlur={(e) => { const v = Number(e.target.value); if (v > 0 && v <= 1 && v !== a.share) upd(a, { share: v }); }} />
            </div>
            {canEdit && (
              <select aria-label="Move to box" value="" onChange={(e) => { if (e.target.value) upd(a, { boxKey: e.target.value }); }} style={{ width: '100%' }}>
                <option value="">Move to box…</option>
                {boxes.filter((b) => b.kind === 'role' && b.key !== box.key).map((b) => <option key={b.key} value={b.key}>{b.title || b.key}</option>)}
              </select>
            )}
          </div>
        ))}
        {canEdit && (
          <div className="row" style={{ display: 'flex', gap: 6 }}>
            <input aria-label="New person name" placeholder="Add a person…" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} style={{ flex: 1, height: 32 }} />
            <button type="button" className="btn btn-sm" onClick={add} disabled={!name.trim()}>Add</button>
          </div>
        )}
      </div>
    );
  }

  function BoxPanel({ box, mode, chartId, people, positions, assignments, liveKeys, allBoxes, onField, onChanged, onError, onMenu }) {
    const [tab, setTab] = useState('box');
    const restr = mode === 'restructure', editing = mode === 'edit' || restr;
    const struct = editing && restr;
    const hint = editing && !restr ? 'Use Restructure' : undefined;
    const seats = positions.filter((p) => p.boxKey === box.key);
    const occ = (p) => assignments.find((a) => a.positionId === p.id);
    const num = (field, min, max, disabled) => (
      <input type="number" min={min} max={max} value={box[field] == null ? '' : box[field]} disabled={disabled} title={disabled && hint ? hint : undefined}
        onChange={(e) => { const v = e.target.value === '' ? 0 : Number(e.target.value); onField((b) => { b[field] = Math.max(min, Math.min(max, Math.round(v))); }, field); }} />
    );
    return (
      <div className="ocv2-panel">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <h3 style={{ margin: 0, flex: 1 }}>{box.title || 'Untitled box'}</h3>
          <button type="button" className="btn btn-sm btn-secondary" aria-label="Box menu" title="Box menu" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); onMenu(r.left, r.bottom + 4); }}>{'⋯'}</button>
        </div>
        {box.kind === 'role' && (
          <div className="ocv2-ptabs" role="tablist">
            <button type="button" role="tab" aria-pressed={tab === 'box'} onClick={() => setTab('box')}>Box</button>
            <button type="button" role="tab" aria-pressed={tab === 'people'} onClick={() => setTab('people')}>People ({people.length})</button>
            <button type="button" role="tab" aria-pressed={tab === 'seats'} onClick={() => setTab('seats')}>Seats ({seats.length})</button>
          </div>
        )}
        {(tab === 'box' || box.kind !== 'role') && (
          <div>
            <Field label="Title"><input value={box.title || ''} disabled={!editing} onChange={(e) => onField((b) => { b.title = e.target.value; }, 'title')} /></Field>
            <Field label="Kind">
              <select value={box.kind} disabled={!struct} title={!struct && editing ? hint : undefined} onChange={(e) => onField((b) => { b.kind = e.target.value; }, 'kind')}>
                <option value="role">Role (title, count, names)</option><option value="team">Team (title only)</option><option value="text">Text panel</option>
              </select>
            </Field>
            {box.kind === 'text' && <Field label="Text"><textarea rows={6} value={box.text || ''} disabled={!editing} onChange={(e) => onField((b) => { b.text = e.target.value; }, 'text')} /></Field>}
            {box.kind === 'role' && (
              <>
                <div className="ocv2-two">
                  <Field label="Planned seats">{num('planned', 0, 500, !struct)}</Field>
                  <Field label="Proposed seats">{num('proposed', 0, 500, !struct)}</Field>
                </div>
                <div className="ocv2-checks">
                  <label><input type="checkbox" checked={!!box.shared} disabled={!editing} onChange={(e) => onField((b) => { b.shared = e.target.checked; }, 'shared')} /> Shared</label>
                  <label><input type="checkbox" checked={!!box.zati} disabled={!editing} onChange={(e) => onField((b) => { b.zati = e.target.checked; }, 'zati')} /> zati (labour)</label>
                </div>
                <Field label="Count line override (e.g. X0.34 Shared)"><input value={box.countLabel || ''} disabled={!editing} onChange={(e) => onField((b) => { if (e.target.value) b.countLabel = e.target.value; else delete b.countLabel; }, 'countLabel')} /></Field>
              </>
            )}
            <div className="ocv2-two">
              <Field label="Width (pt)"><input type="number" min="40" max="400" value={box.w || DEFAULT_W} disabled={!editing} onChange={(e) => onField((b) => { b.w = Math.max(40, Math.min(400, Number(e.target.value) || DEFAULT_W)); }, 'w')} /></Field>
              {box.kind !== 'text' && (
                <Field label="Arrange team">
                  <select value={box.arrange || 'row'} disabled={!editing} onChange={(e) => onField((b) => { b.arrange = e.target.value; }, 'arrange', true)}>
                    {ARRANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </Field>
              )}
            </div>
          </div>
        )}
        {box.kind === 'role' && tab === 'people' && (
          liveKeys.has(box.key)
            ? <PeopleList chartId={chartId} box={box} people={people} boxes={allBoxes.filter((b) => liveKeys.has(b.key))} canEdit={editing} onChanged={onChanged} onError={onError} />
            : <p className="page-sub">This box is new in the draft. People can be added once the restructure is published.</p>
        )}
        {box.kind === 'role' && tab === 'seats' && (
          <div>
            {seats.length === 0 && <p className="page-sub">No seats yet. Seats are created when the chart is published.</p>}
            <table className="table" style={{ width: '100%', fontSize: 12 }}>
              <thead><tr><th>Position</th><th>Approval</th><th>Occupant</th></tr></thead>
              <tbody>{seats.map((p) => { const a = occ(p); return (
                <tr key={p.id}><td>#{p.id}</td><td>{p.approval}</td><td>{a ? a.personName : 'Open'}</td></tr>); })}</tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  function PageSettings({ page, editing, onField, selCount }) {
    return (
      <div className="ocv2-panel">
        <h3>{selCount > 1 ? selCount + ' boxes selected' : 'Page settings'}</h3>
        {selCount > 1 && <p className="page-sub">Use Align and Auto-arrange in the toolbar, or drag to move them together.</p>}
        <Field label="Heading line 1"><input value={page.title1 || ''} disabled={!editing} onChange={(e) => onField((p) => { p.title1 = e.target.value; }, 'title1')} /></Field>
        <Field label="Heading line 2"><input value={page.title2 || ''} disabled={!editing} onChange={(e) => onField((p) => { p.title2 = e.target.value; }, 'title2')} /></Field>
        <div className="ocv2-two">
          <Field label="Date (dd/mm/yyyy)"><input value={page.date || ''} placeholder="dd/mm/yyyy" disabled={!editing} onChange={(e) => onField((p) => { if (e.target.value) p.date = e.target.value; else p.date = null; }, 'date')} /></Field>
          <Field label="Page name"><input value={page.name || ''} disabled={!editing} onChange={(e) => onField((p) => { p.name = e.target.value; }, 'name')} /></Field>
        </div>
        <h3 style={{ marginTop: 16 }}>Legend</h3>
        <div className="ocv2-legend">
          <div><i style={{ background: '#fff' }} /> Role box: title, count, names</div>
          <div><i style={{ background: '#fff', borderStyle: 'dashed' }} /> Proposed seats (not yet approved)</div>
          <div><span style={{ color: JOIN_RED, fontWeight: 700 }}>- Name 30/10</span> New joiner until the date</div>
          <div><span style={{ color: '#b45309', fontWeight: 700 }}>{'●'}</span> Soft warning (span, layers, no one in post)</div>
        </div>
        <h3 style={{ marginTop: 16 }}>Shortcuts</h3>
        <div className="ocv2-kbd">
          <div><kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Y</kbd> undo, redo</div>
          <div><kbd>Tab</kbd> add report, <kbd>Enter</kbd> add peer (Restructure)</div>
          <div><kbd>Del</kbd> delete box (Restructure)</div>
          <div><kbd>Shift</kbd> or drag a frame: multi-select</div>
          <div><kbd>Alt</kbd>+drag: move the box without its team</div>
          <div><kbd>Space</kbd>+drag or middle mouse: pan</div>
          <div><kbd>Ctrl</kbd>+wheel: zoom, arrows: nudge</div>
        </div>
      </div>
    );
  }

  /* ---------------------------------- compare ------------------------------ */
  function Compare({ published, draft, pageIdx, assignments, diff, today }) {
    const pubP = published.pages[pageIdx] || published.pages[0], drP = draft.pages[pageIdx] || draft.pages[0];
    const pubKeys = new Map(published.pages.flatMap((p) => p.boxes).map((b) => [b.key, b]));
    const drKeys = new Map(draft.pages.flatMap((p) => p.boxes).map((b) => [b.key, b]));
    const hlPub = new Map(), hlDr = new Map();
    for (const [k, b] of pubKeys) {
      if (!drKeys.has(k)) hlPub.set(k, 'removed');
      else if ((drKeys.get(k).parentKey || null) !== (b.parentKey || null)) hlPub.set(k, 'moved');
    }
    for (const [k, b] of drKeys) {
      if (!pubKeys.has(k)) hlDr.set(k, 'added');
      else if ((pubKeys.get(k).parentKey || null) !== (b.parentKey || null)) hlDr.set(k, 'moved');
    }
    const by = useMemo(() => { const m = new Map(); for (const a of assignments) { if (!m.has(a.boxKey)) m.set(a.boxKey, []); m.get(a.boxKey).push(a); } m.forEach((l) => l.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)); return m; }, [assignments]);
    const sheet = (page, hl) => {
      const geo = buildGeo(page, by, today);
      return <SheetSvg page={page} geo={geo} lines={pageLines(page, geo, new Set())} k={0.5} highlight={hl} sel={null} width={PAGE_W} height={PAGE_H} />;
    };
    const title = (k) => (drKeys.get(k) || pubKeys.get(k) || {}).title || k;
    const d = diff;
    return (
      <div>
        <div className="ocv2-compare">
          <div><p className="cap">Published (live)</p>{sheet(pubP, hlPub)}</div>
          <div><p className="cap">This draft</p>{sheet(drP, hlDr)}</div>
        </div>
        <div className="card card-pad" style={{ marginTop: 12 }}>
          <h3 style={{ margin: '0 0 8px' }}>What changes</h3>
          {!d && <p className="page-sub">Loading the change list…</p>}
          {d && (
            <ul className="ocv2-changes" style={{ paddingLeft: 18, margin: 0 }}>
              <li><span style={{ color: '#1a9b4b', fontWeight: 700 }}>Added</span> ({d.boxesAdded.length}){d.boxesAdded.length ? ': ' + d.boxesAdded.map((b) => b.title || b.key).join(', ') : ''}</li>
              <li><span style={{ color: '#d8232a', fontWeight: 700 }}>Removed</span> ({d.boxesRemoved.length}){d.boxesRemoved.length ? ': ' + d.boxesRemoved.map((b) => b.title || b.key).join(', ') : ''}</li>
              <li><span style={{ color: '#b45309', fontWeight: 700 }}>Moved</span> ({d.boxesMoved.length}){d.boxesMoved.length ? ': ' + d.boxesMoved.map((b) => (b.title || b.key) + ' now reports to ' + (b.toParentKey ? title(b.toParentKey) : 'nobody (top level)')).join('; ') : ''}</li>
              <li>Renamed ({d.boxesRenamed.length}){d.boxesRenamed.length ? ': ' + d.boxesRenamed.map((b) => b.from + ' to ' + b.to).join('; ') : ''}</li>
              <li>Seats: {d.seatsDelta.approved >= 0 ? '+' : ''}{d.seatsDelta.approved} approved, {d.seatsDelta.proposed >= 0 ? '+' : ''}{d.seatsDelta.proposed} proposed</li>
              <li>Layers: {d.layersBefore} to {d.layersAfter}. Widest span: {d.widestSpanBefore} to {d.widestSpanAfter}.</li>
            </ul>
          )}
        </div>
      </div>
    );
  }

  /* ---------------------------------- phone ------------------------------- */
  function PhoneList({ doc, assignments, today }) {
    const [focus, setFocus] = useState(null);
    const boxes = doc.pages.flatMap((p) => p.boxes);
    const byKey = new Map(boxes.map((b) => [b.key, b]));
    const kids = (k) => boxes.filter((b) => (k ? b.parentKey === k : !b.parentKey || !byKey.has(b.parentKey))).sort((a, b) => a.x - b.x || a.y - b.y);
    const cur = focus && byKey.get(focus);
    const peopleOf = (k) => assignments.filter((a) => a.boxKey === k).sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
    return (
      <div>
        {cur && (
          <div className="card card-pad" style={{ marginBottom: 12 }}>
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => setFocus(cur.parentKey && byKey.has(cur.parentKey) ? cur.parentKey : null)}>Back</button>
            <h3 style={{ margin: '10px 0 4px' }}>{cur.title}</h3>
            {cur.kind === 'role' && <div className="page-sub">{countLine(cur)}</div>}
            {peopleOf(cur.key).map((a) => { const l = personLine(a, today); return <div key={a.id} style={{ color: l.red ? JOIN_RED : 'inherit', fontSize: 13 }}>{l.t}</div>; })}
          </div>
        )}
        {kids(focus).map((b) => (
          <button key={b.key} type="button" className="ocv2-list-row" onClick={() => setFocus(b.key)}>
            <strong>{b.title || String(b.text || '').split('\n')[0] || 'Untitled'}</strong>
            <div className="page-sub" style={{ margin: 0 }}>{[b.kind === 'role' ? countLine(b) : '', kids(b.key).length ? kids(b.key).length + ' reports' : ''].filter(Boolean).join(' · ')}</div>
            {peopleOf(b.key).map((a) => { const l = personLine(a, today); return <div key={a.id} style={{ color: l.red ? JOIN_RED : 'inherit', fontSize: 12 }}>{l.t}</div>; })}
          </button>
        ))}
        {!kids(focus).length && !cur && <p className="page-sub">This chart has no boxes yet.</p>}
      </div>
    );
  }

  /* --------------------------------- dialogs ------------------------------- */
  function useAction(fn) {
    const [busy, setBusy] = useState(false), [error, setError] = useState(null);
    const go = async (...a) => { setBusy(true); setError(null); try { await fn(...a); } catch (e) { setError(errText(e)); setBusy(false); } };
    return { busy, error, go };
  }

  function NewChartModal({ onClose, onCreate }) {
    const [name, setName] = useState(''), [scope, setScope] = useState('project');
    const a = useAction(() => onCreate({ name: name.trim(), scope }));
    return (
      <Modal title="New chart" onClose={onClose} footer={<><button type="button" className="btn btn-ghost" onClick={onClose} disabled={a.busy}>Cancel</button>
        <button type="button" className="btn" disabled={!name.trim() || a.busy} onClick={() => a.go()}>{a.busy ? 'Creating…' : 'Create chart'}</button></>}>
        {a.error && <div className="error-banner" role="alert">{a.error}</div>}
        <div className="form-grid">
          <div className="field"><label>Chart name</label><input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Harbor Tower" /></div>
          <div className="field"><label>Type</label><select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="project">Project</option><option value="head_office">Head Office</option><option value="department">Department</option></select></div>
        </div>
      </Modal>
    );
  }

  function StartModal({ hasDraft, onClose, onStart }) {
    const [label, setLabel] = useState(hasDraft ? 'Option B' : 'Restructure draft'), [date, setDate] = useState('');
    const a = useAction(() => onStart(label.trim(), date));
    return (
      <Modal title="Start restructure" onClose={onClose} footer={<><button type="button" className="btn btn-ghost" onClick={onClose} disabled={a.busy}>Cancel</button>
        <button type="button" className="btn" disabled={!date || a.busy} onClick={() => a.go()}>{a.busy ? 'Starting…' : 'Start restructure'}</button></>}>
        {a.error && <div className="error-banner" role="alert">{a.error}</div>}
        <p className="page-sub" style={{ marginTop: 0 }}>A draft is a full copy of the live chart. Nothing reaches the published chart until the HR Director approves it and it is published.</p>
        <div className="form-grid">
          <div className="field"><label>Draft name</label><input value={label} onChange={(e) => setLabel(e.target.value)} /></div>
          <div className="field"><label>Effective date</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        </div>
      </Modal>
    );
  }

  function DeleteModal({ keys, initial, page, assignments, onClose, onDelete }) {
    const [m, setM] = useState(initial || 'promote');
    const boxes = keys.map((k) => page.boxes.find((b) => b.key === k)).filter(Boolean);
    const reports = boxes.reduce((n, b) => n + childrenOf(page, b.key).length, 0);
    const branch = new Set(); keys.forEach((k) => { branch.add(k); descendants(page, k).forEach((d) => branch.add(d)); });
    const people = assignments.filter((a) => (m === 'branch' ? branch.has(a.boxKey) : keys.includes(a.boxKey))).length;
    return (
      <Modal title={boxes.length === 1 ? 'Delete ' + (boxes[0].title || 'box') : 'Delete ' + boxes.length + ' boxes'} onClose={onClose}
        footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="button" className="btn btn-danger" onClick={() => onDelete(m)}>{m === 'branch' ? 'Delete whole branch (' + branch.size + ' boxes)' : 'Delete'}</button></>}>
        <div className="ocv2-checks" style={{ flexDirection: 'column', gap: 8 }}>
          <label><input type="radio" name="dm" checked={m === 'promote'} onChange={() => setM('promote')} /> Promote its reports to the manager above{reports ? ' (' + reports + ' reports move up)' : ''}</label>
          <label><input type="radio" name="dm" checked={m === 'branch'} onChange={() => setM('branch')} /> Delete the whole branch ({branch.size} boxes)</label>
        </div>
        {people > 0 && <p className="page-sub">{people} {people === 1 ? 'person is' : 'people are'} assigned in these boxes. You will choose where they go when the draft is published.</p>}
      </Modal>
    );
  }

  function MoveModal({ box, people, boxes, onClose, onMove }) {
    const [to, setTo] = useState('');
    const a = useAction(() => onMove(to));
    return (
      <Modal title={'Move people from ' + (box.title || 'box')} onClose={onClose} footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn" disabled={!to || !people.length || a.busy} onClick={() => a.go()}>Move {people.length} {people.length === 1 ? 'person' : 'people'}</button></>}>
        {a.error && <div className="error-banner" role="alert">{a.error}</div>}
        {!people.length && <p className="page-sub">Nobody is assigned to this box.</p>}
        <div className="field"><label>Destination box</label><select value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">Choose a box{'…'}</option>{boxes.map((b) => <option key={b.key} value={b.key}>{b.title || b.key}</option>)}</select></div>
      </Modal>
    );
  }

  function OrphanModal({ keys, boxes, oldBoxes, onClose, onPublish }) {
    const [moves, setMoves] = useState({});
    const ok = keys.every((k) => moves[k]);
    const nm = (k) => (oldBoxes.find((b) => b.key === k) || {}).title || k;
    return (
      <Modal title="Choose where people go" onClose={onClose} footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn" disabled={!ok} onClick={() => onPublish(moves)}>Move people and publish</button></>}>
        <p className="page-sub" style={{ marginTop: 0 }}>People are still assigned to boxes this draft removes. Pick a new box for each.</p>
        {keys.map((k) => (
          <div className="field" key={k}><label>People in {'“'}{nm(k)}{'”'} move to</label>
            <select value={moves[k] || ''} onChange={(e) => setMoves({ ...moves, [k]: e.target.value })}>
              <option value="">Choose a box{'…'}</option>{boxes.map((b) => <option key={b.key} value={b.key}>{b.title || b.key}</option>)}</select></div>
        ))}
      </Modal>
    );
  }


  /* ------------------------------- export hook ----------------------------- */
  // HOOK for the export task (PDF, Visio, SVG, CSV, JSON). Intentionally a no-op for now.
  function exportCurrent(format, ctx) { /* TODO(export task): render ctx.doc / ctx.assignments to `format` */ return false; }

  function useNoPhone() { return false; }

  /* ================================ the page ================================ */
  function OrgStructureV2Page({ user }) {
    injectStyles();
    const manage = canManageChart(user), director = isHrDirector(user);
    const isPhone = (window.ArabtecUseIsPhone || useNoPhone)();
    const today = todayISO();

    const [charts, setCharts] = useState(null);
    const [chartId, setChartId] = useState(null);
    const [detail, setDetail] = useState(null);
    const [assignments, setAssignments] = useState([]);
    const [positions, setPositions] = useState([]);
    const [versions, setVersions] = useState([]);
    const [mode, setMode] = useState('view');
    const [doc, setDocState] = useState(null);
    const [ver, setVerState] = useState(null);
    const [pageIdx, setPageIdx] = useState(0);
    const [sel, setSel] = useState(() => new Set());
    const [selLine, setSelLine] = useState(null);
    const [view, setViewState] = useState({ x: 20, y: 20, k: 1 });
    const [ui, setUi] = useState({});
    const [collapsed, setCollapsed] = useState(() => new Set());
    const [err, setErr] = useState(null);
    const [toast, setToast] = useState(null);
    const [saveState, setSaveState] = useState('idle');
    const [menu, setMenu] = useState(null);
    const [modal, setModal] = useState(null);
    const [compare, setCompare] = useState(null);      // {published, diff}
    const [stale, setStale] = useState(null);          // {message, changes}
    const [panning, setPanning] = useState(false);
    const [loadingChart, setLoadingChart] = useState(false);

    const docRef = useRef(null), verRef = useRef(null), viewRef = useRef(view), stageRef = useRef(null);
    const drag = useRef(null), spaceRef = useRef(false), undoRef = useRef({ u: [], r: [], co: null });
    const saver = useRef({ timer: null, inflight: false, dirty: false });
    const fitted = useRef(false), toastTimer = useRef(null);

    const setDoc = (d) => { docRef.current = d; setDocState(d); };
    const setVer = (v) => { verRef.current = v; setVerState(v); };
    const setView = (v) => { viewRef.current = v; setViewState(v); };
    const say = (msg, type) => { setToast({ msg, type: type || 'ok' }); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), 3200); };
    useEffect(() => () => { clearTimeout(toastTimer.current); clearTimeout(saver.current.timer); }, []);

    const restr = mode === 'restructure';
    const draftEditable = restr && ver && ver.state === 'draft';
    const editable = mode === 'edit' || draftEditable;
    const editing = editable;
    const page = doc ? doc.pages[Math.min(pageIdx, doc.pages.length - 1)] : null;

    /* ------------------------------ data loading ----------------------------- */
    const loadCharts = useCallback(async () => {
      try {
        const r = await api().get('/org/charts');
        setCharts(r.charts || []);
        setChartId((cur) => {
          if (cur && (r.charts || []).some((c) => c.id === cur)) return cur;
          let saved = null; try { saved = Number(localStorage.getItem('ocv2.chart')); } catch (e) { /* storage blocked */ }
          const hit = (r.charts || []).find((c) => c.id === saved) || (r.charts || [])[0];
          return hit ? hit.id : null;
        });
      } catch (e) { setErr(errText(e, 'Could not load the organization charts.')); setCharts([]); }
    }, []);
    useEffect(() => { loadCharts(); }, [loadCharts]);

    const applyPublished = (d) => {
      setDetail(d); setAssignments(d.assignments || []); setPositions(d.positions || []);
      setVer(d.version); setDoc(d.version ? clone(d.version.payload) : null);
      undoRef.current = { u: [], r: [], co: null };
    };
    const reloadChart = useCallback(async (id) => {
      const d = await api().get('/org/charts/' + id);
      const vs = await api().get('/org/charts/' + id + '/versions');
      setVersions(vs.versions || []);
      applyPublished(d);
      return d;
    }, []);
    useEffect(() => {
      if (!chartId) { setDetail(null); setDoc(null); return; }
      let live = true;
      setLoadingChart(true); setErr(null); setMode('view'); setSel(new Set()); setSelLine(null); setCompare(null); setPageIdx(0); setCollapsed(new Set()); fitted.current = false;
      try { localStorage.setItem('ocv2.chart', String(chartId)); } catch (e) { /* storage blocked */ }
      reloadChart(chartId).catch((e) => { if (live) setErr(errText(e, 'Could not load this chart.')); }).finally(() => { if (live) setLoadingChart(false); });
      return () => { live = false; };
    }, [chartId, reloadChart]);

    const refreshPeople = useCallback(async () => {
      if (!chartId) return;
      try { const d = await api().get('/org/charts/' + chartId); setAssignments(d.assignments || []); setPositions(d.positions || []); }
      catch (e) { setErr(errText(e)); }
    }, [chartId]);

    const drafts = versions.filter((v) => v.state === 'draft' || v.state === 'pending_approval');
    const openDraft = async (id) => {
      const r = await api().get('/org/charts/versions/' + id);
      setVer(r.version); setDoc(clone(r.version.payload));
      undoRef.current = { u: [], r: [], co: null };
      setSel(new Set()); setSelLine(null); setCompare(null);
    };

    /* --------------------------------- saving -------------------------------- */
    const flush = async () => {
      const s = saver.current;
      if (s.inflight || !s.dirty) return;
      const v = verRef.current;
      if (!v) { s.dirty = false; return; }
      s.dirty = false; s.inflight = true; setSaveState('saving');
      try {
        const r = await api().put('/org/charts/versions/' + v.id, { payload: docRef.current, updatedAt: v.updatedAt });
        setVer({ ...verRef.current, updatedAt: r.version.updatedAt });
        if (!s.dirty) setSaveState('saved');
      } catch (e) {
        s.dirty = false;
        setSaveState('error');
        const data = (e && e.data) || {};
        if (e.status === 409 && data.currentUpdatedAt) {
          setErr('Someone else saved this chart since you opened it. It has been reloaded; please repeat your last change.');
          try { if (verRef.current.state === 'published') await reloadChart(chartId); else await openDraft(verRef.current.id); } catch (e2) { setErr(errText(e2)); }
        } else if (e.status === 409 && data.changes) {
          setErr(errText(e) + ' (' + data.changes.join('; ') + '). Your last change was not saved.');
          try { await reloadChart(chartId); } catch (e2) { /* shown above */ }
        } else setErr(errText(e, 'Could not save. Your last change is not saved.'));
      } finally {
        s.inflight = false;
        if (s.dirty) flush();
      }
    };
    const scheduleSave = () => {
      const s = saver.current; s.dirty = true; setSaveState('dirty');
      clearTimeout(s.timer); s.timer = setTimeout(flush, 600);
    };
    const waitSaved = async () => {
      const s = saver.current;
      for (let i = 0; i < 100 && (s.dirty || s.inflight); i++) {
        clearTimeout(s.timer);
        if (!s.inflight) await flush(); else await new Promise((r) => setTimeout(r, 50));
      }
    };

    /* -------------------------- document edits + undo ------------------------ */
    const curPage = (d) => d.pages[Math.min(pageIdx, d.pages.length - 1)];
    const pushUndo = (str, co) => {
      const u = undoRef.current, now = Date.now();
      if (co && u.co && u.co.key === co && now - u.co.t < 1200) { u.co.t = now; return; }
      u.u.push(str); if (u.u.length > 150) u.u.shift(); u.r = []; u.co = co ? { key: co, t: now } : null;
    };
    const warnCount = (d) => { let n = 0; computeWarnings(d.pages, assignments).forEach((l) => { n += l.length; }); return n; };
    const commit = (mut, opts) => {
      const cur = docRef.current;
      if (!cur || !(mode === 'edit' || (restr && verRef.current && verRef.current.state === 'draft'))) return false;
      const next = clone(cur);
      if (mut(next, curPage(next)) === false) return false;
      pushUndo(JSON.stringify(cur), opts && opts.coalesce);
      setDoc(next); scheduleSave();
      if (!(opts && opts.quiet) && warnCount(next) > warnCount(cur)) say('Heads up: this change adds a layout warning (amber dot on the box).', 'warn');
      return true;
    };
    const needRestructure = () => { say('Use Restructure for that change.', 'warn'); };
    const undo = () => {
      const u = undoRef.current; if (!u.u.length || !editable) return;
      u.r.push(JSON.stringify(docRef.current)); const d = JSON.parse(u.u.pop()); u.co = null;
      setDoc(d); setSel((s) => new Set([...s].filter((k) => d.pages.some((p) => p.boxes.some((b) => b.key === k))))); scheduleSave();
    };
    const redo = () => {
      const u = undoRef.current; if (!u.r.length || !editable) return;
      u.u.push(JSON.stringify(docRef.current)); const d = JSON.parse(u.r.pop()); u.co = null;
      setDoc(d); scheduleSave();
    };

    /* ------------------------------- derived data ---------------------------- */
    const peopleByBox = useMemo(() => {
      const m = new Map();
      for (const a of assignments) { if (!m.has(a.boxKey)) m.set(a.boxKey, []); m.get(a.boxKey).push(a); }
      m.forEach((l) => l.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id));
      return m;
    }, [assignments]);
    const geo = useMemo(() => (page ? buildGeo(page, peopleByBox, today) : null), [page, peopleByBox, today]);
    const hidden = useMemo(() => {
      const h = new Set();
      if (page) collapsed.forEach((k) => descendants(page, k).forEach((d) => h.add(d)));
      return h;
    }, [page, collapsed]);
    const rawKey = drag.current && drag.current.type === 'seg' ? drag.current.key : null;
    const lines = page && geo ? pageLines(page, geo, hidden, rawKey) : [];
    const metrics = useMemo(() => (doc ? computeMetrics(doc.pages, assignments) : null), [doc, assignments]);
    const warnings = useMemo(() => (doc && editing ? computeWarnings(doc.pages, assignments) : null), [doc, assignments, editing]);
    const liveKeys = useMemo(() => new Set(detail && detail.version ? detail.version.payload.pages.flatMap((p) => p.boxes).filter((b) => b.kind === 'role').map((b) => b.key) : []), [detail]);
    const allBoxes = useMemo(() => (doc ? doc.pages.flatMap((p) => p.boxes) : []), [doc]);
    const selKeys = [...sel].filter((k) => geo && geo.has(k));
    const selBox = selKeys.length === 1 ? geo.get(selKeys[0]).b : null;

    /* ---------------------------------- view --------------------------------- */
    const fit = useCallback(() => {
      const st = stageRef.current; if (!st) return;
      const r = st.getBoundingClientRect();
      const k = Math.max(0.2, Math.min((r.width - 40) / PAGE_W, (r.height - 40) / PAGE_H, 2));
      setView({ k, x: (r.width - PAGE_W * k) / 2, y: (r.height - PAGE_H * k) / 2 });
    }, []);
    useEffect(() => { if (doc && stageRef.current && !fitted.current) { fitted.current = true; fit(); } });
    const zoomAt = (factor, cx, cy) => {
      const v = viewRef.current, st = stageRef.current.getBoundingClientRect();
      const px = cx == null ? st.width / 2 : cx, py = cy == null ? st.height / 2 : cy;
      const k = Math.max(0.2, Math.min(6, v.k * factor));
      setView({ k, x: px - (px - v.x) * (k / v.k), y: py - (py - v.y) * (k / v.k) });
    };
    const zoomToBox = (key) => {
      const g = geo && geo.get(key); if (!g) return;
      const st = stageRef.current.getBoundingClientRect(), k = 3;
      setView({ k, x: st.width / 2 - (g.x + g.w / 2) * k, y: st.height / 2 - (g.y + g.h / 2) * k });
    };
    useEffect(() => {
      const st = stageRef.current; if (!st) return;
      const onWheel = (e) => {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) { const r = st.getBoundingClientRect(); zoomAt(Math.exp(-e.deltaY * 0.0018), e.clientX - r.left, e.clientY - r.top); }
        else { const v = viewRef.current; setView({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }); }
      };
      st.addEventListener('wheel', onWheel, { passive: false });
      return () => st.removeEventListener('wheel', onWheel);
    }, [doc === null, isPhone, !!compare]);
    const toWorld = (cx, cy) => {
      const r = stageRef.current.getBoundingClientRect(), v = viewRef.current;
      return { x: (cx - r.left - v.x) / v.k, y: (cy - r.top - v.y) / v.k };
    };

    /* ---------------------------- structural actions ------------------------- */
    const newBox = (parentKey, x, y) => ({ key: uid(), kind: 'role', title: 'New role', planned: 1, proposed: 0, shared: false, zati: false, parentKey: parentKey || null, x: snap(x), y: snap(y), w: DEFAULT_W });
    const slotUnder = (p, parentKey) => {
      const pg = geo.get(parentKey);
      const sibs = p.boxes.filter((b) => b.parentKey === parentKey).map((b) => geo.get(b.key)).filter(Boolean);
      if (sibs.length) return { x: Math.max(...sibs.map((s) => s.x + s.w)) + GAPX, y: sibs[0].y };
      return { x: pg.x + pg.w / 2 - DEFAULT_W / 2, y: pg.y + pg.h + GAPY * 1.5 };
    };
    const addBox = (parentKey) => {
      if (!restr) return needRestructure();
      let key = null;
      commit((d, p) => {
        const at = parentKey && geo.has(parentKey) ? slotUnder(p, parentKey) : { x: PAGE_W / 2 - DEFAULT_W / 2, y: TOP_Y };
        const b = newBox(parentKey, at.x, at.y); key = b.key; p.boxes.push(b);
      });
      if (key) { setSel(new Set([key])); setSelLine(null); }
    };
    const addPeer = (key) => { if (!restr) return needRestructure(); const b = geo.get(key); addBox(b ? b.b.parentKey || null : null); };
    const insertAbove = (keys) => {
      if (!restr) return needRestructure();
      const parents = new Set(keys.map((k) => geo.get(k).b.parentKey || ''));
      if (parents.size !== 1) return say('Select boxes that report to the same manager.', 'warn');
      let nk = null;
      commit((d, p) => {
        const gs = keys.map((k) => geo.get(k));
        const cx = (Math.min(...gs.map((g) => g.x)) + Math.max(...gs.map((g) => g.x + g.w))) / 2;
        const b = newBox(geo.get(keys[0]).b.parentKey, cx - DEFAULT_W / 2, Math.min(...gs.map((g) => g.y)) - 40);
        b.title = 'New manager'; nk = b.key; p.boxes.push(b);
        keys.forEach((k) => { p.boxes.find((x) => x.key === k).parentKey = b.key; resetLink(p, k); });
        resetLink(p, b.key);
      });
      if (nk) setSel(new Set([nk]));
    };
    const insertBelow = (key) => {
      if (!restr) return needRestructure();
      let nk = null;
      commit((d, p) => {
        const g = geo.get(key), kids = p.boxes.filter((b) => b.parentKey === key);
        const b = newBox(key, g.x, g.y + g.h + GAPY); b.title = 'New level'; nk = b.key;
        if (kids.length) { const cs = kids.map((c) => geo.get(c.key)); b.x = snap((Math.min(...cs.map((c) => c.x)) + Math.max(...cs.map((c) => c.x + c.w))) / 2 - DEFAULT_W / 2); }
        const shift = 50 + GAPY;
        descendants(p, key).forEach((dk) => { const x = p.boxes.find((q) => q.key === dk); x.y += shift; });
        kids.forEach((c) => { c.parentKey = b.key; resetLink(p, c.key); });
        p.boxes.push(b);
      });
      if (nk) setSel(new Set([nk]));
    };
    const removeBoxes = (p, keys, modeDel) => {
      for (const key of keys) {
        const b = p.boxes.find((x) => x.key === key); if (!b) continue;
        let gone;
        if (modeDel === 'branch') gone = new Set([key, ...descendants(p, key)]);
        else { gone = new Set([key]); p.boxes.filter((c) => c.parentKey === key).forEach((c) => { c.parentKey = b.parentKey || null; resetLink(p, c.key); }); }
        p.boxes = p.boxes.filter((x) => !gone.has(x.key));
        p.links = p.links.filter((l) => !gone.has(l.childKey));
      }
    };
    const arrangeTeam = (key, arr) => {
      commit((d, p) => {
        const b = p.boxes.find((x) => x.key === key); b.arrange = arr;
        const g2 = buildGeo(p, peopleByBox, today);
        const pos = autoLayout(p, g2, [key]);
        pos.forEach((v, k) => { const x = p.boxes.find((q) => q.key === k); x.x = v.x; x.y = v.y; if (k !== key) resetLink(p, k); });
      });
    };
    const autoArrange = () => {
      const keys = selKeys;
      commit((d, p) => {
        const pos = autoLayout(p, geo, keys.length ? keys : null);
        pos.forEach((v, k) => { const x = p.boxes.find((q) => q.key === k); if (x) { x.x = v.x; x.y = v.y; resetLink(p, k); } });
      });
    };
    const alignSel = (kind) => {
      if (selKeys.length < 2) return;
      commit((d, p) => {
        const gs = selKeys.map((k) => geo.get(k));
        const minX = Math.min(...gs.map((g) => g.x)), maxR = Math.max(...gs.map((g) => g.x + g.w)), minY = Math.min(...gs.map((g) => g.y)), maxB = Math.max(...gs.map((g) => g.y + g.h));
        const put = (g, patch) => Object.assign(p.boxes.find((x) => x.key === g.b.key), patch);
        if (kind === 'left') gs.forEach((g) => put(g, { x: r1(minX) }));
        if (kind === 'right') gs.forEach((g) => put(g, { x: r1(maxR - g.w) }));
        if (kind === 'center') gs.forEach((g) => put(g, { x: r1((minX + maxR) / 2 - g.w / 2) }));
        if (kind === 'top') gs.forEach((g) => put(g, { y: r1(minY) }));
        if (kind === 'bottom') gs.forEach((g) => put(g, { y: r1(maxB - g.h) }));
        if (kind === 'middle') gs.forEach((g) => put(g, { y: r1((minY + maxB) / 2 - g.h / 2) }));
        if (kind === 'dist-h' && gs.length > 2) {
          const s = gs.slice().sort((a, b) => a.x - b.x), gap = (maxR - minX - s.reduce((t, g) => t + g.w, 0)) / (s.length - 1);
          let x = minX; s.forEach((g) => { put(g, { x: r1(x) }); x += g.w + gap; });
        }
        if (kind === 'dist-v' && gs.length > 2) {
          const s = gs.slice().sort((a, b) => a.y - b.y), gap = (maxB - minY - s.reduce((t, g) => t + g.h, 0)) / (s.length - 1);
          let y = minY; s.forEach((g) => { put(g, { y: r1(y) }); y += g.h + gap; });
        }
      });
    };
    const nudge = (dx, dy, alt) => {
      if (!selKeys.length || !editable) return;
      commit((d, p) => {
        const moving = new Set();
        selKeys.forEach((k) => { moving.add(k); if (!alt) descendants(p, k).forEach((x) => moving.add(x)); });
        p.boxes.forEach((b) => { if (moving.has(b.key)) { b.x = r1(b.x + dx); b.y = r1(b.y + dy); } });
        p.links.forEach((l) => { const b = p.boxes.find((x) => x.key === l.childKey); if (l.points && b && moving.has(b.key) && moving.has(b.parentKey)) l.points = l.points.map((q) => ({ x: r1(q.x + dx), y: r1(q.y + dy) })); });
      }, { coalesce: 'nudge', quiet: true });
    };
    const toggleHide = (key) => setCollapsed((c) => { const n = new Set(c); if (n.has(key)) n.delete(key); else n.add(key); return n; });
    const addPage = () => {
      if (!restr) return needRestructure();
      commit((d) => {
        const first = d.pages[0], n = d.pages.length + 1;
        d.pages.push({ key: 'p' + uid().slice(1), name: 'Page ' + n, title1: first.title1, title2: '', date: first.date || null, paper: 'A3', boxes: [], links: [], notes: [] });
      });
      setPageIdx(doc.pages.length); fitted.current = false;
    };
    const patchBox = (key, mut, field, relayout) => {
      commit((d, p) => {
        const b = p.boxes.find((x) => x.key === key); if (!b) return false;
        mut(b);
        if (relayout) {
          const pos = autoLayout(p, buildGeo(p, peopleByBox, today), [key]);
          pos.forEach((v, k) => { const x = p.boxes.find((q) => q.key === k); x.x = v.x; x.y = v.y; if (k !== key) resetLink(p, k); });
        }
      }, { coalesce: 'f:' + key + ':' + field });
    };
    const resetRoute = () => { const k = selLineRef.current; if (k) commit((d, p) => { resetLink(p, k); }); };

    /* ------------------------------ keyboard --------------------------------- */
    const K = useRef({});
    K.current = { resetRoute, editable, restr, selKeys, undo, redo, addBox, addPeer, nudge, mode, modal, menu, geo };
    useEffect(() => {
      const down = (e) => {
        const t = e.target, tag = t && t.tagName;
        const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable);
        const s = K.current;
        if (e.key === ' ' && !typing && stageRef.current && (document.activeElement === stageRef.current || document.activeElement === document.body)) { spaceRef.current = true; e.preventDefault(); return; }
        if (typing || s.modal) return;
        const mod = e.ctrlKey || e.metaKey;
        if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) s.redo(); else s.undo(); return; }
        if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); s.redo(); return; }
        if (mod && (e.key === 'a' || e.key === 'A') && s.geo) { e.preventDefault(); setSel(new Set(s.geo.keys())); return; }
        if (e.key === 'Escape') { setSel(new Set()); setSelLine(null); setMenu(null); return; }
        if (selLineRef.current && (e.key === 'Delete' || e.key === 'Backspace') && s.editable) { e.preventDefault(); s.resetRoute(); return; }
        if (!s.selKeys.length) return;
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          if (!s.restr) { if (s.editable) say('Use Restructure to delete a box.', 'warn'); return; }
          if (s.editable) setModal({ type: 'delete', keys: s.selKeys });
        } else if (e.key === 'Tab') { e.preventDefault(); if (s.selKeys.length === 1) s.addBox(s.selKeys[0]); }
        else if (e.key === 'Enter') { e.preventDefault(); if (s.selKeys.length === 1) s.addPeer(s.selKeys[0]); }
        else if (e.key.startsWith('Arrow')) {
          e.preventDefault();
          const st = e.shiftKey ? SNAP : 1;
          s.nudge(e.key === 'ArrowLeft' ? -st : e.key === 'ArrowRight' ? st : 0, e.key === 'ArrowUp' ? -st : e.key === 'ArrowDown' ? st : 0, e.altKey);
        }
      };
      const up = (e) => { if (e.key === ' ') spaceRef.current = false; };
      window.addEventListener('keydown', down); window.addEventListener('keyup', up);
      return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
    }, []);
    const selLineRef = useRef(null); selLineRef.current = selLine;

    /* ------------------------------ pointer handling ------------------------- */
    const rectOf = (g) => ({ x: g.x, y: g.y, w: g.w, h: g.h });
    const isEditHit = (t) => editable && t;

    function onPointerDown(e) {
      if (!page || !geo) return;
      const st = stageRef.current;
      st.focus({ preventScroll: true });
      if (e.button === 1 || spaceRef.current) {
        e.preventDefault();
        drag.current = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y };
        st.setPointerCapture(e.pointerId); setPanning(true); return;
      }
      if (e.button !== 0) return;
      const w = toWorld(e.clientX, e.clientY);
      const segH = e.target.closest('[data-seg]'), endH = e.target.closest('[data-end]'), hitL = e.target.closest('[data-line]'), boxEl = e.target.closest('[data-key]');
      const base = JSON.stringify(docRef.current);
      if ((segH || endH) && selLine && editable) {
        const L = lines.find((x) => x.key === selLine); if (!L) return;
        if (segH) {
          const F = L.route.pts, S = F[0], E = F[F.length - 1];
          const stub = (A, B) => { const len = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1, t = Math.min(9, len / 2) / len; return [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t]; };
          const a = stub(S, F[1]), z = stub(E, F[F.length - 2]);
          const Fp = [S, a, [...a], ...F.slice(1, -1).map((q) => [...q]), [...z], z, E];
          const j = +segH.dataset.seg + 2, horiz = near(Fp[j][1], Fp[j + 1][1]);
          drag.current = { type: 'seg', key: L.key, Fp, j, horiz, o: Fp[j][horiz ? 1 : 0], sw: w, base, moved: false, fs: L.route.fs, ts: L.route.ts };
        } else drag.current = { type: 'end', key: L.key, which: endH.dataset.end, base, target: null, px: w.x, py: w.y };
        st.setPointerCapture(e.pointerId); return;
      }
      if (hitL && !boxEl) { setSelLine(hitL.dataset.line); setSel(new Set()); return; }
      if (selLine) setSelLine(null);
      if (boxEl) {
        const key = boxEl.dataset.key;
        let ns;
        if (e.shiftKey || e.ctrlKey || e.metaKey) { ns = new Set(sel); if (ns.has(key)) { ns.delete(key); setSel(ns); return; } ns.add(key); }
        else if (!sel.has(key)) ns = new Set([key]); else ns = new Set(sel);
        setSel(ns);
        if (!editable) return;
        const moving = new Set();
        ns.forEach((k) => { if (!geo.has(k)) return; moving.add(k); if (!e.altKey) descendants(page, k).forEach((d) => moving.add(d)); });
        const start = {}; moving.forEach((k) => { const g = geo.get(k); start[k] = { x: g.x, y: g.y }; });
        const others = []; geo.forEach((g, k) => { if (!moving.has(k) && !hidden.has(k)) others.push(rectOf(g)); });
        drag.current = { type: 'move', sx: w.x, sy: w.y, lead: key, leadRect: rectOf(geo.get(key)), start, moving, others, single: ns.size === 1, collapse: !(e.shiftKey || e.ctrlKey || e.metaKey) && sel.has(key) && sel.size > 1 ? key : null, base, moved: false, cur: null, dropKey: null, targets: [...geo.entries()].filter(([k]) => !moving.has(k) && !hidden.has(k)).map(([k, g]) => ({ k, ...rectOf(g) })) };
        st.setPointerCapture(e.pointerId); return;
      }
      if (!e.shiftKey) setSel(new Set());
      drag.current = { type: 'marquee', sx: w.x, sy: w.y, baseSel: e.shiftKey ? new Set(sel) : new Set() };
      st.setPointerCapture(e.pointerId);
    }

    function onPointerMove(e) {
      const d = drag.current; if (!d) return;
      if (d.type === 'pan') { setView({ ...viewRef.current, x: d.vx + e.clientX - d.sx, y: d.vy + e.clientY - d.sy }); return; }
      const w = toWorld(e.clientX, e.clientY), k = viewRef.current.k;
      if (d.type === 'marquee') {
        const x0 = Math.min(d.sx, w.x), y0 = Math.min(d.sy, w.y), x1 = Math.max(d.sx, w.x), y1 = Math.max(d.sy, w.y);
        if ((x1 - x0) * k < 3 && (y1 - y0) * k < 3) return;
        const ns = new Set(d.baseSel);
        geo.forEach((g, key) => { if (!hidden.has(key) && g.x < x1 && g.x + g.w > x0 && g.y < y1 && g.y + g.h > y0) ns.add(key); });
        setSel(ns); setUi({ marquee: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } }); return;
      }
      const nd = JSON.parse(d.base), pg = curPage(nd);
      if (d.type === 'seg') {
        const ax = d.horiz ? 1 : 0, v = snap(d.o + (d.horiz ? w.y - d.sw.y : w.x - d.sw.x));
        if (!d.moved && v === d.o) return;
        d.moved = true;
        const P = d.Fp.map((q) => [...q]); P[d.j][ax] = v; P[d.j + 1][ax] = v;
        setLink(pg, d.key, { style: 'manual', fromSide: d.fs, toSide: d.ts, points: P.slice(1, -1).map((q) => ({ x: r1(q[0]), y: r1(q[1]) })) });
        d.cur = nd; setDoc(nd); return;
      }
      if (d.type === 'end') {
        const c = geo.get(d.key);
        d.px = w.x; d.py = w.y; d.target = null; d.hoverKey = null;
        let over = null;
        geo.forEach((g, key) => {
          if (over || hidden.has(key)) return;
          if (w.x < g.x - 12 || w.x > g.x + g.w + 12 || w.y < g.y - 12 || w.y > g.y + g.h + 12) return;
          if (d.which === 'e' ? key === d.key : (key !== d.key && !wouldCycle(page, d.key, key))) over = key;
        });
        if (over) { d.hoverKey = over; d.target = { key: over, side: sideAt(geo.get(over), [w.x, w.y]) }; }
        setUi({ endDrag: { which: d.which, px: d.px, py: d.py, target: d.target, hoverKey: d.hoverKey, key: d.key } }); return;
      }
      if (d.type === 'move') {
        let dx = w.x - d.sx, dy = w.y - d.sy;
        if (!d.moved && Math.hypot(dx, dy) * k < 4) return;
        d.moved = true;
        const L = d.leadRect, thr = 5 / k, guides = [];
        const best = (mine, theirs) => { let b = null; for (const m of mine) for (const t of theirs) { const df = t - m; if (Math.abs(df) <= thr && (!b || Math.abs(df) < Math.abs(b.df))) b = { df, at: t }; } return b; };
        const xs = [L.x + dx, L.x + L.w / 2 + dx, L.x + L.w + dx], ys = [L.y + dy, L.y + L.h / 2 + dy, L.y + L.h + dy];
        const tx = [PAGE_W / 2], ty = [];
        d.others.forEach((o) => { tx.push(o.x, o.x + o.w / 2, o.x + o.w); ty.push(o.y, o.y + o.h / 2, o.y + o.h); });
        const bx = best(xs, tx), by = best(ys, ty);
        if (bx) { dx += bx.df; guides.push({ x: bx.at }); } else dx = snap(L.x + dx) - L.x;
        if (by) { dy += by.df; guides.push({ y: by.at }); } else dy = snap(L.y + dy) - L.y;
        pg.boxes.forEach((b) => { if (d.moving.has(b.key)) { b.x = r1(d.start[b.key].x + dx); b.y = r1(d.start[b.key].y + dy); } });
        pg.links.forEach((l) => { const b = pg.boxes.find((x) => x.key === l.childKey); if (l.points && b && d.moving.has(b.key) && d.moving.has(b.parentKey)) l.points = l.points.map((q) => ({ x: r1(q.x + dx), y: r1(q.y + dy) })); });
        let dropKey = null;
        if (restr && d.single && !e.altKey) {
          const hit = d.targets.find((t) => w.x >= t.x && w.x <= t.x + t.w && w.y >= t.y && w.y <= t.y + t.h);
          if (hit && !wouldCycle(page, d.lead, hit.k) && page.boxes.find((b) => b.key === d.lead).parentKey !== hit.k) dropKey = hit.k;
        }
        d.dropKey = dropKey; d.dx = dx; d.dy = dy; d.cur = nd;
        setDoc(nd); setUi({ guides, dropKey });
      }
    }

    function onPointerUp(e) {
      const d = drag.current; if (!d) return;
      drag.current = null; setPanning(false); setUi({});
      try { stageRef.current.releasePointerCapture(e.pointerId); } catch (er) { /* already released */ }
      if (d.type === 'pan' || d.type === 'marquee') return;
      const finish = (nd) => { pushUndo(d.base); setDoc(nd); scheduleSave(); };
      if (d.type === 'seg') {
        if (!d.moved || !d.cur) return;
        const pg = curPage(d.cur), L = pg.links.find((l) => l.childKey === d.key);
        const P = simplifyPts([d.Fp[0], ...L.points.map((q) => [q.x, q.y]), d.Fp[d.Fp.length - 1]]).slice(1, -1);
        if (P.length >= 2) L.points = P.map((q) => ({ x: r1(q[0]), y: r1(q[1]) })); else delete L.points;
        finish(d.cur); return;
      }
      if (d.type === 'end') {
        const t = d.target;
        if (!t) { setDoc(JSON.parse(d.base)); return; }
        const nd = JSON.parse(d.base), pg = curPage(nd), b = pg.boxes.find((x) => x.key === d.key);
        if (d.which === 'e') setLink(pg, d.key, { style: 'manual', toSide: t.side, points: undefined });
        else {
          if (t.key !== b.parentKey) {
            if (!restr) { say('Use Restructure to change who a box reports to.', 'warn'); setDoc(JSON.parse(d.base)); return; }
            b.parentKey = t.key; say(b.title + ' now reports to ' + (pg.boxes.find((x) => x.key === t.key).title || 'that box'));
          }
          setLink(pg, d.key, { style: 'manual', fromSide: t.side, points: undefined });
        }
        finish(nd); return;
      }
      if (d.type === 'move') {
        if (!d.moved || !d.cur) { if (d.collapse) setSel(new Set([d.collapse])); return; }
        if (d.dropKey && restr) {
          const nd = JSON.parse(d.base), pg = curPage(nd), b = pg.boxes.find((x) => x.key === d.lead);
          b.parentKey = d.dropKey; resetLink(pg, d.lead);
          const at = slotUnder(pg, d.dropKey), ddx = snap(at.x) - d.start[d.lead].x, ddy = snap(at.y) - d.start[d.lead].y;
          pg.boxes.forEach((x) => { if (d.moving.has(x.key)) { x.x = r1(d.start[x.key].x + ddx); x.y = r1(d.start[x.key].y + ddy); } });
          const tg = geo.get(d.dropKey); toggleHideOpen(d.dropKey);
          say(b.title + ' now reports to ' + (tg.b.title || 'that box'));
          finish(nd); return;
        }
        finish(d.cur);
      }
    }
    const toggleHideOpen = (key) => setCollapsed((c) => { if (!c.has(key)) return c; const n = new Set(c); n.delete(key); return n; });

    function onContextMenu(e) {
      e.preventDefault();
      const boxEl = e.target.closest('[data-key]');
      if (!boxEl) return;
      const key = boxEl.dataset.key;
      let keys = selKeys;
      if (!sel.has(key)) { keys = [key]; setSel(new Set([key])); setSelLine(null); }
      setMenu({ x: e.clientX, y: e.clientY, keys });
    }

    /* ------------------------------- box menu (plan 4) ----------------------- */
    function menuItems(keys) {
      const key = keys[0], g = geo.get(key); if (!g) return [];
      const single = keys.length === 1;
      const useRestr = restr ? undefined : 'Use Restructure';
      const noEdit = editing ? undefined : 'Switch to Edit to change this';
      const structTitle = !editing ? 'Switch to Restructure to change this' : useRestr;
      const structOff = !draftEditable;
      const hasKids = single && childrenOf(page, key).length > 0;
      return [
        { label: 'Add report', onClick: () => addBox(key), disabled: structOff || !single, title: structTitle },
        { label: 'Add peer', onClick: () => addPeer(key), disabled: structOff || !single, title: structTitle },
        { label: 'Insert manager above', onClick: () => insertAbove(keys), disabled: structOff, title: structTitle },
        { label: 'Insert level below', onClick: () => insertBelow(key), disabled: structOff || !single, title: structTitle },
        { sep: true },
        { label: 'Arrange team', disabled: !editing || !single || g.b.kind === 'text', title: noEdit, sub: ARRANGES.map(([v, l]) => ({ label: l, checked: (g.b.arrange || 'row') === v, onClick: () => arrangeTeam(key, v) })) },
        { label: collapsed.has(key) ? 'Show team' : 'Hide team', onClick: () => toggleHide(key), disabled: !hasKids, title: hasKids ? undefined : 'This box has no team' },
        { sep: true },
        { label: 'Move people…', onClick: () => setModal({ type: 'move', key }), disabled: !editing || !single || g.b.kind !== 'role' || !liveKeys.has(key), title: noEdit },
        { label: 'Transfer people…', disabled: true, title: 'Transfers between charts arrive with the People phase' },
        { sep: true },
        { label: 'Delete', disabled: structOff, title: structTitle, sub: [
          { label: 'Promote reports', onClick: () => setModal({ type: 'delete', keys, mode: 'promote' }) },
          { label: 'Delete branch', onClick: () => setModal({ type: 'delete', keys, mode: 'branch' }) },
        ] },
      ];
    }

    /* --------------------------- modes, drafts, workflow --------------------- */
    async function switchMode(m) {
      if (m === mode) return;
      setErr(null); setStale(null); setMenu(null);
      try {
        await waitSaved();
        if (m === 'restructure') {
          const d = await reloadChart(chartId);
          const latest = (await api().get('/org/charts/' + chartId + '/versions')).versions.filter((v) => v.state === 'draft' || v.state === 'pending_approval')[0];
          if (!latest) { setMode('view'); setModal({ type: 'start' }); return; }
          setMode('restructure'); await openDraft(latest.id); return;
        }
        if (mode === 'restructure') await reloadChart(chartId);
        setCompare(null); setMode(m); setSel(new Set()); setSelLine(null);
      } catch (e) { setErr(errText(e)); }
    }
    async function startRestructure(label, effectiveDate) {
      const r = await api().post('/org/charts/' + chartId + '/drafts', { label: label || 'Restructure draft' });
      const pl = clone(r.version.payload); pl.effectiveDate = effectiveDate;
      const saved = await api().put('/org/charts/versions/' + r.version.id, { payload: pl, updatedAt: r.version.updatedAt });
      const vs = await api().get('/org/charts/' + chartId + '/versions'); setVersions(vs.versions || []);
      setMode('restructure'); setVer(saved.version); setDoc(clone(saved.version.payload));
      undoRef.current = { u: [], r: [], co: null }; setSel(new Set()); setCompare(null);
    }
    async function refreshDraft(id) {
      const vs = await api().get('/org/charts/' + chartId + '/versions'); setVersions(vs.versions || []);
      await openDraft(id);
    }
    async function step(name, body) {
      setErr(null); setStale(null);
      try {
        await waitSaved();
        const id = verRef.current.id;
        const r = await api().post('/org/charts/versions/' + id + '/' + name, body || {});
        if (name === 'publish') {
          await reloadChart(chartId); await loadCharts(); setMode('view'); setCompare(null); say('Published. The old version is kept in history.'); return;
        }
        say({ submit: 'Submitted for approval.', approve: 'Approved. It can be published now.', reject: 'Sent back to draft.' }[name] || 'Done.');
        await refreshDraft(id);
      } catch (e) {
        const data = (e && e.data) || {};
        if (e.status === 409 && data.liveChanges) setStale({ message: errText(e), changes: data.liveChanges });
        else if (e.status === 409 && data.orphanBoxKeys) setModal({ type: 'orphans', keys: data.orphanBoxKeys });
        else setErr(errText(e));
      }
    }
    async function rebase() {
      try {
        const r = await api().post('/org/charts/versions/' + verRef.current.id + '/rebase', {});
        setStale(null); setVer(r.version); setDoc(clone(r.version.payload)); say('Live changes brought into this draft.');
      } catch (e) { setErr(errText(e)); }
    }
    async function openCompare() {
      if (compare) { setCompare(null); return; }
      try {
        await waitSaved();
        const pub = await api().get('/org/charts/versions/' + detail.chart.currentVersionId);
        setCompare({ published: pub.version.payload, diff: null });
        const r = await api().get('/org/charts/' + chartId + '/diff?a=' + detail.chart.currentVersionId + '&b=' + verRef.current.id);
        setCompare({ published: pub.version.payload, diff: r.diff });
      } catch (e) { setErr(errText(e)); setCompare(null); }
    }

    /* --------------------------------- rendering ----------------------------- */
    const chartsByScope = useMemo(() => {
      const g = {}; (charts || []).forEach((c) => { (g[c.scope] = g[c.scope] || []).push(c); }); return g;
    }, [charts]);
    const selLineObj = selLine && lines.find((l) => l.key === selLine);

    function buildLineUi() {
      if (!selLineObj || !geo) return null;
      const pts = selLineObj.route.pts, k = view.k, hs = 10 / k, out = [];
      const dragEnd = ui.endDrag;
      out.push(<path key="sl" d={ptsD(pts)} fill="none" stroke="#008064" strokeWidth={2.5 / k} opacity="0.35" pointerEvents="none" />);
      if (editable && !dragEnd) {
        pts.forEach((a, i) => {
          const b = pts[i + 1]; if (!b) return;
          if (Math.hypot(b[0] - a[0], b[1] - a[1]) * k < 14) return;
          const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
          out.push(<rect key={'s' + i} data-seg={i} x={mx - hs / 2} y={my - hs / 2} width={hs} height={hs} rx={2 / k} fill="#fff" stroke="#008064" strokeWidth={1.5 / k} style={{ cursor: near(a[1], b[1]) ? 'ns-resize' : 'ew-resize' }}><title>Drag to move this part of the line</title></rect>);
        });
        const S = pts[0], E = pts[pts.length - 1];
        out.push(<circle key="es" data-end="s" cx={S[0]} cy={S[1]} r={6 / k} fill="#fff" stroke="#008064" strokeWidth={2 / k} style={{ cursor: 'crosshair' }}><title>Drag to another side of the manager's box{restr ? ' or onto another box to change the manager' : ''}</title></circle>);
        out.push(<circle key="ee" data-end="e" cx={E[0]} cy={E[1]} r={6 / k} fill="#fff" stroke="#008064" strokeWidth={2 / k} style={{ cursor: 'crosshair' }}><title>Drag to another side of this box</title></circle>);
      }
      if (dragEnd && geo.get(dragEnd.key)) {
        const fixed = dragEnd.which === 's' ? pts[pts.length - 1] : pts[0];
        const tip = dragEnd.target ? anchor(geo.get(dragEnd.target.key), dragEnd.target.side) : [dragEnd.px, dragEnd.py];
        out.push(<path key="tmp" d={'M' + fixed + ' L' + tip} fill="none" stroke="#008064" strokeWidth={1.5 / k} strokeDasharray={4 / k + ' ' + 3 / k} pointerEvents="none" />);
        const tn = dragEnd.target ? geo.get(dragEnd.target.key) : dragEnd.hoverKey ? geo.get(dragEnd.hoverKey) : null;
        if (tn) ['top', 'bottom', 'left', 'right'].forEach((sd) => { const q = anchor(tn, sd); out.push(<circle key={'cp' + sd} cx={q[0]} cy={q[1]} r={5 / k} fill={dragEnd.target && dragEnd.target.side === sd ? '#008064' : '#fff'} stroke="#008064" strokeWidth={1.5 / k} pointerEvents="none" />); });
      }
      return <g>{out}</g>;
    }

    const statusText = { idle: '', dirty: 'Unsaved changes…', saving: 'Saving…', saved: 'Saved', error: 'Not saved' }[saveState];
    const pill = mode === 'edit' ? <span className="ocv2-pill">Editing live</span> : null;
    const draftState = restr && ver ? ver.state : null;

    if (isPhone) {
      return (
        <div>
          <div className="page-head"><div><div className="breadcrumb">Workspace / Organization Structure</div><h1 className="page-title">Organization Structure</h1><p className="page-sub">Read-only list. Open the chart on a larger screen to edit.</p></div></div>
          {err && <div className="error-banner" role="alert">{err}</div>}
          {charts && charts.length > 0 && (
            <div className="toolbar"><select aria-label="Chart" value={chartId || ''} onChange={(e) => setChartId(Number(e.target.value))} style={{ width: '100%' }}>
              {Object.keys(chartsByScope).map((s) => <optgroup key={s} label={SCOPE_LABEL[s] || s}>{chartsByScope[s].map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>)}
            </select></div>
          )}
          {doc ? <PhoneList doc={doc} assignments={assignments} today={today} /> : <p className="page-sub">{charts && !charts.length ? 'No charts yet.' : 'Loading…'}</p>}
        </div>
      );
    }

    const exportItems = [['pdf', 'PDF (A4 to A1)'], ['vsdx', 'Visio (.vsdx)'], ['svg', 'SVG'], ['csv', 'CSV of assignments'], ['json', 'JSON backup']]
      .map(([f, l]) => ({ label: l, onClick: () => { exportCurrent(f, { doc: docRef.current, assignments, chart: detail && detail.chart }); say('Export is not available yet. It arrives in the next update.'); } }));
    const manageable = manage && !!detail;

    return (
      <div>
        <div className="page-head">
          <div>
            <div className="breadcrumb">Workspace / Organization Structure</div>
            <h1 className="page-title">Organization Structure</h1>
            <p className="page-sub">{detail ? detail.chart.name + ' · ' + (STATE_LABEL[(ver && ver.state) || 'published']) : 'Org charts'}{manage ? '' : ' · View only'}</p>
          </div>
          <div className="page-head-actions ocv2-bar">
            {charts && charts.length > 0 && (
              <select aria-label="Chart" value={chartId || ''} onChange={(e) => { waitSaved().then(() => setChartId(Number(e.target.value))); }}>
                {Object.keys(chartsByScope).map((s) => <optgroup key={s} label={SCOPE_LABEL[s] || s}>{chartsByScope[s].map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>)}
              </select>
            )}
            {manage && <button type="button" className="btn btn-secondary" onClick={() => setModal({ type: 'new' })}>New chart</button>}
            <div className="ocv2-seg" role="group" aria-label="Mode">
              <button type="button" aria-pressed={mode === 'view'} onClick={() => switchMode('view')}>View</button>
              <button type="button" aria-pressed={mode === 'edit'} disabled={!manageable} title={manage ? undefined : 'You need organization chart permission'} onClick={() => switchMode('edit')}>Edit</button>
              <button type="button" aria-pressed={restr} disabled={!manageable} title={manage ? undefined : 'You need organization chart permission'} onClick={() => switchMode('restructure')}>Restructure</button>
            </div>
            {pill}
            <button type="button" className="btn btn-secondary" disabled={!detail} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 4, items: exportItems }); }}>Export</button>
            {manageable && mode === 'view' && <button type="button" className="btn" onClick={() => switchMode('edit')}>Edit chart</button>}
            {manageable && mode === 'edit' && <button type="button" className="btn" onClick={() => switchMode('restructure')}>Start restructure</button>}
          </div>
        </div>

        {err && <div className="error-banner" role="alert">{err} <button type="button" className="btn btn-sm btn-secondary" onClick={() => setErr(null)}>Dismiss</button></div>}

        {restr && ver && (
          <div className="ocv2-banner" role="status">
            <strong>Restructure draft {'—'} not published</strong>
            <span>{draftState === 'pending_approval' ? (ver.approvedBy ? 'Approved by the HR Director, ready to publish.' : 'Waiting for the HR Director.') : 'Effective ' + (ddmmyyyy(doc && doc.effectiveDate) || 'date not set') + '.'}</span>
            {drafts.length > 1 && (
              <select aria-label="Draft" value={ver.id} onChange={(e) => refreshDraft(Number(e.target.value)).catch((x) => setErr(errText(x)))}>
                {drafts.map((v) => <option key={v.id} value={v.id}>{v.label || 'Draft ' + v.id}</option>)}
              </select>
            )}
            <span className="ocv2-grow" />
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => setModal({ type: 'start' })}>New draft</button>
            <button type="button" className="btn btn-sm btn-secondary" aria-pressed={!!compare} onClick={openCompare}>{compare ? 'Back to sheet' : 'Compare'}</button>
            {draftState === 'draft' && <button type="button" className="btn btn-sm" onClick={() => step('submit')}>Submit for approval</button>}
            {draftState === 'pending_approval' && director && !ver.approvedBy && <button type="button" className="btn btn-sm" onClick={() => step('approve')}>Approve</button>}
            {draftState === 'pending_approval' && director && <button type="button" className="btn btn-sm btn-danger" onClick={() => step('reject')}>Reject</button>}
            {draftState === 'pending_approval' && director && ver.approvedBy && <button type="button" className="btn btn-sm" onClick={() => step('publish')}>Publish</button>}
          </div>
        )}
        {stale && (
          <div className="error-banner" role="alert">
            <div>{stale.message}</div>
            {stale.changes.length > 0 && <ul style={{ margin: '6px 0 6px 18px' }}>{stale.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>}
            <button type="button" className="btn btn-sm" onClick={rebase}>Bring live changes in</button>
          </div>
        )}

        {charts && charts.length === 0 && !err && (
          <div className="card card-pad"><h3 style={{ marginTop: 0 }}>No organization charts yet</h3>
            <p className="page-sub">{manage ? 'Create the first chart to start drawing the structure.' : 'An administrator has not created a chart yet.'}</p>
            {manage && <button type="button" className="btn" onClick={() => setModal({ type: 'new' })}>New chart</button>}</div>
        )}
        {loadingChart && !doc && <p className="page-sub">Loading chart{'…'}</p>}

        {doc && page && geo && metrics && (
          <>
            <div className="ocv2-metrics" aria-label="Chart metrics">
              {[['Planned', metrics.planned], ['In post', metrics.inPost], ['Joining', metrics.joining], ['Open', metrics.open], ['Proposed', metrics.proposed], ['Layers', metrics.layers], ['Widest span', metrics.widest]].map(([l, v]) => (
                <div key={l} className={'ocv2-metric' + ((l === 'Layers' && v > LIMITS.layersMax) || (l === 'Widest span' && v > LIMITS.spanMax) ? ' warn' : '')}><b>{v}</b><span>{l}</span></div>
              ))}
            </div>

            {compare && restr ? (
              <Compare published={compare.published} draft={doc} pageIdx={pageIdx} assignments={assignments} diff={compare.diff} today={today} />
            ) : (
              <div className="ocv2-layout">
                <div>
                  <div className="ocv2-tools">
                    <button type="button" className="btn btn-secondary" aria-label="Zoom out" title="Zoom out" onClick={() => zoomAt(1 / 1.25)}>{'−'}</button>
                    <span style={{ fontSize: 12, minWidth: 40, textAlign: 'center' }}>{Math.round(view.k * 100)}%</span>
                    <button type="button" className="btn btn-secondary" aria-label="Zoom in" title="Zoom in" onClick={() => zoomAt(1.25)}>+</button>
                    <button type="button" className="btn btn-secondary" onClick={fit}>Fit page</button>
                    <button type="button" className="btn btn-secondary" disabled={!selBox} title="Zoom to the selected box" onClick={() => selBox && zoomToBox(selBox.key)}>Zoom to box</button>
                    {editing && <>
                      <span className="sep" />
                      <button type="button" className="btn btn-secondary" aria-label="Undo" title="Undo (Ctrl+Z)" onClick={undo} disabled={!undoRef.current.u.length}>Undo</button>
                      <button type="button" className="btn btn-secondary" aria-label="Redo" title="Redo (Ctrl+Y)" onClick={redo} disabled={!undoRef.current.r.length}>Redo</button>
                      <button type="button" className="btn btn-secondary" title="Arrange the selection, or the whole page when nothing is selected" onClick={autoArrange}>Auto-arrange</button>
                      <button type="button" className="btn btn-secondary" disabled={selKeys.length < 2} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 4, items: [
                        { label: 'Align left', onClick: () => alignSel('left') }, { label: 'Align centre', onClick: () => alignSel('center') }, { label: 'Align right', onClick: () => alignSel('right') },
                        { label: 'Align top', onClick: () => alignSel('top') }, { label: 'Align middle', onClick: () => alignSel('middle') }, { label: 'Align bottom', onClick: () => alignSel('bottom') }, { sep: true },
                        { label: 'Distribute horizontally', onClick: () => alignSel('dist-h'), disabled: selKeys.length < 3 }, { label: 'Distribute vertically', onClick: () => alignSel('dist-v'), disabled: selKeys.length < 3 }] }); }}>Align</button>
                    </>}
                    {draftEditable && <button type="button" className="btn btn-secondary" onClick={() => addBox(selKeys.length === 1 ? selKeys[0] : null)}>{selKeys.length === 1 ? 'Add report' : 'Add box'}</button>}
                    <span className="ocv2-grow" />
                    {editing && <span className={'ocv2-status' + (saveState === 'error' ? ' err' : '')} role="status" aria-live="polite">{statusText}</span>}
                  </div>
                  <div className={'ocv2-stage' + (panning ? ' panning' : '')} ref={stageRef} tabIndex={0} aria-label="Organization chart sheet"
                    onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onContextMenu={onContextMenu}>
                    <div className="ocv2-world" style={{ transform: 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.k + ')' }}>
                      <SheetSvg page={page} geo={geo} lines={lines} sel={sel} selLine={selLine} warn={warnings} hidden={hidden} k={view.k} interactive
                        dateFallback={ver && ver.publishedAt ? ddmmyyyy(ver.publishedAt) : ''} ui={{ ...ui, lineUi: buildLineUi() }} />
                    </div>
                    {page.boxes.length === 0 && <div style={{ position: 'absolute', left: 0, right: 0, top: '45%', textAlign: 'center', color: '#5b6572', pointerEvents: 'none', fontSize: 13 }}>This page has no boxes yet.{draftEditable ? ' Use Add box in the toolbar.' : ''}</div>}
                  </div>
                  <div className="ocv2-tabs" role="tablist" aria-label="Pages">
                    {doc.pages.map((p, i) => <button key={p.key} type="button" role="tab" className="ocv2-tab" aria-selected={i === pageIdx} onClick={() => { setPageIdx(i); setSel(new Set()); setSelLine(null); }}>{p.name || 'Page ' + (i + 1)}</button>)}
                    {draftEditable && <button type="button" className="ocv2-tab" aria-label="Add page" title="Add page" onClick={addPage}>+</button>}
                  </div>
                </div>
                <div className="card">
                  {selBox
                    ? <BoxPanel key={selBox.key} box={selBox} mode={mode} chartId={chartId} people={peopleByBox.get(selBox.key) || []} positions={positions} assignments={assignments}
                        liveKeys={liveKeys} allBoxes={allBoxes} onField={(mut, field, relayout) => patchBox(selBox.key, mut, field, relayout)} onChanged={refreshPeople} onError={setErr}
                        onMenu={(x, y) => setMenu({ x, y, keys: [selBox.key] })} />
                    : <PageSettings page={page} editing={editing} selCount={selKeys.length} onField={(mut, field) => commit((d, p) => { mut(p); }, { coalesce: 'p:' + field, quiet: true })} />}
                </div>
              </div>
            )}
          </>
        )}

        {menu && <Menu x={menu.x} y={menu.y} items={menu.items || menuItems(menu.keys)} onClose={() => setMenu(null)} />}
        {modal && modal.type === 'new' && <NewChartModal onClose={() => setModal(null)} onCreate={async (b) => { const r = await api().post('/org/charts', b); await loadCharts(); setChartId(r.chart.id); setModal(null); }} />}
        {modal && modal.type === 'start' && <StartModal hasDraft={drafts.length > 0} onClose={() => setModal(null)} onStart={async (l, d) => { await startRestructure(l, d); setModal(null); }} />}
        {modal && modal.type === 'delete' && <DeleteModal keys={modal.keys} initial={modal.mode} page={page} assignments={assignments} onClose={() => setModal(null)} onDelete={(m) => { commit((d, p) => { removeBoxes(p, modal.keys, m); }); setSel(new Set()); setModal(null); }} />}
        {modal && modal.type === 'move' && <MoveModal box={geo.get(modal.key).b} people={peopleByBox.get(modal.key) || []} boxes={allBoxes.filter((b) => b.kind === 'role' && liveKeys.has(b.key) && b.key !== modal.key)} onClose={() => setModal(null)}
          onMove={async (to) => { try { for (const a of peopleByBox.get(modal.key) || []) await api().put('/org/charts/' + chartId + '/assignments/' + a.id, { boxKey: to }); } catch (e) { setErr(errText(e)); } await refreshPeople(); setModal(null); }} />}
        {modal && modal.type === 'orphans' && <OrphanModal keys={modal.keys} boxes={allBoxes.filter((b) => b.kind === 'role')} oldBoxes={(detail && detail.version ? detail.version.payload.pages.flatMap((p) => p.boxes) : [])} onClose={() => setModal(null)} onPublish={(moves) => { setModal(null); step('publish', { moves }); }} />}
        {toast && <div className={'ocv2-toast' + (toast.type === 'warn' ? ' warn' : '')} role="status">{toast.msg}</div>}
      </div>
    );
  }
  /* --------------------------- flag gate + registration --------------------- */
  // The server flag org_chart_v2 reaches the client through GET /api/settings/features (any signed-in user).
  function OrgStructureGate(props) {
    const [on, setOn] = useState(null);
    useEffect(() => {
      let live = true;
      api().get('/settings/features')
        .then((r) => { if (live) setOn(!!((r.features || []).find((f) => f.key === 'org_chart_v2') || {}).enabled); })
        .catch(() => { if (live) setOn(false); });
      return () => { live = false; };
    }, []);
    if (on === null) return <p className="page-sub">Loading{'…'}</p>;
    const V1 = window.ArabtecOrgStructurePage;
    if (!on && V1) return <V1 {...props} />;
    return <OrgStructureV2Page {...props} />;
  }

  window.ArabtecOrgStructureV2Page = OrgStructureV2Page;
  window.ArabtecOrgStructureV2Gate = OrgStructureGate;
  window.ORG_CHART_V2 = { boxModel, autoLayout, routeOf, elbowPts, computeMetrics, computeWarnings };
})();
