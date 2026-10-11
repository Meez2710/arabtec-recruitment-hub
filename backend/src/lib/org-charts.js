// Organization Structure v2 domain module (docs/org-chart/ORG_CHART_V2_PLAN.md sections 3 and 4).
// One module owns every write to org_chart / org_chart_version / org_position / org_assignment,
// the way lib/join.js owns the join transaction. Routes stay thin; this throws OrgChartError.
import { z } from "zod";
import { get, all, run, tx, driverKind } from "./db.js";

export class OrgChartError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const ARRANGE = ["row", "col-left", "col-right", "two-col"];
export const VERSION_STATES = [
  "draft",
  "pending_approval",
  "published",
  "superseded",
];
export const ASSIGNMENT_STATUSES = ["in_post", "joining", "leaving"];
export const SCOPES = ["project", "head_office", "department"];
const SIDES = ["top", "bottom", "left", "right"];
const EPS = 1e-9;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

/* ------------------------------ payload schema ----------------------------- */

const boxSchema = z.looseObject({
  key: z.string().trim().min(1).max(64),
  kind: z.enum(["role", "team", "text"]),
  title: z.string().max(200).default(""),
  designationId: z.number().int().nullish(),
  planned: z.number().int().min(0).max(500).default(0),
  // Extension of plan section 3: seats beyond `planned` that are drawn dashed and not yet authorised.
  proposed: z.number().int().min(0).max(500).default(0),
  shared: z.boolean().default(false),
  zati: z.boolean().default(false),
  countLabel: z.string().max(60).nullish(),
  parentKey: z.string().min(1).max(64).nullish(),
  arrange: z.enum(ARRANGE).nullish(),
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite().positive().default(81),
  h: z.number().finite().positive().nullish(),
  text: z.string().max(5000).nullish(),
});

const linkSchema = z
  .looseObject({
  childKey: z.string().min(1).max(64),
  // Dotted lines have no parent to infer the start from, so they name it.
  fromKey: z.string().min(1).max(64).nullish(),
  kind: z.enum(["reports", "dotted"]).default("reports"),
  fromSide: z.enum(SIDES).default("bottom"),
  toSide: z.enum(SIDES).default("top"),
  points: z
    .array(z.object({ x: z.number().finite(), y: z.number().finite() }))
    .nullish(),
  style: z.union([z.string().max(60), z.record(z.string(), z.any())]).nullish(),
  })
  .refine((l) => l.kind !== "dotted" || !!l.fromKey, {
    message: "A dotted line needs fromKey.",
    path: ["fromKey"],
  });

// A person read from an imported file. Lives in the draft only; publishing turns each into an org_assignment.
const importPersonSchema = z.looseObject({
  boxKey: z.string().min(1).max(64),
  personName: z.string().trim().min(1).max(200),
  status: z.enum(ASSIGNMENT_STATUSES).default("in_post"),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  suffix: z.string().max(40).nullish(),
  share: z.number().gt(0).max(1).default(1),
  sortOrder: z.number().int().nullish(),
});

const pageSchema = z.looseObject({
  key: z.string().trim().min(1).max(64),
  name: z.string().max(120).default(""),
  title1: z.string().max(200).default(""),
  title2: z.string().max(200).default(""),
  date: z.string().max(40).nullish(),
  paper: z.enum(["A0", "A1", "A2", "A3", "A4"]).default("A3"),
  boxes: z.array(boxSchema).max(2000).default([]),
  links: z.array(linkSchema).max(4000).default([]),
  notes: z
    .array(z.looseObject({ text: z.string().max(5000) }))
    .max(200)
    .default([]),
  importPeople: z.array(importPersonSchema).max(5000).optional(),
});

export const payloadSchema = z.looseObject({
  pages: z.array(pageSchema).min(1).max(20),
  effectiveDate: z.string().max(40).nullish(),
  // Set by "import as new draft on this chart": publishing replaces the chart's people with the file's.
  importReplacesPeople: z.boolean().optional(),
});

export const emptyPayload = (title = "") => ({
  pages: [
    {
      key: "p1",
      name: "Page 1",
      title1: title,
      title2: "",
      date: null,
      paper: "A3",
      boxes: [],
      links: [],
      notes: [],
    },
  ],
});

export const allBoxes = (payload) =>
  payload.pages.flatMap((p) => p.boxes.map((b) => ({ ...b, pageKey: p.key })));
const parentOf = (b) => b.parentKey || null;

/** First box key that sits on a reporting cycle, or null. */
export function findCycle(boxes) {
  const parent = new Map(boxes.map((b) => [b.key, parentOf(b)]));
  for (const b of boxes) {
    const seen = new Set();
    let cur = b.key;
    while (cur != null) {
      if (seen.has(cur)) return b.key;
      seen.add(cur);
      cur = parent.get(cur) ?? null;
    }
  }
  return null;
}

/** Parse + validate a payload. Returns the normalised document or throws OrgChartError(400). */
export function validatePayload(raw) {
  if (raw == null || typeof raw !== "object")
    throw new OrgChartError(400, "The chart content is missing.");
  if (JSON.stringify(raw).length > MAX_PAYLOAD_BYTES)
    throw new OrgChartError(400, "The chart is too large to save.");
  const r = payloadSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new OrgChartError(
      400,
      `Invalid chart content at ${i.path.join(".") || "root"}: ${i.message}`,
    );
  }
  const payload = r.data;
  const pageKeys = new Set();
  for (const p of payload.pages) {
    if (pageKeys.has(p.key))
      throw new OrgChartError(400, `Page key "${p.key}" is used twice.`);
    pageKeys.add(p.key);
  }
  const boxes = allBoxes(payload);
  const keys = new Set();
  for (const b of boxes) {
    if (keys.has(b.key))
      throw new OrgChartError(
        400,
        `Box key "${b.key}" is used twice. Each box needs its own key.`,
      );
    keys.add(b.key);
  }
  for (const b of boxes) {
    const pk = parentOf(b);
    if (pk === b.key)
      throw new OrgChartError(400, "A box cannot report to itself.");
    if (pk != null && !keys.has(pk))
      throw new OrgChartError(
        400,
        `Box "${b.key}" reports to "${pk}", which does not exist.`,
      );
  }
  const cyc = findCycle(boxes);
  if (cyc)
    throw new OrgChartError(
      400,
      `That change would create a reporting cycle (at box "${cyc}").`,
    );
  const roleKeys = new Set(boxes.filter((b) => b.kind === "role").map((b) => b.key));
  for (const p of payload.pages) {
    if (p.importPeople) {
      p.importPeople = p.importPeople.filter((x) => roleKeys.has(x.boxKey));
      if (!p.importPeople.length) delete p.importPeople;
    }
    for (const l of p.links) {
      if (l.fromKey && !keys.has(l.fromKey))
        throw new OrgChartError(
          400,
          `A line starts at box "${l.fromKey}", which does not exist.`,
        );
      if (!keys.has(l.childKey))
        throw new OrgChartError(
          400,
          `A line points at box "${l.childKey}", which does not exist.`,
        );
    }
  }
  return payload;
}

