// Organization Structure v2 routes, mounted at /api/org/charts (behind the org_chart_v2 flag).
// Reads need a signed-in user (org.js applies requireAuth); writes need org_chart.manage and are audited.
import { Router } from "express";
import { requirePermission } from "../middleware/auth.js";
import { writeAudit } from "../lib/audit.js";
import { isEnabled } from "../lib/feature-flags.js";
import * as Charts from "../lib/org-charts.js";

const manage = requirePermission("org_chart.manage");

function canManage(req) {
  return !!(
    req.user &&
    Array.isArray(req.user.permissions) &&
    req.user.permissions.includes("org_chart.manage")
  );
}

// Plan section 8: only the HR Director approves a restructure.
function isHrDirector(req) {
  return !!(
    req.user &&
    Array.isArray(req.user.roles) &&
    req.user.roles.includes("hr_director")
  );
}

function id(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0)
    throw new Charts.OrgChartError(400, "That id is not valid.");
  return n;
}

// Wrap a handler so OrgChartError becomes a plain-English JSON response.
const h = (fn) => (req, res, next) => {
  try {
    fn(req, res, next);
  } catch (e) {
    if (e instanceof Charts.OrgChartError)
      return res.status(e.status).json({ error: e.message, ...e.extra });
    next(e);
  }
};

// A version must be read through its chart so ids from other charts never leak across.
function versionOr404(vid) {
  return Charts.getVersion(id(vid));
}

