// Super-admin UI control surface: built-in field visibility, custom fields,
// and logo upload. Gated by app.manage_ui (held by system_admin).
import { Router } from 'express';
import { FieldConfig, CustomFields, Branding } from '../lib/models.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { writeAudit } from '../lib/audit.js';
import { multipart, streamFile } from '../lib/upload.js';

const router = Router();

// Public (no auth): the logo image, so the login screen can display it before sign-in.
router.get('/logo', (req, res) => {
  const name = Branding.all().logo_stored_name;
  if (!name) return res.status(404).json({ error: 'No custom logo set.' });
  streamFile(name, res, 'logo', { inline: true });
});

// Everything below requires authentication.
router.use(requireAuth);
const admin = requirePermission('app.manage_ui');

// Catalog of the built-in (toggleable) fields per form. The UI lists these so the
// admin can show/hide/require/relabel them without code changes.
const BUILTIN_FIELDS = {
  request: [
    ['title', 'Title'], ['justification', 'Justification'], ['projectId', 'Project'],
    ['departmentId', 'Department'], ['location', 'Location'], ['hiringManagerId', 'Hiring Manager'],
    ['headcount', 'Headcount'], ['priority', 'Priority'], ['grade', 'Grade'],
    ['employmentType', 'Employment Type'], ['discipline', 'Discipline'], ['staffCategory', 'Staff Category'],
    ['targetJoinDate', 'Target Join Date'], ['salaryBandMin', 'Salary Band Min'], ['salaryBandMax', 'Salary Band Max'],
    ['keyResponsibilities', 'Key Responsibilities'], ['keyRequirements', 'Key Requirements'],
    ['jobDescription', 'Job Description'], ['hiringManagerNotes', 'Hiring Manager Notes'], ['requiredSkills', 'Required Skills'],
  ],
  candidate: [
    ['fullName', 'Full Name'], ['email', 'Email'], ['phone', 'Phone'], ['nationality', 'Nationality'],
    ['location', 'Location'], ['linkedinUrl', 'LinkedIn URL'], ['currentCompany', 'Current Company'],
    ['currentPosition', 'Current Position'], ['yearsExperience', 'Years of Experience'],
    ['noticePeriod', 'Notice Period'], ['source', 'Source'], ['expectedSalary', 'Expected Salary'], ['tags', 'Tags'],
  ],
  offer: [
    ['positionTitle', 'Position Title'], ['salaryOffered', 'Salary Offered'], ['currency', 'Currency'],
    ['benefits', 'Benefits'], ['joiningDate', 'Joining Date'],
  ],
  interview: [
    ['scheduledAt', 'Scheduled At'], ['mode', 'Mode'], ['location', 'Location'], ['panel', 'Panel'],
  ],
};
const FORMS = Object.keys(BUILTIN_FIELDS);

function fcOut(r) { return { form: r.form, fieldKey: r.field_key, label: r.label, visible: r.visible === 1, required: r.required === 1, sortOrder: r.sort_order }; }
function cfOut(r) { return { id: r.id, entity: r.entity, fieldKey: r.field_key, label: r.label, fieldType: r.field_type, options: r.options ? JSON.parse(r.options) : null, required: r.required === 1, visible: r.visible === 1, sortOrder: r.sort_order }; }

/* ---------------- Built-in field visibility ---------------- */
// Catalog + current overrides for a form (admin view).
router.get('/fields/:form', admin, (req, res) => {
  const form = req.params.form;
  if (!FORMS.includes(form)) return res.status(404).json({ error: 'Unknown form.' });
  const overrides = Object.fromEntries(FieldConfig.forForm(form).map((r) => [r.field_key, fcOut(r)]));
  const fields = BUILTIN_FIELDS[form].map(([key, label], i) => ({
    fieldKey: key, defaultLabel: label,
    ...(overrides[key] || { visible: true, required: false, label: null, sortOrder: i }),
  }));
  res.json({ form, fields });
});
router.put('/fields/:form/:fieldKey', admin, (req, res) => {
  const { form, fieldKey } = req.params;
  if (!FORMS.includes(form)) return res.status(404).json({ error: 'Unknown form.' });
  if (!BUILTIN_FIELDS[form].some(([k]) => k === fieldKey)) return res.status(404).json({ error: 'Unknown field.' });
  const updated = FieldConfig.upsert(form, fieldKey, req.body || {});
  writeAudit(req, { action: 'admin.field_config_changed', entityType: 'field_config', entityId: `${form}.${fieldKey}`, newValue: fcOut(updated) });
  res.json({ field: fcOut(updated) });
});