/* ------------------------- structure, diff, delete ------------------------- */

/** What differs structurally (add/remove box, parent, seats, kind, page, lines). [] = only text/layout changed. */
export function structuralChanges(oldP, newP) {
  const out = [];
  const pk = (p) => p.pages.map((x) => x.key).join("|");
  if (pk(oldP) !== pk(newP)) out.push("pages added, removed or reordered");
  const ob = new Map(allBoxes(oldP).map((b) => [b.key, b]));
  const nb = new Map(allBoxes(newP).map((b) => [b.key, b]));
  for (const k of nb.keys()) if (!ob.has(k)) out.push(`box "${k}" added`);
  for (const k of ob.keys()) if (!nb.has(k)) out.push(`box "${k}" removed`);
  for (const [k, n] of nb) {
    const o = ob.get(k);
    if (!o) continue;
    if (o.pageKey !== n.pageKey) out.push(`box "${k}" moved to another page`);
    if (o.kind !== n.kind) out.push(`box "${k}" changed kind`);
    if (parentOf(o) !== parentOf(n))
      out.push(`box "${k}" reports to a different box`);
    if (o.planned !== n.planned || o.proposed !== n.proposed)
      out.push(`box "${k}" changed planned seats`);
  }
  // A reporting line is implied by parentKey (checked above), so a "reports" link entry only carries
  // its route and may be added or dropped live. Dotted lines are real extra relationships.
  const ls = (p) =>
    p.pages
      .flatMap((x) => x.links.filter((l) => l.kind === "dotted").map((l) => `${l.fromKey}>${l.childKey}|${l.kind}`))
      .sort()
      .join(",");
  if (ls(oldP) !== ls(newP)) out.push("lines added or removed");
  return out;
}

function shape(payload) {
  const boxes = allBoxes(payload);
  const children = new Map();
  for (const b of boxes) {
    const pk = parentOf(b);
    if (pk) children.set(pk, (children.get(pk) || 0) + 1);
  }
  const byKey = new Map(boxes.map((b) => [b.key, b]));
  const depth = (k, seen = new Set()) => {
    const p = parentOf(byKey.get(k));
    return p && byKey.has(p) && !seen.has(p) ? 1 + depth(p, seen.add(p)) : 1;
  };
  return {
    layers: boxes.reduce((m, b) => Math.max(m, depth(b.key)), 0),
    widestSpan: Math.max(0, ...children.values()),
    approved: boxes
      .filter((b) => b.kind === "role")
      .reduce((s, b) => s + b.planned, 0),
    proposed: boxes
      .filter((b) => b.kind === "role")
      .reduce((s, b) => s + b.proposed, 0),
  };
}

export function diffPayloads(a, b) {
  const A = new Map(allBoxes(a).map((x) => [x.key, x]));
  const B = new Map(allBoxes(b).map((x) => [x.key, x]));
  const brief = (x) => ({ key: x.key, title: x.title });
  const boxesAdded = [...B.values()].filter((x) => !A.has(x.key)).map(brief);
  const boxesRemoved = [...A.values()].filter((x) => !B.has(x.key)).map(brief);
  const boxesMoved = [];
  const boxesRenamed = [];
  for (const [k, n] of B) {
    const o = A.get(k);
    if (!o) continue;
    if (parentOf(o) !== parentOf(n))
      boxesMoved.push({
        key: k,
        title: n.title,
        fromParentKey: parentOf(o),
        toParentKey: parentOf(n),
      });
    if (o.title !== n.title)
      boxesRenamed.push({ key: k, from: o.title, to: n.title });
  }
  const sa = shape(a);
  const sb = shape(b);
  return {
    boxesAdded,
    boxesRemoved,
    boxesMoved,
    boxesRenamed,
    seatsDelta: {
      approved: sb.approved - sa.approved,
      proposed: sb.proposed - sa.proposed,
    },
    layersBefore: sa.layers,
    layersAfter: sb.layers,
    widestSpanBefore: sa.widestSpan,
    widestSpanAfter: sb.widestSpan,
  };
}

export function descendantKeys(payload, key) {
  const boxes = allBoxes(payload);
  const out = [];
  const queue = [key];
  while (queue.length) {
    const cur = queue.shift();
    for (const b of boxes)
      if (parentOf(b) === cur) {
        out.push(b.key);
        queue.push(b.key);
      }
  }
  return out;
}

/**
 * Remove a box from a payload (pure; returns a new payload).
 * promote: its direct reports move up to its own parent. branch: it and everything under it go.
 */
export function deleteBox(payload, key, mode = "promote") {
  if (!["promote", "branch"].includes(mode))
    throw new OrgChartError(400, "Delete mode must be promote or branch.");
  const box = allBoxes(payload).find((b) => b.key === key);
  if (!box) throw new OrgChartError(404, "Box not found.");
  const next = structuredClone(payload);
  const removed =
    mode === "branch" ? [key, ...descendantKeys(payload, key)] : [key];
  const gone = new Set(removed);
  const promoted =
    mode === "promote"
      ? allBoxes(payload)
          .filter((b) => parentOf(b) === key)
          .map((b) => b.key)
      : [];
  for (const p of next.pages) {
    p.boxes = p.boxes.filter((b) => !gone.has(b.key));
    for (const b of p.boxes)
      if (promoted.includes(b.key)) b.parentKey = box.parentKey || null;
    p.links = p.links.filter((l) => !gone.has(l.childKey) && !gone.has(l.fromKey));
    if (p.importPeople) p.importPeople = p.importPeople.filter((x) => !gone.has(x.boxKey));
    for (const l of p.links) if (promoted.includes(l.childKey)) delete l.points; // the old route no longer fits
  }
  return { payload: next, removed, promoted };
}