export function registerOrgChartV2Routes(parent) {
  const router = Router();

  router.get(
    "/",
    h((req, res) => {
      res.json({ charts: Charts.listCharts(), canManage: canManage(req) });
    }),
  );

  router.post(
    "/",
    manage,
    h((req, res) => {
      const b = req.body || {};
      const out = Charts.createChart(
        {
          name: b.name,
          scope: b.scope || "project",
          projectId:
            b.projectId == null || b.projectId === "" ? null : id(b.projectId),
          departmentId:
            b.departmentId == null || b.departmentId === ""
              ? null
              : id(b.departmentId),
          payload: b.payload || null,
        },
        req.user.id,
      );
      writeAudit(req, {
        action: "org_chart_v2.chart_created",
        entityType: "org_chart",
        entityId: out.chart.id,
        newValue: { chart: out.chart, payload: out.version.payload },
      });
      res.status(201).json(out);
    }),
  );

  router.get(
    "/versions/:vid",
    h((req, res) => {
      res.json({ version: versionOr404(req.params.vid) });
    }),
  );

  router.put(
    "/versions/:vid",
    manage,
    h((req, res) => {
      const vid = id(req.params.vid);
      const b = req.body || {};
      const { before, after } = Charts.saveVersion(vid, {
        payload: b.payload,
        updatedAt: b.updatedAt,
        label: b.label,
      });
      writeAudit(req, {
        action:
          before.state === "published"
            ? "org_chart_v2.live_edit"
            : "org_chart_v2.draft_saved",
        entityType: "org_chart_version",
        entityId: vid,
        oldValue: { label: before.label, payload: before.payload },
        newValue: { label: after.label, payload: after.payload },
      });
      res.json({ version: after });
    }),
  );

  router.delete(
    "/versions/:vid/boxes/:boxKey",
    manage,
    h((req, res) => {
      const vid = id(req.params.vid);
      const mode = String(req.query.mode || "promote");
      const out = Charts.deleteBoxInDraft(
        vid,
        req.params.boxKey,
        mode,
        String(req.query.confirm || "") === "true",
      );
      writeAudit(req, {
        action:
          mode === "branch"
            ? "org_chart_v2.branch_deleted"
            : "org_chart_v2.box_deleted",
        entityType: "org_chart_version",
        entityId: vid,
        oldValue: out.before.payload,
        newValue: out.after.payload,
        comments: `Removed ${out.removed.join(", ")}${out.promoted.length ? `; reports promoted: ${out.promoted.join(", ")}` : ""}`,
      });
      res.json({
        version: out.after,
        removed: out.removed,
        promoted: out.promoted,
      });
    }),
  );

  const step = (name, fn, { director = false } = {}) =>
    router.post(
      `/versions/:vid/${name}`,
      manage,
      h((req, res) => {
        if (director && !isHrDirector(req)) {
          return res
            .status(403)
            .json({
              error:
                "Only the HR Director can approve or reject a restructure.",
            });
        }
        const vid = id(req.params.vid);
        const out = fn(vid, req);
        writeAudit(req, {
          action: `org_chart_v2.version_${name}`,
          entityType: "org_chart_version",
          entityId: vid,
          oldValue: {
            state: out.before.state,
            approvedBy: out.before.approvedBy,
          },
          newValue: {
            state: out.after.state,
            approvedBy: out.after.approvedBy,
            publishedAt: out.after.publishedAt,
          },
          comments: (req.body && req.body.comment) || null,
        });
        res.json({
          version: out.after,
          ...(out.supersededVersionId
            ? { supersededVersionId: out.supersededVersionId }
            : {}),
        });
      }),
    );
  step("submit", (vid, req) => Charts.submitVersion(vid, req.user.id));
  step("approve", (vid, req) => Charts.approveVersion(vid, req.user.id), {
    director: true,
  });
  step("reject", (vid) => Charts.rejectVersion(vid), { director: true });
  step("publish", (vid, req) =>
    Charts.publishVersion(vid, req.user.id, (req.body && req.body.moves) || {}),
  );

  router.get(
    "/:id",
    h((req, res) => {
      res.json({
        ...Charts.chartDetail(id(req.params.id)),
        canManage: canManage(req),
      });
    }),
  );

  router.post(
    "/:id/drafts",
    manage,
    h((req, res) => {
      const cid = id(req.params.id);
      const version = Charts.createDraft(cid, req.body || {}, req.user.id);
      writeAudit(req, {
        action: "org_chart_v2.draft_created",
        entityType: "org_chart_version",
        entityId: version.id,
        newValue: {
          chartId: cid,
          label: version.label,
          basedOnVersionId: version.basedOnVersionId,
        },
      });
      res.status(201).json({ version });
    }),
  );

  router.get(
    "/:id/versions",
    h((req, res) => {
      const cid = id(req.params.id);
      Charts.getChart(cid);
      res.json({ versions: Charts.listVersions(cid) });
    }),
  );

  router.get(
    "/:id/diff",
    h((req, res) => {
      res.json({
        diff: Charts.diffVersions(
          id(req.params.id),
          id(req.query.a),
          id(req.query.b),
        ),
      });
    }),
  );

  router.post(
    "/:id/assignments",
    manage,
    h((req, res) => {
      const cid = id(req.params.id);
      const assignment = Charts.createAssignment(cid, req.body);
      writeAudit(req, {
        action: "org_chart_v2.assignment_created",
        entityType: "org_assignment",
        entityId: assignment.id,
        newValue: assignment,
      });
      res.status(201).json({ assignment });
    }),
  );

  router.put(
    "/:id/assignments/:aid",
    manage,
    h((req, res) => {
      const { before, after } = Charts.updateAssignment(
        id(req.params.id),
        id(req.params.aid),
        req.body,
      );
      writeAudit(req, {
        action: "org_chart_v2.assignment_updated",
        entityType: "org_assignment",
        entityId: after.id,
        oldValue: before,
        newValue: after,
      });
      res.json({ assignment: after });
    }),
  );

  router.delete(
    "/:id/assignments/:aid",
    manage,
    h((req, res) => {
      const before = Charts.deleteAssignment(
        id(req.params.id),
        id(req.params.aid),
      );
      writeAudit(req, {
        action: "org_chart_v2.assignment_deleted",
        entityType: "org_assignment",
        entityId: before.id,
        oldValue: before,
      });
      res.json({ ok: true });
    }),
  );

  // Checked on every request, so switching the flag takes effect without a restart. Off = 404.
  parent.use(
    "/charts",
    (req, res, next) => {
      if (!isEnabled("org_chart_v2"))
        return res.status(404).json({ error: "Not found." });
      next();
    },
    router,
  );
}
