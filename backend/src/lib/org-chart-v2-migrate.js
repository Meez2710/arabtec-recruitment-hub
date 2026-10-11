// One-off, idempotent conversion of the legacy organization_node trees into org_chart v2.
// Runs at startup only when the org_chart_v2 flag is on. organization_node is read, never changed or deleted.
// Same advisory-lock pattern as org-chart-seed.js so several backends starting together convert once.
import { get, all, run, tx, driverKind } from "./db.js";
import { createChart, listPositions } from "./org-charts.js";

const MIGRATION_LOCK_KEY = 8402117002;

// A3 landscape in points; role box width and spacing follow the blueprint (plan section 2).
const BOX_W = 81;
const LINE_H = 9.6;
const PAD = 4.5;
const GAP_X = 9;
const GAP_Y = 30;
const COL_INDENT = 12;
// The Hub logo sits top-right under the header band; boxes are never placed under it (mirrors LOGO in org-structure-v2.jsx).
const LOGO = { x: 1107, y: 83, w: 58, h: 56 };
const UNIT_TYPES = new Set(["department", "project", "organizational_unit"]);

const norm = (s) =>
  String(s || "")
    .trim()
    .toLowerCase();

function lockedTx(fn) {
  return tx(() => {
    if (driverKind() === "postgres")
      get(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY}) AS locked`);
    return fn();
  });
}

/** Build one chart payload (+ the people to insert) from a root node and the full node list. */
export function convertTree(root, kidsOf, sharesByName, prefix = "b") {
  let n = 0;
  const boxes = [];
  const people = []; // { boxKey, slot, name, sort }
  const seats = new Map(); // boxKey -> planned

  // `nodes` are the source rows behind this box (several siblings can merge into one role box).
  function addBox(parentKey, kind, title, nodes) {
    n += 1;
    const box = {
      key: `${prefix}${n}`,
      kind,
      title,
      parentKey,
      planned: 0,
      proposed: 0,
      shared: false,
      zati: false,
      x: 0,
      y: 0,
      w: BOX_W,
    };
    boxes.push(box);
    if (kind === "role") {
      box.planned = nodes.length;
      nodes.forEach((node, i) => {
        if ((node.employee_name || "").trim())
          people.push({
            boxKey: box.key,
            slot: i + 1,
            name: node.employee_name.trim(),
            sort: i,
          });
      });
      seats.set(box.key, nodes.length);
    }
    const lines =
      kind === "role"
        ? 2 + nodes.filter((x) => (x.employee_name || "").trim()).length
        : 1;
    box.h = lines * LINE_H + PAD * 2;
    expand(
      box,
      nodes.flatMap((x) => kidsOf.get(x.id) || []),
    );
    return box;
  }

  function expand(parent, childNodes) {
    const groups = new Map();
    for (const c of childNodes) {
      const isPerson =
        (c.employee_name || "").trim() || !UNIT_TYPES.has(c.node_type);
      if (!isPerson) {
        addBox(parent.key, "team", c.position_title || c.department || "Team", [
          c,
        ]);
        continue;
      }
      const g = `${norm(c.position_title)}|${norm(c.department)}`;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(c);
    }
    for (const members of groups.values())
      addBox(
        parent.key,
        "role",
        members[0].position_title || "Position",
        members,
      );
  }

  const rootIsPerson =
    (root.employee_name || "").trim() || !UNIT_TYPES.has(root.node_type);
  addBox(
    null,
    rootIsPerson ? "role" : "team",
    root.position_title || root.employee_name || "Chart",
    [root],
  );

  // Tidy tree: parents centred over their children; a box whose reports are all leaves stacks them in a column.
  const kids = new Map();
  for (const b of boxes)
    if (b.parentKey)
      kids.set(b.parentKey, [...(kids.get(b.parentKey) || []), b]);
  const isStack = (b) =>
    (kids.get(b.key) || []).length > 2 &&
    kids.get(b.key).every((k) => !kids.has(k.key));
  const width = new Map();
  const measure = (b) => {
    const ks = kids.get(b.key) || [];
    let w = b.w;
    if (ks.length && isStack(b)) w = b.w + COL_INDENT;
    else if (ks.length)
      w = Math.max(
        b.w,
        ks.reduce((s, k) => s + measure(k), 0) + GAP_X * (ks.length - 1),
      );
    if (ks.length && isStack(b)) ks.forEach(measure);
    width.set(b.key, w);
    return w;
  };
  const place = (b, x0, y) => {
    const ks = kids.get(b.key) || [];
    b.y = y;
    if (!ks.length) {
      b.x = x0;
      return;
    }
    if (isStack(b)) {
      b.arrange = "col-left";
      b.x = x0;
      let cy = y + b.h + 12;
      for (const k of ks) {
        k.x = x0 + COL_INDENT;
        k.y = cy;
        cy += k.h + 6;
      }
      return;
    }
    const total =
      ks.reduce((s, k) => s + width.get(k.key), 0) + GAP_X * (ks.length - 1);
    let cx = x0 + (width.get(b.key) - total) / 2;
    for (const k of ks) {
      place(k, cx, y + b.h + GAP_Y);
      cx += width.get(k.key) + GAP_X;
    }
    b.x = x0 + (width.get(b.key) - b.w) / 2;
    b.arrange = "row";
  };
  measure(boxes[0]);
  place(boxes[0], 20, 90);
  // Keep the whole tree clear of the logo: move it down until no box touches that corner.
  for (let i = 0; i < 6; i += 1) {
    const hit = boxes.filter(
      (b) =>
        b.x < LOGO.x + LOGO.w + 4 &&
        b.x + b.w > LOGO.x - 4 &&
        b.y < LOGO.y + LOGO.h + 4 &&
        b.y + b.h > LOGO.y - 4,
    );
    if (!hit.length) break;
    const dy = LOGO.y + LOGO.h + 6 - Math.min(...hit.map((b) => b.y));
    for (const b of boxes) b.y += dy;
  }

  const links = boxes
    .filter((b) => b.parentKey)
    .map((b) => ({
      childKey: b.key,
      kind: "reports",
      fromSide: "bottom",
      toSide: "top",
    }));
  const today = new Date().toISOString().slice(0, 10);
  const title =
    root.position_title || root.employee_name || "Organization chart";
  const payload = {
    pages: [
      {
        key: "p1",
        name: "Page 1",
        title1: title,
        title2: root.project_or_location || "",
        date: today,
        paper: "A3",
        boxes,
        links,
        notes: [],
      },
    ],
  };
  // A name that appears in several nodes is split so the person's shares across charts never exceed 1.
  const shared = people.map((p) => ({
    ...p,
    share: 1 / (sharesByName.get(norm(p.name)) || 1),
  }));
  return { payload, people: shared };
}

/**
 * People rows from a CSV (parsed in the browser) -> one chart payload, grouped into role boxes with the same
 * rules as the migration. rows: [{ id, name, title, department, reportsToId, reportsTo }].
 * Several top-level rows hang under one team box named after the chart. Returns { payload } with importPeople set.
 */
export function buildPayloadFromRows(rows, chartName = "Imported chart") {
  const nodes = rows.map((r, i) => ({
    id: i + 1,
    src: String(r.id ?? "").trim(),
    employee_name: String(r.name ?? "").trim(),
    position_title: String(r.title ?? "").trim(),
    department: String(r.department ?? "").trim(),
    node_type: "employee_position",
    rid: String(r.reportsToId ?? "").trim(),
    rname: norm(r.reportsTo),
    parent_id: null,
  }));
  const bySrc = new Map();
  const byName = new Map();
  for (const n of nodes) {
    if (n.src) bySrc.set(n.src, n.id);
    for (const k of [norm(n.employee_name), norm(n.position_title)])
      if (k && !byName.has(k)) byName.set(k, n.id);
  }
  for (const n of nodes) {
    const p = (n.rid && bySrc.get(n.rid)) || (n.rname && byName.get(n.rname)) || null;
    n.parent_id = p === n.id ? null : p;
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    const seen = new Set([n.id]);
    for (let p = n.parent_id; p; p = byId.get(p)?.parent_id) {
      if (seen.has(p)) {
        n.parent_id = null;
        break;
      }
      seen.add(p);
    }
  }
  const kidsOf = new Map();
  for (const n of nodes)
    if (n.parent_id != null)
      kidsOf.set(n.parent_id, [...(kidsOf.get(n.parent_id) || []), n]);
  let roots = nodes.filter((n) => n.parent_id == null);
  if (roots.length > 1) {
    const top = { id: 0, employee_name: "", position_title: chartName, department: "", node_type: "organizational_unit", parent_id: null };
    kidsOf.set(0, roots);
    roots = [top];
  }
  if (!roots.length) throw new Error("The file has no people rows.");
  const nameCount = new Map();
  for (const n of nodes) {
    const k = norm(n.employee_name);
    if (k) nameCount.set(k, (nameCount.get(k) || 0) + 1);
  }
  const prefix = `i${Math.random().toString(36).slice(2, 5)}_`;
  const { payload, people } = convertTree(roots[0], kidsOf, nameCount, prefix);
  payload.pages[0].importPeople = people.map((p) => ({
    boxKey: p.boxKey,
    personName: p.name,
    status: "in_post",
    share: p.share,
    sortOrder: p.sort,
  }));
  return { payload };
}

export function migrateOrganizationNodesToCharts() {
  return lockedTx(() => {
    if ((get("SELECT COUNT(*) AS c FROM org_chart")?.c || 0) > 0)
      return { migrated: false, reason: "charts_exist" };
    const nodes = all(
      "SELECT * FROM organization_node ORDER BY sort_order ASC, id ASC",
    );
    if (!nodes.length) return { migrated: false, reason: "no_nodes" };
    const kidsOf = new Map();
    for (const nd of nodes) {
      if (nd.parent_id == null) continue;
      kidsOf.set(nd.parent_id, [...(kidsOf.get(nd.parent_id) || []), nd]);
    }
    const nameCount = new Map();
    for (const nd of nodes) {
      const k = norm(nd.employee_name);
      if (k) nameCount.set(k, (nameCount.get(k) || 0) + 1);
    }
    const roots = nodes.filter((nd) => nd.parent_id == null);
    let charts = 0;
    let assignments = 0;
    for (const root of roots) {
      const { payload, people } = convertTree(root, kidsOf, nameCount);
      const isHo =
        norm(root.department) === "head office" ||
        norm(root.project_or_location) === "head office";
      const { chart } = createChart(
        {
          name: root.position_title || root.employee_name || `Chart ${root.id}`,
          scope: isHo ? "head_office" : "project",
          projectId: root.project_id ?? null,
          departmentId: root.department_id ?? null,
          payload,
        },
        null,
      );
      run(
        "UPDATE org_chart_version SET label='Migrated from organization_node' WHERE chart_id=?",
        [chart.id],
      );
      const seat = new Map(
        listPositions(chart.id).map((p) => [`${p.boxKey}#${p.slotNo}`, p.id]),
      );
      const t = new Date().toISOString();
      for (const p of people) {
        run(
          `INSERT INTO org_assignment (chart_id, box_key, position_id, person_name, status, share, sort_order, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [
            chart.id,
            p.boxKey,
            seat.get(`${p.boxKey}#${p.slot}`) ?? null,
            p.name,
            "in_post",
            p.share,
            p.sort,
            t,
            t,
          ],
        );
        assignments += 1;
      }
      charts += 1;
    }
    return { migrated: true, charts, assignments };
  });
}
