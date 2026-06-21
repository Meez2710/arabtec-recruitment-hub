// Phase 1 API smoke test. Run against a running server.
const BASE = process.env.BASE || 'http://localhost:4055';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name} ${extra}`); fail++; }
};
async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

(async () => {
  console.log('\n— Auth —');
  const badLogin = await api('/api/auth/login', { method: 'POST', body: { email: 'admin@arabtec.com', password: 'wrong' } });
  check('wrong password rejected (401)', badLogin.status === 401, `got ${badLogin.status}`);

  const login = await api('/api/auth/login', { method: 'POST', body: { email: 'admin@arabtec.com', password: 'Admin@12345' } });
  check('admin login (200)', login.status === 200, `got ${login.status}`);
  const adminToken = login.json?.token;
  check('admin has system_admin role', login.json?.user?.roles?.includes('system_admin'));
  check('admin has all permissions (47)', login.json?.user?.permissions?.length === 47, `got ${login.json?.user?.permissions?.length}`);

  const me = await api('/api/auth/me', { token: adminToken });
  check('/me returns user', me.json?.user?.email === 'admin@arabtec.com');

  const noAuth = await api('/api/users');
  check('no token blocked (401)', noAuth.status === 401, `got ${noAuth.status}`);

  console.log('\n— RBAC enforcement —');
  const rec = await api('/api/auth/login', { method: 'POST', body: { email: 'recruiter@arabtec.com', password: 'Arabtec@123' } });
  const recToken = rec.json?.token;
  check('recruiter login (200)', rec.status === 200);
  const recUsers = await api('/api/users', { token: recToken });
  check('recruiter blocked from user mgmt (403)', recUsers.status === 403, `got ${recUsers.status}`);
  const recProj = await api('/api/org/projects', { method: 'POST', token: recToken, body: { code: 'PRJ-X', name: 'X' } });
  check('recruiter blocked from create project (403)', recProj.status === 403, `got ${recProj.status}`);
  const recAudit = await api('/api/audit', { token: recToken });
  check('recruiter blocked from audit (403)', recAudit.status === 403, `got ${recAudit.status}`);

  console.log('\n— Admin CRUD —');
  const users = await api('/api/users', { token: adminToken });
  check('admin lists users (9)', users.json?.users?.length === 9, `got ${users.json?.users?.length}`);

  const newUser = await api('/api/users', { method: 'POST', token: adminToken, body: {
    fullName: 'Test Engineer', email: `test_${Date.now()}@arabtec.com`, jobTitle: 'Site Engineer',
    roleCodes: ['recruiter'], password: 'Arabtec@123',
  }});
  check('admin creates user (201)', newUser.status === 201, `got ${newUser.status}`);
  const newId = newUser.json?.user?.id;

  const badEmail = await api('/api/users', { method: 'POST', token: adminToken, body: { fullName: 'Bad', email: 'not-an-email' } });
  check('invalid email rejected (400)', badEmail.status === 400, `got ${badEmail.status}`);

  const deact = await api(`/api/users/${newId}/deactivate`, { method: 'POST', token: adminToken });
  check('deactivate user (200)', deact.status === 200);

  const proj = await api('/api/org/projects', { method: 'POST', token: adminToken, body: { code: `PRJ-${Date.now()}`, name: 'Smoke Project', clientName: 'ACME' } });
  check('admin creates project (201)', proj.status === 201, `got ${proj.status}`);

  const dupProj = await api('/api/org/projects', { method: 'POST', token: adminToken, body: { code: 'PRJ-HILLS', name: 'Dup' } });
  check('duplicate project code rejected (409)', dupProj.status === 409, `got ${dupProj.status}`);

  console.log('\n— Branding / Buttons / Workflow —');
  const branding = await api('/api/settings/branding', { token: adminToken });
  check('branding loads (minimal corporate: red accent)', branding.json?.branding?.accent_color === '#d2232a' && branding.json?.branding?.button_color === '#d2232a');
  const setBrand = await api('/api/settings/branding', { method: 'PUT', token: adminToken, body: { branding: { accent_color: '#00B0F0' } } });
  check('admin updates branding (200)', setBrand.status === 200 && setBrand.json?.branding?.accent_color === '#00B0F0');
  const recBrand = await api('/api/settings/branding', { method: 'PUT', token: recToken, body: { branding: { accent_color: '#000' } } });
  check('recruiter blocked from branding (403)', recBrand.status === 403, `got ${recBrand.status}`);

  const resolved = await api('/api/settings/buttons/resolved', { token: recToken });
  const createReq = resolved.json?.buttons?.find((b) => b.buttonKey === 'create_request');
  const viewSalary = resolved.json?.buttons?.find((b) => b.buttonKey === 'view_salary');
  check('recruiter CAN see Create Request button', createReq?.visible === true);
  check('recruiter CANNOT see View Salary button', viewSalary?.visible === false);

  console.log('\n— Audit trail —');
  const audit = await api('/api/audit?pageSize=200', { token: adminToken });
  const actions = (audit.json?.logs || []).map((l) => l.action);
  check('audit captured login', actions.includes('auth.login'));
  check('audit captured failed login', actions.includes('auth.login_failed'));
  check('audit captured user.created', actions.includes('user.created'));
  check('audit captured user.deactivated', actions.includes('user.deactivated'));
  check('audit captured project.created', actions.includes('project.created'));
  check('audit captured branding.changed', actions.includes('branding.changed'));

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail ? 1 : 0);
})();