/* ------------------------------- row mappers ------------------------------- */

const nowISO = () => new Date().toISOString();
// updated_at doubles as the optimistic-concurrency token, so it must change on every write.
const stamp = (prev) => {
  const t = nowISO();
  return prev && t <= prev ? new Date(Date.parse(prev) + 1).toISOString() : t;
};

export const toChart = (r) =>
  r && {
    id: r.id,
    name: r.name,
    projectId: r.project_id ?? null,
    departmentId: r.department_id ?? null,
    scope: r.scope,
    status: r.status,
    currentVersionId: r.current_version_id ?? null,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };

export const toVersion = (r, withPayload = false) =>
  r && {
    id: r.id,
    chartId: r.chart_id,
    label: r.label,
    state: r.state,
    basedOnVersionId: r.based_on_version_id ?? null,
    createdBy: r.created_by ?? null,
    submittedBy: r.submitted_by ?? null,
    approvedBy: r.approved_by ?? null,
    publishedAt: r.published_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(withPayload ? { payload: JSON.parse(r.payload_json) } : {}),
  };

export const toAssignment = (r) =>
  r && {
    id: r.id,
    chartId: r.chart_id,
    boxKey: r.box_key,
    positionId: r.position_id ?? null,
    personName: r.person_name,
    employeeId: r.employee_id ?? null,
    userId: r.user_id ?? null,
    status: r.status,
    effectiveDate: r.effective_date ?? null,
    share: Number(r.share),
    suffix: r.suffix ?? null,
    applicationId: r.application_id ?? null,
    sortOrder: r.sort_order ?? 0,
    notes: r.notes ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };

export const toPosition = (r) =>
  r && {
    id: r.id,
    chartId: r.chart_id,
    boxKey: r.box_key,
    slotNo: r.slot_no,
    approval: r.approval,
    requisitionSeatId: r.requisition_seat_id ?? null,
    createdInVersionId: r.created_in_version_id ?? null,
    closedInVersionId: r.closed_in_version_id ?? null,
  };

/* --------------------------------- reads ---------------------------------- */

export function getChart(id) {
  const row = get("SELECT * FROM org_chart WHERE id=?", [id]);
  if (!row) throw new OrgChartError(404, "Organization chart not found.");
  return toChart(row);
}

export function getVersionRow(id) {
  const row = get("SELECT * FROM org_chart_version WHERE id=?", [id]);
  if (!row) throw new OrgChartError(404, "Chart version not found.");
  return row;
}

export const getVersion = (id, withPayload = true) =>
  toVersion(getVersionRow(id), withPayload);

export function listCharts() {
  return all("SELECT * FROM org_chart ORDER BY name ASC, id ASC").map((r) => ({
    ...toChart(r),
    publishedAt:
      get("SELECT published_at AS p FROM org_chart_version WHERE id=?", [
        r.current_version_id,
      ])?.p ?? null,
    peopleCount:
      get("SELECT COUNT(*) AS c FROM org_assignment WHERE chart_id=?", [r.id])
        ?.c ?? 0,
    seatCount:
      get(
        "SELECT COUNT(*) AS c FROM org_position WHERE chart_id=? AND closed_in_version_id IS NULL",
        [r.id],
      )?.c ?? 0,
  }));
}

export const listVersions = (chartId) =>
  all("SELECT * FROM org_chart_version WHERE chart_id=? ORDER BY id DESC", [
    chartId,
  ]).map((r) => toVersion(r));

export const listAssignments = (chartId) =>
  all(
    "SELECT * FROM org_assignment WHERE chart_id=? ORDER BY box_key ASC, sort_order ASC, id ASC",
    [chartId],
  ).map(toAssignment);

export const listPositions = (chartId) =>
  all(
    "SELECT * FROM org_position WHERE chart_id=? AND closed_in_version_id IS NULL ORDER BY box_key ASC, slot_no ASC, id ASC",
    [chartId],
  ).map(toPosition);

export function chartDetail(id) {
  const chart = getChart(id);
  const version = chart.currentVersionId
    ? getVersion(chart.currentVersionId)
    : null;
  return {
    chart,
    version,
    assignments: listAssignments(id),
    positions: listPositions(id),
    possibleDuplicates: possibleDuplicates(id),
  };
}

export function diffVersions(chartId, aId, bId) {
  const a = getVersionRow(aId);
  const b = getVersionRow(bId);
  if (a.chart_id !== chartId || b.chart_id !== chartId)
    throw new OrgChartError(400, "Both versions must belong to this chart.");
  return diffPayloads(JSON.parse(a.payload_json), JSON.parse(b.payload_json));
}

/* ------------------------------ seats (positions) --------------------------- */

/** Make org_position match the payload: one open row per seat, closed (never deleted or reused) when a seat goes. */
export function syncPositions(chartId, versionId, payload) {
  const desired = new Map();
  for (const b of allBoxes(payload)) {
    if (b.kind !== "role") continue;
    for (let i = 1; i <= b.planned + b.proposed; i += 1)
      desired.set(`${b.key}#${i}`, i <= b.planned ? "approved" : "proposed");
  }
  const seen = new Set();
  const t = nowISO();
  for (const p of all(
    "SELECT * FROM org_position WHERE chart_id=? AND closed_in_version_id IS NULL",
    [chartId],
  )) {
    const id = `${p.box_key}#${p.slot_no}`;
    if (!desired.has(id)) {
      run(
        "UPDATE org_position SET closed_in_version_id=?, updated_at=? WHERE id=?",
        [versionId, t, p.id],
      );
    } else {
      seen.add(id);
      if (p.approval !== desired.get(id) && p.approval !== "frozen") {
        run("UPDATE org_position SET approval=?, updated_at=? WHERE id=?", [
          desired.get(id),
          t,
          p.id,
        ]);
      }
    }
  }
  for (const [id, approval] of desired) {
    if (seen.has(id)) continue;
    const [boxKey, slot] = [
      id.slice(0, id.lastIndexOf("#")),
      Number(id.slice(id.lastIndexOf("#") + 1)),
    ];
    run(
      "INSERT INTO org_position (chart_id, box_key, slot_no, approval, created_in_version_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
      [chartId, boxKey, slot, approval, versionId, t, t],
    );
  }
}