// Public (auth-only) read used by the forms to know which built-in fields to render.
router.get('/field-config/:form', (req, res) => {
  const overrides = FieldConfig.forForm(req.params.form).map(fcOut);
  res.json({ overrides });
});

/* ---------------- Custom fields ---------------- */
const ENTITIES = ['request', 'candidate'];
router.get('/custom-fields/:entity', (req, res) => {
  const e = req.params.entity;
  if (!ENTITIES.includes(e)) return res.status(404).json({ error: 'Unknown entity.' });
  res.json({ fields: CustomFields.forEntity(e).map(cfOut) });
});
router.post('/custom-fields/:entity', admin, (req, res) => {
  const e = req.params.entity;
  if (!ENTITIES.includes(e)) return res.status(404).json({ error: 'Unknown entity.' });
  const d = req.body || {};
  const fieldKey = (d.fieldKey || d.label || '').toString().trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (!fieldKey || !d.label) return res.status(400).json({ error: 'Label is required.' });
  if (CustomFields.byKey(e, fieldKey)) return res.status(409).json({ error: 'A field with this key already exists.' });
  const TYPES = ['text', 'textarea', 'number', 'date', 'select', 'checkbox'];
  const created = CustomFields.create({
    entity: e, fieldKey, label: d.label, fieldType: TYPES.includes(d.fieldType) ? d.fieldType : 'text',
    options: Array.isArray(d.options) ? d.options : (d.options ? String(d.options).split(',').map((s) => s.trim()).filter(Boolean) : null),
    required: !!d.required, visible: d.visible !== false, sortOrder: d.sortOrder ?? 0,
  });
  writeAudit(req, { action: 'admin.custom_field_created', entityType: 'custom_field', entityId: `${e}.${fieldKey}`, newValue: cfOut(created) });
  res.status(201).json({ field: cfOut(created) });
});
router.put('/custom-fields/:entity/:fieldKey', admin, (req, res) => {
  const { entity, fieldKey } = req.params;
  const updated = CustomFields.update(entity, fieldKey, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Field not found.' });
  writeAudit(req, { action: 'admin.custom_field_updated', entityType: 'custom_field', entityId: `${entity}.${fieldKey}`, newValue: cfOut(updated) });
  res.json({ field: cfOut(updated) });
});
router.delete('/custom-fields/:entity/:fieldKey', admin, (req, res) => {
  const { entity, fieldKey } = req.params;
  if (!CustomFields.byKey(entity, fieldKey)) return res.status(404).json({ error: 'Field not found.' });
  CustomFields.remove(entity, fieldKey);
  writeAudit(req, { action: 'admin.custom_field_deleted', entityType: 'custom_field', entityId: `${entity}.${fieldKey}` });
  res.json({ ok: true });
});

/* ---------------- Logo upload ---------------- */
// Stores the uploaded image in file_blob and records its stored name in branding.
router.post('/logo', admin, multipart, (req, res) => {
  if (!req.uploadedFile) return res.status(400).json({ error: 'No image uploaded.' });
  const { ext, storedName } = req.uploadedFile;
  if (!['.png', '.jpg', '.jpeg', '.svg'].includes(ext)) return res.status(400).json({ error: 'Logo must be PNG, JPG or SVG.' });
  Branding.upsert('logo_stored_name', storedName);
  Branding.upsert('logo_uploaded_at', new Date().toISOString());
  writeAudit(req, { action: 'admin.logo_uploaded', entityType: 'branding', entityId: 'logo', newValue: { storedName } });
  res.json({ ok: true, logoUrl: '/api/admin-ui/logo' });
});
// (Public logo GET is registered above, before auth.)
// Remove custom logo (revert to built-in mark).
router.delete('/logo', admin, (req, res) => {
  Branding.upsert('logo_stored_name', '');
  writeAudit(req, { action: 'admin.logo_removed', entityType: 'branding', entityId: 'logo' });
  res.json({ ok: true });
});

export default router;
export { BUILTIN_FIELDS, FORMS };
