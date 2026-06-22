// Repository layer: thin, explicit data-access functions over node:sqlite.
// Booleans are stored as 0/1 and converted at the edges. Camel/snake mapping
// is done here so route code stays clean.
import { get, all, run } from './db.js';

const nowISO = () => new Date().toISOString();
const b = (v) => (v ? 1 : 0);          // bool -> int
const ub = (v) => v === 1 || v === true; // int -> bool

// ---------------- Users ----------------
export const Users = {
  byEmail(email) {
    return get('SELECT * FROM users WHERE email = ?', [email]);
  },
  byId(id) {
    return get('SELECT * FROM users WHERE id = ?', [id]);
  },
  list({ q, status } = {}) {
    let sql = 'SELECT * FROM users WHERE 1=1';
    const p = [];
    if (status) { sql += ' AND status = ?'; p.push(status); }
    if (q) {
      sql += ' AND (full_name LIKE ? OR email LIKE ? OR employee_no LIKE ?)';
      const like = `%${q}%`; p.push(like, like, like);
    }
    sql += ' ORDER BY created_at ASC, id ASC';
    return all(sql, p);
  },
  create(d) {
    const r = run(
      `INSERT INTO users (employee_no, full_name, email, phone, job_title, password_hash, status, department_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [d.employeeNo || null, d.fullName, d.email, d.phone || null, d.jobTitle || null,
       d.passwordHash, d.status || 'active', d.departmentId || null, nowISO(), nowISO()],
    );
    return this.byId(Number(r.lastInsertRowid));
  },
  update(id, d) {
    const cur = this.byId(id);
    run(
      `UPDATE users SET full_name=?, email=?, phone=?, job_title=?, employee_no=?, department_id=?, updated_at=? WHERE id=?`,
      [d.fullName ?? cur.full_name, d.email ?? cur.email, d.phone ?? cur.phone,
       d.jobTitle ?? cur.job_title, d.employeeNo ?? cur.employee_no,
       d.departmentId !== undefined ? d.departmentId : cur.department_id, nowISO(), id],
    );
    return this.byId(id);
  },
  setStatus(id, status) {
    run('UPDATE users SET status=?, updated_at=? WHERE id=?', [status, nowISO(), id]);
  },
  setPassword(id, hash) {
    run('UPDATE users SET password_hash=?, updated_at=? WHERE id=?', [hash, nowISO(), id]);
  },
  touchLogin(id) {
    run('UPDATE users SET last_login_at=? WHERE id=?', [nowISO(), id]);
  },
};

// ---------------- Roles & permissions ----------------
export const Roles = {
  all() { return all('SELECT * FROM role ORDER BY id ASC'); },
  byCode(code) { return get('SELECT * FROM role WHERE code = ?', [code]); },
  byId(id) { return get('SELECT * FROM role WHERE id = ?', [id]); },
  permissionsForRole(roleId) {
    return all(
      `SELECT p.code FROM role_permission rp JOIN permission p ON p.id = rp.permission_id WHERE rp.role_id = ?`,
      [roleId],
    ).map((r) => r.code);
  },
  setPermissions(roleId, permIds) {
    run('DELETE FROM role_permission WHERE role_id = ?', [roleId]);
    for (const pid of permIds) {
      run('INSERT INTO role_permission (role_id, permission_id) VALUES (?,?)', [roleId, pid]);
    }
  },
};
export const Permissions = {
  all() { return all('SELECT * FROM permission ORDER BY code ASC'); },
  byCodes(codes) {
    if (!codes.length) return [];
    const ph = codes.map(() => '?').join(',');
    return all(`SELECT * FROM permission WHERE code IN (${ph})`, codes);
  },
};

// ---------------- User roles & scopes ----------------
export const UserRoles = {
  forUser(userId) {
    return all(
      `SELECT r.code, r.name FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE ur.user_id = ?`,
      [userId],
    );
  },
  set(userId, roleCodes) {
    run('DELETE FROM user_role WHERE user_id = ?', [userId]);
    for (const code of roleCodes) {
      const role = Roles.byCode(code);
      if (role) run('INSERT INTO user_role (user_id, role_id) VALUES (?,?)', [userId, role.id]);
    }
  },
};
export const UserScopes = {
  forUser(userId) { return all('SELECT * FROM user_scope WHERE user_id = ?', [userId]); },
  set(userId, { globalScope, projectIds = [], siteIds = [] }) {
    run('DELETE FROM user_scope WHERE user_id = ?', [userId]);
    if (globalScope) {
      run('INSERT INTO user_scope (user_id, scope_type) VALUES (?, ?)', [userId, 'global']);
    } else {
      for (const pid of projectIds) run('INSERT INTO user_scope (user_id, scope_type, project_id) VALUES (?,?,?)', [userId, 'project', pid]);
      for (const sid of siteIds) run('INSERT INTO user_scope (user_id, scope_type, site_id) VALUES (?,?,?)', [userId, 'site', sid]);
    }
  },
};

// Build the full auth context for a user.
export function userContext(userId) {
  const u = Users.byId(userId);
  if (!u) return null;
  const roles = UserRoles.forUser(userId);
  const roleCodes = roles.map((r) => r.code);
  const permSet = new Set();
  for (const rc of roleCodes) {
    const role = Roles.byCode(rc);
    if (role) for (const p of Roles.permissionsForRole(role.id)) permSet.add(p);
  }
  const dept = u.department_id ? get('SELECT id, name FROM department WHERE id = ?', [u.department_id]) : null;
  return {
    id: u.id, employeeNo: u.employee_no, fullName: u.full_name, email: u.email,
    phone: u.phone, jobTitle: u.job_title, status: u.status,
    department: dept ? { id: dept.id, name: dept.name } : null,
    lastLoginAt: u.last_login_at,
    roles: roleCodes,
    permissions: [...permSet],
    scopes: UserScopes.forUser(userId),
  };
}

// ---------------- Sessions ----------------
export const Sessions = {
  create({ id, userId, token, ip, userAgent, expiresAt }) {
    run(
      `INSERT INTO session (id, user_id, token, ip, user_agent, expires_at, created_at) VALUES (?,?,?,?,?,?,?)`,
      [id, userId, token, ip || null, userAgent || null, expiresAt, nowISO()],
    );
  },
  byToken(token) { return get('SELECT * FROM session WHERE token = ?', [token]); },
  revoke(token) { run('UPDATE session SET revoked_at=? WHERE token=?', [nowISO(), token]); },
  revokeForUser(userId) { run('UPDATE session SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', [nowISO(), userId]); },
};

// ---------------- Org ----------------
export const BusinessUnits = { all() { return all('SELECT * FROM business_unit ORDER BY name ASC'); } };

export const Projects = {
  all() { return all('SELECT * FROM project ORDER BY created_at ASC, id ASC'); },
  byId(id) { return get('SELECT * FROM project WHERE id = ?', [id]); },
  byCode(code) { return get('SELECT * FROM project WHERE code = ?', [code]); },
  create(d) {
    const r = run(
      `INSERT INTO project (code,name,client_name,location,status,start_date,end_date,project_manager_id,business_unit_id,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [d.code, d.name, d.clientName || null, d.location || null, d.status || 'active',
       d.startDate || null, d.endDate || null, d.projectManagerId || null, d.businessUnitId || null, nowISO(), nowISO()],
    );
    return this.byId(Number(r.lastInsertRowid));
  },
  update(id, d) {
    const c = this.byId(id);
    run(
      `UPDATE project SET name=?, client_name=?, location=?, status=?, start_date=?, end_date=?, project_manager_id=?, business_unit_id=?, updated_at=? WHERE id=?`,
      [d.name ?? c.name, d.clientName ?? c.client_name, d.location ?? c.location, d.status ?? c.status,
       d.startDate ?? c.start_date, d.endDate ?? c.end_date,
       d.projectManagerId !== undefined ? d.projectManagerId : c.project_manager_id,
       d.businessUnitId !== undefined ? d.businessUnitId : c.business_unit_id, nowISO(), id],
    );
    return this.byId(id);
  },
  siteCount(id) { return get('SELECT COUNT(*) c FROM site WHERE project_id = ?', [id]).c; },
};

export const Sites = {
  all() { return all('SELECT * FROM site ORDER BY created_at ASC, id ASC'); },
  byId(id) { return get('SELECT * FROM site WHERE id = ?', [id]); },
  byCode(code) { return get('SELECT * FROM site WHERE code = ?', [code]); },
  create(d) {
    const r = run(
      `INSERT INTO site (code,name,location,status,project_id,site_manager_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`,
      [d.code, d.name, d.location || null, d.status || 'active', d.projectId, d.siteManagerId || null, nowISO(), nowISO()],
    );
    return this.byId(Number(r.lastInsertRowid));
  },
  update(id, d) {
    const c = this.byId(id);
    run(
      `UPDATE site SET name=?, location=?, status=?, project_id=?, site_manager_id=?, updated_at=? WHERE id=?`,
      [d.name ?? c.name, d.location ?? c.location, d.status ?? c.status,
       d.projectId ?? c.project_id, d.siteManagerId !== undefined ? d.siteManagerId : c.site_manager_id, nowISO(), id],
    );
    return this.byId(id);
  },
};

export const Departments = {
  all() { return all('SELECT * FROM department ORDER BY created_at ASC, id ASC'); },
  byId(id) { return get('SELECT * FROM department WHERE id = ?', [id]); },
  byCode(code) { return get('SELECT * FROM department WHERE code = ?', [code]); },
  create(d) {
    const r = run(
      `INSERT INTO department (code,name,status,head_user_id,business_unit_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
      [d.code, d.name, d.status || 'active', d.headUserId || null, d.businessUnitId || null, nowISO(), nowISO()],
    );
    return this.byId(Number(r.lastInsertRowid));
  },
  update(id, d) {
    const c = this.byId(id);
    run(
      `UPDATE department SET name=?, status=?, head_user_id=?, business_unit_id=?, updated_at=? WHERE id=?`,
      [d.name ?? c.name, d.status ?? c.status,
       d.headUserId !== undefined ? d.headUserId : c.head_user_id,
       d.businessUnitId !== undefined ? d.businessUnitId : c.business_unit_id, nowISO(), id],
    );
    return this.byId(id);
  },
};

// ---------------- Settings ----------------
export const Branding = {
  all() { return Object.fromEntries(all('SELECT key, value FROM branding_setting').map((r) => [r.key, r.value])); },
  upsert(key, value) {
    run(`INSERT INTO branding_setting (key,value,updated_at) VALUES (?,?,?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
        [key, String(value), nowISO()]);
  },
};

export const Buttons = {
  all() { return all('SELECT * FROM button_config ORDER BY screen ASC, button_key ASC'); },
  byKey(key) { return get('SELECT * FROM button_config WHERE button_key = ?', [key]); },
  update(key, d) {
    const c = this.byKey(key);
    run(
      `UPDATE button_config SET label=?, visible=?, enabled=?, required_permission=?, allowed_roles=?, confirm_required=?, reason_required=?, audit_required=?, variant=?, updated_at=? WHERE button_key=?`,
      [d.label ?? c.label,
       d.visible !== undefined ? b(d.visible) : c.visible,
       d.enabled !== undefined ? b(d.enabled) : c.enabled,
       d.requiredPermission !== undefined ? d.requiredPermission : c.required_permission,
       d.allowedRoles !== undefined ? (d.allowedRoles ? JSON.stringify(d.allowedRoles) : null) : c.allowed_roles,
       d.confirmRequired !== undefined ? b(d.confirmRequired) : c.confirm_required,
       d.reasonRequired !== undefined ? b(d.reasonRequired) : c.reason_required,
       d.auditRequired !== undefined ? b(d.auditRequired) : c.audit_required,
       d.variant ?? c.variant, nowISO(), key],
    );
    return this.byKey(key);
  },
};

// ---- Super-admin: built-in field visibility per form ----
export const FieldConfig = {
  forForm(form) { return all('SELECT * FROM field_config WHERE form=? ORDER BY sort_order ASC, field_key ASC', [form]); },
  all() { return all('SELECT * FROM field_config ORDER BY form ASC, sort_order ASC'); },
  upsert(form, fieldKey, d) {
    run(`INSERT INTO field_config (form, field_key, label, visible, required, sort_order, updated_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(form, field_key) DO UPDATE SET
           label=excluded.label, visible=excluded.visible, required=excluded.required,
           sort_order=excluded.sort_order, updated_at=excluded.updated_at`,
        [form, fieldKey, d.label ?? null, b(d.visible !== undefined ? d.visible : true),
         b(d.required !== undefined ? d.required : false), d.sortOrder ?? 0, nowISO()]);
    return get('SELECT * FROM field_config WHERE form=? AND field_key=?', [form, fieldKey]);
  },
};

// ---- Super-admin: custom fields the admin invents ----
export const CustomFields = {
  forEntity(entity) { return all('SELECT * FROM custom_field WHERE entity=? ORDER BY sort_order ASC, id ASC', [entity]); },
  all() { return all('SELECT * FROM custom_field ORDER BY entity ASC, sort_order ASC'); },
  byKey(entity, key) { return get('SELECT * FROM custom_field WHERE entity=? AND field_key=?', [entity, key]); },
  create(d) {
    run(`INSERT INTO custom_field (entity, field_key, label, field_type, options, required, visible, sort_order)
         VALUES (?,?,?,?,?,?,?,?)`,
        [d.entity, d.fieldKey, d.label, d.fieldType || 'text',
         d.options ? JSON.stringify(d.options) : null,
         b(!!d.required), b(d.visible !== undefined ? d.visible : true), d.sortOrder ?? 0]);
    return this.byKey(d.entity, d.fieldKey);
  },
  update(entity, key, d) {
    const c = this.byKey(entity, key);
    if (!c) return null;
    run(`UPDATE custom_field SET label=?, field_type=?, options=?, required=?, visible=?, sort_order=? WHERE entity=? AND field_key=?`,
        [d.label ?? c.label, d.fieldType ?? c.field_type,
         d.options !== undefined ? (d.options ? JSON.stringify(d.options) : null) : c.options,
         d.required !== undefined ? b(d.required) : c.required,
         d.visible !== undefined ? b(d.visible) : c.visible,
         d.sortOrder !== undefined ? d.sortOrder : c.sort_order, entity, key]);
    return this.byKey(entity, key);
  },
  remove(entity, key) {
    run('DELETE FROM custom_field WHERE entity=? AND field_key=?', [entity, key]);
    run('DELETE FROM custom_field_value WHERE entity=? AND field_key=?', [entity, key]);
  },
  valuesFor(entity, recordId) {
    return Object.fromEntries(all('SELECT field_key, value FROM custom_field_value WHERE entity=? AND record_id=?', [entity, recordId]).map((r) => [r.field_key, r.value]));
  },
  setValue(entity, recordId, fieldKey, value) {
    run(`INSERT INTO custom_field_value (entity, record_id, field_key, value, updated_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(entity, record_id, field_key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
        [entity, recordId, fieldKey, value == null ? null : String(value), nowISO()]);
  },
};

export const Workflows = {
  all() { return all('SELECT * FROM workflow_setting ORDER BY id ASC'); },
  byKey(key) { return get('SELECT * FROM workflow_setting WHERE key = ?', [key]); },
  update(key, d) {
    const c = this.byKey(key);
    run('UPDATE workflow_setting SET value=?, is_active=?, updated_at=? WHERE key=?',
        [d.value !== undefined ? JSON.stringify(d.value) : c.value,
         d.isActive !== undefined ? b(d.isActive) : c.is_active, nowISO(), key]);
    return this.byKey(key);
  },
};

export const SystemSettings = {
  all() { return Object.fromEntries(all('SELECT key, value FROM system_setting').map((r) => [r.key, r.value])); },
  upsert(key, value) {
    run(`INSERT INTO system_setting (key,value,updated_at) VALUES (?,?,?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
        [key, String(value), nowISO()]);
  },
};

// ---------------- Audit ----------------
export const Audit = {
  write(d) {
    run(
      `INSERT INTO audit_log (actor_id,actor_name,actor_role,action,entity_type,entity_id,old_value,new_value,comments,ip,user_agent,occurred_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [d.actorId || null, d.actorName || null, d.actorRole || null, d.action, d.entityType,
       d.entityId != null ? String(d.entityId) : null,
       d.oldValue ? JSON.stringify(d.oldValue) : null,
       d.newValue ? JSON.stringify(d.newValue) : null,
       d.comments || null, d.ip || null, d.userAgent || null, nowISO()],
    );
  },
  query({ action, entityType, actorId, q, skip = 0, take = 50 }) {
    let where = 'WHERE 1=1'; const p = [];
    if (action) { where += ' AND action LIKE ?'; p.push(`%${action}%`); }
    if (entityType) { where += ' AND entity_type = ?'; p.push(entityType); }
    if (actorId) { where += ' AND actor_id = ?'; p.push(actorId); }
    if (q) {
      where += ' AND (action LIKE ? OR actor_name LIKE ? OR entity_type LIKE ? OR comments LIKE ?)';
      const like = `%${q}%`; p.push(like, like, like, like);
    }
    const total = get(`SELECT COUNT(*) c FROM audit_log ${where}`, p).c;
    const rows = all(`SELECT * FROM audit_log ${where} ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`, [...p, take, skip]);
    return { total, rows };
  },
  forActor(actorId, limit = 100) {
    return all('SELECT * FROM audit_log WHERE actor_id = ? ORDER BY occurred_at DESC, id DESC LIMIT ?', [actorId, limit]);
  },
  facets() {
    return {
      actions: all('SELECT DISTINCT action FROM audit_log ORDER BY action').map((r) => r.action),
      entityTypes: all('SELECT DISTINCT entity_type FROM audit_log ORDER BY entity_type').map((r) => r.entity_type),
    };
  },
};

// ---------------- Phase 2: Recruitment Requests ----------------
export const Requests = {
  nextTicketNo() {
    const prefix = (get("SELECT value FROM system_setting WHERE key='ticket_prefix'")?.value) || 'REQ';
    const cur = parseInt(get("SELECT value FROM system_setting WHERE key='request_counter'")?.value || '0', 10) + 1;
    run("UPDATE system_setting SET value=? WHERE key='request_counter'", [String(cur)]);
    const year = new Date().getFullYear();
    return `${prefix}-${year}-${String(cur).padStart(5, '0')}`;
  },
  byId(id) { return get('SELECT * FROM recruitment_request WHERE id=?', [id]); },
  // Stamp a lifecycle milestone date only if not already set (captures the FIRST occurrence).
  stampLifecycle(id, column) {
    const allowed = ['first_candidate_at', 'first_shortlist_at', 'first_interview_at', 'first_offer_at', 'posting_date'];
    if (!allowed.includes(column)) return;
    run(`UPDATE recruitment_request SET ${column}=?, updated_at=? WHERE id=? AND (${column} IS NULL OR ${column}='')`, [nowISO(), nowISO(), id]);
  },
  create(d) {
    const r = run(
      `INSERT INTO recruitment_request
        (ticket_no,title,business_unit_id,project_id,site_id,department_id,requester_id,owner_id,
         employment_type,discipline,staff_category,headcount,priority,grade,salary_band_min,salary_band_max,
         currency,justification,job_description,required_skills,target_join_date,status,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [d.ticketNo, d.title, d.businessUnitId, d.projectId, d.siteId, d.departmentId, d.requesterId, d.ownerId || null,
       d.employmentType || 'permanent', d.discipline || null, d.staffCategory || 'staff', d.headcount,
       d.priority || 'medium', d.grade || null, d.salaryBandMin ?? null, d.salaryBandMax ?? null,
       d.currency || 'EGP', d.justification || null, d.jobDescription || null,
       d.requiredSkills ? JSON.stringify(d.requiredSkills) : null, d.targetJoinDate || null,
       d.status || 'draft', d.createdBy, nowISO(), nowISO()],
    );
    return this.byId(Number(r.lastInsertRowid));
  },
  update(id, fields) {
    const cur = this.byId(id);
    const f = { ...cur, ...fields };
    run(
      `UPDATE recruitment_request SET title=?,business_unit_id=?,project_id=?,site_id=?,department_id=?,
        employment_type=?,discipline=?,staff_category=?,headcount=?,priority=?,grade=?,salary_band_min=?,
        salary_band_max=?,currency=?,justification=?,job_description=?,required_skills=?,target_join_date=?,
        key_requirements=?,hiring_manager_notes=?,location=?,key_responsibilities=?,hiring_manager_id=?,
        attachment_path=?,attachment_name=?,
        version=version+1,updated_at=? WHERE id=?`,
      [f.title, f.business_unit_id, f.project_id, f.site_id, f.department_id, f.employment_type, f.discipline,
       f.staff_category, f.headcount, f.priority, f.grade, f.salary_band_min, f.salary_band_max, f.currency,
       f.justification, f.job_description,
       f.required_skills != null ? (typeof f.required_skills === 'string' ? f.required_skills : JSON.stringify(f.required_skills)) : null,
       f.target_join_date, f.key_requirements ?? null, f.hiring_manager_notes ?? null,
       f.location ?? null, f.key_responsibilities ?? null, f.hiring_manager_id ?? null,
       f.attachment_path ?? null, f.attachment_name ?? null, nowISO(), id],
    );
    return this.byId(id);
  },
  setStatus(id, status, extra = {}) {
    const sets = ['status=?', 'updated_at=?']; const params = [status, nowISO()];
    for (const [k, v] of Object.entries(extra)) { sets.push(`${k}=?`); params.push(v); }
    params.push(id);
    run(`UPDATE recruitment_request SET ${sets.join(',')} WHERE id=?`, params);
    return this.byId(id);
  },
  setOwner(id, ownerId) { run('UPDATE recruitment_request SET owner_id=?, updated_at=? WHERE id=?', [ownerId, nowISO(), id]); },
  setBudget(id, status, note) { run('UPDATE recruitment_request SET budget_status=?, budget_note=?, updated_at=? WHERE id=?', [status, note || null, nowISO(), id]); },
  list(filters = {}) {
    let sql = 'SELECT * FROM recruitment_request WHERE 1=1';
    const p = [];
    if (filters.status) { sql += ' AND status=?'; p.push(filters.status); }
    if (filters.priority) { sql += ' AND priority=?'; p.push(filters.priority); }
    if (filters.projectId) { sql += ' AND project_id=?'; p.push(Number(filters.projectId)); }
    if (filters.departmentId) { sql += ' AND department_id=?'; p.push(Number(filters.departmentId)); }
    if (filters.ownerId) { sql += ' AND owner_id=?'; p.push(Number(filters.ownerId)); }
    if (filters.requesterId) { sql += ' AND requester_id=?'; p.push(Number(filters.requesterId)); }
    if (filters.q) { sql += ' AND (title LIKE ? OR ticket_no LIKE ? OR discipline LIKE ?)'; const l = `%${filters.q}%`; p.push(l, l, l); }
    if (filters.ownedOnly && filters.userId) { sql += ' AND (owner_id=? OR requester_id=? OR created_by=?)'; p.push(filters.userId, filters.userId, filters.userId); }
    const sortCol = ({ created: 'created_at', priority: 'priority', title: 'title', status: 'status', target: 'target_join_date', ticket: 'ticket_no' })[filters.sort] || 'created_at';
    const dir = (filters.dir || 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    sql += ` ORDER BY ${sortCol} ${dir}`;
    return all(sql, p);
  },
  counts() {
    return all('SELECT status, COUNT(*) c FROM recruitment_request GROUP BY status');
  },
};

export const Seats = {
  forRequest(reqId) { return all('SELECT * FROM requisition_seat WHERE request_id=? ORDER BY seat_no', [reqId]); },
  createMany(reqId, count, siteId = null) {
    for (let i = 1; i <= count; i++) run('INSERT INTO requisition_seat (request_id,seat_no,site_id) VALUES (?,?,?)', [reqId, i, siteId]);
  },
  filledCount(reqId) { return get("SELECT COUNT(*) c FROM requisition_seat WHERE request_id=? AND status='filled'", [reqId]).c; },
  cancelOpen(reqId, reason) {
    run("UPDATE requisition_seat SET status='cancelled', cancel_reason=? WHERE request_id=? AND status IN ('open','reserved','reopened')", [reason, reqId]);
  },
};

export const Approvals = {
  forRequest(reqId) { return all('SELECT * FROM request_approval WHERE request_id=? ORDER BY level', [reqId]); },
  createChain(reqId, levels) {
    for (const lv of levels) run('INSERT INTO request_approval (request_id,level,name,role_code) VALUES (?,?,?,?)', [reqId, lv.level, lv.name, lv.roleCode || null]);
  },
  currentPending(reqId) {
    return get("SELECT * FROM request_approval WHERE request_id=? AND decision='pending' ORDER BY level LIMIT 1", [reqId]);
  },
  decide(id, { decision, approverId, comment }) {
    run('UPDATE request_approval SET decision=?, approver_id=?, comment=?, decided_at=? WHERE id=?', [decision, approverId, comment || null, nowISO(), id]);
  },
  allApproved(reqId) {
    const pendingOrRejected = get("SELECT COUNT(*) c FROM request_approval WHERE request_id=? AND decision IN ('pending','rejected','returned')", [reqId]).c;
    const total = get('SELECT COUNT(*) c FROM request_approval WHERE request_id=?', [reqId]).c;
    return total > 0 && pendingOrRejected === 0;
  },
  resetChain(reqId) { run("UPDATE request_approval SET decision='pending', approver_id=NULL, comment=NULL, decided_at=NULL WHERE request_id=?", [reqId]); },
};

export const RequestActivity = {
  add(reqId, actor, type, { fromStatus = null, toStatus = null, note = null } = {}) {
    run('INSERT INTO request_activity (request_id,actor_id,actor_name,type,from_status,to_status,note,occurred_at) VALUES (?,?,?,?,?,?,?,?)',
      [reqId, actor?.id || null, actor?.fullName || null, type, fromStatus, toStatus, note, nowISO()]);
  },
  forRequest(reqId) { return all('SELECT * FROM request_activity WHERE request_id=? ORDER BY occurred_at DESC, id DESC', [reqId]); },
};

// ---------------- Phase 3: Candidates & Applications ----------------
const normEmail = (e) => (e || '').toLowerCase().trim() || null;
const normPhone = (p) => (p || '').replace(/[^0-9]/g, '') || null;
const normLinkedin = (l) => (l || '').toLowerCase().replace(/\/+$/, '').replace(/^https?:\/\/(www\.)?/, '') || null;

export const Candidates = {
  nextNo() {
    const prefix = get("SELECT value FROM system_setting WHERE key='candidate_prefix'")?.value || 'CAN';
    const cur = parseInt(get("SELECT value FROM system_setting WHERE key='candidate_counter'")?.value || '0', 10) + 1;
    run("UPDATE system_setting SET value=? WHERE key='candidate_counter'", [String(cur)]);
    return `${prefix}-${String(cur).padStart(5, '0')}`;
  },
  byId(id) { return get('SELECT * FROM candidate WHERE id=?', [id]); },
  create(d) {
    const r = run(
      `INSERT INTO candidate (candidate_no,full_name,email,phone,nationality,location,linkedin_url,
        current_company,current_position,years_experience,expected_salary,notice_period,source,
        employer,current_project,graduation_year,university,major,tags,
        owner_recruiter_id,dedup_email,dedup_phone,dedup_linkedin,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [d.candidateNo, d.fullName, d.email || null, d.phone || null, d.nationality || null, d.location || null,
       d.linkedinUrl || null, d.currentCompany || null, d.currentPosition || null,
       d.yearsExperience ?? null, d.expectedSalary ?? null, d.noticePeriod || null, d.source || null,
       d.employer || null, d.currentProject || null, d.graduationYear ?? null, d.university || null, d.major || null,
       d.tags ? JSON.stringify(d.tags) : null, d.ownerRecruiterId || null,
       normEmail(d.email), normPhone(d.phone), normLinkedin(d.linkedinUrl), d.createdBy, nowISO(), nowISO()],
    );
    return this.byId(Number(r.lastInsertRowid));
  },
  update(id, d) {
    const c = this.byId(id);
    run(
      `UPDATE candidate SET full_name=?,email=?,phone=?,nationality=?,location=?,linkedin_url=?,
        current_company=?,current_position=?,years_experience=?,expected_salary=?,notice_period=?,source=?,
        employer=?,current_project=?,graduation_year=?,university=?,major=?,
        tags=?,owner_recruiter_id=?,dedup_email=?,dedup_phone=?,dedup_linkedin=?,updated_at=? WHERE id=?`,
      [d.fullName ?? c.full_name, d.email ?? c.email, d.phone ?? c.phone, d.nationality ?? c.nationality,
       d.location ?? c.location, d.linkedinUrl ?? c.linkedin_url, d.currentCompany ?? c.current_company,
       d.currentPosition ?? c.current_position, d.yearsExperience ?? c.years_experience,
       d.expectedSalary !== undefined ? d.expectedSalary : c.expected_salary, d.noticePeriod ?? c.notice_period,
       d.source ?? c.source,
       d.employer ?? c.employer, d.currentProject ?? c.current_project,
       d.graduationYear !== undefined ? d.graduationYear : c.graduation_year, d.university ?? c.university, d.major ?? c.major,
       d.tags !== undefined ? (d.tags ? JSON.stringify(d.tags) : null) : c.tags,
       d.ownerRecruiterId !== undefined ? d.ownerRecruiterId : c.owner_recruiter_id,
       normEmail(d.email ?? c.email), normPhone(d.phone ?? c.phone), normLinkedin(d.linkedinUrl ?? c.linkedin_url),
       nowISO(), id],
    );
    return this.byId(id);
  },
  findDuplicates({ email, phone, linkedinUrl, excludeId = null }) {
    const de = normEmail(email), dp = normPhone(phone), dl = normLinkedin(linkedinUrl);
    if (!de && !dp && !dl) return [];
    const conds = [], p = [];
    if (de) { conds.push('dedup_email=?'); p.push(de); }
    if (dp) { conds.push('dedup_phone=?'); p.push(dp); }
    if (dl) { conds.push('dedup_linkedin=?'); p.push(dl); }
    let sql = `SELECT * FROM candidate WHERE (${conds.join(' OR ')}) AND candidate_state != 'merged'`;
    if (excludeId) { sql += ' AND id != ?'; p.push(excludeId); }
    return all(sql, p);
  },
  list(f = {}) {
    let sql = 'SELECT * FROM candidate WHERE candidate_state != \'merged\'';
    const p = [];
    if (f.q) { sql += ' AND (full_name LIKE ? OR candidate_no LIKE ? OR current_company LIKE ? OR email LIKE ?)'; const l = `%${f.q}%`; p.push(l, l, l, l); }
    if (f.source) { sql += ' AND source=?'; p.push(f.source); }
    if (f.location) { sql += ' AND location LIKE ?'; p.push(`%${f.location}%`); }
    if (f.currentCompany) { sql += ' AND current_company LIKE ?'; p.push(`%${f.currentCompany}%`); }
    if (f.noticePeriod) { sql += ' AND notice_period=?'; p.push(f.noticePeriod); }
    if (f.ownerRecruiterId) { sql += ' AND owner_recruiter_id=?'; p.push(Number(f.ownerRecruiterId)); }
    if (f.minExp) { sql += ' AND years_experience >= ?'; p.push(Number(f.minExp)); }
    if (f.maxExp) { sql += ' AND years_experience <= ?'; p.push(Number(f.maxExp)); }
    if (f.tag) { sql += ' AND tags LIKE ?'; p.push(`%"${f.tag}"%`); }
    sql += ' ORDER BY created_at DESC, id DESC';
    return all(sql, p);
  },
};

export const CandidateDocuments = {
  forCandidate(cid) { return all('SELECT * FROM candidate_document WHERE candidate_id=? ORDER BY uploaded_at DESC', [cid]); },
  add(d) {
    const r = run('INSERT INTO candidate_document (candidate_id,doc_type,file_name,file_hash,file_size,note,uploaded_by) VALUES (?,?,?,?,?,?,?)',
      [d.candidateId, d.docType || 'cv', d.fileName, d.fileHash || null, d.fileSize || null, d.note || null, d.uploadedBy]);
    return get('SELECT * FROM candidate_document WHERE id=?', [Number(r.lastInsertRowid)]);
  },
  byHash(hash) { return hash ? all('SELECT * FROM candidate_document WHERE file_hash=?', [hash]) : []; },
};

export const Applications = {
  nextNo() {
    const prefix = get("SELECT value FROM system_setting WHERE key='application_prefix'")?.value || 'APP';
    const cur = parseInt(get("SELECT value FROM system_setting WHERE key='application_counter'")?.value || '0', 10) + 1;
    run("UPDATE system_setting SET value=? WHERE key='application_counter'", [String(cur)]);
    return `${prefix}-${String(cur).padStart(5, '0')}`;
  },
  byId(id) { return get('SELECT * FROM application WHERE id=?', [id]); },
  existing(candidateId, requestId) { return get('SELECT * FROM application WHERE candidate_id=? AND request_id=?', [candidateId, requestId]); },
  create(d) {
    const r = run(
      `INSERT INTO application (application_no,candidate_id,request_id,position_applied,status,match_score,
        recruiter_id,source,stage_date,last_activity_at,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [d.applicationNo, d.candidateId, d.requestId, d.positionApplied || null, d.status || 'applied',
       d.matchScore ?? null, d.recruiterId || null, d.source || null, nowISO(), nowISO(), d.createdBy, nowISO(), nowISO()],
    );
    return this.byId(Number(r.lastInsertRowid));
  },
  forRequest(requestId) { return all('SELECT * FROM application WHERE request_id=? ORDER BY created_at', [requestId]); },
  forCandidate(candidateId) { return all('SELECT * FROM application WHERE candidate_id=? ORDER BY created_at DESC', [candidateId]); },
  setStatus(id, status, reasonField = null, reason = null) {
    const sets = ['status=?', 'stage_date=?', 'last_activity_at=?', 'updated_at=?'];
    const p = [status, nowISO(), nowISO(), nowISO()];
    if (reasonField) { sets.push(`${reasonField}=?`); p.push(reason); }
    p.push(id);
    run(`UPDATE application SET ${sets.join(',')} WHERE id=?`, p);
    return this.byId(id);
  },
  setRecruiter(id, recruiterId) { run('UPDATE application SET recruiter_id=?, last_activity_at=?, updated_at=? WHERE id=?', [recruiterId, nowISO(), nowISO(), id]); },
  setNextAction(id, nextAction, nextActionDate) { run('UPDATE application SET next_action=?, next_action_date=?, last_activity_at=?, updated_at=? WHERE id=?', [nextAction, nextActionDate, nowISO(), nowISO(), id]); },
  touch(id) { run('UPDATE application SET last_activity_at=?, updated_at=? WHERE id=?', [nowISO(), nowISO(), id]); },
};

export const StageHistory = {
  add(appId, fromStatus, toStatus, actor, reason = null) {
    run('INSERT INTO application_stage_history (application_id,from_status,to_status,reason,actor_id,actor_name,moved_at) VALUES (?,?,?,?,?,?,?)',
      [appId, fromStatus, toStatus, reason, actor?.id || null, actor?.fullName || null, nowISO()]);
  },
  forApplication(appId) { return all('SELECT * FROM application_stage_history WHERE application_id=? ORDER BY moved_at DESC, id DESC', [appId]); },
};

export const CandidateNotes = {
  add(d) {
    run('INSERT INTO candidate_note (candidate_id,application_id,note_type,body,author_id,author_name) VALUES (?,?,?,?,?,?)',
      [d.candidateId, d.applicationId || null, d.noteType || 'note', d.body, d.authorId, d.authorName]);
  },
  forCandidate(cid) { return all('SELECT * FROM candidate_note WHERE candidate_id=? ORDER BY created_at DESC', [cid]); },
};

export const CandidateActivity = {
  add(d) {
    run('INSERT INTO candidate_activity (candidate_id,application_id,actor_id,actor_name,type,note,occurred_at) VALUES (?,?,?,?,?,?,?)',
      [d.candidateId || null, d.applicationId || null, d.actorId || null, d.actorName || null, d.type, d.note || null, nowISO()]);
  },
  forCandidate(cid) { return all('SELECT * FROM candidate_activity WHERE candidate_id=? ORDER BY occurred_at DESC, id DESC', [cid]); },
};

export const RejectReasons = { all() { return all("SELECT * FROM reject_reason WHERE is_active=1 ORDER BY id"); } };

// ---------------- Interview assessment (Arabtec form) ----------------
export const Assessments = {
  forApplication(appId) { return all('SELECT * FROM application_assessment WHERE application_id=? ORDER BY evaluator_type', [appId]); },
  byType(appId, type) { return get('SELECT * FROM application_assessment WHERE application_id=? AND evaluator_type=?', [appId, type]); },
  upsert(d) {
    const existing = this.byType(d.applicationId, d.evaluatorType);
    const cols = {
      behavioral: d.behavioral ? JSON.stringify(d.behavioral) : null,
      technical: d.technical ? JSON.stringify(d.technical) : null,
      critical_flags: d.criticalFlags ? JSON.stringify(d.criticalFlags) : null,
      recommendation: d.recommendation || null,
      behavioral_fit: d.behavioralFit || null, technical_fit: d.technicalFit || null,
      behavioral_justification: d.behavioralJustification || null,
      technical_justification: d.technicalJustification || null,
      submitted: d.submitted ? 1 : 0,
    };
    if (existing) {
      run(`UPDATE application_assessment SET behavioral=?,technical=?,critical_flags=?,recommendation=?,behavioral_fit=?,technical_fit=?,behavioral_justification=?,technical_justification=?,submitted=?,updated_at=? WHERE id=?`,
        [cols.behavioral, cols.technical, cols.critical_flags, cols.recommendation, cols.behavioral_fit, cols.technical_fit, cols.behavioral_justification, cols.technical_justification, cols.submitted, nowISO(), existing.id]);
      return get('SELECT * FROM application_assessment WHERE id=?', [existing.id]);
    }
    const r = run(`INSERT INTO application_assessment (application_id,evaluator_type,evaluator_id,evaluator_name,behavioral,technical,critical_flags,recommendation,behavioral_fit,technical_fit,behavioral_justification,technical_justification,submitted) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [d.applicationId, d.evaluatorType, d.evaluatorId, d.evaluatorName, cols.behavioral, cols.technical, cols.critical_flags, cols.recommendation, cols.behavioral_fit, cols.technical_fit, cols.behavioral_justification, cols.technical_justification, cols.submitted]);
    return get('SELECT * FROM application_assessment WHERE id=?', [Number(r.lastInsertRowid)]);
  },
  finalDecision(appId) { return get('SELECT * FROM application_final_decision WHERE application_id=?', [appId]); },
  setFinalDecision(d) {
    run(`INSERT INTO application_final_decision (application_id,decision,decided_by,decided_by_name,notes,decided_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(application_id) DO UPDATE SET decision=excluded.decision,decided_by=excluded.decided_by,decided_by_name=excluded.decided_by_name,notes=excluded.notes,decided_at=excluded.decided_at`,
      [d.applicationId, d.decision, d.decidedBy, d.decidedByName, d.notes || null, nowISO()]);
    return this.finalDecision(d.applicationId);
  },
};

// ---------------- Ticket thread (email-style conversation on a request) ----------------
export const Posts = {
  byId(id) { return get('SELECT * FROM ticket_post WHERE id=?', [id]); },
  forRequest(requestId) {
    return all('SELECT * FROM ticket_post WHERE request_id=? ORDER BY created_at ASC, id ASC', [requestId]);
  },
  create(d) {
    const r = run(
      `INSERT INTO ticket_post (request_id,parent_post_id,post_type,author_id,author_name,author_role,body,file_path,file_name,candidate_id,application_id,payload)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [d.requestId, d.parentPostId || null, d.postType || 'message', d.authorId || null, d.authorName || null, d.authorRole || null,
        d.body || null, d.filePath || null, d.fileName || null, d.candidateId || null, d.applicationId || null,
        d.payload ? JSON.stringify(d.payload) : null]);
    return this.byId(Number(r.lastInsertRowid));
  },
  // System post (stage/status change) — author is the actor, type 'system'.
  system(requestId, body, payload, actor) {
    return this.create({ requestId, postType: 'system', body, payload, authorId: actor?.id || null, authorName: actor?.fullName || 'System', authorRole: actor?.role || null });
  },
  update(id, fields) {
    const sets = [], vals = [];
    for (const [k, v] of Object.entries(fields)) { sets.push(`${k}=?`); vals.push(v); }
    if (!sets.length) return this.byId(id);
    sets.push('edited=1', 'updated_at=?'); vals.push(nowISO(), id);
    run(`UPDATE ticket_post SET ${sets.join(',')} WHERE id=?`, vals);
    return this.byId(id);
  },
  remove(id) { run('DELETE FROM ticket_post WHERE id=?', [id]); },
};

// ---------------- Phase 4: Interviews & Feedback ----------------
export const Interviews = {
  nextNo() {
    const prefix = get("SELECT value FROM system_setting WHERE key='interview_prefix'")?.value || 'INT';
    const cur = parseInt(get("SELECT value FROM system_setting WHERE key='interview_counter'")?.value || '0', 10) + 1;
    run("UPDATE system_setting SET value=? WHERE key='interview_counter'", [String(cur)]);
    return `${prefix}-${String(cur).padStart(5, '0')}`;
  },
  byId(id) { return get('SELECT * FROM interview WHERE id=?', [id]); },
  create(d) {
    const r = run(
      `INSERT INTO interview (interview_no,application_id,candidate_id,request_id,round,interview_type,mode,
        scheduled_at,duration_min,location_or_link,organizer_id,status,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [d.interviewNo, d.applicationId, d.candidateId, d.requestId, d.round || 1, d.interviewType || 'technical',
       d.mode || 'onsite', d.scheduledAt || null, d.durationMin || 60, d.locationOrLink || null,
       d.organizerId, d.status || 'scheduled', d.createdBy, nowISO(), nowISO()],
    );
    return this.byId(Number(r.lastInsertRowid));
  },
  update(id, fields) {
    const c = this.byId(id);
    run(`UPDATE interview SET round=?,interview_type=?,mode=?,scheduled_at=?,duration_min=?,location_or_link=?,updated_at=? WHERE id=?`,
      [fields.round ?? c.round, fields.interviewType ?? c.interview_type, fields.mode ?? c.mode,
       fields.scheduledAt ?? c.scheduled_at, fields.durationMin ?? c.duration_min,
       fields.locationOrLink ?? c.location_or_link, nowISO(), id]);
    return this.byId(id);
  },
  setStatus(id, status, extra = {}) {
    const sets = ['status=?', 'updated_at=?']; const p = [status, nowISO()];
    for (const [k, v] of Object.entries(extra)) { sets.push(`${k}=?`); p.push(v); }
    p.push(id);
    run(`UPDATE interview SET ${sets.join(',')} WHERE id=?`, p);
    return this.byId(id);
  },
  setOutcome(id, outcome) { run('UPDATE interview SET overall_outcome=?, updated_at=? WHERE id=?', [outcome, nowISO(), id]); },
  forApplication(appId) { return all('SELECT * FROM interview WHERE application_id=? ORDER BY round, scheduled_at', [appId]); },
  forCandidate(candId) { return all('SELECT * FROM interview WHERE candidate_id=? ORDER BY scheduled_at DESC', [candId]); },
  forRequest(reqId) { return all('SELECT * FROM interview WHERE request_id=? ORDER BY scheduled_at DESC', [reqId]); },
  // List, with optional restriction to interviews where the user is a panelist (scoped roles).
  list({ assignedTo = null, status = null, q = null } = {}) {
    let sql = 'SELECT DISTINCT i.* FROM interview i';
    const p = [];
    if (assignedTo) { sql += ' JOIN interview_panel ip ON ip.interview_id = i.id AND ip.interviewer_id = ?'; p.push(assignedTo); }
    sql += ' WHERE 1=1';
    if (status) { sql += ' AND i.status=?'; p.push(status); }
    if (q) { sql += ' AND (i.interview_no LIKE ? OR i.interview_type LIKE ?)'; const l = `%${q}%`; p.push(l, l); }
    sql += ' ORDER BY i.scheduled_at DESC, i.id DESC';
    return all(sql, p);
  },
  isPanelist(interviewId, userId) {
    return !!get('SELECT 1 FROM interview_panel WHERE interview_id=? AND interviewer_id=?', [interviewId, userId]);
  },
};

export const InterviewPanel = {
  forInterview(ivId) {
    return all(`SELECT ip.interviewer_id, ip.is_lead, u.full_name FROM interview_panel ip JOIN users u ON u.id=ip.interviewer_id WHERE ip.interview_id=?`, [ivId]);
  },
  set(ivId, panel) {
    run('DELETE FROM interview_panel WHERE interview_id=?', [ivId]);
    for (const m of panel) run('INSERT OR IGNORE INTO interview_panel (interview_id, interviewer_id, is_lead) VALUES (?,?,?)', [ivId, m.interviewerId, m.isLead ? 1 : 0]);
  },
  interviewerIds(ivId) { return all('SELECT interviewer_id FROM interview_panel WHERE interview_id=?', [ivId]).map((r) => r.interviewer_id); },
};

export const InterviewFeedback = {
  forInterview(ivId) { return all('SELECT * FROM interview_feedback WHERE interview_id=? ORDER BY submitted_at', [ivId]); },
  byInterviewer(ivId, interviewerId) { return get('SELECT * FROM interview_feedback WHERE interview_id=? AND interviewer_id=?', [ivId, interviewerId]); },
  upsert(d) {
    const existing = this.byInterviewer(d.interviewId, d.interviewerId);
    if (existing) {
      run('UPDATE interview_feedback SET criteria=?, overall_score=?, recommendation=?, comments=?, submitted_at=? WHERE id=?',
        [d.criteria ? JSON.stringify(d.criteria) : null, d.overallScore ?? null, d.recommendation || null, d.comments || null, nowISO(), existing.id]);
      return get('SELECT * FROM interview_feedback WHERE id=?', [existing.id]);
    }
    const r = run('INSERT INTO interview_feedback (interview_id,interviewer_id,criteria,overall_score,recommendation,comments,submitted_at) VALUES (?,?,?,?,?,?,?)',
      [d.interviewId, d.interviewerId, d.criteria ? JSON.stringify(d.criteria) : null, d.overallScore ?? null, d.recommendation || null, d.comments || null, nowISO()]);
    return get('SELECT * FROM interview_feedback WHERE id=?', [Number(r.lastInsertRowid)]);
  },
};

export const InterviewActivity = {
  add(ivId, actor, type, note = null) {
    run('INSERT INTO interview_activity (interview_id,actor_id,actor_name,type,note,occurred_at) VALUES (?,?,?,?,?,?)',
      [ivId, actor?.id || null, actor?.fullName || null, type, note, nowISO()]);
  },
  forInterview(ivId) { return all('SELECT * FROM interview_activity WHERE interview_id=? ORDER BY occurred_at DESC, id DESC', [ivId]); },
};

// ---------------- Phase 5: Offers & Joining ----------------
export const Offers = {
  nextNo() {
    const prefix = get("SELECT value FROM system_setting WHERE key='offer_prefix'")?.value || 'OFR';
    const cur = parseInt(get("SELECT value FROM system_setting WHERE key='offer_counter'")?.value || '0', 10) + 1;
    run("UPDATE system_setting SET value=? WHERE key='offer_counter'", [String(cur)]);
    const year = new Date().getFullYear();
    return `${prefix}-${year}-${String(cur).padStart(5, '0')}`;
  },
  byId(id) { return get('SELECT * FROM offer WHERE id=?', [id]); },
  activeForApplication(appId) { return get("SELECT * FROM offer WHERE application_id=? AND status NOT IN ('rejected_by_candidate','withdrawn','rejected_by_approver') ORDER BY id DESC LIMIT 1", [appId]); },
  create(d) {
    const r = run(
      `INSERT INTO offer (offer_no,application_id,candidate_id,request_id,position_title,salary_offered,currency,
        benefits,joining_date,notes,status,prepared_by,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [d.offerNo, d.applicationId, d.candidateId, d.requestId, d.positionTitle || null, d.salaryOffered ?? null,
       d.currency || 'EGP', d.benefits || null, d.joiningDate || null, d.notes || null,
       d.status || 'draft', d.preparedBy, d.createdBy, nowISO(), nowISO()],
    );
    return this.byId(Number(r.lastInsertRowid));
  },
  update(id, fields, { salaryAllowed = false } = {}) {
    const c = this.byId(id);
    const salary = salaryAllowed && fields.salaryOffered !== undefined ? fields.salaryOffered : c.salary_offered;
    run(`UPDATE offer SET position_title=?,salary_offered=?,currency=?,benefits=?,joining_date=?,notes=?,version=version+1,updated_at=? WHERE id=?`,
      [fields.positionTitle ?? c.position_title, salary, fields.currency ?? c.currency,
       fields.benefits ?? c.benefits, fields.joiningDate ?? c.joining_date, fields.notes ?? c.notes, nowISO(), id]);
    return this.byId(id);
  },
  setStatus(id, status, extra = {}) {
    const sets = ['status=?', 'updated_at=?']; const p = [status, nowISO()];
    for (const [k, v] of Object.entries(extra)) { sets.push(`${k}=?`); p.push(v); }
    p.push(id);
    run(`UPDATE offer SET ${sets.join(',')} WHERE id=?`, p);
    return this.byId(id);
  },
  setApprovedBy(id, userId) { run('UPDATE offer SET approved_by=?, updated_at=? WHERE id=?', [userId, nowISO(), id]); },
  forApplication(appId) { return all('SELECT * FROM offer WHERE application_id=? ORDER BY created_at DESC', [appId]); },
  forCandidate(candId) { return all('SELECT * FROM offer WHERE candidate_id=? ORDER BY created_at DESC', [candId]); },
  forRequest(reqId) { return all('SELECT * FROM offer WHERE request_id=? ORDER BY created_at DESC', [reqId]); },
  list(f = {}) {
    let sql = 'SELECT * FROM offer WHERE 1=1'; const p = [];
    if (f.status) { sql += ' AND status=?'; p.push(f.status); }
    if (f.requestId) { sql += ' AND request_id=?'; p.push(Number(f.requestId)); }
    if (f.preparedBy) { sql += ' AND prepared_by=?'; p.push(Number(f.preparedBy)); }
    if (f.q) { sql += ' AND (offer_no LIKE ? OR position_title LIKE ?)'; const l = `%${f.q}%`; p.push(l, l); }
    if (f.joiningFrom) { sql += ' AND joining_date >= ?'; p.push(f.joiningFrom); }
    if (f.joiningTo) { sql += ' AND joining_date <= ?'; p.push(f.joiningTo); }
    sql += ' ORDER BY created_at DESC, id DESC';
    return all(sql, p);
  },
};

export const OfferApprovals = {
  forOffer(offerId) { return all('SELECT * FROM offer_approval WHERE offer_id=? ORDER BY level', [offerId]); },
  createChain(offerId, levels) {
    for (const lv of levels) run('INSERT INTO offer_approval (offer_id,level,name,role_code) VALUES (?,?,?,?)', [offerId, lv.level, lv.name, lv.roleCode || null]);
  },
  reset(offerId) { run("UPDATE offer_approval SET decision='pending', approver_id=NULL, comment=NULL, decided_at=NULL WHERE offer_id=?", [offerId]); },
  clear(offerId) { run('DELETE FROM offer_approval WHERE offer_id=?', [offerId]); },
  currentPending(offerId) { return get("SELECT * FROM offer_approval WHERE offer_id=? AND decision='pending' ORDER BY level LIMIT 1", [offerId]); },
  decide(id, { decision, approverId, comment }) { run('UPDATE offer_approval SET decision=?, approver_id=?, comment=?, decided_at=? WHERE id=?', [decision, approverId, comment || null, nowISO(), id]); },
  allApproved(offerId) {
    const pendingOrRejected = get("SELECT COUNT(*) c FROM offer_approval WHERE offer_id=? AND decision IN ('pending','rejected')", [offerId]).c;
    const total = get('SELECT COUNT(*) c FROM offer_approval WHERE offer_id=?', [offerId]).c;
    return total > 0 && pendingOrRejected === 0;
  },
};

export const OfferActivity = {
  add(offerId, actor, type, { fromStatus = null, toStatus = null, note = null } = {}) {
    run('INSERT INTO offer_activity (offer_id,actor_id,actor_name,type,from_status,to_status,note,occurred_at) VALUES (?,?,?,?,?,?,?,?)',
      [offerId, actor?.id || null, actor?.fullName || null, type, fromStatus, toStatus, note, nowISO()]);
  },
  forOffer(offerId) { return all('SELECT * FROM offer_activity WHERE offer_id=? ORDER BY occurred_at DESC, id DESC', [offerId]); },
};

export { ub, b };