/** Lowest open seat in the box that nobody holds, or null. */
function freeSeat(chartId, boxKey, exceptAssignmentId = 0) {
  return (
    get(
      `SELECT p.id FROM org_position p
      WHERE p.chart_id=? AND p.box_key=? AND p.closed_in_version_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM org_assignment a WHERE a.position_id=p.id AND a.id<>?)
      ORDER BY p.slot_no ASC, p.id ASC`,
      [chartId, boxKey, exceptAssignmentId],
    )?.id ?? null
  );
}

/** After seats change, people whose seat closed or sits in another box take a free seat in their box, else none. */
function reseatAssignments(chartId) {
  const rows = all(
    `SELECT a.id, a.box_key FROM org_assignment a
       LEFT JOIN org_position p ON p.id=a.position_id
      WHERE a.chart_id=? AND a.position_id IS NOT NULL
        AND (p.id IS NULL OR p.closed_in_version_id IS NOT NULL OR p.box_key<>a.box_key)`,
    [chartId],
  );
  for (const r of rows) {
    run("UPDATE org_assignment SET position_id=?, updated_at=? WHERE id=?", [
      null,
      nowISO(),
      r.id,
    ]);
    const seat = freeSeat(chartId, r.box_key, r.id);
    if (seat)
      run("UPDATE org_assignment SET position_id=? WHERE id=?", [seat, r.id]);
  }
}

/* ------------------------------- chart + drafts ----------------------------- */

/** Copy of the payload without the import-only people lists. */
function stripImportPeople(payload) {
  const next = structuredClone(payload);
  delete next.importReplacesPeople;
  for (const p of next.pages) delete p.importPeople;
  return next;
}

/** Turn each importPeople entry into an assignment (seat, share and box rules apply). Returns how many. */
function createImportedAssignments(chartId, payload) {
  let n = 0;
  for (const p of payload.pages) {
    const list = (p.importPeople || [])
      .slice()
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    for (const x of list) {
      createAssignment(chartId, {
        boxKey: x.boxKey,
        personName: x.personName,
        status: x.status,
        effectiveDate: x.effectiveDate || null,
        suffix: x.suffix || null,
        share: x.share,
      });
      n += 1;
    }
  }
  return n;
}

