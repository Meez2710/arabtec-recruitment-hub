/* Organization Structure v2: exports (docs/org-chart/ORG_CHART_V2_PLAN.md section 5).
   window.ArabtecOrgExport = { pdf, vsdx, svg, csv, download, PAPER }
   Each page of a chart arrives as a "sheet model" built by org-structure-v2.jsx from exactly what the sheet shows:
   { style, name, title1, title2, date, boxes: [{ key, kind, x, y, w, h, rows, center, lines, logical, left, dashed }], lines: [{ key, pts, fs, ts, parent }] }
   style "clean" (default): rows = [{ runs: [{ t, tone, s, w }], lh, s }]. style "classic" (Visio replica): lines = wrapped lines as drawn
   ({ t, red }); logical = unwrapped lines for Visio, which wraps the text itself. Neither style draws a logo.
   PDF and Visio code is ported from docs/org-chart/reference/prototype-org-chart-builder.html (toPDF / groupedPDF,
   vsdxPackage / groupedVSDX, svgToPng). jsPDF and JSZip load on demand from /vendor/. World units are points on A3 (1190 x 842). */
(function (root) {
  "use strict";

  // Same numbers as the constants in org-structure-v2.jsx (the sheet).
  const W = 1190,
    H = 842,
    FS = 8,
    LH = 9.6,
    PAD = 4.5;
  const MAROON = "#860915",
    RED = "#E0161B";
  const BAND = { x: 14.4, w: 1161.2, hy: 25, hh: 52, fy: 801, fh: 28 };
  // Clean style: Hub tokens resolved to literals (exports cannot read CSS variables).
  const UI_FONT = 'Inter, Arial, "Liberation Sans", Helvetica, sans-serif';
  const DISPLAY_FONT =
    '"Inter Tight", Inter, Arial, "Liberation Sans", Helvetica, sans-serif';
  const PADX = 7,
    PADY = 6;
  const TONE = {
    ink: "#1A1A1A",
    soft: "#4A4641",
    muted: "#6F6A64",
    brand: "#D01827",
  };
  const CLEAN = {
    line: "#D0D4DA",
    dash: "#C9CED6",
    team: "#F0F1F3",
    text: "#FAFAFB",
  };
  const MON = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  function updated(d) {
    if (!d) return "";
    let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(d),
      day,
      mon,
      yr;
    if (m) [day, mon, yr] = [m[1], m[2], m[3]];
    else if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d)))
      [day, mon, yr] = [m[3], m[2], m[1]];
    return (
      "Updated " +
      (MON[+mon - 1]
        ? String(+day).padStart(2, "0") + " " + MON[+mon - 1] + " " + yr
        : d)
    );
  }
  // Baselines of the rows of one clean box: [{ row, base }]
  function rowBases(b) {
    let y = b.y + PADY;
    if (b.center) y = b.y + (b.h - b.rows.reduce((n, r) => n + r.lh, 0)) / 2;
    return b.rows.map((r) => {
      const base = y + r.lh / 2 + r.s * 0.35;
      y += r.lh;
      return { row: r, base };
    });
  }
  const fillOf = (b) =>
    b.left ? CLEAN.text : b.center ? CLEAN.team : "#FFFFFF";
  const strokeOf = (b) =>
    b.left || b.center ? null : b.dashed ? CLEAN.dash : CLEAN.line;
  const BOX_FONT = 'Arial, "Liberation Sans", Helvetica, sans-serif';
  const HEAD_FONT = 'Calibri, Carlito, Arial, "Liberation Sans", sans-serif';
  const PAPER = {
    A4: [841.89, 595.28],
    A3: [1190.55, 841.89],
    A2: [1683.78, 1190.55],
    A1: [2383.94, 1683.78],
  };
  const GREY = "#b9bec5";

  const esc = (v) =>
    String(v == null ? "" : v)
      .replace(
        /[&<>"]/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
      )
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  const r1 = (n) => Math.round(n * 10) / 10;
  const f6 = (v) => (Math.round(v * 1e6) / 1e6).toString();

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = root.document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () =>
        reject(
          new Error(
            "A tool the export needs did not load. Check the connection and try again.",
          ),
        );
      root.document.head.appendChild(s);
    });
  }
  async function needJsPdf() {
    if (!(root.jspdf && root.jspdf.jsPDF))
      await loadScript("/vendor/jspdf.umd.min.js");
    return root.jspdf.jsPDF;
  }
  async function needZip() {
    if (!root.JSZip) await loadScript("/vendor/jszip.min.js");
    return root.JSZip;
  }

  function arrowHead(pts, size) {
    const E = pts[pts.length - 1];
    let A = pts[0];
    for (let i = pts.length - 2; i >= 0; i--)
      if (Math.hypot(E[0] - pts[i][0], E[1] - pts[i][1]) > 1) {
        A = pts[i];
        break;
      }
    const ang = Math.atan2(E[1] - A[1], E[0] - A[0]),
      w = size * 0.4;
    const bx = E[0] - size * Math.cos(ang),
      by = E[1] - size * Math.sin(ang);
    return [
      E,
      [bx + w * Math.sin(ang), by - w * Math.cos(ang)],
      [bx - w * Math.sin(ang), by + w * Math.cos(ang)],
    ];
  }

  /* ----------------------------------- SVG ----------------------------------- */
  function cleanSvg(m) {
    const f = (fam, sz, wt, fill, x, y, anchor, t) =>
      '<text x="' +
      x +
      '" y="' +
      y +
      '"' +
      (anchor ? ' text-anchor="' + anchor + '"' : "") +
      ' font-family="' +
      fam +
      '" font-size="' +
      sz +
      '" font-weight="' +
      wt +
      '" fill="' +
      fill +
      '">' +
      esc(t) +
      "</text>";
    let o =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' +
      W +
      " " +
      H +
      '" width="' +
      W +
      '" height="' +
      H +
      '">';
    o += '<rect width="' + W + '" height="' + H + '" fill="#fff"/>';
    o += f(DISPLAY_FONT, 16, 700, TONE.ink, 24, 38, "", m.title1);
    o += f(UI_FONT, 9, 400, TONE.muted, 24, 52, "", m.title2);
    if (m.date)
      o += f(
        UI_FONT,
        7.5,
        400,
        TONE.muted,
        W - 24,
        H - 24,
        "end",
        updated(m.date),
      );
    for (const L of m.lines)
      o +=
        '<path d="M' +
        L.pts.map((q) => r1(q[0]) + "," + r1(q[1])).join(" L") +
        '" fill="none" stroke="' +
        CLEAN.line +
        '" stroke-width="1"/>';
    for (const b of m.boxes) {
      const st = strokeOf(b);
      o +=
        '<rect x="' +
        r1(b.x + 0.5) +
        '" y="' +
        r1(b.y + 0.5) +
        '" width="' +
        r1(b.w - 1) +
        '" height="' +
        r1(b.h - 1) +
        '" rx="5.5" fill="' +
        fillOf(b) +
        '"' +
        (st ? ' stroke="' + st + '" stroke-width="1"' : "") +
        (b.dashed ? ' stroke-dasharray="3 2"' : "") +
        "/>";
      o += '<text font-family="' + UI_FONT + '" xml:space="preserve">';
      for (const { row, base } of rowBases(b)) {
        if (!row.runs.length) continue;
        o +=
          '<tspan x="' +
          r1(b.center ? b.x + b.w / 2 : b.x + PADX) +
          '" y="' +
          r1(base) +
          '" text-anchor="' +
          (b.center ? "middle" : "start") +
          '">';
        for (const u of row.runs)
          o +=
            '<tspan font-size="' +
            u.s +
            '" font-weight="' +
            u.w +
            '" fill="' +
            TONE[u.tone] +
            '">' +
            esc(u.t) +
            "</tspan>";
        o += "</tspan>";
      }
      o += "</text>";
    }
    return o + "</svg>";
  }
  function svgOf(m, _lg, style) {
    if ((style || m.style || "clean") !== "classic") return cleanSvg(m);
    return classicSvg(m);
  }
  function classicSvg(m) {
    let o =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ' +
      W +
      " " +
      H +
      '" width="' +
      W +
      '" height="' +
      H +
      '">';
    o += '<rect width="' + W + '" height="' + H + '" fill="#fff"/>';
    o +=
      '<rect x="' +
      BAND.x +
      '" y="' +
      BAND.hy +
      '" width="' +
      BAND.w +
      '" height="' +
      BAND.hh +
      '" fill="' +
      MAROON +
      '" stroke="#000" stroke-width="0.75"/>';
    const t = (y, s) =>
      '<text x="' +
      W / 2 +
      '" y="' +
      y +
      '" text-anchor="middle" fill="#fff" font-family="' +
      HEAD_FONT +
      '" font-weight="bold" font-size="18">' +
      esc(s) +
      "</text>";
    o += t(BAND.hy + 20, m.title1) + t(BAND.hy + 42, m.title2);
    o +=
      '<rect x="' +
      BAND.x +
      '" y="' +
      BAND.fy +
      '" width="' +
      BAND.w +
      '" height="' +
      BAND.fh +
      '" fill="' +
      MAROON +
      '" stroke="#000" stroke-width="0.75"/>';
    if (m.date)
      o +=
        '<text x="1168" y="787" text-anchor="end" font-family="' +
        HEAD_FONT +
        '" font-size="7" fill="#333">' +
        esc("Date: " + m.date) +
        "</text>";
    for (const L of m.lines) {
      o +=
        '<path d="M' +
        L.pts.map((q) => r1(q[0]) + "," + r1(q[1])).join(" L") +
        '" fill="none" stroke="#000" stroke-width="0.75"/>';
      o +=
        '<path d="M' +
        arrowHead(L.pts, 5)
          .map((q) => r1(q[0]) + "," + r1(q[1]))
          .join(" L") +
        ' Z" fill="#000"/>';
    }
    for (const b of m.boxes) {
      o +=
        '<rect x="' +
        r1(b.x) +
        '" y="' +
        r1(b.y) +
        '" width="' +
        r1(b.w) +
        '" height="' +
        r1(b.h) +
        '" fill="#fff" stroke="' +
        (b.left ? GREY : "#000") +
        '" stroke-width="0.75"' +
        (b.dashed ? ' stroke-dasharray="3 2"' : "") +
        "/>";
      o +=
        '<text font-family="' +
        (b.left ? HEAD_FONT : BOX_FONT) +
        '" font-size="' +
        FS +
        '" font-weight="' +
        (b.left ? "normal" : "bold") +
        '">';
      b.lines.forEach((l, i) => {
        o +=
          '<tspan x="' +
          r1(b.left ? b.x + PAD : b.x + b.w / 2) +
          '" y="' +
          r1(b.y + PAD + i * LH + 7.4) +
          '" text-anchor="' +
          (b.left ? "start" : "middle") +
          '" fill="' +
          (l.red ? RED : "#000") +
          '">' +
          (esc(l.t) || " ") +
          "</tspan>";
      });
      o += "</text>";
    }
    return o + "</svg>";
  }
  async function svg(m, { style } = {}) {
    return new Blob([svgOf(m, null, style)], { type: "image/svg+xml" });
  }

  /* ----------------------------------- PDF ----------------------------------- */
  function svgToPng(svgText, wPx, hPx) {
    return new Promise((res, rej) => {
      const img = new root.Image();
      img.onload = () => {
        const cv = root.document.createElement("canvas");
        cv.width = wPx;
        cv.height = hPx;
        const g = cv.getContext("2d");
        g.fillStyle = "#fff";
        g.fillRect(0, 0, wPx, hPx);
        g.drawImage(img, 0, 0, wPx, hPx);
        res(cv.toDataURL("image/png"));
      };
      img.onerror = () => rej(new Error("The chart image could not be drawn."));
      img.src =
        "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgText);
    });
  }
  const NON_LATIN1 = /[^\u0000-ÿ–—‘’“”•…]/;
  const pageText = (m) =>
    [
      m.title1,
      m.title2,
      m.date,
      ...m.boxes.flatMap((b) =>
        b.rows
          ? b.rows.flatMap((r) => r.runs.map((u) => u.t))
          : b.lines.map((l) => l.t),
      ),
    ].join(" ");
  const clean = (t) =>
    String(t)
      .replace(/[–—]/g, "-")
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/•/g, "·")
      .replace(/…/g, "...");

  async function pdf(
    models,
    { paper = "A3", title = "Organization chart", style = "clean" } = {},
  ) {
    const J = await needJsPdf();
    const [pw, ph] = PAPER[paper] || PAPER.A3,
      s = pw / W;
    const doc = new J({
      orientation: "landscape",
      unit: "pt",
      format: [pw, ph],
      compress: true,
    });
    doc.setProperties({
      title,
      subject: "Organization chart",
      creator: "Arabtec Recruitment Hub",
    });
    for (let i = 0; i < models.length; i++) {
      const m = models[i];
      const clean_ = (style || m.style || "clean") !== "classic";
      if (i > 0) doc.addPage([pw, ph], "landscape");
      // Arabic or other scripts the standard PDF fonts cannot draw: print this page as a sharp image (about 200 dpi)
      if (NON_LATIN1.test(pageText(m))) {
        const px = Math.min(9000, Math.round((pw / 72) * 200)),
          py = Math.round((px * ph) / pw);
        doc.addImage(
          await svgToPng(svgOf(m, null, clean_ ? "clean" : "classic"), px, py),
          "PNG",
          0,
          0,
          pw,
          ph,
        );
        continue;
      }
      const X = (x) => x * s,
        Y = (y) => y * s;
      if (clean_) cleanPdfPage(doc, m, s, X, Y);
      else classicPdfPage(doc, m, s, X, Y);
    }
    return doc.output("blob");
  }
  function cleanPdfPage(doc, m, s, X, Y) {
    doc.setLineDashPattern([], 0);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16 * s);
    doc.setTextColor(TONE.ink);
    doc.text(clean(m.title1 || ""), X(24), Y(38));
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9 * s);
    doc.setTextColor(TONE.muted);
    doc.text(clean(m.title2 || ""), X(24), Y(52));
    if (m.date) {
      doc.setFontSize(7.5 * s);
      doc.text(clean(updated(m.date)), X(W - 24), Y(H - 24), {
        align: "right",
      });
    }
    doc.setLineWidth(1 * s);
    doc.setDrawColor(CLEAN.line);
    for (const L of m.lines) {
      const P = L.pts,
        rel = [];
      for (let k = 1; k < P.length; k++)
        rel.push([X(P[k][0] - P[k - 1][0]), Y(P[k][1] - P[k - 1][1])]);
      doc.lines(rel, X(P[0][0]), Y(P[0][1]), [1, 1], "S", false);
    }
    for (const b of m.boxes) {
      const st = strokeOf(b);
      doc.setFillColor(fillOf(b));
      if (st) doc.setDrawColor(st);
      if (b.dashed) doc.setLineDashPattern([3 * s, 2 * s], 0);
      doc.roundedRect(
        X(b.x + 0.5),
        Y(b.y + 0.5),
        X(b.w - 1),
        Y(b.h - 1),
        5.5 * s,
        5.5 * s,
        st ? "FD" : "F",
      );
      doc.setLineDashPattern([], 0);
      for (const { row, base } of rowBases(b)) {
        if (!row.runs.length) continue;
        const wid = row.runs.map((u) => {
          doc.setFont("helvetica", u.w >= 600 ? "bold" : "normal");
          doc.setFontSize(u.s * s);
          return doc.getTextWidth(clean(u.t));
        });
        let x = b.center
          ? X(b.x + b.w / 2) - wid.reduce((n, v) => n + v, 0) / 2
          : X(b.x + PADX);
        row.runs.forEach((u, k) => {
          doc.setFont("helvetica", u.w >= 600 ? "bold" : "normal");
          doc.setFontSize(u.s * s);
          doc.setTextColor(TONE[u.tone]);
          doc.text(clean(u.t), x, Y(base));
          x += wid[k];
        });
      }
    }
  }
  function classicPdfPage(doc, m, s, X, Y) {
    doc.setLineDashPattern([], 0);
    doc.setLineWidth(0.75 * s);
    doc.setDrawColor("#000000");
    doc.setFillColor(MAROON);
    doc.rect(X(BAND.x), Y(BAND.hy), X(BAND.w), Y(BAND.hh), "FD");
    doc.rect(X(BAND.x), Y(BAND.fy), X(BAND.w), Y(BAND.fh), "FD");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(18 * s);
    doc.setTextColor("#FFFFFF");
    doc.text(clean(m.title1 || ""), X(W / 2), Y(BAND.hy + 20), {
      align: "center",
    });
    doc.text(clean(m.title2 || ""), X(W / 2), Y(BAND.hy + 42), {
      align: "center",
    });
    if (m.date) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7 * s);
      doc.setTextColor("#333333");
      doc.text("Date: " + clean(m.date), X(1168), Y(787), { align: "right" });
    }
    doc.setDrawColor("#000000");
    doc.setFillColor("#000000");
    for (const L of m.lines) {
      const P = L.pts,
        rel = [];
      for (let k = 1; k < P.length; k++)
        rel.push([X(P[k][0] - P[k - 1][0]), Y(P[k][1] - P[k - 1][1])]);
      doc.lines(rel, X(P[0][0]), Y(P[0][1]), [1, 1], "S", false);
      const a = arrowHead(P, 5);
      doc.triangle(
        X(a[0][0]),
        Y(a[0][1]),
        X(a[1][0]),
        Y(a[1][1]),
        X(a[2][0]),
        Y(a[2][1]),
        "F",
      );
    }
    for (const b of m.boxes) {
      doc.setFillColor("#FFFFFF");
      doc.setDrawColor(b.left ? GREY : "#000000");
      doc.setLineWidth(0.75 * s);
      if (b.dashed) doc.setLineDashPattern([3 * s, 2 * s], 0);
      doc.rect(X(b.x), Y(b.y), X(b.w), Y(b.h), "FD");
      doc.setLineDashPattern([], 0);
      doc.setFont("helvetica", b.left ? "normal" : "bold");
      doc.setFontSize(FS * s);
      b.lines.forEach((l, k) => {
        doc.setTextColor(l.red ? RED : "#000000");
        doc.text(
          clean(l.t),
          X(b.left ? b.x + PAD : b.x + b.w / 2),
          Y(b.y + PAD + k * LH + 7.4),
          { align: b.left ? "left" : "center" },
        );
      });
    }
  }

  /* ---------------------------------- Visio ---------------------------------- */
  const NS =
    'xmlns="http://schemas.microsoft.com/office/visio/2012/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const cell = (n, v, u, f) =>
    '<Cell N="' +
    n +
    '" V="' +
    esc(v) +
    '"' +
    (u ? ' U="' + u + '"' : "") +
    (f ? ' F="' + esc(f) + '"' : "") +
    "/>";
  const rectGeom =
    '<Section N="Geometry" IX="0">' +
    cell("NoFill", 0) +
    cell("NoLine", 0) +
    cell("NoShow", 0) +
    cell("NoSnap", 0) +
    '<Row T="RelMoveTo" IX="1">' +
    cell("X", 0) +
    cell("Y", 0) +
    '</Row><Row T="RelLineTo" IX="2">' +
    cell("X", 1) +
    cell("Y", 0) +
    '</Row><Row T="RelLineTo" IX="3">' +
    cell("X", 1) +
    cell("Y", 1) +
    '</Row><Row T="RelLineTo" IX="4">' +
    cell("X", 0) +
    cell("Y", 1) +
    '</Row><Row T="RelLineTo" IX="5">' +
    cell("X", 0) +
    cell("Y", 0) +
    "</Row></Section>";
  const chr = (ix, pt, color, bold, font) =>
    '<Row IX="' +
    ix +
    '">' +
    cell("Font", font || 0) +
    cell("Color", color) +
    cell("Style", bold ? 1 : 0) +
    cell("Size", f6(pt / 72), "PT") +
    "</Row>";
  const PWI = PAPER.A3[0] / 72,
    PHI = PAPER.A3[1] / 72; // A3 landscape in inches
  const ix = (x) => x / 72,
    iy = (y) => PHI - y / 72;

  /* One Visio page of shapes. Ids start at 1 on every page. */
  function vsdxPage(m, style) {
    const cleanStyle = style !== "classic";
    let id = 1;
    const parts = [],
      conns = [],
      bid = {};
    const place = (x, y, w, h) =>
      cell("PinX", f6(ix(x + w / 2))) +
      cell("PinY", f6(iy(y + h / 2))) +
      cell("Width", f6(w / 72)) +
      cell("Height", f6(h / 72)) +
      cell("LocPinX", f6(w / 144), "", "Width*0.5") +
      cell("LocPinY", f6(h / 144), "", "Height*0.5") +
      cell("Angle", 0);
    const band = (y, h, text) => {
      const sid = id++;
      parts.push(
        '<Shape ID="' +
          sid +
          '" NameU="Band.' +
          sid +
          '" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">' +
          place(BAND.x, y, BAND.w, h) +
          cell("FillForegnd", MAROON) +
          cell("FillPattern", 1) +
          cell("LineColor", "#000000") +
          cell("LineWeight", f6(0.75 / 72), "PT") +
          cell("VerticalAlign", 1) +
          '<Section N="Character">' +
          chr(0, 18, "#FFFFFF", 1, 0) +
          '</Section><Section N="Paragraph"><Row IX="0">' +
          cell("HorzAlign", 1) +
          "</Row></Section>" +
          rectGeom +
          (text ? '<Text><cp IX="0"/>' + esc(text) + "</Text>" : "") +
          "</Shape>",
      );
    };
    if (cleanStyle) {
      const textShape = (name, x, y, w, h, valign, halign, runs) => {
        const sid = id++;
        parts.push(
          '<Shape ID="' +
            sid +
            '" NameU="' +
            name +
            "." +
            sid +
            '" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">' +
            place(x, y, w, h) +
            cell("LinePattern", 0) +
            cell("FillPattern", 0) +
            cell("VerticalAlign", valign) +
            cell("LeftMargin", 0, "PT") +
            cell("RightMargin", 0, "PT") +
            cell("TopMargin", 0, "PT") +
            cell("BottomMargin", 0, "PT") +
            '<Section N="Character">' +
            runs.map((r, i) => chr(i, r.s, r.c, r.bold, 0)).join("") +
            '</Section><Section N="Paragraph"><Row IX="0">' +
            cell("HorzAlign", halign) +
            "</Row></Section>" +
            "<Text>" +
            runs.map((r, i) => '<cp IX="' + i + '"/>' + esc(r.t)).join("\n") +
            "</Text></Shape>",
        );
      };
      const heads = [{ t: m.title1, s: 16, c: TONE.ink, bold: 1 }];
      if (m.title2) heads.push({ t: m.title2, s: 9, c: TONE.muted, bold: 0 });
      textShape("Title", 24, 24, 760, 16 + (m.title2 ? 14 : 0), 0, 0, heads);
      if (m.date)
        textShape("Date", W - 24 - 200, H - 24 - 12, 200, 12, 2, 2, [
          { t: updated(m.date), s: 7.5, c: TONE.muted, bold: 0 },
        ]);
    } else {
      band(BAND.hy, BAND.hh, [m.title1, m.title2].filter(Boolean).join("\n"));
      band(BAND.fy, BAND.fh, "");
      if (m.date) {
        const sid = id++;
        parts.push(
          '<Shape ID="' +
            sid +
            '" NameU="Date.' +
            sid +
            '" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">' +
            place(1040, 779, 128, 12) +
            cell("LinePattern", 0) +
            cell("FillPattern", 0) +
            cell("VerticalAlign", 1) +
            cell("LeftMargin", 0, "PT") +
            cell("RightMargin", 0, "PT") +
            cell("TopMargin", 0, "PT") +
            cell("BottomMargin", 0, "PT") +
            '<Section N="Character">' +
            chr(0, 7, "#333333", 0, 0) +
            '</Section><Section N="Paragraph"><Row IX="0">' +
            cell("HorzAlign", 2) +
            '</Row></Section><Text><cp IX="0"/>' +
            esc("Date: " + m.date) +
            "</Text></Shape>",
        );
      }
    }
    const conStart = id;
    id += m.lines.length;
    m.boxes.forEach((b) => {
      bid[b.key] = id++;
    });
    const sideIx = { top: 0, left: 1, right: 2, bottom: 3 };
    const conRow = (n, x, y, fx, fy) =>
      '<Row IX="' +
      n +
      '">' +
      cell("X", f6(x), "", fx) +
      cell("Y", f6(y), "", fy) +
      cell("DirX", 0) +
      cell("DirY", 0) +
      cell("Type", 0) +
      "</Row>";
    m.lines.forEach((L, i) => {
      const cid = conStart + i,
        P = L.pts.map(([x, y]) => [ix(x), iy(y)]),
        [bx, by] = P[0],
        [ex, ey] = P[P.length - 1];
      const len = Math.hypot(ex - bx, ey - by) || 0.0001,
        ang = Math.atan2(ey - by, ex - bx),
        ca = Math.cos(-ang),
        sa = Math.sin(-ang);
      const rows = P.map(([x, y], k) => {
        const dx = x - bx,
          dy = y - by;
        return (
          '<Row T="' +
          (k ? "LineTo" : "MoveTo") +
          '" IX="' +
          (k + 1) +
          '">' +
          cell("X", f6(dx * ca - dy * sa)) +
          cell("Y", f6(dx * sa + dy * ca)) +
          "</Row>"
        );
      }).join("");
      parts.splice(
        0,
        0,
        '<Shape ID="' +
          cid +
          '" NameU="Dynamic connector.' +
          cid +
          '" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">' +
          cell("PinX", f6((bx + ex) / 2)) +
          cell("PinY", f6((by + ey) / 2)) +
          cell("Width", f6(len)) +
          cell("Height", 0) +
          cell("LocPinX", f6(len / 2), "", "Width*0.5") +
          cell("LocPinY", 0) +
          cell("Angle", f6(ang)) +
          cell("BeginX", f6(bx)) +
          cell("BeginY", f6(by)) +
          cell("EndX", f6(ex)) +
          cell("EndY", f6(ey)) +
          cell("ObjType", 2) +
          cell("ShapeRouteStyle", 1) +
          cell("ConFixedCode", 2) +
          cell("LineColor", cleanStyle ? CLEAN.line : "#000000") +
          cell("LinePattern", 1) +
          cell("LineWeight", f6(0.75 / 72), "PT") +
          cell("BeginArrow", 0) +
          cell("EndArrow", cleanStyle ? 0 : 4) +
          cell("EndArrowSize", 1) +
          '<Section N="Geometry" IX="0">' +
          cell("NoFill", 1) +
          cell("NoLine", 0) +
          cell("NoShow", 0) +
          cell("NoSnap", 0) +
          rows +
          "</Section></Shape>",
      );
      const part = (side) => (sideIx[side] == null ? null : sideIx[side]);
      const fa = part(L.fs),
        ta = part(L.ts);
      conns.push(
        fa == null
          ? ""
          : '<Connect FromSheet="' +
              cid +
              '" FromCell="BeginX" FromPart="9" ToSheet="' +
              bid[L.parent] +
              '" ToCell="Connections.X' +
              (fa + 1) +
              '" ToPart="' +
              (100 + fa) +
              '"/>',
        ta == null
          ? ""
          : '<Connect FromSheet="' +
              cid +
              '" FromCell="EndX" FromPart="12" ToSheet="' +
              bid[L.key] +
              '" ToCell="Connections.X' +
              (ta + 1) +
              '" ToPart="' +
              (100 + ta) +
              '"/>',
      );
    });
    for (const b of m.boxes) {
      const sid = bid[b.key],
        w = b.w / 72,
        h = b.h / 72;
      let ci = 0;
      const text = cleanStyle
        ? b.rows
            .map((r, i) =>
              r.runs.length
                ? r.runs
                    .map(
                      (u, k) =>
                        '<cp IX="' + ci++ + '"/>' + (k ? "" : '<pp IX="' + i + '"/>') + esc(u.t),
                    )
                    .join("")
                : '<pp IX="' + i + '"/>',
            )
            .join("\n")
        : b.logical.map((l, i) => '<cp IX="' + i + '"/>' + esc(l.t)).join("\n");
      const chars = cleanStyle
        ? (() => {
            let n = 0;
            return b.rows
              .flatMap((r) => r.runs)
              .map((u) => chr(n++, u.s, TONE[u.tone], u.w >= 600, 0))
              .join("");
          })()
        : b.logical
            .map((l, i) =>
              chr(i, FS, l.red ? RED : "#000000", !b.left, b.left ? 0 : 1),
            )
            .join("");
      const paras = cleanStyle
        ? b.rows
            .map(
              (r, i) =>
                '<Row IX="' +
                i +
                '">' +
                cell("HorzAlign", b.center ? 1 : 0) +
                cell("SpLine", f6(-(r.lh / (1.17 * r.s)))) +
                "</Row>",
            )
            .join("")
        : '<Row IX="0">' +
          cell("HorzAlign", b.left ? 0 : 1) +
          cell("SpLine", -1.2) +
          "</Row>";
      parts.push(
        '<Shape ID="' +
          sid +
          '" NameU="' +
          (b.kind === "text" ? "Text" : b.kind === "team" ? "Team" : "Role") +
          "." +
          sid +
          '" Name="' +
          esc(
            (cleanStyle
              ? b.rows[0] && b.rows[0].runs[0] && b.rows[0].runs[0].t
              : b.logical[0] && b.logical[0].t) || "Box",
          ) +
          '" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">' +
          place(b.x, b.y, b.w, b.h) +
          (cleanStyle
            ? cell("LineColor", b.dashed ? CLEAN.dash : CLEAN.line) +
              cell("LinePattern", b.left || b.center ? 0 : b.dashed ? 2 : 1) +
              cell("Rounding", f6(6 / 72), "IN")
            : cell("LineColor", b.left ? GREY : "#000000") +
              cell("LinePattern", b.dashed ? 2 : 1)) +
          cell("LineWeight", f6(0.75 / 72), "PT") +
          cell("FillForegnd", cleanStyle ? fillOf(b) : "#FFFFFF") +
          cell("FillPattern", 1) +
          cell(
            "VerticalAlign",
            cleanStyle ? (b.center ? 1 : 0) : b.left ? 0 : 1,
          ) +
          cell("TopMargin", f6((cleanStyle ? PADY : PAD) / 72), "PT") +
          cell("BottomMargin", f6((cleanStyle ? PADY : PAD) / 72), "PT") +
          cell("LeftMargin", f6((cleanStyle ? PADX : PAD) / 72), "PT") +
          cell("RightMargin", f6((cleanStyle ? PADX : PAD) / 72), "PT") +
          '<Section N="Character">' +
          // one Character row per run/line: viewers read repeated run indexes unreliably
          chars +
          '</Section><Section N="Paragraph">' +
          paras +
          "</Section>" +
          '<Section N="Connection">' +
          conRow(0, w / 2, h, "Width*0.5", "Height*1") +
          conRow(1, 0, h / 2, "Width*0", "Height*0.5") +
          conRow(2, w, h / 2, "Width*1", "Height*0.5") +
          conRow(3, w / 2, 0, "Width*0.5", "Height*0") +
          "</Section>" +
          rectGeom +
          "<Text>" +
          text +
          "</Text></Shape>",
      );
    }
    return (
      '<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<PageContents ' +
      NS +
      ' xml:space="preserve"><Shapes>' +
      parts.join("") +
      "</Shapes>" +
      (conns.filter(Boolean).length
        ? "<Connects>" + conns.filter(Boolean).join("") + "</Connects>"
        : "") +
      "</PageContents>"
    );
  }

  async function vsdx(
    models,
    { title = "Organization chart", style = "clean" } = {},
  ) {
    const Z = await needZip();
    const R = "http://schemas.openxmlformats.org/package/2006/relationships",
      VR = "http://schemas.microsoft.com/visio/2010/relationships";
    const hdr = '<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n';
    const pageEntries = models
      .map(
        (m, i) =>
          '<Page ID="' +
          i +
          '" NameU="Page-' +
          (i + 1) +
          '" Name="' +
          esc((m.name || "Page " + (i + 1)).slice(0, 31)) +
          '"><PageSheet LineStyle="0" FillStyle="0" TextStyle="0">' +
          cell("PageWidth", f6(PWI)) +
          cell("PageHeight", f6(PHI)) +
          cell("ShdwOffsetX", 0.125) +
          cell("ShdwOffsetY", -0.125) +
          cell("PageScale", 1, "IN") +
          cell("DrawingScale", 1, "IN") +
          cell("DrawingSizeType", 0) +
          cell("DrawingScaleType", 0) +
          cell("InhibitSnap", 0) +
          cell("UIVisibility", 0) +
          cell("ShdwType", 0) +
          cell("ShdwObliqueAngle", 0) +
          cell("ShdwScaleFactor", 1) +
          cell("DrawingResizeType", 1) +
          cell("PageShapeSplit", 1) +
          cell("PrintPageOrientation", 2) +
          '</PageSheet><Rel r:id="rId' +
          (i + 1) +
          '"/></Page>',
      )
      .join("");
    const styleCells = [
      cell("EnableLineProps", 1),
      cell("EnableFillProps", 1),
      cell("EnableTextProps", 1),
      cell("HideForApply", 0),
      cell("LineWeight", f6(0.75 / 72), "PT"),
      cell("LineColor", "#000000"),
      cell("LinePattern", 1),
      cell("Rounding", 0, "IN"),
      cell("EndArrowSize", 2),
      cell("BeginArrow", 0),
      cell("EndArrow", 0),
      cell("LineCap", 0),
      cell("BeginArrowSize", 2),
      cell("LineColorTrans", 0),
      cell("CompoundType", 0),
      cell("FillForegnd", "#FFFFFF"),
      cell("FillForegndTrans", 0),
      cell("FillBkgnd", "#000000"),
      cell("FillBkgndTrans", 0),
      cell("FillPattern", 1),
      cell("ShdwForegnd", "#000000"),
      cell("ShdwPattern", 0),
      cell("LeftMargin", f6(4 / 72), "PT"),
      cell("RightMargin", f6(4 / 72), "PT"),
      cell("TopMargin", f6(4 / 72), "PT"),
      cell("BottomMargin", f6(4 / 72), "PT"),
      cell("VerticalAlign", 1),
      cell("TextBkgnd", 0),
      cell("DefaultTabStop", 0.5),
      cell("TextDirection", 0),
      cell("TextBkgndTrans", 0),
    ].join("");
    const docXml =
      hdr +
      "<VisioDocument " +
      NS +
      ' xml:space="preserve"><DocumentSettings TopPage="0" DefaultTextStyle="0" DefaultLineStyle="0" DefaultFillStyle="0" DefaultGuideStyle="0">' +
      cell("GlueSettings", 9) +
      cell("SnapSettings", 65847) +
      cell("SnapExtensions", 34) +
      cell("SnapAngles", 0) +
      cell("DynamicGridEnabled", 1) +
      cell("ProtectStyles", 0) +
      cell("ProtectShapes", 0) +
      cell("ProtectMasters", 0) +
      cell("ProtectBkgnds", 0) +
      '</DocumentSettings><Colors><ColorEntry IX="0" RGB="#000000"/><ColorEntry IX="1" RGB="#FFFFFF"/></Colors><FaceNames><FaceName NameU="Calibri" UnicodeRanges="-536859905 -1073732485 9 0" CharSets="536871423 0" Panose="2 15 5 2 2 2 4 3 2 4" Flags="325"/><FaceName NameU="Arial" UnicodeRanges="-536859905 -1073711039 9 0" CharSets="536871423 0" Panose="2 11 6 4 2 2 2 2 2 4" Flags="325"/></FaceNames><StyleSheets><StyleSheet ID="0" NameU="No Style" IsCustomNameU="1" Name="No Style" IsCustomName="1">' +
      styleCells +
      '<Section N="Character"><Row IX="0">' +
      cell("Font", 0) +
      cell("Color", "#000000") +
      cell("Style", 0) +
      cell("Case", 0) +
      cell("Pos", 0) +
      cell("FontScale", 1) +
      cell("Size", f6(10 / 72), "PT") +
      cell("DblUnderline", 0) +
      cell("Overline", 0) +
      cell("Strikethru", 0) +
      cell("Letterspace", 0) +
      cell("ColorTrans", 0) +
      cell("AsianFont", 0) +
      cell("ComplexScriptFont", 0) +
      cell("ComplexScriptSize", -1) +
      cell("LangID", "en-US") +
      '</Row></Section><Section N="Paragraph"><Row IX="0">' +
      cell("IndFirst", 0) +
      cell("IndLeft", 0) +
      cell("IndRight", 0) +
      cell("SpLine", -1.2) +
      cell("SpBefore", 0) +
      cell("SpAfter", 0) +
      cell("HorzAlign", 1) +
      cell("Bullet", 0) +
      cell("BulletStr", "") +
      cell("BulletFont", 0) +
      cell("BulletFontSize", -1) +
      cell("TextPosAfterBullet", 0) +
      cell("Flags", 0) +
      "</Row></Section></StyleSheet></StyleSheets></VisioDocument>";
    const z = new Z();
    z.file(
      "[Content_Types].xml",
      hdr +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/visio/document.xml" ContentType="application/vnd.ms-visio.drawing.main+xml"/><Override PartName="/visio/pages/pages.xml" ContentType="application/vnd.ms-visio.pages+xml"/>' +
        models
          .map(
            (_, i) =>
              '<Override PartName="/visio/pages/page' +
              (i + 1) +
              '.xml" ContentType="application/vnd.ms-visio.page+xml"/>',
          )
          .join("") +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>',
    );
    z.file(
      "_rels/.rels",
      hdr +
        '<Relationships xmlns="' +
        R +
        '"><Relationship Id="rId1" Type="' +
        VR +
        '/document" Target="visio/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>',
    );
    z.file(
      "docProps/core.xml",
      hdr +
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>' +
        esc(title) +
        '</dc:title><dc:creator>Arabtec Recruitment Hub</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">' +
        new Date().toISOString().slice(0, 19) +
        "Z</dcterms:created></cp:coreProperties>",
    );
    z.file(
      "docProps/app.xml",
      hdr +
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Visio</Application><DocSecurity>0</DocSecurity><Template/></Properties>',
    );
    z.file("visio/document.xml", docXml);
    z.file(
      "visio/_rels/document.xml.rels",
      hdr +
        '<Relationships xmlns="' +
        R +
        '"><Relationship Id="rId1" Type="' +
        VR +
        '/pages" Target="pages/pages.xml"/></Relationships>',
    );
    z.file(
      "visio/pages/pages.xml",
      hdr +
        "<Pages " +
        NS +
        ' xml:space="preserve">' +
        pageEntries +
        "</Pages>",
    );
    z.file(
      "visio/pages/_rels/pages.xml.rels",
      hdr +
        '<Relationships xmlns="' +
        R +
        '">' +
        models
          .map(
            (_, i) =>
              '<Relationship Id="rId' +
              (i + 1) +
              '" Type="' +
              VR +
              '/page" Target="page' +
              (i + 1) +
              '.xml"/>',
          )
          .join("") +
        "</Relationships>",
    );
    models.forEach((m, i) => {
      z.file(
        "visio/pages/page" + (i + 1) + ".xml",
        vsdxPage(m, style || m.style),
      );
    });
    return z.generateAsync({
      type: "blob",
      mimeType: "application/vnd.ms-visio.drawing",
      compression: "DEFLATE",
    });
  }

  /* ----------------------------- CSV and download ----------------------------- */
  function csv(rows) {
    const q = (v) => {
      const s = v == null ? "" : String(v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return new Blob(
      ["﻿" + rows.map((r) => r.map(q).join(",")).join("\r\n") + "\r\n"],
      { type: "text/csv;charset=utf-8" },
    );
  }
  function download(blob, name) {
    const url = root.URL.createObjectURL(blob),
      a = root.document.createElement("a");
    a.href = url;
    a.download = name;
    a.rel = "noopener";
    root.document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => root.URL.revokeObjectURL(url), 4000);
  }

  root.ArabtecOrgExport = { pdf, vsdx, svg, svgOf, csv, download, PAPER };
})(window);
