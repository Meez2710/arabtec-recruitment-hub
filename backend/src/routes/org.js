import { Router } from 'express';
import {
  BusinessUnits, Projects, Sites, Departments, Users,
} from '../lib/models.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { writeAudit } from '../lib/audit.js';

const router = Router();
router.use(requireAuth);

const userName = (id) => { const u = id ? Users.byId(id) : null; return u ? { id: u.id, name: u.full_name } : null; };

// ---------------- Business Units ----------------
router.get('/business-units', (req, res) => res.json({ businessUnits: BusinessUnits.all() }));

// ---------------- Projects ----------------
router.get('/projects', (req, res) => {
  const projects = Projects.all().map((p) => ({
    id: p.id, code: p.code, name: p.name, clientName: p.client_name, location: p.location,
    status: p.status, startDate: p.start_date, endDate: p.end_date,
    projectManager: userName(p.project_manager_id), projectManagerId: p.project_manager_id,
    businessUnitId: p.business_unit_id, siteCount: Projects.siteCount(p.id),
  }));
  res.json({ projects });
});

router.post('/projects', requirePermission('org.manage'), (req, res) => {
  const { code, name, clientName, location, status, startDate, endDate, projectManagerId, businessUnitId } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: 'Project code and name are required.' });
  if (Projects.byCode(code)) return res.status(409).json({ error: 'Project code already exists.' });
  if (startDate && endDate && new Date(endDate) < new Date(startDate)) {
    return res.status(400).json({ error: 'End date cannot be before start date.' });
  }
  const created = Projects.create({
    code, name, clientName, location, status,
    startDate: startDate || null, endDate: endDate || null,
    projectManagerId: projectManagerId ? Number(projectManagerId) : null,
    businessUnitId: businessUnitId ? Number(businessUnitId) : null,
  });
  writeAudit(req, { action: 'project.created', entityType: 'project', entityId: created.id, newValue: created });
  res.status(201).json({ project: created });
});

router.put('/projects/:id', requirePermission('org.manage'), (req, res) => {
  const id = Number(req.params.id);
  const before = Projects.byId(id);
  if (!before) return res.status(404).json({ error: 'Project not found.' });
  const { name, clientName, location, status, startDate, endDate, projectManagerId, businessUnitId } = req.body || {};
  const updated = Projects.update(id, {
    name, clientName, location, status, startDate, endDate,
    projectManagerId: projectManagerId !== undefined ? (projectManagerId ? Number(projectManagerId) : null) : undefined,
    businessUnitId: businessUnitId !== undefined ? (businessUnitId ? Number(businessUnitId) : null) : undefined,
  });
  writeAudit(req, { action: 'project.updated', entityType: 'project', entityId: id, oldValue: before, newValue: updated });
  res.json({ project: updated });
});

// ---------------- Sites ----------------
router.get('/sites', (req, res) => {
  const sites = Sites.all().map((s) => {
    const p = s.project_id ? Projects.byId(s.project_id) : null;
    return {
      id: s.id, code: s.code, name: s.name, location: s.location, status: s.status,
      project: p ? { id: p.id, name: p.name } : null, projectId: s.project_id,
      siteManager: userName(s.site_manager_id), siteManagerId: s.site_manager_id,
    };
  });
  res.json({ sites });
});

router.post('/sites', requirePermission('org.manage'), (req, res) => {
  const { code, name, location, status, projectId, siteManagerId } = req.body || {};
  if (!code || !name || !projectId) return res.status(400).json({ error: 'Site code, name and project are required.' });
  if (Sites.byCode(code)) return res.status(409).json({ error: 'Site code already exists.' });
  if (!Projects.byId(Number(projectId))) return res.status(400).json({ error: 'Selected project does not exist.' });
  const created = Sites.create({
    code, name, location, status, projectId: Number(projectId),
    siteManagerId: siteManagerId ? Number(siteManagerId) : null,
  });
  writeAudit(req, { action: 'site.created', entityType: 'site', entityId: created.id, newValue: created });
  res.status(201).json({ site: created });
});

router.put('/sites/:id', requirePermission('org.manage'), (req, res) => {
  const id = Number(req.params.id);
  const before = Sites.byId(id);
  if (!before) return res.status(404).json({ error: 'Site not found.' });
  const { name, location, status, projectId, siteManagerId } = req.body || {};
  const updated = Sites.update(id, {
    name, location, status, projectId: projectId ? Number(projectId) : undefined,
    siteManagerId: siteManagerId !== undefined ? (siteManagerId ? Number(siteManagerId) : null) : undefined,
  });
  writeAudit(req, { action: 'site.updated', entityType: 'site', entityId: id, oldValue: before, newValue: updated });
  res.json({ site: updated });
});

// ---------------- Departments ----------------
router.get('/departments', (req, res) => {
  const departments = Departments.all().map((d) => ({
    id: d.id, code: d.code, name: d.name, status: d.status,
    head: userName(d.head_user_id), headUserId: d.head_user_id, businessUnitId: d.business_unit_id,
  }));
  res.json({ departments });
});

router.post('/departments', requirePermission('org.manage'), (req, res) => {
  const { code, name, status, headUserId, businessUnitId } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: 'Department code and name are required.' });
  if (Departments.byCode(code)) return res.status(409).json({ error: 'Department code already exists.' });
  const created = Departments.create({
    code, name, status, headUserId: headUserId ? Number(headUserId) : null,
    businessUnitId: businessUnitId ? Number(businessUnitId) : null,
  });
  writeAudit(req, { action: 'department.created', entityType: 'department', entityId: created.id, newValue: created });
  res.status(201).json({ department: created });
});

router.put('/departments/:id', requirePermission('org.manage'), (req, res) => {
  const id = Number(req.params.id);
  const before = Departments.byId(id);
  if (!before) return res.status(404).json({ error: 'Department not found.' });
  const { name, status, headUserId, businessUnitId } = req.body || {};
  const updated = Departments.update(id, {
    name, status,
    headUserId: headUserId !== undefined ? (headUserId ? Number(headUserId) : null) : undefined,
    businessUnitId: businessUnitId !== undefined ? (businessUnitId ? Number(businessUnitId) : null) : undefined,
  });
  writeAudit(req, { action: 'department.updated', entityType: 'department', entityId: id, oldValue: before, newValue: updated });
  res.json({ department: updated });
});

export default router;