export function createChart(
  {
    name,
    scope = "project",
    projectId = null,
    departmentId = null,
    payload = null,
    asDraft = false,
  },
  userId = null,
) {
  const nm = String(name || "").trim();
  if (!nm) throw new OrgChartError(400, "Chart name is required.");
  if (!SCOPES.includes(scope))
    throw new OrgChartError(
      400,
      "Scope must be project, head_office or department.",
    );
  if (
    projectId != null &&
    !get("SELECT id FROM project WHERE id=?", [projectId])
  )
    throw new OrgChartError(400, "Selected project does not exist.");
  if (
    departmentId != null &&
    !get("SELECT id FROM department WHERE id=?", [departmentId])
  )
    throw new OrgChartError(400, "Selected department does not exist.");
  const doc = validatePayload(payload || emptyPayload(nm));
  return tx(() => {
    const t = nowISO();
    const cid = Number(
      run(
        "INSERT INTO org_chart (name, project_id, department_id, scope, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
        [nm, projectId, departmentId, scope, userId, t, t],
      ).lastInsertRowid,
    );
    // An imported chart starts as a draft with nothing published: people and seats appear when it is published.
    if (asDraft) {
      const vid = Number(
        run(
          `INSERT INTO org_chart_version (chart_id, label, state, payload_json, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
          [cid, "Imported draft", "draft", JSON.stringify(doc), userId, t, t],
        ).lastInsertRowid,
      );
      return { chart: getChart(cid), version: getVersion(vid) };
    }
    const clean = stripImportPeople(doc);
    const vid = Number(
      run(
        `INSERT INTO org_chart_version (chart_id, label, state, payload_json, created_by, approved_by, published_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          cid,
          "Initial version",
          "published",
          JSON.stringify(clean),
          userId,
          userId,
          t,
          t,
          t,
        ],
      ).lastInsertRowid,
    );
    run("UPDATE org_chart SET current_version_id=? WHERE id=?", [vid, cid]);
    syncPositions(cid, vid, clean);
    createImportedAssignments(cid, doc);
    return { chart: getChart(cid), version: getVersion(vid) };
  });
}

export function createDraft(chartId, { label, payload } = {}, userId = null) {
  const chart = getChart(chartId);
  const imported = payload ? JSON.stringify(validatePayload(payload)) : null;
  if (!chart.currentVersionId)
    throw new OrgChartError(
      409,
      "This chart has no published version to copy.",
    );
  const base = getVersionRow(chart.currentVersionId);
  const t = nowISO();
  const vid = Number(
    run(
      `INSERT INTO org_chart_version (chart_id, label, state, based_on_version_id, based_on_updated_at, base_payload_json, payload_json, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        chartId,
        String(label || "Restructure draft").slice(0, 120),
        "draft",
        base.id,
        base.updated_at,
        base.payload_json,
        imported || base.payload_json,
        userId,
        t,
        t,
      ],
    ).lastInsertRowid,
  );
  return getVersion(vid);
}

/**
 * Save the whole payload of a version. Drafts take any valid payload. The published version takes
 * only non-structural edits (text, widths, positions, line routes). `updatedAt` must match the
 * stored value or nothing is written (409).
 */
export function saveVersion(vid, body) {
  return tx(() => {
    const peek = getVersionRow(vid);
    if (peek.state === "published") {
      lockChart(peek.chart_id);
      if (getChart(peek.chart_id).currentVersionId !== vid)
        throw new OrgChartError(409, "This chart was just republished — reload.");
    }
    return saveVersionLocked(vid, body);
  });
}

function saveVersionLocked(vid, { payload, updatedAt, label }) {
  if (!updatedAt)
    throw new OrgChartError(
      400,
      "updatedAt is required so a newer save is never overwritten.",
    );
  const row = getVersionRow(vid);
  if (row.state === "superseded")
    throw new OrgChartError(
      409,
      "Superseded versions are history and cannot be edited.",
    );
  if (row.state === "pending_approval")
    throw new OrgChartError(
      409,
      "This draft is waiting for approval. Ask for it to be rejected back to draft before editing.",
    );
  let doc = validatePayload(payload);
  if (row.state === "published") {
    doc = stripImportPeople(doc);
    const changes = structuralChanges(JSON.parse(row.payload_json), doc);
    if (changes.length)
      throw new OrgChartError(409, "Use a restructure draft for that change.", {
        changes,
      });
  }
  const before = toVersion(row, true);
  const next = stamp(row.updated_at);
  const r = run(
    `UPDATE org_chart_version SET payload_json=?, label=?, updated_at=? WHERE id=? AND updated_at=? AND state=?`,
    [
      JSON.stringify(doc),
      label != null ? String(label).slice(0, 120) : row.label,
      next,
      vid,
      updatedAt,
      row.state,
    ],
  );
  if (!r.changes) {
    throw new OrgChartError(
      409,
      "Someone else saved this chart since you opened it. Reload to see their changes.",
      { currentUpdatedAt: getVersionRow(vid).updated_at },
    );
  }
  return { before, after: getVersion(vid) };
}

/** Delete a box from a draft (promote or branch) and save it. */
export function deleteBoxInDraft(vid, boxKey, mode, confirm) {
  const row = getVersionRow(vid);
  if (row.state !== "draft")
    throw new OrgChartError(409, "Use a restructure draft for that change.");
  const payload = JSON.parse(row.payload_json);
  const res = deleteBox(payload, boxKey, mode);
  if (mode === "branch" && !confirm) {
    throw new OrgChartError(
      409,
      "Deleting a branch needs confirmation. This will remove the box and everything under it.",
      {
        requiresConfirm: true,
        boxCount: res.removed.length,
      },
    );
  }
  const out = saveVersion(vid, {
    payload: res.payload,
    updatedAt: row.updated_at,
  });
  return { ...out, removed: res.removed, promoted: res.promoted };
}

/* ------------------------- live changes since a draft started ---------------- */

const BOX_LIVE_FIELDS = ["title", "text", "w", "x", "y"];
const LINK_LIVE_FIELDS = ["points", "fromSide", "toSide"];
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Non-structural differences between the payload a draft started from and the live one. */
function liveDelta(base, live) {
  const out = [];
  const bb = new Map(allBoxes(base).map((b) => [b.key, b]));
  for (const nb of allBoxes(live)) {
    const o = bb.get(nb.key);
    if (!o) continue;
    const f = BOX_LIVE_FIELDS.filter((k) => !same(o[k], nb[k]));
    if (f.length) out.push({ kind: "box", key: nb.key, title: nb.title, fields: f });
  }
  const bl = new Map(base.pages.flatMap((p) => p.links).map((l) => [`${l.fromKey}>${l.childKey}|${l.kind}`, l]));
  for (const l of live.pages.flatMap((p) => p.links)) {
    const o = bl.get(`${l.fromKey}>${l.childKey}|${l.kind}`);
    if (!o) {
      if (l.kind !== "dotted") out.push({ kind: "link", key: l.childKey, fields: ["route"] });
      continue;
    }
    const f = LINK_LIVE_FIELDS.filter((k) => !same(o[k], l[k]));
    if (f.length) out.push({ kind: "link", key: l.childKey, fields: f });
  }
  return out;
}

const FIELD_WORDS = { title: "title", text: "text", w: "width", x: "position", y: "position" };
const describeDelta = (d) =>
  d.map((x) =>
    x.kind === "box"
      ? `Box "${x.title || x.key}": ${[...new Set(x.fields.map((f) => FIELD_WORDS[f] || f))].join(", ")} changed`
      : `Line to "${x.key}": route changed`,
  );

/** Throws 409 with a summary when the live chart was edited after this draft started. */
function assertNotStale(row, chart) {
  if (!row.based_on_updated_at) return;
  const live = getVersionRow(chart.currentVersionId);
  if (live.updated_at <= row.based_on_updated_at) return;
  const base = JSON.parse(row.base_payload_json || row.payload_json);
  throw new OrgChartError(409, "The live chart changed after this draft started.", {
    liveChanges: describeDelta(liveDelta(base, JSON.parse(live.payload_json))),
  });
}

/**
 * Copy the live chart's non-structural changes into a draft. A change is skipped when the draft
 * changed the same field itself (the draft wins) or the box/line no longer exists in the draft.
 */
export function rebaseDraft(vid) {
  const row = getVersionRow(vid);
  // Approved drafts may be rebased too: only non-structural live edits (which never need approval) come in.
  if (row.state !== "draft" && row.state !== "pending_approval")
    throw new OrgChartError(409, "Only a draft can be updated with live changes.");
  const chart = getChart(row.chart_id);
  if (row.based_on_version_id !== chart.currentVersionId)
    throw new OrgChartError(
      409,
      "The published chart has changed since this draft was started. Start a new draft from the current chart.",
    );
  const live = getVersionRow(chart.currentVersionId);
  const base = JSON.parse(row.base_payload_json || row.payload_json);
  const livePayload = JSON.parse(live.payload_json);
  const draft = JSON.parse(row.payload_json);
  const before = toVersion(row, true);
  const dBoxes = new Map(allBoxes(draft).map((b) => [b.key, b]));
  // allBoxes spreads copies, so look the real box objects up on the pages.
  const real = new Map(draft.pages.flatMap((p) => p.boxes).map((b) => [b.key, b]));
  const bBoxes = new Map(allBoxes(base).map((b) => [b.key, b]));
  for (const lb of allBoxes(livePayload)) {
    const o = bBoxes.get(lb.key);
    const d = real.get(lb.key);
    if (!o || !d || !dBoxes.has(lb.key)) continue;
    for (const k of BOX_LIVE_FIELDS)
      if (!same(o[k], lb[k]) && same(o[k], d[k])) {
        if (lb[k] === undefined) delete d[k];
        else d[k] = lb[k];
      }
  }
  const dl = new Map(draft.pages.flatMap((p) => p.links).map((l) => [`${l.fromKey}>${l.childKey}|${l.kind}`, l]));
  const bl = new Map(base.pages.flatMap((p) => p.links).map((l) => [`${l.fromKey}>${l.childKey}|${l.kind}`, l]));
  for (const l of livePayload.pages.flatMap((p) => p.links)) {
    const key = `${l.fromKey}>${l.childKey}|${l.kind}`;
    const o = bl.get(key);
    const d = dl.get(key);
    if (!o && !d && l.kind !== "dotted" && real.has(l.childKey)) {
      // a route drawn live for a line the draft has no entry for: copy it onto the page that holds the box
      const pg = draft.pages.find((q) => q.boxes.some((b) => b.key === l.childKey));
      if (pg) pg.links.push(JSON.parse(JSON.stringify(l)));
      continue;
    }
    if (!o || !d) continue;
    for (const k of LINK_LIVE_FIELDS)
      if (!same(o[k], l[k]) && same(o[k], d[k])) {
        if (l[k] === undefined) delete d[k];
        else d[k] = l[k];
      }
  }
  const doc = validatePayload(draft);
  const r = run(
    `UPDATE org_chart_version SET payload_json=?, base_payload_json=?, based_on_updated_at=?, updated_at=? WHERE id=? AND updated_at=? AND state=?`,
    [JSON.stringify(doc), live.payload_json, live.updated_at, stamp(row.updated_at), vid, row.updated_at, row.state],
  );
  if (!r.changes)
    throw new OrgChartError(409, "Someone else saved this draft. Reload to see their changes.");
  return { before, after: getVersion(vid) };
}

/* ------------------------------- state machine ------------------------------ */

function transition(vid, fromState, sets, params, failMsg) {
  const r = run(
    `UPDATE org_chart_version SET ${sets}, updated_at=? WHERE id=? AND state=?`,
    [...params, nowISO(), vid, fromState],
  );
  if (!r.changes) throw new OrgChartError(409, failMsg);
}

export function submitVersion(vid, userId) {
  const row = getVersionRow(vid);
  if (row.state !== "draft")
    throw new OrgChartError(409, "Only a draft can be submitted for approval.");
  const chart = getChart(row.chart_id);
  if (row.based_on_version_id !== chart.currentVersionId) {
    throw new OrgChartError(
      409,
      "The published chart has changed since this draft was started. Start a new draft from the current chart.",
    );
  }
  assertNotStale(row, chart);
  const before = toVersion(row);
  transition(
    vid,
    "draft",
    "state=?, submitted_by=?, approved_by=?",
    ["pending_approval", userId, null],
    "Only a draft can be submitted for approval.",
  );
  return { before, after: getVersion(vid, false) };
}

export function approveVersion(vid, userId) {
  const row = getVersionRow(vid);
  if (row.state !== "pending_approval")
    throw new OrgChartError(409, "Only a submitted draft can be approved.");
  const before = toVersion(row);
  transition(
    vid,
    "pending_approval",
    "approved_by=?",
    [userId],
    "Only a submitted draft can be approved.",
  );
  return { before, after: getVersion(vid, false) };
}

/** Rejecting sends the draft back to its editors. */
export function rejectVersion(vid) {
  const row = getVersionRow(vid);
  if (row.state !== "pending_approval")
    throw new OrgChartError(409, "Only a submitted draft can be rejected.");
  const before = toVersion(row);
  transition(
    vid,
    "pending_approval",
    "state=?, submitted_by=?, approved_by=?",
    ["draft", null, null],
    "Only a submitted draft can be rejected.",
  );
  return { before, after: getVersion(vid, false) };
}

/**
 * Publish an approved draft: supersede the previous published version, point the chart at this one,
 * sync seats. People whose box no longer exists must be moved (`moves` = { oldBoxKey: newBoxKey }) first.
 */
export function publishVersion(vid, userId, moves = {}) {
  return tx(() => {
    lockChart(getVersionRow(vid).chart_id);
    const row = getVersionRow(vid);
    if (row.state !== "pending_approval")
      throw new OrgChartError(409, "Only a submitted draft can be published.");
    if (!row.approved_by)
      throw new OrgChartError(
        409,
        "This draft has not been approved by the HR Director yet.",
      );
    const chart = getChart(row.chart_id);
    if (row.based_on_version_id !== chart.currentVersionId) {
      throw new OrgChartError(
        409,
        "The published chart has changed since this draft was started. Start a new draft from the current chart.",
      );
    }
    assertNotStale(row, chart);
    const before = toVersion(row);
    const payload = JSON.parse(row.payload_json);
    // People can only sit in role boxes, so team/text boxes are not valid destinations.
    const keys = new Set(
      allBoxes(payload)
        .filter((b) => b.kind === "role")
        .map((b) => b.key),
    );
    const t = nowISO();
    // Compare-and-set on the published pointer: of two approved drafts on the same base, only one wins.
    const claimed =
      chart.currentVersionId == null
        ? run(
            "UPDATE org_chart SET current_version_id=?, updated_at=? WHERE id=? AND current_version_id IS NULL",
            [vid, t, chart.id],
          )
        : run(
            "UPDATE org_chart SET current_version_id=?, updated_at=? WHERE id=? AND current_version_id=?",
            [vid, t, chart.id, chart.currentVersionId],
          );
    if (!claimed.changes)
      throw new OrgChartError(
        409,
        "Another restructure was published first — rebase this draft.",
      );
    // A re-import brings the whole roster, so the chart's current people are replaced by the file's.
    let replaced = 0;
    if (payload.importReplacesPeople && payload.pages.some((p) => p.importPeople?.length))
      replaced = run("DELETE FROM org_assignment WHERE chart_id=?", [chart.id]).changes;
    for (const [from, to] of Object.entries(moves || {})) {
      if (!keys.has(to))
        throw new OrgChartError(
          400,
          `Cannot move people to "${to}": that is not a role box in this draft.`,
        );
      run(
        "UPDATE org_assignment SET box_key=?, updated_at=? WHERE chart_id=? AND box_key=?",
        [to, t, chart.id, from],
      );
    }
    const orphans = [
      ...new Set(
        all("SELECT DISTINCT box_key FROM org_assignment WHERE chart_id=?", [
          chart.id,
        ]).map((r) => r.box_key),
      ),
    ].filter((k) => !keys.has(k));
    if (orphans.length) {
      throw new OrgChartError(
        409,
        "People are still assigned to boxes this draft removes. Choose where they go, then publish again.",
        { orphanBoxKeys: orphans },
      );
    }
    run(
      "UPDATE org_chart_version SET state='superseded', updated_at=? WHERE chart_id=? AND state='published'",
      [t, chart.id],
    );
    run(
      "UPDATE org_chart_version SET state='published', published_at=?, updated_at=? WHERE id=?",
      [t, t, vid],
    );
    const clean = stripImportPeople(payload);
    run("UPDATE org_chart_version SET payload_json=? WHERE id=?", [
      JSON.stringify(clean),
      vid,
    ]);
    syncPositions(chart.id, vid, clean);
    reseatAssignments(chart.id);
    const imported = createImportedAssignments(chart.id, payload);
    return {
      imported,
      replaced,
      before,
      after: getVersion(vid, false),
      supersededVersionId: chart.currentVersionId,
      possibleDuplicates: possibleDuplicates(chart.id),
    };
  });
}

/* -------------------------------- assignments ------------------------------- */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function cleanAssignment(b, partial) {
  const out = {};
  const bad = (m) => {
    throw new OrgChartError(400, m);
  };
  if (!partial || b.personName !== undefined) {
    const n = String(b.personName ?? "").trim();
    if (!n) bad("Person name is required.");
    if (n.length > 200) bad("Person name is too long.");
    out.personName = n;
  }
  if (!partial || b.boxKey !== undefined) {
    const k = String(b.boxKey ?? "").trim();
    if (!k) bad("Box is required.");
    out.boxKey = k;
  }
  if (b.status !== undefined) {
    if (!ASSIGNMENT_STATUSES.includes(b.status))
      bad("Status must be in_post, joining or leaving.");
    out.status = b.status;
  }
  if (b.effectiveDate !== undefined) {
    if (
      b.effectiveDate !== null &&
      b.effectiveDate !== "" &&
      !ISO_DATE.test(String(b.effectiveDate))
    )
      bad("Date must look like 2026-10-30.");
    out.effectiveDate = b.effectiveDate || null;
  }
  if (b.share !== undefined) {
    const s = Number(b.share);
    if (!Number.isFinite(s) || s <= 0 || s > 1)
      bad("Share must be more than 0 and at most 1.");
    out.share = s;
  }
  if (b.suffix !== undefined)
    out.suffix = b.suffix ? String(b.suffix).trim().slice(0, 40) : null;
  if (b.notes !== undefined)
    out.notes = b.notes ? String(b.notes).slice(0, 1000) : null;
  if (b.sortOrder !== undefined) {
    const s = Number(b.sortOrder);
    if (!Number.isInteger(s)) bad("Sort order must be a whole number.");
    out.sortOrder = s;
  }
  for (const f of ["employeeId", "userId", "positionId", "applicationId"]) {
    if (b[f] !== undefined) {
      if (b[f] === null || b[f] === "") out[f] = null;
      else if (Number.isInteger(Number(b[f])) && Number(b[f]) > 0)
        out[f] = Number(b[f]);
      else bad(`${f} must be a number.`);
    }
  }
  return out;
}

function publishedBoxKeys(chart) {
  if (!chart.currentVersionId)
    throw new OrgChartError(409, "This chart has no published version yet.");
  const payload = JSON.parse(
    getVersionRow(chart.currentVersionId).payload_json,
  );
  return new Set(
    allBoxes(payload)
      .filter((b) => b.kind === "role")
      .map((b) => b.key),
  );
}

function assertRoleBox(chart, boxKey) {
  const roles = publishedBoxKeys(chart);
  if (roles.has(boxKey)) return;
  const box = allBoxes(
    JSON.parse(getVersionRow(chart.currentVersionId).payload_json),
  ).find((b) => b.key === boxKey);
  throw new OrgChartError(
    400,
    box
      ? "People can only be placed in role boxes."
      : "That box is not on the published chart.",
  );
}

/** Advisory-lock names that serialise share checks per identity (PostgreSQL only). */
export function identityLockKeys(employeeId, userId) {
  return [
    employeeId ? `org_assign:emp:${employeeId}` : null,
    userId ? `org_assign:user:${userId}` : null,
  ].filter(Boolean);
}

/** Serialise writes to one chart (publish, live saves, assignment writes) per chart (PostgreSQL only). */
export function lockChart(chartId, kind = driverKind(), q = get) {
  if (kind !== "postgres") return;
  q("SELECT pg_advisory_xact_lock(hashtext('org_chart:'||?)) AS locked", [String(chartId)]);
}

function lockIdentities(employeeId, userId) {
  if (driverKind() !== "postgres") return;
  for (const k of identityLockKeys(employeeId, userId))
    get("SELECT pg_advisory_xact_lock(hashtext(?)) AS locked", [k]);
}

/** One person's shares across ALL charts must not exceed 1. Only enforced for people with an employee_id or user_id; names are not identities. */
export function assertSharesWithinOne({
  employeeId,
  userId,
  personName,
  share,
  exceptId = 0,
}) {
  if (!employeeId && !userId) return;
  lockIdentities(employeeId, userId);
  for (const [col, id] of [
    ["employee_id", employeeId],
    ["user_id", userId],
  ]) {
    if (!id) continue;
    const total =
      all(`SELECT share FROM org_assignment WHERE ${col}=? AND id<>?`, [
        id,
        exceptId,
      ]).reduce((s, r) => s + Number(r.share), 0) + share;
    if (total > 1 + EPS) {
      throw new OrgChartError(
        409,
        `${personName} would be allocated ${Math.round(total * 100)}% across charts. A person's shares can add up to 100% at most.`,
        { totalShare: total },
      );
    }
  }
}

