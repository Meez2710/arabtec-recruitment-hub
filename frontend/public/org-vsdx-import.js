/* Organization Structure v2: file import helpers (docs/org-chart/ORG_CHART_V2_PLAN.md section 5).
   window.ArabtecOrgVsdx.parse(arrayBuffer) -> Promise<{ payload, people, stats }>   Visio .vsdx (JSZip + DOMParser)
   window.ArabtecOrgVsdx.parseParts(parts)  -> same, synchronous, from already-unzipped XML strings (unit tests)
   window.ArabtecOrgCsv.parse(text)         -> { rows, total }   people rows with reports_to, ported from the prototype
   Plain script (no build step). JSZip is loaded on demand from /vendor/jszip.min.js. */
(function (root) {
  "use strict";

  const PT = 72;
  const local = (n) => n.localName || n.nodeName;
  function kids(el, name) {
    const out = [];
    for (let c = el && el.firstChild; c; c = c.nextSibling)
      if (c.nodeType === 1 && (!name || local(c) === name)) out.push(c);
    return out;
  }
  const num = (v, d) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : d;
  };
  function cell(shape, name) {
    for (const c of kids(shape, "Cell"))
      if (c.getAttribute("N") === name) return c.getAttribute("V");
    return null;
  }
  const cellNum = (shape, name, d) => num(cell(shape, name), d);
  const pad2 = (n) => String(n).padStart(2, "0");
  const parseXml = (s) => new root.DOMParser().parseFromString(s, "text/xml");

  /* ------------------------------- text helpers ------------------------------ */
  function isRed(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(
      String(hex || "").trim(),
    );
    if (!m) return false;
    return (
      parseInt(m[1], 16) >= 0xc0 &&
      parseInt(m[2], 16) <= 0x60 &&
      parseInt(m[3], 16) <= 0x60
    );
  }
  /* Character rows of a shape: IX -> colour string. */
  function charColors(shape) {
    const out = {};
    for (const sec of kids(shape, "Section")) {
      if (sec.getAttribute("N") !== "Character") continue;
      for (const row of kids(sec, "Row"))
        out[row.getAttribute("IX")] = cell(row, "Color");
    }
    return out;
  }
  /* Lines of a shape's own <Text>: [{ text, red }]. <cp IX/> markers pick the Character row of each run. */
  function textLines(shape) {
    const t = kids(shape, "Text")[0];
    if (!t) return [];
    const colors = charColors(shape);
    const lines = [{ text: "", red: false }];
    let ix = "0";
    for (let c = t.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1) {
        if (local(c) === "cp") ix = c.getAttribute("IX") || "0";
        continue;
      }
      if (c.nodeType !== 3 && c.nodeType !== 4) continue;
      const red = isRed(colors[ix]);
      for (const ch of c.data) {
        if (ch === "\n" || ch === " " || ch === "\u000b")
          lines.push({ text: "", red: false });
        else {
          const cur = lines[lines.length - 1];
          cur.text += ch;
          if (red && /\S/.test(ch)) cur.red = true;
        }
      }
    }
    return lines;
  }
  const plain = (shape) =>
    textLines(shape)
      .map((l) => l.text)
      .join("\n");
  /* First sub-shape (depth first) that carries a <Text>. */
  function firstTextChild(group) {
    for (const wrap of kids(group, "Shapes"))
      for (const s of kids(wrap, "Shape")) {
        if (kids(s, "Text").length) return s;
        const deeper = firstTextChild(s);
        if (deeper) return deeper;
      }
    return null;
  }

  /* "- Name – Sr. 30/10" -> { name, suffix, day, month }. */
  function parsePerson(raw) {
    let t = String(raw)
      .replace(/^\s*[-–]\s*/, "")
      .replace(/\s+/g, " ")
      .trim();
    let day = null,
      month = null;
    const d = /\s(\d{1,2})\/(\d{1,2})$/.exec(t);
    if (d && +d[1] >= 1 && +d[1] <= 31 && +d[2] >= 1 && +d[2] <= 12) {
      day = +d[1];
      month = +d[2];
      t = t.slice(0, d.index).trim();
    }
    let suffix = null,
      at = -1,
      len = 0;
    const re = /\s*[–-]\s+(?=\S)/g;
    let m;
    while ((m = re.exec(t))) {
      at = m.index;
      len = m[0].length;
    }
    if (at > 0) {
      suffix = t.slice(at + len).trim() || null;
      t = t.slice(0, at).trim();
    }
    return { name: t, suffix, day, month };
  }

  /* ----------------------------- one Visio page ------------------------------ */
  function parsePage(xml, meta, ctx) {
    const doc = parseXml(xml);
    const top = doc.documentElement;
    const shapes = kids(kids(top, "Shapes")[0], "Shape");
    const PW = meta.w,
      PH = meta.h;
    const masterOf = (s) => ctx.masters.get(s.getAttribute("Master")) || "";
    const page = {
      key: "p" + (meta.index + 1),
      name: meta.name,
      title1: "",
      title2: "",
      date: null,
      paper: "A3",
      boxes: [],
      links: [],
      notes: [],
    };
    const people = [];
    const byShape = new Map();
    const connectors = [];
    const geom = (s) => {
      const w = cellNum(s, "Width", 0),
        h = cellNum(s, "Height", 0);
      const lx = cellNum(s, "LocPinX", w / 2),
        ly = cellNum(s, "LocPinY", h / 2);
      const px = cellNum(s, "PinX", 0),
        py = cellNum(s, "PinY", 0);
      return {
        w,
        h,
        lx,
        ly,
        px,
        py,
        left: px - lx,
        bottom: py - ly,
        ang: cellNum(s, "Angle", 0),
      };
    };
    const toPt = (x, y) => [x * PT, (PH - y) * PT];
    const yearOf = () => {
      const m = /(\d{4})\s*$/.exec(page.date || "");
      return m ? +m[1] : new Date().getFullYear();
    };

    // Pass 1: the date, so effective dates of joiners can take its year.
    for (const s of shapes) {
      if (masterOf(s) || s.getAttribute("Type") === "Foreign") continue;
      const m = /^\s*Date:\s*(.*)$/im.exec(plain(s));
      if (m) page.date = m[1].trim() || null;
    }

    for (const s of shapes) {
      const name = masterOf(s);
      const id = s.getAttribute("ID");
      const g = geom(s);
      if (cell(s, "BeginX") !== null && cell(s, "EndX") !== null) {
        connectors.push({ s, id, name, g });
        continue;
      }
      if (/Belt/i.test(name)) {
        const key = ctx.prefix + ++ctx.n;
        const lines = textLines(s);
        const t = firstTextChild(s);
        const titleParts = t
          ? textLines(t)
              .map((l) => l.text.trim())
              .filter(Boolean)
          : [];
        const box = {
          key,
          kind: "role",
          title: "",
          planned: 0,
          proposed: 0,
          shared: false,
          zati: false,
          x: Math.round(g.left * PT * 10) / 10,
          y: Math.round((PH - (g.bottom + g.h)) * PT * 10) / 10,
          w: Math.round(g.w * PT * 10) / 10,
        };
        // main text: count line, people, extra title words
        const raw = lines.filter((l) => l.text.trim());
        const countIx = raw.findIndex((l) =>
          /^X\s*[\d.]+/i.test(l.text.trim()),
        );
        const hasDash = raw.some((l) => /^\s*-/.test(l.text));
        const title0 = titleParts.join(" ");
        const toTitle = (l) =>
          /^&/.test(l.text.trim()) ||
          /Team$/i.test(l.text.trim()) ||
          (countIx < 0 && !hasDash && /Team$/i.test(title0));
        const extra = [];
        const persons = []; // { text, red, rawEnd }
        let lastIx = -2;
        raw.forEach((l, i) => {
          if (i === countIx) return;
          const tx = l.text.trim();
          const startsDash = /^-/.test(tx);
          const prev = persons[persons.length - 1];
          if (!startsDash && toTitle(l)) {
            extra.push(tx);
            return;
          }
          if (
            !startsDash &&
            prev &&
            lastIx === i - 1 &&
            /[\s–-]$/.test(prev.rawEnd)
          ) {
            prev.text += " " + tx;
            prev.red = prev.red || l.red;
            prev.rawEnd = l.text;
            lastIx = i;
            return;
          }
          persons.push({ text: tx, red: l.red, rawEnd: l.text });
          lastIx = i;
        });
        box.title = [title0, ...extra]
          .filter(Boolean)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (countIx >= 0) {
          const ct = raw[countIx].text.trim();
          const m = /^X\s*([\d.]+)\s*(.*)$/i.exec(ct);
          const n = num(m[1], 1);
          box.zati = /zati/i.test(m[2]);
          box.shared = /shared/i.test(m[2]) || !Number.isInteger(n);
          box.planned = Number.isInteger(n) ? Math.min(500, n) : 1;
          const canon =
            "X" +
            box.planned +
            (box.shared ? " Shared" : "") +
            (box.zati ? " zati" : "");
          if (ct !== canon) box.countLabel = ct;
        } else if (!persons.length) box.kind = "team";
        page.boxes.push(box);
        byShape.set(id, { box, g });
        persons.forEach((p, i) => {
          const q = parsePerson(p.text);
          if (!q.name) return;
          const joining = p.red;
          const o = {
            pageKey: page.key,
            boxKey: key,
            boxTitle: box.title,
            personName: q.name,
            status: joining ? "joining" : "in_post",
            share: 1,
            sortOrder: i,
          };
          if (q.suffix) o.suffix = q.suffix;
          if (q.day)
            o.effectiveDate =
              yearOf() + "-" + pad2(q.month) + "-" + pad2(q.day);
          people.push(o);
        });
        continue;
      }
      if (name || s.getAttribute("Type") === "Foreign") continue;
      // plain shapes: bands, the date, text panels
      const text = plain(s).replace(/\s+$/g, "");
      const mid = g.bottom + g.h / 2;
      if (g.w > PW * 0.5) {
        const ls = text
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean);
        if (mid > PH / 2 && ls.length && !page.title1) {
          page.title1 = ls[0];
          page.title2 = ls[1] || "";
        }
        continue;
      }
      if (/^\s*Date:/i.test(text) || !text.trim()) continue;
      const key = ctx.prefix + ++ctx.n;
      page.boxes.push({
        key,
        kind: "text",
        title: "",
        planned: 0,
        proposed: 0,
        shared: false,
        zati: false,
        text: text.replace(/^\s+/, "").slice(0, 5000),
        x: Math.round(g.left * PT * 10) / 10,
        y: Math.round((PH - (g.bottom + g.h)) * PT * 10) / 10,
        w: Math.round(g.w * PT * 10) / 10,
      });
    }

    // Connections: connector id -> { begin: {sheet, toCell, toPart}, end: {...} }
    const conn = new Map();
    for (const wrap of kids(top, "Connects"))
      for (const c of kids(wrap, "Connect")) {
        const cid = c.getAttribute("FromSheet");
        const end =
          c.getAttribute("FromCell") === "EndX"
            ? "end"
            : c.getAttribute("FromCell") === "BeginX"
              ? "begin"
              : null;
        if (!end) continue;
        if (!conn.has(cid)) conn.set(cid, {});
        conn.get(cid)[end] = {
          sheet: c.getAttribute("ToSheet"),
          toCell: c.getAttribute("ToCell") || "",
          toPart: c.getAttribute("ToPart") || "",
        };
      }
    const sideFrom = (e) => {
      let m = /Connections\.(Top|Bottom|Left|Right)\./.exec(e.toCell);
      if (m)
        return { Top: "top", Bottom: "bottom", Left: "left", Right: "right" }[
          m[1]
        ];
      return (
        { 100: "top", 101: "left", 102: "right", 103: "bottom" }[e.toPart] ||
        null
      );
    };
    const nearestSide = (info, pt) => {
      const b = info.box,
        x0 = b.x,
        y0 = b.y,
        w = b.w,
        h = info.g.h * PT;
      const A = {
        top: [x0 + w / 2, y0],
        bottom: [x0 + w / 2, y0 + h],
        left: [x0, y0 + h / 2],
        right: [x0 + w, y0 + h / 2],
      };
      let best = "bottom",
        d = Infinity;
      for (const k of Object.keys(A)) {
        const dd = Math.hypot(A[k][0] - pt[0], A[k][1] - pt[1]);
        if (dd < d) {
          d = dd;
          best = k;
        }
      }
      return best;
    };
    const wouldCycle = (child, parent) => {
      const byKey = new Map(page.boxes.map((b) => [b.key, b]));
      for (let k = parent, n = 0; k && n < 5000; n++) {
        if (k === child) return true;
        k = (byKey.get(k) || {}).parentKey;
      }
      return false;
    };
    const stats = { connectors: connectors.length, linked: 0, skipped: 0 };
    for (const c of connectors) {
      const cn = conn.get(c.id);
      // An end that is not glued to a box is matched to the box whose edge it touches (within 6 pt).
      const atPt = (pt) => {
        let best = null,
          d = 6;
        for (const info of byShape.values()) {
          const bx = info.box.x, by = info.box.y;
          const dx = Math.max(bx - pt[0], 0, pt[0] - bx - info.box.w);
          const dy = Math.max(by - pt[1], 0, pt[1] - by - info.g.h * PT);
          const dd = Math.hypot(dx, dy);
          if (dd <= d) { d = dd; best = info; }
        }
        return best;
      };
      const Bp = toPt(cellNum(c.s, "BeginX", c.g.px), cellNum(c.s, "BeginY", c.g.py));
      const Ep = toPt(cellNum(c.s, "EndX", c.g.px), cellNum(c.s, "EndY", c.g.py));
      // A line that starts on another line's vertical trunk belongs to the box that trunk hangs from.
      const trunk = (pt) => {
        let best = null;
        for (const info of byShape.values()) {
          const bottom = info.box.y + info.g.h * PT;
          if (Math.abs(info.box.x + info.box.w / 2 - pt[0]) > 6 || bottom > pt[1] + 1) continue;
          if (!best || bottom > best.box.y + best.g.h * PT) best = info;
        }
        return best;
      };
      const pInfo = (cn && cn.begin && byShape.get(cn.begin.sheet)) || atPt(Bp) || trunk(Bp),
        cInfo = (cn && cn.end && byShape.get(cn.end.sheet)) || atPt(Ep);
      if (!pInfo || !cInfo || pInfo === cInfo) {
        stats.skipped++;
        continue;
      }
      const dotted = /dotted/i.test(c.name);
      if (!dotted && cInfo.box.parentKey === pInfo.box.key) continue; // the same line drawn twice
      if (
        !dotted &&
        (cInfo.box.parentKey || wouldCycle(cInfo.box.key, pInfo.box.key))
      ) {
        stats.skipped++;
        continue;
      }
      // route in page coordinates (points, top-left origin)
      const g = c.g,
        cs = Math.cos(g.ang),
        sn = Math.sin(g.ang);
      const L2P = (x, y) => {
        const dx = x - g.lx,
          dy = y - g.ly;
        return toPt(g.px + dx * cs - dy * sn, g.py + dx * sn + dy * cs);
      };
      const rows = [];
      for (const sec of kids(c.s, "Section"))
        if (sec.getAttribute("N") === "Geometry")
          for (const r of kids(sec, "Row"))
            if (r.getAttribute("Del") !== "1") rows.push(r);
      rows.sort(
        (a, b) => num(a.getAttribute("IX"), 0) - num(b.getAttribute("IX"), 0),
      );
      const B = toPt(
          cellNum(c.s, "BeginX", g.px),
          cellNum(c.s, "BeginY", g.py),
        ),
        E = toPt(cellNum(c.s, "EndX", g.px), cellNum(c.s, "EndY", g.py));
      let pts = [];
      if (rows.length) {
        let px = 0,
          py = 0;
        pts.push(L2P(0, 0));
        for (const r of rows) {
          const x = cellNum(r, "X", px),
            y = cellNum(r, "Y", py);
          px = x;
          py = y;
          if (r.getAttribute("T") === "MoveTo") {
            pts = [L2P(x, y)];
            continue;
          }
          pts.push(L2P(x, y));
        }
        if (Math.hypot(pts[0][0] - B[0], pts[0][1] - B[1]) > 2) pts.unshift(B);
        if (
          Math.hypot(
            pts[pts.length - 1][0] - E[0],
            pts[pts.length - 1][1] - E[1],
          ) > 2
        )
          pts.push(E);
      } else pts = [B, E];
      // drop repeated and collinear points
      const clean = [];
      for (const q of pts) {
        const l = clean[clean.length - 1];
        if (!l || Math.abs(l[0] - q[0]) > 0.3 || Math.abs(l[1] - q[1]) > 0.3)
          clean.push(q);
      }
      for (let i = clean.length - 2; i >= 1; i--) {
        const a = clean[i - 1],
          b = clean[i],
          d = clean[i + 1];
        if (
          (Math.abs(a[0] - b[0]) < 0.3 && Math.abs(b[0] - d[0]) < 0.3) ||
          (Math.abs(a[1] - b[1]) < 0.3 && Math.abs(b[1] - d[1]) < 0.3)
        )
          clean.splice(i, 1);
      }
      const link = {
        childKey: cInfo.box.key,
        kind: dotted ? "dotted" : "reports",
        fromSide: (cn && cn.begin && sideFrom(cn.begin)) || nearestSide(pInfo, clean[0]),
        toSide: (cn && cn.end && sideFrom(cn.end)) || nearestSide(cInfo, clean[clean.length - 1]),
      };
      const inner = clean.slice(1, -1);
      if (inner.length >= 2) {
        link.points = inner.map((q) => ({
          x: Math.round(q[0] * 10) / 10,
          y: Math.round(q[1] * 10) / 10,
        }));
        link.style = "manual";
      }
      if (!dotted) cInfo.box.parentKey = pInfo.box.key;
      page.links.push(link);
      stats.linked++;
    }
    if (people.length)
      page.importPeople = people.map((p) => ({
        boxKey: p.boxKey,
        personName: p.personName,
        status: p.status,
        effectiveDate: p.effectiveDate || null,
        suffix: p.suffix || null,
        share: 1,
        sortOrder: p.sortOrder,
      }));
    return { page, people, stats };
  }

  /* -------------------------------- whole file ------------------------------- */
  /* parts: { pagesXml, pagesRels, mastersXml, pageXml: { 'page1.xml': '<xml>' } } */
  function parseParts(parts) {
    const ctx = {
      masters: new Map(),
      n: 0,
      prefix: "v" + Math.random().toString(36).slice(2, 5) + "_",
    };
    if (parts.mastersXml)
      for (const m of kids(
        parseXml(parts.mastersXml).documentElement,
        "Master",
      ))
        ctx.masters.set(
          m.getAttribute("ID"),
          m.getAttribute("NameU") || m.getAttribute("Name") || "",
        );
    const rels = new Map();
    if (parts.pagesRels)
      for (const r of kids(parseXml(parts.pagesRels).documentElement, "Relationship"))
        rels.set(r.getAttribute("Id"), r.getAttribute("Target"));
    const pagesDoc = parseXml(parts.pagesXml).documentElement;
    const pages = [],
      people = [],
      stats = {
        pages: 0,
        boxes: 0,
        people: 0,
        joiners: 0,
        links: 0,
        connectors: 0,
        skippedConnectors: 0,
      };
    let index = 0;
    for (const p of kids(pagesDoc, "Page")) {
      const sheet = kids(p, "PageSheet")[0];
      const rel = kids(p, "Rel")[0];
      const target = rel && rels.get(rel.getAttribute("r:id"));
      const xml = target && parts.pageXml[target.replace(/^.*\//, "")];
      if (!xml) continue;
      const meta = {
        index,
        name: p.getAttribute("Name") || "Page " + (index + 1),
        w: sheet ? cellNum(sheet, "PageWidth", 16.535) : 16.535,
        h: sheet ? cellNum(sheet, "PageHeight", 11.693) : 11.693,
      };
      const r = parsePage(xml, meta, ctx);
      pages.push(r.page);
      people.push(...r.people);
      stats.boxes += r.page.boxes.length;
      stats.links += r.stats.linked;
      stats.connectors += r.stats.connectors;
      stats.skippedConnectors += r.stats.skipped;
      index++;
    }
    if (!pages.length)
      throw new Error("No pages were found in this Visio file.");
    stats.pages = pages.length;
    stats.people = people.length;
    stats.joiners = people.filter((x) => x.status === "joining").length;
    return { payload: { pages }, people, stats };
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = root.document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () =>
        reject(
          new Error(
            "A tool the page needs did not load. Check the connection and try again.",
          ),
        );
      root.document.head.appendChild(s);
    });
  }

  async function parse(buf) {
    if (!buf || buf.byteLength > 25 * 1024 * 1024)
      throw new Error("That file is too large to import (25 MB limit).");
    if (!root.JSZip) await loadScript("/vendor/jszip.min.js");
    let zip;
    try {
      zip = await root.JSZip.loadAsync(buf);
    } catch (e) {
      throw new Error("That file is not a Visio drawing (.vsdx).");
    }
    const read = async (path) => {
      const f = zip.file(path);
      return f ? f.async("string") : null;
    };
    const pagesXml = await read("visio/pages/pages.xml");
    if (!pagesXml) throw new Error("That file is not a Visio drawing (.vsdx).");
    const parts = {
      pagesXml,
      pagesRels: await read("visio/pages/_rels/pages.xml.rels"),
      mastersXml: await read("visio/masters/masters.xml"),
      pageXml: {},
    };
    for (const f of zip.file(/^visio\/pages\/page\d+\.xml$/))
      parts.pageXml[f.name.replace(/^.*\//, "")] = await f.async("string");
    return parseParts(parts);
  }

  /* --------------------------------- CSV (ported) ---------------------------- */
  function parseRows(text) {
    const first = text.split(/\r?\n/, 1)[0] || "";
    const delim = [",", ";", "\t"]
      .map((d) => [d, first.split(d).length])
      .sort((a, b) => b[1] - a[1])[0][0];
    const rows = [];
    let row = [],
      cur = "",
      q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            cur += '"';
            i++;
          } else q = false;
        } else cur += c;
      } else if (c === '"') q = true;
      else if (c === delim) {
        row.push(cur);
        cur = "";
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(cur);
        rows.push(row);
        row = [];
        cur = "";
      } else cur += c;
    }
    if (cur || row.length) {
      row.push(cur);
      rows.push(row);
    }
    return rows.filter((r) => r.some((v) => v.trim()));
  }
  /* -> { rows: [{ id, name, title, department, reportsToId, reportsTo }], total } (same column names as the prototype) */
  function parseCsv(text) {
    const all = parseRows(String(text).replace(/^﻿/, ""));
    if (all.length < 2) throw new Error("The CSV has no data rows.");
    const hd = all[0].map((h) =>
      h
        .trim()
        .toLowerCase()
        .replace(/[^a-z]/g, ""),
    );
    const col = (...keys) => hd.findIndex((h) => keys.includes(h));
    const ix = {
      id: col("id", "positionid", "code"),
      name: col("name", "fullname", "employee", "employeename"),
      title: col("title", "jobtitle", "position", "role", "designation"),
      dept: col("department", "dept", "division", "section"),
      rid: col("reportstoid", "managerid", "parentid"),
      rname: col(
        "reportsto",
        "reportstoname",
        "manager",
        "managername",
        "linemanager",
      ),
    };
    if (ix.name < 0 && ix.title < 0)
      throw new Error("Couldn't find a Name or Title column.");
    const g = (r, i) => (i >= 0 ? (r[i] || "").trim() : "");
    const rows = all.slice(1).map((r) => {
      const nm = g(r, ix.name);
      return {
        id: g(r, ix.id),
        name: /^(vacant|tbh|tbd|open)$/i.test(nm) ? "" : nm,
        title: g(r, ix.title),
        department: g(r, ix.dept),
        reportsToId: g(r, ix.rid),
        reportsTo: g(r, ix.rname),
      };
    });
    return { rows, total: rows.length };
  }

  root.ArabtecOrgVsdx = { parse, parseParts, parsePerson, loadScript };
  root.ArabtecOrgCsv = { parse: parseCsv };
})(typeof window !== "undefined" ? window : globalThis);