const normName = (s) => String(s).trim().toLowerCase().replace(/\s+/g, " ");

/** Name-only people whose normalised name appears more than once across published charts and this chart. Not a block, just a hint. */
export function possibleDuplicates(chartId) {
  const rows = all(
    `SELECT a.person_name, a.chart_id, a.box_key, c.name AS chart_name, c.current_version_id AS cv
       FROM org_assignment a JOIN org_chart c ON c.id=a.chart_id
      WHERE a.employee_id IS NULL AND a.user_id IS NULL
        AND (a.chart_id=? OR c.current_version_id IS NOT NULL)
      ORDER BY a.chart_id, a.box_key, a.sort_order, a.id`,
    [chartId],
  );
  const titles = new Map();
  const boxTitle = (r) => {
    if (!titles.has(r.chart_id)) {
      const m = new Map();
      if (r.cv) {
        const v = get("SELECT payload_json FROM org_chart_version WHERE id=?", [r.cv]);
        if (v) for (const b of allBoxes(JSON.parse(v.payload_json))) m.set(b.key, b.title);
      }
      titles.set(r.chart_id, m);
    }
    return titles.get(r.chart_id).get(r.box_key) ?? r.box_key;
  };
  const groups = new Map();
  for (const r of rows) {
    const k = normName(r.person_name);
    if (!groups.has(k)) groups.set(k, { personName: r.person_name.trim(), occurrences: [] });
    groups.get(k).occurrences.push({
      chartId: r.chart_id,
      chartName: r.chart_name,
      boxKey: r.box_key,
      boxTitle: boxTitle(r),
    });
  }
  return [...groups.values()].filter((g) => g.occurrences.length > 1);
}

function checkPosition(chartId, boxKey, positionId, exceptId = 0) {
  const p = get(
    "SELECT box_key, closed_in_version_id FROM org_position WHERE id=? AND chart_id=?",
    [positionId, chartId],
  );
  if (!p || p.closed_in_version_id != null)
    throw new OrgChartError(400, "That seat was not found on this chart.");
  if (p.box_key !== boxKey)
    throw new OrgChartError(400, "That seat belongs to a different box.");
  if (
    get("SELECT id FROM org_assignment WHERE position_id=? AND id<>?", [
      positionId,
      exceptId,
    ])
  )
    throw new OrgChartError(409, "That seat is already taken.");
}

export function getAssignment(chartId, aid) {
  const row = get("SELECT * FROM org_assignment WHERE id=? AND chart_id=?", [
    aid,
    chartId,
  ]);
  if (!row) throw new OrgChartError(404, "Assignment not found.");
  return toAssignment(row);
}

export function createAssignment(chartId, body) {
  getChart(chartId);
  const d = cleanAssignment(body || {}, false);
  return tx(() => {
    lockChart(chartId);
    const chart = getChart(chartId);
    assertRoleBox(chart, d.boxKey);
    const share = d.share ?? 1;
    assertSharesWithinOne({
      employeeId: d.employeeId ?? null,
      userId: d.userId ?? null,
      personName: d.personName,
      share,
    });
    if (d.positionId != null) checkPosition(chartId, d.boxKey, d.positionId);
    const positionId = d.positionId ?? freeSeat(chartId, d.boxKey);
    const sort =
      d.sortOrder ??
      (get(
        "SELECT MAX(sort_order) AS m FROM org_assignment WHERE chart_id=? AND box_key=?",
        [chartId, d.boxKey],
      )?.m ?? -1) + 1;
    const t = nowISO();
    const id = Number(
      run(
        `INSERT INTO org_assignment (chart_id, box_key, position_id, person_name, employee_id, user_id, status, effective_date,
         share, suffix, application_id, sort_order, notes, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          chartId,
          d.boxKey,
          positionId,
          d.personName,
          d.employeeId ?? null,
          d.userId ?? null,
          d.status || "in_post",
          d.effectiveDate ?? null,
          share,
          d.suffix ?? null,
          d.applicationId ?? null,
          sort,
          d.notes ?? null,
          t,
          t,
        ],
      ).lastInsertRowid,
    );
    return getAssignment(chartId, id);
  });
}

export function updateAssignment(chartId, aid, body) {
  getChart(chartId);
  getAssignment(chartId, aid);
  const d = cleanAssignment(body || {}, true);
  return tx(() => {
    lockChart(chartId);
    const chart = getChart(chartId);
    const before = getAssignment(chartId, aid);
    const next = { ...before, ...d };
    const moved = d.boxKey !== undefined && d.boxKey !== before.boxKey;
    if (moved) assertRoleBox(chart, d.boxKey);
    if (
      d.share !== undefined ||
      d.personName !== undefined ||
      d.employeeId !== undefined ||
      d.userId !== undefined
    ) {
      assertSharesWithinOne({
        employeeId: next.employeeId,
        userId: next.userId,
        personName: next.personName,
        share: next.share,
        exceptId: aid,
      });
    }
    if (d.positionId != null) checkPosition(chartId, next.boxKey, d.positionId, aid);
    else if (moved && d.positionId === undefined)
      next.positionId = freeSeat(chartId, next.boxKey, aid);
    run(
      `UPDATE org_assignment SET box_key=?, position_id=?, person_name=?, employee_id=?, user_id=?, status=?, effective_date=?,
         share=?, suffix=?, application_id=?, sort_order=?, notes=?, updated_at=? WHERE id=?`,
      [
        next.boxKey,
        next.positionId,
        next.personName,
        next.employeeId,
        next.userId,
        next.status,
        next.effectiveDate,
        next.share,
        next.suffix,
        next.applicationId,
        next.sortOrder,
        next.notes,
        nowISO(),
        aid,
      ],
    );
    return { before, after: getAssignment(chartId, aid) };
  });
}

export function deleteAssignment(chartId, aid) {
  getChart(chartId);
  return tx(() => {
    lockChart(chartId);
    const before = getAssignment(chartId, aid);
    run("DELETE FROM org_assignment WHERE id=?", [aid]);
    return before;
  });
}
