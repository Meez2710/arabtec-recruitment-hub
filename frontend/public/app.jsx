/* Arabtec Recruitment Hub — Phase 1 SPA (React via Babel standalone).
   Single-file app: API client, auth, shell, dashboard, and admin modules.
   Permissions/buttons are resolved from the server; UI also hides what the
   user can't use, but the server is the source of truth (RBAC in logic). */
const { useState, useEffect, useCallback, useMemo, createContext, useContext } = React;

/* ----------------------------- API client ----------------------------- */
const TOKEN_KEY = 'arabtec_token';
const api = {
  token: localStorage.getItem(TOKEN_KEY) || null,
  setToken(t) { this.token = t; t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); },
  async call(path, { method = 'GET', body } = {}) {
    const res = await fetch('/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null; try { data = await res.json(); } catch {}
    if (!res.ok) throw Object.assign(new Error(data?.error || 'Request failed'), { status: res.status, data });
    return data;
  },
  get(p) { return this.call(p); },
  post(p, body) { return this.call(p, { method: 'POST', body }); },
  put(p, body) { return this.call(p, { method: 'PUT', body }); },
  async upload(p, file, fields = {}) {
    const fd = new FormData(); fd.append('file', file);
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    const res = await fetch('/api' + p, { method: 'POST', headers: this.token ? { Authorization: 'Bearer ' + this.token } : {}, body: fd });
    let data = null; try { data = await res.json(); } catch {}
    if (!res.ok) throw Object.assign(new Error(data?.error || 'Upload failed'), { status: res.status, data });
    return data;
  },
  // Multipart upload to an arbitrary endpoint with extra text fields (thread file/CV posts).
  async uploadTo(p, file, fields = {}) {
    const fd = new FormData(); fd.append('file', file);
    for (const [k, v] of Object.entries(fields)) if (v != null && v !== '') fd.append(k, v);
    const res = await fetch('/api' + p, { method: 'POST', headers: this.token ? { Authorization: 'Bearer ' + this.token } : {}, body: fd });
    let data = null; try { data = await res.json(); } catch {}
    if (!res.ok) throw Object.assign(new Error(data?.error || 'Upload failed'), { status: res.status, data });
    return data;
  },
  // Authenticated file download → opens the blob in a new tab (view) or triggers save.
  async download(p, filename) {
    const res = await fetch('/api' + p, { headers: this.token ? { Authorization: 'Bearer ' + this.token } : {} });
    if (!res.ok) { let d = null; try { d = await res.json(); } catch {} throw new Error(d?.error || 'Download failed'); }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    if (filename) { const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); }
    else { window.open(url, '_blank'); }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  },
};

/* ----------------------------- Helpers ----------------------------- */
function initials(name) { return (name || '?').split(' ').map((s) => s[0]).slice(0, 2).join('').toUpperCase(); }
// Minimal line-icon set (stroke-based, inherits color). Keeps the UI emoji-free.
const ICON_PATHS = {
  dashboard: 'M3 3h7v7H3zM14 3h7v4h-7zM14 11h7v10h-7zM3 14h7v7H3z',
  ticket: 'M4 5h16a1 1 0 011 1v3a2 2 0 000 4v3a1 1 0 01-1 1H4a1 1 0 01-1-1v-3a2 2 0 000-4V6a1 1 0 011-1zM12 6v12',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0',
  users: 'M9 11a4 4 0 100-8 4 4 0 000 8zM2 21a7 7 0 0114 0M17 11a4 4 0 000-8M22 21a7 7 0 00-5-6.7',
  calendar: 'M4 5h16a1 1 0 011 1v14a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1zM3 9h18M8 3v4M16 3v4',
  doc: 'M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9zM14 3v6h6',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  building: 'M4 21V5a1 1 0 011-1h7a1 1 0 011 1v16M13 21V9a1 1 0 011-1h5a1 1 0 011 1v12M7 8h2M7 12h2M16 12h1M16 16h1M3 21h18',
  pin: 'M12 21s7-5.5 7-11a7 7 0 00-14 0c0 5.5 7 11 7 11zM12 12a2.5 2.5 0 100-5 2.5 2.5 0 000 5z',
  hardhat: 'M3 18h18v2H3zM5 18v-3a7 7 0 0114 0v3M10 5a2 2 0 014 0v3h-4z',
  palette: 'M12 3a9 9 0 100 18c1.5 0 2-1 2-2s-.5-1.5-.5-2 .5-1 1.5-1H18a3 3 0 003-3c0-4-4-7-9-7zM7.5 12a1 1 0 100-2 1 1 0 000 2zM10.5 8a1 1 0 100-2 1 1 0 000 2zM15 8a1 1 0 100-2 1 1 0 000 2z',
  button: 'M3 9a3 3 0 013-3h12a3 3 0 013 3v6a3 3 0 01-3 3H6a3 3 0 01-3-3zM9 12h6',
  flow: 'M5 4h4v4H5zM15 16h4v4h-4zM7 8v4a2 2 0 002 2h6M17 16v-2',
  gear: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 13a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-2.7 1.1V19a2 2 0 11-4 0v-.1A1.6 1.6 0 007 17.4a1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00-1.1-2.7H1a2 2 0 110-4h.1A1.6 1.6 0 002.6 7a1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H7a1.6 1.6 0 001-1.5V1a2 2 0 114 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V7a1.6 1.6 0 001.5 1H23a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z',
  scroll: 'M5 4h11a2 2 0 012 2v12a2 2 0 002 2H8a2 2 0 01-2-2V6a2 2 0 00-2-2zM9 8h6M9 12h6',
};
function Icon({ name, size = 17 }) {
  const d = ICON_PATHS[name];
  if (!d) return <span style={{ width: size, display: 'inline-block' }} />;
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }} aria-hidden="true"><path d={d} /></svg>;
}

// Brand mark — the Arabtec red twin-peak "A". Inline SVG so it inherits color/scale anywhere.
// withText=true renders the official lockup: the red mark with the lowercase
// "arabtec" wordmark centered below it (matching the company logo).
function Logo({ size = 28, color = 'var(--brand)', withText = false, textColor }) {
  const mark = (
    <svg width={size} height={size * (320 / 463)} viewBox="0 0 463 320" aria-label="Arabtec" role="img" style={{ display: 'block' }}>
      <path fill={color} d="M150 0 L223 0 L223 118 L73 263 L73 320 L0 320 L0 205 Z" />
      <path fill={color} d="M313 0 L240 0 L240 118 L390 263 L390 320 L463 320 L463 205 Z" />
    </svg>
  );
  if (!withText) return mark;
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: Math.round(size * 0.12), lineHeight: 1 }}>
      {mark}
      <span style={{
        fontFamily: 'Arial, Helvetica, sans-serif', fontWeight: 400,
        fontSize: Math.round(size * 0.62), letterSpacing: '0.01em',
        color: textColor || '#6b7280',
      }}>arabtec</span>
    </span>
  );
}
function fmtDate(d) { if (!d) return '—'; const x = new Date(d); return isNaN(x) ? '—' : x.toLocaleString(); }
function fmtDateShort(d) { if (!d) return '—'; const x = new Date(d); return isNaN(x) ? '—' : x.toLocaleDateString(); }
// Relative time ("just now", "5m", "3h", "2d") — falls back to a short date past a week.
function timeAgo(d) {
  if (!d) return '—';
  const x = new Date(d); if (isNaN(x)) return '—';
  const s = Math.floor((Date.now() - x.getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 604800) return Math.floor(s / 86400) + 'd ago';
  return x.toLocaleDateString();
}
const ROLE_NAMES = {
  system_admin: 'System Admin', hr_director: 'HR Director', hr_manager: 'HR Manager',
  recruitment_manager: 'Recruitment Manager', recruiter: 'Recruiter', hiring_manager: 'Hiring Manager',
  project_manager: 'Project Manager', interviewer: 'Interviewer', viewer: 'Viewer',
};

function applyBranding(b) {
  if (!b) return;
  const r = document.documentElement.style;
  const map = {
    primary_color: '--primary', secondary_color: '--secondary', accent_color: '--accent',
    background_color: '--bg', surface_color: '--surface', text_dark: '--text-dark',
    text_gray: '--text-gray', border_color: '--border', button_color: '--button',
    success_color: '--success', warning_color: '--warning', critical_color: '--critical',
    font_family: '--font', border_radius: '--radius', card_radius: '--card-radius',
  };
  for (const [k, cssVar] of Object.entries(map)) if (b[k]) r.setProperty(cssVar, b[k]);
  document.title = (b.company_name || 'Arabtec Recruitment Hub');
}

/* ----------------------------- Auth context ----------------------------- */
const AppCtx = createContext(null);
const useApp = () => useContext(AppCtx);

function can(user, perm) { return user?.permissions?.includes(perm); }

/* ----------------------------- Toast ----------------------------- */
const ToastCtx = createContext(() => {});
function ToastProvider({ children }) {
  const [toast, setToast] = useState(null);
  const show = useCallback((msg, type = 'success') => {
    setToast({ msg, type }); setTimeout(() => setToast(null), 3200);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {toast && (
        <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 200,
          background: toast.type === 'error' ? 'var(--critical)' : 'var(--success)',
          color: '#fff', padding: '12px 18px', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,.2)', fontSize: 13.5, fontWeight: 600 }}>
          {toast.msg}
        </div>
      )}
    </ToastCtx.Provider>
  );
}
const useToast = () => useContext(ToastCtx);

/* ----------------------------- Reusable UI ----------------------------- */
function Badge({ children, variant = 'soft' }) {
  const cls = { success: 'badge-success', warning: 'badge-warning', critical: 'badge-critical', info: 'badge-info', soft: 'badge-soft' }[variant] || 'badge-soft';
  return <span className={'badge ' + cls}>{children}</span>;
}
function StatusBadge({ status }) {
  const map = { active: 'success', inactive: 'critical', invited: 'warning', planned: 'info', on_hold: 'warning', closed: 'soft' };
  return <Badge variant={map[status] || 'soft'}>{status}</Badge>;
}
function Modal({ title, children, onClose, footer, wide }) {
  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={wide ? { maxWidth: 760 } : null}>
        <div className="modal-head"><h3>{title}</h3><button className="icon-btn" onClick={onClose}>✕</button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
function Confirm({ title, message, requireReason, confirmLabel = 'Confirm', danger, onConfirm, onClose }) {
  const [reason, setReason] = useState('');
  return (
    <Modal title={title} onClose={onClose}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className={'btn ' + (danger ? 'btn-danger' : '')}
          disabled={requireReason && !reason.trim()}
          onClick={() => onConfirm(reason)}>{confirmLabel}</button>
      </>}>
      <p style={{ marginTop: 0 }}>{message}</p>
      {requireReason && (
        <div className="field"><label>Reason (required)</label>
          <textarea rows="3" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Provide a reason…" /></div>
      )}
    </Modal>
  );
}
function Empty({ icon, text }) {
  return (
    <div className="empty">
      <div className="ico" aria-hidden="true">
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: .5 }}>
          <path d="M3 7l9-4 9 4-9 4-9-4zM3 7v10l9 4 9-4V7M3 12l9 4 9-4" />
        </svg>
      </div>
      <p>{text}</p>
    </div>
  );
}
function Skeleton({ rows = 5 }) { return <div className="card-pad">{Array.from({ length: rows }).map((_, i) => <div key={i} className="skeleton" style={{ width: (90 - i * 8) + '%' }} />)}</div>; }

/* ----------------------------- Login ----------------------------- */
function Login({ branding, onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(null);

  async function submit(e) {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      const { token, user } = await api.post('/auth/login', { email, password, remember });
      api.setToken(token); onLogin(user);
    } catch (e) { setErr(e.message || 'Login failed'); } finally { setBusy(false); }
  }
  async function doForgot() {
    try { const r = await api.post('/auth/forgot-password', { email }); setForgot(r.message); }
    catch (e) { setForgot(e.message); }
  }
  const name = branding?.company_name || 'Arabtec Recruitment Hub';
  return (
    <div className="login-wrap">
      <div className="login-brand">
        <div style={{ marginBottom: 26 }}><Logo size={72} withText /></div>
        <h1>Recruitment Hub</h1>
        <p>Enterprise Recruitment Ticketing &amp; Applicant Tracking. Every hiring need, controlled end-to-end — approvals, ownership, pipeline, and full audit.</p>
      </div>
      <div className="login-form-side">
        <form className="login-card" onSubmit={submit}>
          <h2>Sign in</h2>
          <p className="sub">Use your Arabtec corporate account.</p>
          {err && <div className="error-banner">{err}</div>}
          {forgot && <div className="success-banner">{forgot}</div>}
          <div className="field"><label>Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@arabtec.com" autoFocus required /></div>
          <div className="field"><label>Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required /></div>
          <div className="row-between" style={{ marginBottom: 20 }}>
            <label className="checkbox"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember me</label>
            <a href="#" onClick={(e) => { e.preventDefault(); doForgot(); }}>Forgot password?</a>
          </div>
          <button className="btn btn-block" disabled={busy}>{busy ? 'Signing in…' : 'Login'}</button>
        </form>
      </div>
    </div>
  );
}

/* ----------------------------- Navigation config ----------------------------- */
const NAV = [
  { section: 'Overview' },
  { key: 'dashboard', label: 'Dashboard', icon: 'dashboard', perm: 'dashboard.view' },
  { section: 'Recruitment' },
  { key: 'requests', label: 'Recruitment Requests', icon: 'ticket', anyPerm: ['request.view_all', 'request.view_own'] },
  { key: 'candidates', label: 'Talent Pool', icon: 'user', perm: 'candidate.view' },
  { key: 'interviews', label: 'Interviews', icon: 'calendar', anyPerm: ['interview.view_all', 'interview.view_assigned'] },
  { key: 'offers', label: 'Offers', icon: 'doc', perm: 'offer.view' },
  { section: 'Administration' },
  { key: 'users', label: 'Users', icon: 'users', perm: 'user.manage' },
  { key: 'roles', label: 'Roles & Permissions', icon: 'shield', perm: 'role.manage' },
  { key: 'projects', label: 'Projects', icon: 'hardhat', perm: null },
  { key: 'sites', label: 'Sites', icon: 'pin', perm: null },
  { key: 'departments', label: 'Departments', icon: 'building', perm: null },
  { section: 'Configuration' },
  { key: 'branding', label: 'Branding Settings', icon: 'palette', perm: 'branding.manage' },
  { key: 'buttons', label: 'Button Settings', icon: 'button', perm: 'button.manage' },
  { key: 'workflow', label: 'Workflow Settings', icon: 'flow', perm: 'workflow.manage' },
  { key: 'system', label: 'System Settings', icon: 'gear', perm: 'system.manage' },
  { section: 'Governance' },
  { key: 'audit', label: 'Audit Logs', icon: 'scroll', perm: 'audit.view' },
];

/* ----------------------------- Shell ----------------------------- */
function Shell({ user, branding, onLogout, refreshBranding }) {
  const [route, setRoute] = useState('dashboard');
  const [collapsed, setCollapsed] = useState(branding?.sidebar_mode === 'collapsed');
  const [menuOpen, setMenuOpen] = useState(false);
  const density = branding?.table_density || 'comfortable';

  const visibleNav = NAV.filter((n) => n.section || (n.anyPerm ? n.anyPerm.some((p) => can(user, p)) : (!n.perm || can(user, n.perm))));

  const Page = {
    dashboard: <Dashboard user={user} />,
    requests: <RequestsPage user={user} />,
    candidates: <CandidatesPage user={user} />,
    interviews: <InterviewsPage user={user} />,
    offers: <OffersPage user={user} />,
    users: <UsersPage user={user} />,
    roles: <RolesPage user={user} />,
    projects: <ProjectsPage user={user} />,
    sites: <SitesPage user={user} />,
    departments: <DepartmentsPage user={user} />,
    branding: <BrandingPage user={user} branding={branding} refreshBranding={refreshBranding} />,
    buttons: <ButtonsPage user={user} />,
    workflow: <WorkflowPage user={user} />,
    system: <SystemPage user={user} />,
    audit: <AuditPage user={user} />,
  }[route] || <Dashboard user={user} />;

  return (
    <div className="shell" style={{ '--sidebar-w': collapsed ? '68px' : '240px' }}>
      <aside className={'sidebar' + (collapsed ? ' collapsed' : '')}>
        <div className="sidebar-head" style={{ justifyContent: 'center' }}>
          {collapsed
            ? <Logo size={26} />
            : <Logo size={40} withText />}
        </div>
        <nav className="nav">
          {visibleNav.map((n, i) => n.section
            ? (!collapsed && <div key={'s' + i} className="nav-section">{n.section}</div>)
            : (
              <button key={n.key} className={'nav-item' + (route === n.key ? ' active' : '')} onClick={() => setRoute(n.key)} title={n.label}>
                <span className="nav-icon"><Icon name={n.icon} size={17} /></span>{!collapsed && <span>{n.label}</span>}
              </button>
            ))}
        </nav>
      </aside>

      <div className="main">
        <header className="topbar">
          <button className="icon-btn" onClick={() => setCollapsed((c) => !c)} title="Toggle sidebar" aria-label="Toggle sidebar">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
          </button>
          <div className="search"><input placeholder="Search…" disabled /></div>
          <div className="spacer" />
          <button className="icon-btn" title="Notifications" aria-label="Notifications">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0" /></svg>
            <span className="dot" />
          </button>
          <div className="profile" onClick={() => setMenuOpen((o) => !o)}>
            <div className="avatar">{initials(user.fullName)}</div>
            <div>
              <div className="profile-name">{user.fullName}</div>
              <div className="profile-role">{ROLE_NAMES[user.roles[0]] || user.roles[0]}</div>
            </div>
            {menuOpen && (
              <div className="menu" onClick={(e) => e.stopPropagation()}>
                <div className="menu-item" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                  <strong>{user.fullName}</strong><span className="muted">{user.email}</span>
                </div>
                <div style={{ borderTop: '1px solid var(--border)' }} />
                <div className="menu-item" onClick={onLogout} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" /></svg>
                  Logout
                </div>
              </div>
            )}
          </div>
        </header>
        <main className={'content density-' + density}>{Page}</main>
      </div>
    </div>
  );
}

/* ----------------------------- Dashboard ----------------------------- */
/* ---- tiny inline-SVG chart helpers (no external libraries) ---- */
const CHART_COLORS = ['#005B96', '#00A3E0', '#2E7D32', '#F59E0B', '#C62828', '#1976D2', '#6B7280', '#003A63'];
function BarChart({ data, height = 160 }) {
  const items = data.filter((d) => d.count > 0);
  if (!items.length) return <Empty icon="📊" text="No data yet." />;
  const max = Math.max(...items.map((d) => d.count), 1);
  const bw = 100 / items.length;
  return (
    <svg viewBox={`0 0 100 ${height / 2}`} style={{ width: '100%', height }} preserveAspectRatio="none">
      {items.map((d, i) => {
        const h = (d.count / max) * (height / 2 - 14);
        return <g key={i}>
          <rect x={i * bw + bw * 0.15} y={height / 2 - 10 - h} width={bw * 0.7} height={h} fill={CHART_COLORS[i % CHART_COLORS.length]} rx="0.6" />
          <text x={i * bw + bw / 2} y={height / 2 - 10 - h - 1.5} fontSize="3" textAnchor="middle" fill="var(--text-dark)">{d.count}</text>
        </g>;
      })}
    </svg>
  );
}
function ChartLegend({ data, labeler = (s) => s }) {
  const items = data.filter((d) => d.count > 0);
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
    {items.map((d, i) => <span key={i} style={{ fontSize: 11.5, color: 'var(--text-gray)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{ width: 9, height: 9, borderRadius: 2, background: CHART_COLORS[i % CHART_COLORS.length], display: 'inline-block' }} />{labeler(d.status)} ({d.count})</span>)}
  </div>;
}
function Funnel({ data }) {
  const order = ['applied', 'cv_screening', 'shortlisted', 'phone_interview', 'technical_interview', 'client_interview', 'final_interview', 'reference_check', 'offer_preparation', 'offer_sent', 'offer_accepted', 'joined'];
  const map = Object.fromEntries(data.map((d) => [d.status, d.count]));
  const rows = order.filter((s) => map[s]).map((s) => ({ status: s, count: map[s] }));
  if (!rows.length) return <Empty icon="🔻" text="No applications yet." />;
  const max = Math.max(...rows.map((r) => r.count), 1);
  return <div>{rows.map((r, i) => (
    <div key={r.status} style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '3px 0' }}>
      <span style={{ width: 130, fontSize: 12, color: 'var(--text-gray)' }}>{(APP_STATUS[r.status] || {}).label || r.status}</span>
      <span style={{ flex: 1, background: '#eef1f4', borderRadius: 4, overflow: 'hidden', height: 18 }}>
        <span style={{ display: 'block', height: '100%', width: `${(r.count / max) * 100}%`, background: CHART_COLORS[i % CHART_COLORS.length], minWidth: 2 }} /></span>
      <strong style={{ width: 28, textAlign: 'right', fontSize: 12.5 }}>{r.count}</strong>
    </div>
  ))}</div>;
}

function Dashboard({ user }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (!can(user, 'dashboard.view')) { setErr('You do not have dashboard access.'); return; }
    api.get('/dashboard').then(setD).catch((e) => setErr(e.message));
  }, []);

  if (err) return <div><PageHead crumb="Home / Dashboard" title={`Welcome, ${user.fullName.split(' ')[0]}`} /><div className="card"><div className="error-banner" style={{ margin: 20 }}>{err}</div></div></div>;
  if (!d) return <div><PageHead crumb="Home / Dashboard" title={`Welcome, ${user.fullName.split(' ')[0]}`} /><Skeleton rows={8} /></div>;

  const k = d.kpis;
  const kpiCards = [
    { label: 'Open Requests', value: k.openRequests, hint: 'active tickets' },
    { label: 'Fill Rate', value: k.fillRate + '%', hint: `${k.headcountFilled}/${k.headcountTotal} seats` },
    { label: 'Candidates in Pipeline', value: k.totalApplications, hint: 'applications' },
    { label: 'Upcoming Interviews', value: k.upcomingInterviews, hint: 'scheduled' },
    { label: 'Offers', value: k.totalOffers, hint: 'all offers' },
    { label: 'Offer Acceptance', value: k.offerAcceptanceRate == null ? '—' : k.offerAcceptanceRate + '%', hint: 'accepted / decided' },
    { label: 'Joined', value: k.joined, hint: 'hires' },
    { label: 'Avg Time-to-Fill', value: k.timeToFillDays == null ? '—' : k.timeToFillDays + 'd', hint: 'filled requests' },
  ];
  const agingData = Object.entries(d.aging).map(([status, count]) => ({ status, count }));

  return (
    <div>
      <div className="page-head"><div>
        <div className="breadcrumb">Home / Dashboard</div>
        <h1 className="page-title">Welcome, {user.fullName.split(' ')[0]}</h1>
        <p className="page-sub">{d.scope === 'all' ? 'Organization-wide recruitment analytics.' : 'Your scoped recruitment analytics (your own requests).'} · Read-only · No salary data.</p>
      </div><Badge variant="info">{d.scope === 'all' ? 'Org-wide' : 'My scope'}</Badge></div>

      <div className="grid-kpi">
        {kpiCards.map((c, i) => <div className="kpi" key={i}><div className="label">{c.label}</div><div className="value">{c.value}</div><div className="hint">{c.hint}</div></div>)}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <div className="card"><div className="card-head"><h3>Requests by Status</h3></div><div className="card-pad">
          <BarChart data={d.requestsByStatus.map((r) => ({ ...r, label: r.status }))} />
          <ChartLegend data={d.requestsByStatus} labeler={(s) => (REQ_STATUS[s] || {}).label || s} />
        </div></div>
        <div className="card"><div className="card-head"><h3>Requisition Aging (open)</h3></div><div className="card-pad">
          <BarChart data={agingData} />
          <ChartLegend data={agingData} labeler={(s) => s + ' days'} />
        </div></div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 16, marginBottom: 16 }}>
        <div className="card"><div className="card-head"><h3>Pipeline Funnel</h3></div><div className="card-pad"><Funnel data={d.applicationsByStatus} /></div></div>
        <div className="card"><div className="card-head"><h3>Offer Outcomes</h3></div><div className="card-pad">
          <BarChart data={d.offersByStatus} />
          <ChartLegend data={d.offersByStatus} labeler={(s) => (OFFER_STATUS[s] || {}).label || s} />
        </div></div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: d.scope === 'all' ? '1fr 1fr' : '1fr', gap: 16 }}>
        <div className="card"><div className="card-head"><h3>My Work</h3></div><div className="card-pad">
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            <div><div className="value" style={{ fontSize: 24, fontWeight: 700, color: 'var(--primary)' }}>{d.myWork.myOpenRequests}</div><div className="muted">my open requests</div></div>
            <div><div className="value" style={{ fontSize: 24, fontWeight: 700, color: 'var(--primary)' }}>{d.myWork.myInterviews}</div><div className="muted">my upcoming interviews</div></div>
            {d.myWork.myPendingOfferApprovals != null && <div><div className="value" style={{ fontSize: 24, fontWeight: 700, color: 'var(--warning)' }}>{d.myWork.myPendingOfferApprovals}</div><div className="muted">offers awaiting approval</div></div>}
          </div>
        </div></div>
        {d.scope === 'all' && (
          <div className="card"><div className="card-head"><h3>Recruiter Load (open requests)</h3></div><div className="card-pad">
            {d.recruiterLoad.length === 0 ? <Empty icon="👥" text="No assigned recruiters yet." /> : (
              <table><tbody>{d.recruiterLoad.map((r, i) => (
                <tr key={i}><td>{r.name}</td><td style={{ width: '60%' }}><span style={{ display: 'inline-block', height: 10, borderRadius: 3, background: CHART_COLORS[i % CHART_COLORS.length], width: `${(r.c / Math.max(...d.recruiterLoad.map((x) => x.c))) * 100}%`, minWidth: 6 }} /></td><td style={{ textAlign: 'right' }}><strong>{r.c}</strong></td></tr>
              ))}</tbody></table>
            )}
          </div></div>
        )}
      </div>
    </div>
  );
}

/* ----------------------------- Users page ----------------------------- */
function PageHead({ crumb, title, sub, actions }) {
  return (
    <div className="page-head">
      <div><div className="breadcrumb">{crumb}</div><h1 className="page-title">{title}</h1>{sub && <p className="page-sub">{sub}</p>}</div>
      <div style={{ display: 'flex', gap: 10 }}>{actions}</div>
    </div>
  );
}

function UsersPage({ user }) {
  const toast = useToast();
  const [users, setUsers] = useState(null);
  const [roles, setRoles] = useState([]);
  const [depts, setDepts] = useState([]);
  const [projects, setProjects] = useState([]);
  const [sites, setSites] = useState([]);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(null);
  const [activity, setActivity] = useState(null);
  const canManage = can(user, 'user.manage');

  const load = useCallback(async () => {
    setUsers(null);
    const [u, r, d, p, s] = await Promise.all([
      api.get('/users' + (q ? '?q=' + encodeURIComponent(q) : '')),
      api.get('/roles'), api.get('/org/departments'), api.get('/org/projects'), api.get('/org/sites'),
    ]);
    setUsers(u.users); setRoles(r.roles); setDepts(d.departments); setProjects(p.projects); setSites(s.sites);
  }, [q]);
  useEffect(() => { load(); }, [load]);

  async function toggleStatus(u) {
    const action = u.status === 'active' ? 'deactivate' : 'activate';
    try { await api.post(`/users/${u.id}/${action}`); toast(`User ${action}d`); load(); }
    catch (e) { toast(e.message, 'error'); }
  }
  async function resetPwd(u) {
    try { const r = await api.post(`/users/${u.id}/reset-password`, {}); toast('Password reset to default'); }
    catch (e) { toast(e.message, 'error'); }
  }
  async function showActivity(u) {
    const r = await api.get(`/users/${u.id}/activity`); setActivity({ user: u, logs: r.activity });
  }

  return (
    <div>
      <PageHead crumb="Administration / Users" title="User Management" sub="Create accounts, assign roles, departments and project/site access."
        actions={canManage && <button className="btn" onClick={() => setEditing({})}>+ Create User</button>} />
      <div className="toolbar">
        <input placeholder="Search name / email / employee no…" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 280 }} />
      </div>
      <div className="card">
        {!users ? <Skeleton /> : users.length === 0 ? <Empty text="No users found." /> : (
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Job Title</th><th>Role(s)</th><th>Status</th><th>Last Login</th><th></th></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td><strong>{u.fullName}</strong><div className="muted">{u.employeeNo || '—'}</div></td>
                  <td>{u.email}</td>
                  <td>{u.jobTitle || '—'}</td>
                  <td>{u.roles.map((r) => <span className="chip" key={r.code}>{r.name}</span>)}</td>
                  <td><StatusBadge status={u.status} /></td>
                  <td className="muted">{fmtDate(u.lastLoginAt)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {canManage && <>
                      <button className="btn btn-secondary btn-sm" onClick={() => setEditing(u)}>Edit</button>{' '}
                      <button className="btn btn-ghost btn-sm" onClick={() => showActivity(u)}>Activity</button>{' '}
                      <button className="btn btn-ghost btn-sm" onClick={() => resetPwd(u)}>Reset PW</button>{' '}
                      <button className={'btn btn-sm ' + (u.status === 'active' ? 'btn-danger' : '')} onClick={() => toggleStatus(u)} disabled={u.id === user.id}>
                        {u.status === 'active' ? 'Deactivate' : 'Activate'}</button>
                    </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && <UserModal user={editing} roles={roles} depts={depts} projects={projects} sites={sites}
        onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {activity && <Modal title={`Activity — ${activity.user.fullName}`} onClose={() => setActivity(null)} wide
        footer={<button className="btn btn-ghost" onClick={() => setActivity(null)}>Close</button>}>
        {activity.logs.length === 0 ? <Empty text="No activity recorded." /> : (
          <table><thead><tr><th>Action</th><th>Entity</th><th>When</th></tr></thead>
            <tbody>{activity.logs.map((l) => <tr key={l.id}><td>{l.action}</td><td>{l.entityType} {l.entityId || ''}</td><td className="muted">{fmtDate(l.occurredAt || l.occurred_at)}</td></tr>)}</tbody></table>
        )}
      </Modal>}
    </div>
  );
}

function UserModal({ user, roles, depts, projects, sites, onClose, onSaved }) {
  const toast = useToast();
  const isNew = !user.id;
  const [f, setF] = useState({
    fullName: user.fullName || '', email: user.email || '', phone: user.phone || '',
    jobTitle: user.jobTitle || '', employeeNo: user.employeeNo || '',
    departmentId: user.departmentId || '', roleCodes: (user.roles || []).map((r) => r.code),
    globalScope: user.isGlobalScope || false,
    projectIds: user.projectScopes || [], siteIds: user.siteScopes || [],
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const toggleArr = (k, v) => setF((s) => ({ ...s, [k]: s[k].includes(v) ? s[k].filter((x) => x !== v) : [...s[k], v] }));

  async function save() {
    setBusy(true);
    try {
      const payload = { ...f, departmentId: f.departmentId || null };
      if (isNew) await api.post('/users', payload);
      else await api.put('/users/' + user.id, payload);
      toast(isNew ? 'User created' : 'User updated'); onSaved();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }
  return (
    <Modal title={isNew ? 'Create User' : 'Edit User'} onClose={onClose} wide
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></>}>
      <div className="form-grid">
        <div className="field"><label>Full Name *</label><input value={f.fullName} onChange={(e) => set('fullName', e.target.value)} /></div>
        <div className="field"><label>Email *</label><input type="email" value={f.email} onChange={(e) => set('email', e.target.value)} /></div>
        <div className="field"><label>Phone</label><input value={f.phone} onChange={(e) => set('phone', e.target.value)} /></div>
        <div className="field"><label>Job Title</label><input value={f.jobTitle} onChange={(e) => set('jobTitle', e.target.value)} /></div>
        <div className="field"><label>Employee No</label><input value={f.employeeNo} onChange={(e) => set('employeeNo', e.target.value)} /></div>
        <div className="field"><label>Department</label>
          <select value={f.departmentId} onChange={(e) => set('departmentId', e.target.value)}>
            <option value="">— None —</option>{depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></div>
      </div>
      <div className="section-title">Roles</div>
      <div>{roles.map((r) => <span key={r.code} className={'tag-toggle' + (f.roleCodes.includes(r.code) ? ' on' : '')} onClick={() => toggleArr('roleCodes', r.code)}>{r.name}</span>)}</div>
      <div className="section-title">Access Scope</div>
      <label className="switch" style={{ marginBottom: 10 }}><input type="checkbox" checked={f.globalScope} onChange={(e) => set('globalScope', e.target.checked)} /> Global access (all projects &amp; sites)</label>
      {!f.globalScope && <>
        <div className="muted" style={{ marginBottom: 6 }}>Projects</div>
        <div style={{ marginBottom: 12 }}>{projects.map((p) => <span key={p.id} className={'tag-toggle' + (f.projectIds.includes(p.id) ? ' on' : '')} onClick={() => toggleArr('projectIds', p.id)}>{p.name}</span>)}</div>
        <div className="muted" style={{ marginBottom: 6 }}>Sites</div>
        <div>{sites.map((s) => <span key={s.id} className={'tag-toggle' + (f.siteIds.includes(s.id) ? ' on' : '')} onClick={() => toggleArr('siteIds', s.id)}>{s.name}</span>)}</div>
      </>}
      {isNew && <p className="muted" style={{ marginTop: 18 }}>Default password <strong>Arabtec@123</strong> will be set (user can be reset later).</p>}
    </Modal>
  );
}

/* ----------------------------- Roles & Permissions ----------------------------- */
function RolesPage({ user }) {
  const toast = useToast();
  const [roles, setRoles] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [selected, setSelected] = useState(null);
  const [draft, setDraft] = useState([]);
  const canManage = can(user, 'role.manage');

  const load = useCallback(async () => {
    const [r, p] = await Promise.all([api.get('/roles'), api.get('/roles/permissions')]);
    setRoles(r.roles); setCatalog(p.permissions);
    if (!selected && r.roles[0]) { setSelected(r.roles[0]); setDraft(r.roles[0].permissions); }
  }, [selected]);
  useEffect(() => { load(); }, []);

  function pick(role) { setSelected(role); setDraft(role.permissions); }
  function toggle(code) { setDraft((d) => d.includes(code) ? d.filter((x) => x !== code) : [...d, code]); }
  async function save() {
    try { await api.put(`/roles/${selected.id}/permissions`, { permissionCodes: draft }); toast('Permissions updated'); load(); }
    catch (e) { toast(e.message, 'error'); }
  }
  const groups = useMemo(() => {
    const g = {};
    for (const p of catalog) { (g[p.resource] ??= []).push(p); }
    return g;
  }, [catalog]);

  if (!roles) return <Skeleton rows={8} />;
  return (
    <div>
      <PageHead crumb="Administration / Roles" title="Roles & Permissions" sub="Toggle capabilities per role. Changes are enforced server-side and audited." />
      <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 16 }}>
        <div className="card"><div className="card-pad">
          {roles.map((r) => (
            <button key={r.id} className={'nav-item' + (selected?.id === r.id ? ' active' : '')} style={{ color: selected?.id === r.id ? '#fff' : 'var(--text-dark)' }} onClick={() => pick(r)}>
              <span>{r.name}</span>
            </button>
          ))}
        </div></div>
        <div className="card">
          <div className="card-head"><h3>{selected?.name} — {draft.length} permissions</h3>
            {canManage && <button className="btn btn-sm" onClick={save}>Save Changes</button>}</div>
          <div className="card-pad">
            {Object.entries(groups).map(([res, perms]) => (
              <div key={res} style={{ marginBottom: 16 }}>
                <div className="muted" style={{ textTransform: 'uppercase', fontWeight: 700, fontSize: 11, marginBottom: 8 }}>{res}</div>
                {perms.map((p) => (
                  <label key={p.code} className="switch" style={{ display: 'inline-flex', width: '48%', marginBottom: 8 }}>
                    <input type="checkbox" disabled={!canManage} checked={draft.includes(p.code)} onChange={() => toggle(p.code)} /> {p.description}
                  </label>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- Generic org table helper ----------------------------- */
function useOrg(endpoint, key) {
  const [rows, setRows] = useState(null);
  const load = useCallback(async () => { setRows((await api.get(endpoint))[key]); }, []);
  useEffect(() => { load(); }, []);
  return [rows, load];
}

function ProjectsPage({ user }) {
  const toast = useToast();
  const [rows, load] = useOrg('/org/projects', 'projects');
  const [bus, setBus] = useState([]);
  const [users, setUsers] = useState([]);
  const [editing, setEditing] = useState(null);
  const canManage = can(user, 'org.manage');
  useEffect(() => { api.get('/org/business-units').then((r) => setBus(r.businessUnits)).catch(() => {}); if (can(user, 'user.manage')) api.get('/users').then((r) => setUsers(r.users)).catch(() => {}); }, []);

  return (
    <div>
      <PageHead crumb="Administration / Projects" title="Projects" sub="Construction projects are the core hiring contexts."
        actions={canManage && <button className="btn" onClick={() => setEditing({})}>+ New Project</button>} />
      <div className="card">
        {!rows ? <Skeleton /> : rows.length === 0 ? <Empty icon="🏗" text="No projects yet." /> : (
          <table><thead><tr><th>Code</th><th>Name</th><th>Client</th><th>Location</th><th>Status</th><th>Sites</th><th>PM</th>{canManage && <th></th>}</tr></thead>
            <tbody>{rows.map((p) => (
              <tr key={p.id}><td><strong>{p.code}</strong></td><td>{p.name}</td><td>{p.clientName || '—'}</td><td>{p.location || '—'}</td>
                <td><StatusBadge status={p.status} /></td><td>{p.siteCount}</td><td>{p.projectManager?.name || '—'}</td>
                {canManage && <td><button className="btn btn-secondary btn-sm" onClick={() => setEditing(p)}>Edit</button></td>}</tr>
            ))}</tbody></table>
        )}
      </div>
      {editing && <OrgModal kind="project" record={editing} bus={bus} users={users}
        onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function SitesPage({ user }) {
  const [rows, load] = useOrg('/org/sites', 'sites');
  const [projects, setProjects] = useState([]);
  const [users, setUsers] = useState([]);
  const [editing, setEditing] = useState(null);
  const canManage = can(user, 'org.manage');
  useEffect(() => { api.get('/org/projects').then((r) => setProjects(r.projects)).catch(() => {}); if (can(user, 'user.manage')) api.get('/users').then((r) => setUsers(r.users)).catch(() => {}); }, []);
  return (
    <div>
      <PageHead crumb="Administration / Sites" title="Sites" sub="Physical locations under projects (multi-site hiring)."
        actions={canManage && <button className="btn" onClick={() => setEditing({})}>+ New Site</button>} />
      <div className="card">
        {!rows ? <Skeleton /> : rows.length === 0 ? <Empty icon="📍" text="No sites yet." /> : (
          <table><thead><tr><th>Code</th><th>Name</th><th>Project</th><th>Location</th><th>Status</th><th>Site Manager</th>{canManage && <th></th>}</tr></thead>
            <tbody>{rows.map((s) => (
              <tr key={s.id}><td><strong>{s.code}</strong></td><td>{s.name}</td><td>{s.project?.name || '—'}</td><td>{s.location || '—'}</td>
                <td><StatusBadge status={s.status} /></td><td>{s.siteManager?.name || '—'}</td>
                {canManage && <td><button className="btn btn-secondary btn-sm" onClick={() => setEditing(s)}>Edit</button></td>}</tr>
            ))}</tbody></table>
        )}
      </div>
      {editing && <OrgModal kind="site" record={editing} projects={projects} users={users}
        onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function DepartmentsPage({ user }) {
  const [rows, load] = useOrg('/org/departments', 'departments');
  const [bus, setBus] = useState([]);
  const [users, setUsers] = useState([]);
  const [editing, setEditing] = useState(null);
  const canManage = can(user, 'org.manage');
  useEffect(() => { api.get('/org/business-units').then((r) => setBus(r.businessUnits)).catch(() => {}); if (can(user, 'user.manage')) api.get('/users').then((r) => setUsers(r.users)).catch(() => {}); }, []);
  return (
    <div>
      <PageHead crumb="Administration / Departments" title="Departments" sub="Disciplines such as Mechanical, Civil, MEP, Planning, QA/QC."
        actions={canManage && <button className="btn" onClick={() => setEditing({})}>+ New Department</button>} />
      <div className="card">
        {!rows ? <Skeleton /> : rows.length === 0 ? <Empty icon="🏢" text="No departments yet." /> : (
          <table><thead><tr><th>Code</th><th>Name</th><th>Head</th><th>Status</th>{canManage && <th></th>}</tr></thead>
            <tbody>{rows.map((d) => (
              <tr key={d.id}><td><strong>{d.code}</strong></td><td>{d.name}</td><td>{d.head?.name || '—'}</td>
                <td><StatusBadge status={d.status} /></td>
                {canManage && <td><button className="btn btn-secondary btn-sm" onClick={() => setEditing(d)}>Edit</button></td>}</tr>
            ))}</tbody></table>
        )}
      </div>
      {editing && <OrgModal kind="department" record={editing} bus={bus} users={users}
        onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function OrgModal({ kind, record, bus = [], projects = [], users = [], onClose, onSaved }) {
  const toast = useToast();
  const isNew = !record.id;
  const [f, setF] = useState({
    code: record.code || '', name: record.name || '', clientName: record.clientName || '',
    location: record.location || '', status: record.status || (kind === 'project' ? 'active' : 'active'),
    startDate: record.startDate ? String(record.startDate).slice(0, 10) : '',
    endDate: record.endDate ? String(record.endDate).slice(0, 10) : '',
    projectManagerId: record.projectManagerId || '', businessUnitId: record.businessUnitId || '',
    projectId: record.projectId || '', siteManagerId: record.siteManagerId || '', headUserId: record.headUserId || '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const endpoint = { project: '/org/projects', site: '/org/sites', department: '/org/departments' }[kind];

  async function save() {
    setBusy(true);
    try {
      const body = { ...f };
      ['projectManagerId', 'businessUnitId', 'projectId', 'siteManagerId', 'headUserId'].forEach((k) => { if (body[k] === '') body[k] = null; });
      if (isNew) await api.post(endpoint, body); else await api.put(`${endpoint}/${record.id}`, body);
      toast(isNew ? `${kind} created` : `${kind} updated`); onSaved();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }
  const title = (isNew ? 'New ' : 'Edit ') + kind.charAt(0).toUpperCase() + kind.slice(1);
  return (
    <Modal title={title} onClose={onClose}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></>}>
      <div className="form-grid">
        <div className="field"><label>Code *</label><input value={f.code} disabled={!isNew} onChange={(e) => set('code', e.target.value)} /></div>
        <div className="field"><label>Name *</label><input value={f.name} onChange={(e) => set('name', e.target.value)} /></div>
        {kind === 'project' && <>
          <div className="field"><label>Client</label><input value={f.clientName} onChange={(e) => set('clientName', e.target.value)} /></div>
          <div className="field"><label>Location</label><input value={f.location} onChange={(e) => set('location', e.target.value)} /></div>
          <div className="field"><label>Start Date</label><input type="date" value={f.startDate} onChange={(e) => set('startDate', e.target.value)} /></div>
          <div className="field"><label>End Date</label><input type="date" value={f.endDate} onChange={(e) => set('endDate', e.target.value)} /></div>
          <div className="field"><label>Status</label><select value={f.status} onChange={(e) => set('status', e.target.value)}><option>planned</option><option>active</option><option>on_hold</option><option>closed</option></select></div>
          <div className="field"><label>Project Manager</label><select value={f.projectManagerId} onChange={(e) => set('projectManagerId', e.target.value)}><option value="">—</option>{users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</select></div>
          <div className="field full"><label>Business Unit</label><select value={f.businessUnitId} onChange={(e) => set('businessUnitId', e.target.value)}><option value="">—</option>{bus.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
        </>}
        {kind === 'site' && <>
          <div className="field"><label>Project *</label><select value={f.projectId} onChange={(e) => set('projectId', e.target.value)}><option value="">— Select —</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
          <div className="field"><label>Location</label><input value={f.location} onChange={(e) => set('location', e.target.value)} /></div>
          <div className="field"><label>Status</label><select value={f.status} onChange={(e) => set('status', e.target.value)}><option>active</option><option>inactive</option></select></div>
          <div className="field"><label>Site Manager</label><select value={f.siteManagerId} onChange={(e) => set('siteManagerId', e.target.value)}><option value="">—</option>{users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</select></div>
        </>}
        {kind === 'department' && <>
          <div className="field"><label>Status</label><select value={f.status} onChange={(e) => set('status', e.target.value)}><option>active</option><option>inactive</option></select></div>
          <div className="field"><label>Department Head</label><select value={f.headUserId} onChange={(e) => set('headUserId', e.target.value)}><option value="">—</option>{users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</select></div>
          <div className="field full"><label>Business Unit</label><select value={f.businessUnitId} onChange={(e) => set('businessUnitId', e.target.value)}><option value="">—</option>{bus.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
        </>}
      </div>
    </Modal>
  );
}

/* ----------------------------- Branding ----------------------------- */
const BRAND_COLORS = [
  ['primary_color', 'Primary (Navy)'], ['secondary_color', 'Corporate Blue'], ['accent_color', 'Accent Sky'],
  ['background_color', 'Background'], ['surface_color', 'Surface'], ['text_dark', 'Text Dark'],
  ['text_gray', 'Text Gray'], ['border_color', 'Border'], ['button_color', 'Button'],
  ['success_color', 'Success'], ['warning_color', 'Warning'], ['critical_color', 'Critical'],
];
function BrandingPage({ user, branding, refreshBranding }) {
  const toast = useToast();
  const [f, setF] = useState(branding || {});
  const [busy, setBusy] = useState(false);
  const canManage = can(user, 'branding.manage');
  const set = (k, v) => { setF((s) => ({ ...s, [k]: v })); applyBranding({ ...f, [k]: v }); };

  async function save() {
    setBusy(true);
    try { await api.put('/settings/branding', { branding: f }); await refreshBranding(); toast('Branding saved — theme applied'); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }
  function reset() { setF(branding); applyBranding(branding); }

  return (
    <div>
      <PageHead crumb="Configuration / Branding" title="Branding & Theme" sub="Live-preview changes apply to the whole UI immediately; Save persists them."
        actions={canManage && <><button className="btn btn-ghost" onClick={reset}>Revert</button><button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save Branding'}</button></>} />
      {!canManage && <div className="error-banner">You have read-only access to branding.</div>}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="field"><label>Company / App Name</label><input value={f.company_name || ''} disabled={!canManage} onChange={(e) => set('company_name', e.target.value)} /></div>
        <div className="form-grid">
          <div className="field"><label>Font Family</label><input value={f.font_family || ''} disabled={!canManage} onChange={(e) => set('font_family', e.target.value)} /></div>
          <div className="field"><label>Button Radius</label><input value={f.border_radius || ''} disabled={!canManage} onChange={(e) => set('border_radius', e.target.value)} /></div>
          <div className="field"><label>Card Radius</label><input value={f.card_radius || ''} disabled={!canManage} onChange={(e) => set('card_radius', e.target.value)} /></div>
          <div className="field"><label>Table Density</label><select value={f.table_density || 'comfortable'} disabled={!canManage} onChange={(e) => set('table_density', e.target.value)}><option>compact</option><option>comfortable</option><option>spacious</option></select></div>
          <div className="field"><label>Sidebar Mode</label><select value={f.sidebar_mode || 'expanded'} disabled={!canManage} onChange={(e) => set('sidebar_mode', e.target.value)}><option>expanded</option><option>collapsed</option></select></div>
          <div className="field"><label>Dark Mode</label><select value={f.dark_mode_enabled || 'false'} disabled={!canManage} onChange={(e) => set('dark_mode_enabled', e.target.value)}><option value="false">Disabled</option><option value="true">Enabled (Phase 3)</option></select></div>
        </div>
      </div>
      <div className="card card-pad">
        <div className="section-title" style={{ marginTop: 0 }}>Color Palette</div>
        <div className="form-grid">
          {BRAND_COLORS.map(([k, label]) => (
            <div className="field" key={k}><label>{label}</label>
              <div className="color-row">
                <input type="color" value={f[k] || '#000000'} disabled={!canManage} onChange={(e) => set(k, e.target.value)} />
                <input value={f[k] || ''} disabled={!canManage} onChange={(e) => set(k, e.target.value)} style={{ flex: 1 }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- Buttons ----------------------------- */
function ButtonsPage({ user }) {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const canManage = can(user, 'button.manage');
  const load = useCallback(async () => setRows((await api.get('/settings/buttons')).buttons), []);
  useEffect(() => { load(); }, []);

  async function update(key, patch) {
    try { await api.put('/settings/buttons/' + key, patch); toast('Button updated'); load(); }
    catch (e) { toast(e.message, 'error'); }
  }
  if (!rows) return <Skeleton rows={8} />;
  return (
    <div>
      <PageHead crumb="Configuration / Buttons" title="Button & Feature Control" sub="Govern every action: visibility, enablement, confirmation, reason, and audit. Enforced together with role permissions." />
      <div className="card">
        <table><thead><tr><th>Button</th><th>Screen</th><th>Permission</th><th>Visible</th><th>Enabled</th><th>Confirm</th><th>Reason</th><th>Audit</th></tr></thead>
          <tbody>{rows.map((b) => (
            <tr key={b.buttonKey}>
              <td><strong>{b.label}</strong><div className="muted">{b.buttonKey}</div></td>
              <td><span className="chip">{b.screen}</span></td>
              <td className="muted">{b.requiredPermission || '—'}</td>
              {['visible', 'enabled', 'confirmRequired', 'reasonRequired', 'auditRequired'].map((flag) => (
                <td key={flag}><input type="checkbox" disabled={!canManage} checked={!!b[flag]} onChange={(e) => update(b.buttonKey, { [flag]: e.target.checked })} /></td>
              ))}
            </tr>
          ))}</tbody></table>
      </div>
    </div>
  );
}

/* ----------------------------- Workflow ----------------------------- */
function WorkflowPage({ user }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.get('/settings/workflows').then((r) => setRows(r.workflows)); }, []);
  if (!rows) return <Skeleton rows={6} />;
  return (
    <div>
      <PageHead crumb="Configuration / Workflow" title="Workflow Settings" sub="The configurable state machines that drive Phase 2+ (requests, applications, approvals)." />
      {rows.map((w) => (
        <div className="card" key={w.key} style={{ marginBottom: 16 }}>
          <div className="card-head"><h3>{w.name}</h3><Badge variant={w.isActive ? 'success' : 'soft'}>{w.isActive ? 'active' : 'inactive'}</Badge></div>
          <div className="card-pad">
            {Object.entries(w.value).map(([group, items]) => (
              <div key={group} style={{ marginBottom: 10 }}>
                <div className="muted" style={{ textTransform: 'capitalize', marginBottom: 6 }}>{group}</div>
                <div>{(items || []).map((s, i) => <span key={i} className="chip">{s}</span>)}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
      <p className="muted">Visual editing of states &amp; transitions ships with the Admin Workflow Designer in a later phase.</p>
    </div>
  );
}

/* ----------------------------- System ----------------------------- */
function SystemPage({ user }) {
  const toast = useToast();
  const [s, setS] = useState(null);
  const canManage = can(user, 'system.manage');
  const load = useCallback(async () => setS((await api.get('/settings/system')).settings), []);
  useEffect(() => { load(); }, []);
  if (!s) return <Skeleton rows={6} />;
  const set = (k, v) => setS((p) => ({ ...p, [k]: v }));
  async function save() { try { await api.put('/settings/system', { settings: s }); toast('System settings saved'); load(); } catch (e) { toast(e.message, 'error'); } }
  return (
    <div>
      <PageHead crumb="Configuration / System" title="System Settings" sub="Platform-wide defaults."
        actions={canManage && <button className="btn" onClick={save}>Save</button>} />
      <div className="card card-pad"><div className="form-grid">
        {Object.entries(s).map(([k, v]) => (
          <div className="field" key={k}><label>{k.replace(/_/g, ' ')}</label>
            <input value={v} disabled={!canManage} onChange={(e) => set(k, e.target.value)} /></div>
        ))}
      </div></div>
    </div>
  );
}

/* ----------------------------- Audit ----------------------------- */
function AuditPage({ user }) {
  const [data, setData] = useState(null);
  const [facets, setFacets] = useState({ actions: [], entityTypes: [] });
  const [filter, setFilter] = useState({ q: '', action: '', entityType: '', page: 1 });
  const [detail, setDetail] = useState(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    Object.entries(filter).forEach(([k, v]) => { if (v) params.set(k, v); });
    setData(await api.get('/audit?' + params.toString()));
  }, [filter]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/audit/facets').then(setFacets).catch(() => {}); }, []);

  return (
    <div>
      <PageHead crumb="Governance / Audit" title="Audit Logs" sub="Immutable record of critical actions. Append-only." />
      <div className="toolbar">
        <input placeholder="Search…" value={filter.q} onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value, page: 1 }))} />
        <select value={filter.action} onChange={(e) => setFilter((f) => ({ ...f, action: e.target.value, page: 1 }))}>
          <option value="">All actions</option>{facets.actions.map((a) => <option key={a}>{a}</option>)}</select>
        <select value={filter.entityType} onChange={(e) => setFilter((f) => ({ ...f, entityType: e.target.value, page: 1 }))}>
          <option value="">All entities</option>{facets.entityTypes.map((a) => <option key={a}>{a}</option>)}</select>
        <div className="spacer" />
        {data && <span className="muted">{data.total} entries</span>}
      </div>
      <div className="card">
        {!data ? <Skeleton /> : data.logs.length === 0 ? <Empty icon="📜" text="No audit entries match." /> : (
          <table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Comments</th><th></th></tr></thead>
            <tbody>{data.logs.map((l) => (
              <tr key={l.id}><td className="muted">{fmtDate(l.occurredAt)}</td><td>{l.actorName || '—'}<div className="muted">{l.actorRole || ''}</div></td>
                <td><span className="chip">{l.action}</span></td><td>{l.entityType}{l.entityId ? ' #' + l.entityId : ''}</td>
                <td className="muted">{l.comments || '—'}</td>
                <td>{(l.oldValue || l.newValue) && <button className="btn btn-ghost btn-sm" onClick={() => setDetail(l)}>Diff</button>}</td></tr>
            ))}</tbody></table>
        )}
      </div>
      {detail && <Modal title={`Audit #${detail.id} — ${detail.action}`} onClose={() => setDetail(null)} wide
        footer={<button className="btn btn-ghost" onClick={() => setDetail(null)}>Close</button>}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <div><div className="section-title" style={{ marginTop: 0 }}>Before</div><pre style={{ background: 'var(--bg)', padding: 12, borderRadius: 6, fontSize: 12, overflow: 'auto' }}>{detail.oldValue ? JSON.stringify(detail.oldValue, null, 2) : '—'}</pre></div>
          <div><div className="section-title" style={{ marginTop: 0 }}>After</div><pre style={{ background: 'var(--bg)', padding: 12, borderRadius: 6, fontSize: 12, overflow: 'auto' }}>{detail.newValue ? JSON.stringify(detail.newValue, null, 2) : '—'}</pre></div>
        </div>
      </Modal>}
    </div>
  );
}

/* ============================ PHASE 2: Recruitment Requests ============================ */
const REQ_STATUS = {
  draft: { label: 'Draft', variant: 'soft' },
  pending_approval: { label: 'Pending Approval', variant: 'warning' },
  budget_validation: { label: 'Budget Validation', variant: 'warning' },
  approved: { label: 'Approved', variant: 'success' },
  in_sourcing: { label: 'In Sourcing', variant: 'info' },
  in_progress: { label: 'In Progress', variant: 'info' },
  partially_filled: { label: 'Partially Filled', variant: 'info' },
  filled: { label: 'Filled', variant: 'success' },
  closed: { label: 'Closed', variant: 'soft' },
  on_hold: { label: 'On Hold', variant: 'warning' },
  rejected: { label: 'Rejected', variant: 'critical' },
  cancelled: { label: 'Cancelled', variant: 'critical' },
  reopened: { label: 'Reopened', variant: 'info' },
};
const PRIORITY = {
  low: { label: 'Low', variant: 'soft' }, medium: { label: 'Medium', variant: 'info' },
  high: { label: 'High', variant: 'warning' }, critical: { label: 'Critical', variant: 'critical' },
};
function ReqStatus({ status }) { const s = REQ_STATUS[status] || { label: status, variant: 'soft' }; return <Badge variant={s.variant}>{s.label}</Badge>; }
function PriorityBadge({ p }) { const x = PRIORITY[p] || { label: p, variant: 'soft' }; return <Badge variant={x.variant}>{x.label}</Badge>; }
function SlaIndicator({ req }) {
  if (req.slaBreached) return <Badge variant="critical">SLA Breached</Badge>;
  if (!req.slaDueAt) return <span className="muted">—</span>;
  const due = new Date(req.slaDueAt), now = new Date();
  const hrs = (due - now) / 3.6e6;
  if (hrs < 0) return <Badge variant="critical">Overdue</Badge>;
  if (hrs < 24) return <Badge variant="warning">{Math.round(hrs)}h left</Badge>;
  return <Badge variant="success">{Math.round(hrs / 24)}d left</Badge>;
}

// Resolve admin-controlled buttons for current user from the server.
function useResolvedButtons() {
  const [map, setMap] = useState({});
  useEffect(() => { api.get('/settings/buttons/resolved').then((r) => { const m = {}; r.buttons.forEach((b) => { m[b.buttonKey] = b; }); setMap(m); }).catch(() => {}); }, []);
  return map;
}

// Compact ticket card for the kanban-style requests board — key info only.
function RequestTicketCard({ r, onOpen }) {
  return (
    <div className="card ticket-card" onClick={onOpen} style={{ cursor: 'pointer', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 4, background: 'var(--ticket-accent)' }} />
      <div className="card-pad" style={{ flex: 1 }}>
        <div className="row-between" style={{ marginBottom: 6 }}>
          <span style={{ fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 11.5, color: 'var(--ticket-accent)', fontWeight: 700 }}>{r.ticketNo}</span>
          <PriorityBadge p={r.priority} />
        </div>
        <div style={{ fontSize: 15.5, fontWeight: 600, marginBottom: 8, lineHeight: 1.3 }}>{r.title}</div>
        <div className="muted" style={{ fontSize: 12.5, display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 12 }}>
          <span><span style={{ display: 'inline-block', minWidth: 64, color: 'var(--muted)' }}>Dept</span>{r.department?.name || '—'}</span>
          <span><span style={{ display: 'inline-block', minWidth: 64, color: 'var(--muted)' }}>Location</span>{r.location || r.site?.name || '—'}</span>
          <span><span style={{ display: 'inline-block', minWidth: 64, color: 'var(--muted)' }}>Seats</span>{r.headcountFilled ?? 0} / {r.headcount}</span>
        </div>
        <div className="row-between" style={{ alignItems: 'center' }}>
          {r.displayStatus ? <Badge variant="info">{r.displayStatus}</Badge> : <ReqStatus status={r.status} />}
          <HealthBadge health={r.health} />
        </div>
      </div>
    </div>
  );
}

function RequestsPage({ user }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [view, setView] = useState('cards'); // cards | table — ticket cards by default
  const [filters, setFilters] = useState({ q: '', status: '', priority: '', sort: 'created', dir: 'desc' });
  const [selectedId, setSelectedId] = useState(null);
  const [creating, setCreating] = useState(false);
  const btns = useResolvedButtons();

  const load = useCallback(async () => {
    setData(null);
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => { if (v) params.set(k, v); });
    setData(await api.get('/requests?' + params.toString()));
  }, [filters]);
  useEffect(() => { load(); }, [load]);

  if (selectedId) return <RequestDetail id={selectedId} user={user} btns={btns} onBack={() => { setSelectedId(null); load(); }} />;

  const canCreate = btns.create_request?.visible;
  return (
    <div>
      <PageHead crumb="Recruitment / Requests" title="Recruitment Requests" sub="Every hiring need is a controlled ticket with approvals, ownership, SLA and audit."
        actions={<>
          <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
            <button className={'btn btn-sm ' + (view === 'table' ? '' : 'btn-secondary')} style={{ borderRadius: 0 }} onClick={() => setView('table')}>Table</button>
            <button className={'btn btn-sm ' + (view === 'cards' ? '' : 'btn-secondary')} style={{ borderRadius: 0 }} onClick={() => setView('cards')}>Cards</button>
          </div>
          {canCreate && <button className="btn" onClick={() => setCreating(true)}>+ {btns.create_request.label}</button>}
        </>} />

      <div className="toolbar">
        <input placeholder="Search title / ticket / discipline…" value={filters.q} onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} style={{ minWidth: 240 }} />
        <select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
          <option value="">All statuses</option>{Object.entries(REQ_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
        <select value={filters.priority} onChange={(e) => setFilters((f) => ({ ...f, priority: e.target.value }))}>
          <option value="">All priorities</option>{Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
        <select value={filters.sort} onChange={(e) => setFilters((f) => ({ ...f, sort: e.target.value }))}>
          <option value="created">Sort: Created</option><option value="priority">Priority</option><option value="title">Title</option><option value="status">Status</option><option value="ticket">Ticket No</option></select>
        <button className="btn btn-ghost btn-sm" onClick={() => setFilters((f) => ({ ...f, dir: f.dir === 'desc' ? 'asc' : 'desc' }))}>{filters.dir === 'desc' ? '↓ Desc' : '↑ Asc'}</button>
        <div className="spacer" />
        {data && <span className="muted">{data.requests.length} requests</span>}
      </div>

      {!data ? <Skeleton rows={6} /> : data.requests.length === 0 ? (
        <div className="card"><Empty icon="🎫" text="No recruitment requests yet." /></div>
      ) : view === 'table' ? (
        <div className="card"><table>
          <thead><tr><th>Ticket</th><th>Position</th><th>Department</th><th>Location</th><th>Priority</th><th>Seats</th><th>Status</th><th>Health</th></tr></thead>
          <tbody>{data.requests.map((r) => (
            <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => setSelectedId(r.id)}>
              <td><strong>{r.ticketNo}</strong></td><td>{r.title}</td>
              <td className="muted">{r.department?.name || '—'}</td>
              <td className="muted">{r.location || r.site?.name || '—'}</td>
              <td><PriorityBadge p={r.priority} /></td>
              <td>{r.headcountFilled}/{r.headcount}</td>
              <td>{r.displayStatus ? <Badge variant="info">{r.displayStatus}</Badge> : <ReqStatus status={r.status} />}</td>
              <td><HealthBadge health={r.health} /></td>
            </tr>
          ))}</tbody>
        </table></div>
      ) : (
        <div className="grid-kpi" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(290px,1fr))' }}>
          {data.requests.map((r) => <RequestTicketCard key={r.id} r={r} onOpen={() => setSelectedId(r.id)} />)}
        </div>
      )}
      {creating && <RequestForm user={user} onClose={() => setCreating(false)} onSaved={(id) => { setCreating(false); load(); setSelectedId(id); }} />}
    </div>
  );
}

function RequestForm({ user, onClose, onSaved }) {
  const toast = useToast();
  const [meta, setMeta] = useState(null);
  const [f, setF] = useState({ title: '', justification: '', projectId: '', siteId: '', departmentId: '', location: '', hiringManagerId: '', headcount: 1, priority: 'medium', targetJoinDate: '', keyResponsibilities: '', keyRequirements: '' });
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  useEffect(() => { api.get('/requests/meta/form').then(setMeta); }, []);
  const sites = meta ? meta.sites.filter((s) => !f.projectId || s.projectId === Number(f.projectId)) : [];

  async function save() {
    setBusy(true);
    try {
      const body = { ...f };
      ['siteId', 'hiringManagerId'].forEach((k) => { if (body[k] === '') body[k] = null; });
      const r = await api.post('/requests', body);
      // Optional attachment upload (real file) after the request exists.
      if (file) { try { await api.upload(`/requests/${r.request.id}/attachment`, file); } catch (e) { toast('Request created, but attachment failed: ' + e.message, 'error'); } }
      toast('Request created: ' + r.request.ticketNo);
      onSaved(r.request.id);
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }
  if (!meta) return <Modal title="New Recruitment Request" onClose={onClose}><Skeleton /></Modal>;
  return (
    <Modal title="New Recruitment Request" onClose={onClose} wide
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn" onClick={save} disabled={busy}>{busy ? 'Creating…' : 'Create Request'}</button></>}>
      <p className="muted" style={{ marginTop: 0 }}>Req ID and Req Date are generated automatically on creation.</p>
      <div className="form-grid">
        <div className="field full"><label>Position *</label><input value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Site Engineer" /></div>
        <div className="field"><label>Justification</label><select value={f.justification} onChange={(e) => set('justification', e.target.value)}><option value="">— Select —</option>{meta.justifications.map((j) => <option key={j.value} value={j.value}>{j.label}</option>)}</select></div>
        <div className="field"><label>Hiring Manager</label><select value={f.hiringManagerId} onChange={(e) => set('hiringManagerId', e.target.value)}><option value="">— None —</option>{meta.hiringManagers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
        <div className="field"><label>Department *</label><select value={f.departmentId} onChange={(e) => set('departmentId', e.target.value)}><option value="">— Select —</option>{meta.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></div>
        <div className="field"><label>Project *</label><select value={f.projectId} onChange={(e) => set('projectId', e.target.value)}><option value="">— Select —</option>{meta.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
        <div className="field"><label>Site</label><select value={f.siteId} onChange={(e) => set('siteId', e.target.value)}><option value="">— None —</option>{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
        <div className="field"><label>Location</label><input value={f.location} onChange={(e) => set('location', e.target.value)} placeholder="e.g. Aliva MV" /></div>
        <div className="field"><label>Headcount *</label><input type="number" min="1" value={f.headcount} onChange={(e) => set('headcount', e.target.value)} /></div>
        <div className="field"><label>Priority</label><select value={f.priority} onChange={(e) => set('priority', e.target.value)}>{Object.keys(PRIORITY).map((p) => <option key={p}>{p}</option>)}</select></div>
        <div className="field"><label>Target Join Date</label><input type="date" value={f.targetJoinDate} onChange={(e) => set('targetJoinDate', e.target.value)} /></div>
        <div className="field full"><label>Key Responsibilities</label><textarea rows="3" value={f.keyResponsibilities} onChange={(e) => set('keyResponsibilities', e.target.value)} placeholder="Main duties for this role…" /></div>
        <div className="field full"><label>Key Requirements</label><textarea rows="3" value={f.keyRequirements} onChange={(e) => set('keyRequirements', e.target.value)} placeholder="Required experience, qualifications, skills…" /></div>
        <div className="field full"><label>Attachment (Job Description / spec)</label>
          <input type="file" accept=".pdf,.doc,.docx,.png,.jpg,.jpeg" onChange={(e) => setFile(e.target.files?.[0] || null)} />
          {file && <div className="muted" style={{ marginTop: 4 }}>Selected: {file.name}</div>}
        </div>
      </div>
    </Modal>
  );
}

/* ----------------------------- Request Detail (tabs) ----------------------------- */
function RequestDetail({ id, user, btns, onBack }) {
  const toast = useToast();
  const [req, setReq] = useState(null);
  const [tab, setTab] = useState('thread');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [meta, setMeta] = useState(null);
  const [action, setAction] = useState(null); // {key,title,reason,danger,run}
  const [assignOpen, setAssignOpen] = useState(false);

  const load = useCallback(async () => { setReq((await api.get('/requests/' + id)).request); }, [id]);
  useEffect(() => { load(); api.get('/requests/meta/form').then(setMeta).catch(() => {}); }, [id]);

  async function doAction(path, body, okMsg) {
    try { const r = await api.post(`/requests/${id}/${path}`, body || {}); setReq(r.request); toast(okMsg); }
    catch (e) { toast(e.message, 'error'); }
  }
  function reasonAction(path, title, okMsg, danger) {
    setAction({ title, danger, run: (reason) => { setAction(null); doAction(path, { reason }, okMsg); } });
  }

  if (!req) return <Skeleton rows={8} />;
  const b = (key) => btns[key] || {};
  const show = (key) => b(key).visible;
  // contextual enablement by status
  const s = req.status;
  const canSubmit = show('submit_request') && ['draft', 'reopened'].includes(s);
  const canApprove = show('approve_request') && s === 'pending_approval';
  const canReject = show('reject_request') && s === 'pending_approval';
  const canAssign = show('assign_recruiter') && ['approved', 'in_sourcing', 'in_progress', 'reopened', 'partially_filled'].includes(s);
  const canHold = show('hold_request') && ['approved', 'in_sourcing', 'in_progress', 'partially_filled', 'pending_approval'].includes(s);
  const canResume = show('resume_request') && s === 'on_hold';
  const canCancel = show('cancel_request') && !['closed', 'cancelled', 'rejected', 'filled'].includes(s);
  const canClose = show('close_request') && !['closed', 'cancelled', 'rejected'].includes(s);
  const canReopen = show('reopen_request') && ['closed', 'cancelled', 'filled'].includes(s);

  // Conversation-first ticket: the thread is the main view (like an email thread);
  // request details collapse at the top; everything else stays a tab away.
  const TABS = [
    ['thread', 'Conversation'], ['pipeline', 'Candidates'], ['jd', 'Responsibilities & Requirements'],
    ['approvals', 'Approval'], ['timeline', 'Activity'],
  ];

  return (
    <div>
      <div className="breadcrumb"><a href="#" onClick={(e) => { e.preventDefault(); onBack(); }}>← Recruitment Requests</a></div>

      <TicketHeader req={req}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: 560 }}>
          {canSubmit && <button className="btn" onClick={() => doAction('submit', {}, 'Submitted for approval')}>{b('submit_request').label}</button>}
          {canApprove && <button className="btn" onClick={() => doAction('approve', {}, 'Approved')}>{b('approve_request').label}</button>}
          {canReject && <button className="btn btn-danger" onClick={() => reasonAction('reject', 'Reject Request', 'Request rejected', true)}>{b('reject_request').label}</button>}
          {canAssign && <button className="btn btn-secondary" onClick={() => setAssignOpen(true)}>{b('assign_recruiter').label}</button>}
          {canHold && <button className="btn btn-secondary" onClick={() => reasonAction('hold', 'Put Request On Hold', 'Request on hold')}>{b('hold_request').label}</button>}
          {canResume && <button className="btn btn-secondary" onClick={() => doAction('resume', {}, 'Resumed')}>{b('resume_request').label}</button>}
          {canClose && <button className="btn btn-secondary" onClick={() => reasonAction('close', 'Close Request', 'Request closed')}>{b('close_request').label}</button>}
          {canCancel && <button className="btn btn-danger" onClick={() => reasonAction('cancel', 'Cancel Request', 'Request cancelled', true)}>{b('cancel_request').label}</button>}
          {canReopen && <button className="btn btn-secondary" onClick={() => reasonAction('reopen', 'Reopen Request', 'Request reopened')}>{b('reopen_request').label}</button>}
        </div>
      </TicketHeader>

      {/* Collapsible request "subject" details, pinned above the conversation */}
      <div className="card" style={{ marginBottom: 14 }}>
        <button className="row-between" onClick={() => setDetailsOpen((o) => !o)}
          style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: '12px 16px', textAlign: 'left' }}>
          <strong style={{ fontSize: 13.5 }}>Request details</strong>
          <span className="muted" style={{ fontSize: 12 }}>{detailsOpen ? '▲ Hide' : '▼ Show'} · {req.department?.name || '—'} · {req.location || req.site?.name || '—'} · {req.headcountFilled ?? 0}/{req.headcount} seats</span>
        </button>
        {detailsOpen && <div style={{ padding: '0 16px 16px' }}><OverviewTab req={req} onReload={load} btns={btns} embedded /></div>}
      </div>

      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', marginBottom: 18 }}>
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className="btn btn-ghost" style={{ border: 'none', borderBottom: tab === k ? '2px solid var(--ticket-accent)' : '2px solid transparent', borderRadius: 0, color: tab === k ? 'var(--ticket-accent)' : 'var(--text-gray)', fontWeight: tab === k ? 700 : 500 }}>{label}</button>
        ))}
      </div>

      {tab === 'thread' && <TicketThread req={req} user={user} />}
      {tab === 'pipeline' && <RequestPipeline request={req} user={user} btns={btns} />}
      {tab === 'jd' && <JDTab req={req} />}
      {tab === 'approvals' && <ApprovalsTab req={req} />}
      {tab === 'timeline' && <TimelineTab req={req} />}

      {action && <Confirm title={action.title} message="Please provide a reason. This will be recorded in the audit trail." requireReason danger={action.danger} confirmLabel="Confirm" onConfirm={action.run} onClose={() => setAction(null)} />}
      {assignOpen && meta && <AssignModal recruiters={meta.recruiters} onClose={() => setAssignOpen(false)} onAssign={(ownerId) => { setAssignOpen(false); doAction('assign', { ownerId }, 'Recruiter assigned'); }} />}
    </div>
  );
}

/* ----------------------------- Ticket thread (email-style conversation) ----------------------------- */
function TicketThread({ req, user }) {
  const toast = useToast();
  const [posts, setPosts] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [replyTo, setReplyTo] = useState(null);
  const [composer, setComposer] = useState('message'); // message | cv
  const fileRef = React.useRef(null);

  const load = useCallback(async () => {
    try { setPosts((await api.get('/thread/request/' + req.id)).posts); }
    catch (e) { toast(e.message, 'error'); setPosts([]); }
  }, [req.id]);
  useEffect(() => { load(); }, [load]);

  const canPost = user.permissions.includes('request.create') || user.permissions.includes('interview.feedback') ||
    user.permissions.includes('request.assign_recruiter') || (req.hiringManager && req.hiringManager.id === user.id);
  const canCv = user.permissions.includes('candidate.add') || user.permissions.includes('candidate.link');
  const canFeedback = user.permissions.includes('interview.feedback');
  // Candidates already linked to this request (for the inline feedback composer).
  const [apps, setApps] = useState([]);
  useEffect(() => { if (canFeedback) api.get('/applications/request/' + req.id).then((r) => setApps(r.applications || [])).catch(() => {}); }, [req.id, canFeedback]);

  async function sendMessage(parentPostId) {
    const body = parentPostId ? replyTo.text : text;
    if (!body || !body.trim()) return;
    setBusy(true);
    try {
      await api.post('/thread/request/' + req.id, { body, parentPostId: parentPostId || null });
      parentPostId ? setReplyTo(null) : setText('');
      load();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }
  async function attachFile(file, parentPostId) {
    if (!file) return;
    setBusy(true);
    try { await api.uploadTo('/thread/request/' + req.id + '/file', file, { body: text, parentPostId: parentPostId || '' }); setText(''); load(); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }
  async function viewPostFile(postId) { try { await api.download('/thread/post/' + postId + '/file'); } catch (e) { toast(e.message, 'error'); } }

  if (!posts) return <Skeleton rows={5} />;

  return (
    <div style={{ maxWidth: 860 }}>
      {posts.length === 0
        ? <div className="card"><Empty icon="💬" text="No messages yet. Start the conversation, attach files, or post a CV below." /></div>
        : <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {posts.map((p) => (
              <ThreadPost key={p.id} post={p} user={user} onView={viewPostFile}
                replyOpen={replyTo?.id === p.id}
                onReply={() => setReplyTo({ id: p.id, text: '' })}
                replyText={replyTo?.id === p.id ? replyTo.text : ''}
                onReplyText={(v) => setReplyTo({ id: p.id, text: v })}
                onSendReply={() => sendMessage(p.id)}
                onCancelReply={() => setReplyTo(null)}
                busy={busy} canPost={canPost} />
            ))}
          </div>}

      {canPost ? (
        <div className="card card-pad" style={{ marginTop: 16, position: 'sticky', bottom: 0, boxShadow: '0 -2px 10px rgba(20,24,28,.04)' }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            <button className={'tag-toggle' + (composer === 'message' ? ' on' : '')} onClick={() => setComposer('message')}>Message</button>
            {canCv && <button className={'tag-toggle' + (composer === 'cv' ? ' on' : '')} onClick={() => setComposer('cv')}>Post a CV</button>}
            {canFeedback && <button className={'tag-toggle' + (composer === 'feedback' ? ' on' : '')} onClick={() => setComposer('feedback')}>Feedback</button>}
          </div>
          {composer === 'message' ? (
            <>
              <textarea rows="3" value={text} onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && text.trim()) sendMessage(); }}
                placeholder="Write a message to the team… (⌘/Ctrl+Enter to send)" style={{ width: '100%' }} />
              <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
                <button className="btn" onClick={() => sendMessage()} disabled={busy || !text.trim()}>{busy ? 'Sending…' : 'Send'}</button>
                <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={(e) => { attachFile(e.target.files?.[0]); e.target.value = ''; }}
                  accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,.txt" />
                <button className="btn btn-secondary" onClick={() => fileRef.current?.click()} disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><FileGlyph /> Attach file</button>
                <span className="muted" style={{ fontSize: 12 }}>Files post into the thread with view/download.</span>
              </div>
            </>
          ) : composer === 'cv' ? (
            <CvComposer req={req} onPosted={() => { setComposer('message'); load(); }} />
          ) : (
            <FeedbackComposer req={req} apps={apps} onPosted={() => { setComposer('message'); load(); }} />
          )}
        </div>
      ) : (
        <div className="card card-pad" style={{ marginTop: 16, textAlign: 'center' }}>
          <span className="muted" style={{ fontSize: 12.5 }}>You can follow this ticket but don't have permission to post.</span>
        </div>
      )}
    </div>
  );
}

// Inline structured feedback — interviewer picks a candidate, recommendation, rating + notes.
function FeedbackComposer({ req, apps, onPosted }) {
  const toast = useToast();
  const [applicationId, setApplicationId] = useState('');
  const [recommendation, setRecommendation] = useState('proceed');
  const [rating, setRating] = useState(4);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!body.trim()) { toast('Add a short feedback note.', 'error'); return; }
    setBusy(true);
    const chosen = apps.find((a) => String(a.id) === String(applicationId));
    try {
      await api.post('/thread/request/' + req.id + '/feedback', {
        applicationId: applicationId || null, candidateId: chosen?.candidate?.id || null, recommendation, rating, body,
      });
      toast('Feedback posted'); onPosted();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }
  return (
    <div>
      <div className="form-grid">
        <div className="field"><label>Candidate</label>
          <select value={applicationId} onChange={(e) => setApplicationId(e.target.value)}>
            <option value="">— General / unlinked —</option>
            {apps.map((a) => <option key={a.id} value={a.id}>{a.candidate?.fullName} ({APP_STATUS[a.status]?.label || a.status})</option>)}
          </select></div>
        <div className="field"><label>Recommendation</label>
          <select value={recommendation} onChange={(e) => setRecommendation(e.target.value)}>
            <option value="proceed">Proceed</option><option value="proceed_conditions">Proceed with conditions</option>
            <option value="hold">Hold</option><option value="cv_pool">CV pool</option><option value="reject">Reject</option>
          </select></div>
      </div>
      <div className="field"><label>Rating</label>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} onClick={() => setRating(n)} aria-label={`Rate ${n} of 5`} style={{ background: 'none', border: 'none', padding: 2, cursor: 'pointer', color: '#b7791f' }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill={n <= rating ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.6"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" /></svg>
            </button>
          ))}
          <span className="muted" style={{ fontSize: 12, marginLeft: 4 }}>{rating}/5</span>
        </div>
      </div>
      <div className="field"><label>Notes</label>
        <textarea rows="3" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Evidence, strengths, concerns…" /></div>
      <button className="btn" onClick={submit} disabled={busy}>{busy ? 'Posting…' : 'Post feedback'}</button>
    </div>
  );
}

// Minimal, corporate post styling — no emoji. A small left rail color + optional label chip.
function postMeta(p) {
  const map = {
    message: { rail: 'var(--ticket-accent)', tint: 'transparent', label: null },
    file: { rail: '#6b7480', tint: 'var(--surface-2, #fbfcfd)', label: 'Attachment' },
    cv: { rail: 'var(--ticket-accent)', tint: 'var(--ticket-chip-bg)', label: 'CV' },
    feedback: { rail: '#b7791f', tint: '#fbf5e8', label: 'Feedback' },
    system: { rail: 'var(--border)', tint: 'var(--surface-2, #fbfcfd)', label: 'Update' },
  };
  return map[p.type] || map.message;
}

function ThreadPost({ post, user, onView, replyOpen, onReply, replyText, onReplyText, onSendReply, onCancelReply, busy, canPost }) {
  const m = postMeta(post);
  const isSystem = post.type === 'system';
  return (
    <div className="card" style={{ background: m.tint, borderLeft: `3px solid ${m.rail}` }}>
      <div style={{ padding: '11px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: post.body || m.label ? 6 : 0 }}>
          {!isSystem
            ? <span className="avatar" style={{ width: 26, height: 26, fontSize: 11 }}>{initials(post.author?.name)}</span>
            : <span style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--surface-2,#f1f3f5)', border: '1px solid var(--border)', display: 'grid', placeItems: 'center', fontSize: 11, color: 'var(--muted)', flex: '0 0 auto' }}>•</span>}
          <strong style={{ fontSize: 13 }}>{post.author?.name || 'System'}</strong>
          {post.author?.role && <span className="muted" style={{ fontSize: 11 }}>{ROLE_NAMES[post.author.role] || post.author.role}</span>}
          {m.label && <span className="chip" style={{ fontSize: 10.5 }}>{m.label}</span>}
          <span className="muted" style={{ fontSize: 11, marginLeft: 'auto' }} title={fmtDate(post.createdAt)}>{timeAgo(post.createdAt)}{post.edited ? ' · edited' : ''}</span>
        </div>
        {post.type === 'cv' && post.payload && (
          <div style={{ fontSize: 13, marginBottom: 4 }}><strong>{post.payload.candidateName}</strong>{post.payload.currentPosition ? ` — ${post.payload.currentPosition}` : ''}{post.payload.employer ? ` @ ${post.payload.employer}` : ''}</div>
        )}
        {post.type === 'feedback' && post.payload && (
          <div style={{ fontSize: 12.5, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
            {post.payload.recommendation && <Badge variant={post.payload.recommendation === 'proceed' ? 'success' : post.payload.recommendation === 'reject' ? 'critical' : 'warning'}>{post.payload.recommendation.replace(/_/g, ' ')}</Badge>}
            {post.payload.rating != null && <Stars value={post.payload.rating} />}
          </div>
        )}
        {post.body && <div style={{ fontSize: 13.5, whiteSpace: 'pre-wrap', lineHeight: 1.55, color: isSystem ? 'var(--text-gray)' : 'var(--text-dark)' }}>{post.body}</div>}
        {post.hasFile && (
          <div style={{ marginTop: 8 }}>
            <button className="btn btn-sm btn-secondary" onClick={() => onView(post.id)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><FileGlyph /> {post.fileName || 'Download file'}</button>
          </div>
        )}
        {!isSystem && canPost && (
          <div style={{ marginTop: 8 }}>
            {!replyOpen
              ? <button className="btn btn-ghost btn-sm" onClick={onReply}>Reply</button>
              : (
                <div style={{ marginTop: 6 }}>
                  <textarea rows="2" value={replyText} autoFocus onChange={(e) => onReplyText(e.target.value)}
                    onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && replyText.trim()) onSendReply(); }}
                    placeholder="Write a reply… (⌘/Ctrl+Enter to send)" style={{ width: '100%' }} />
                  <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                    <button className="btn btn-sm" onClick={onSendReply} disabled={busy || !replyText.trim()}>Reply</button>
                    <button className="btn btn-ghost btn-sm" onClick={onCancelReply}>Cancel</button>
                  </div>
                </div>
              )}
          </div>
        )}
        {(post.replies || []).length > 0 && (
          <div style={{ marginTop: 10, marginLeft: 18, paddingLeft: 12, borderLeft: '2px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {post.replies.map((r) => (
              <div key={r.id}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="avatar" style={{ width: 22, height: 22, fontSize: 10 }}>{initials(r.author?.name)}</span>
                  <strong style={{ fontSize: 12.5 }}>{r.author?.name}</strong>
                  <span className="muted" style={{ fontSize: 11, marginLeft: 'auto' }} title={fmtDate(r.createdAt)}>{timeAgo(r.createdAt)}</span>
                </div>
                {r.body && <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', marginTop: 2, marginLeft: 30 }}>{r.body}</div>}
                {r.hasFile && <div style={{ marginLeft: 30, marginTop: 4 }}><button className="btn btn-sm btn-secondary" onClick={() => onView(r.id)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><FileGlyph /> {r.fileName}</button></div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Tiny inline glyphs (SVG, no emoji) to fit the minimal corporate style.
function FileGlyph() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ display: 'block' }}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><path d="M14 2v6h6" /></svg>;
}
function Stars({ value = 0 }) {
  return (
    <span style={{ display: 'inline-flex', gap: 1, color: '#b7791f' }} title={`${value}/5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <svg key={n} width="13" height="13" viewBox="0 0 24 24" fill={n <= value ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.6"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" /></svg>
      ))}
    </span>
  );
}

function CvComposer({ req, onPosted }) {
  const toast = useToast();
  const [f, setF] = useState({ fullName: '', currentPosition: '', employer: '', yearsExperience: '', matchScore: '' });
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!f.fullName.trim() || !file) { toast('Candidate name and CV file are required.', 'error'); return; }
    setBusy(true);
    try { await api.uploadTo('/thread/request/' + req.id + '/cv', file, f); toast('CV posted to thread'); onPosted(); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }
  return (
    <div>
      <div className="form-grid">
        <div className="field"><label>Candidate Name *</label><input value={f.fullName} onChange={(e) => setF((s) => ({ ...s, fullName: e.target.value }))} /></div>
        <div className="field"><label>Current Position</label><input value={f.currentPosition} onChange={(e) => setF((s) => ({ ...s, currentPosition: e.target.value }))} /></div>
        <div className="field"><label>Employer</label><input value={f.employer} onChange={(e) => setF((s) => ({ ...s, employer: e.target.value }))} /></div>
        <div className="field"><label>Experience (years)</label><input type="number" value={f.yearsExperience} onChange={(e) => setF((s) => ({ ...s, yearsExperience: e.target.value }))} /></div>
        <div className="field"><label>Match Score (0–100)</label><input type="number" min="0" max="100" value={f.matchScore} onChange={(e) => setF((s) => ({ ...s, matchScore: e.target.value }))} /></div>
        <div className="field"><label>CV File *</label>
          <input type="file" onChange={(e) => setFile(e.target.files?.[0])} accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,.txt" />
          {file && <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>Selected: {file.name}</div>}
        </div>
      </div>
      <button className="btn" onClick={submit} disabled={busy}>{busy ? 'Posting…' : 'Post CV to thread'}</button>
      <span className="muted" style={{ fontSize: 12, marginLeft: 10 }}>Creates the candidate, attaches the CV, and links them to this request.</span>
    </div>
  );
}

function Info({ label, children }) { return <div style={{ marginBottom: 14 }}><div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.4px' }}>{label}</div><div style={{ fontWeight: 500 }}>{children ?? '—'}</div></div>; }

// Arabtec ticket-styled field "chip": a soft pink-tinted label/value cell (per mockup).
function FieldChip({ label, children, full }) {
  return (
    <div style={{ gridColumn: full ? '1 / -1' : 'auto', background: 'var(--ticket-chip-bg, #fbeef0)', border: '1px solid var(--ticket-chip-border, #f3d6db)', borderRadius: 8, padding: '9px 12px' }}>
      <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--ticket-accent, #b0202e)', fontWeight: 700 }}>{label}</div>
      <div style={{ fontWeight: 500, marginTop: 3, color: 'var(--text-dark)', whiteSpace: full ? 'pre-wrap' : 'normal', lineHeight: 1.5 }}>{children ?? '—'}</div>
    </div>
  );
}

// Red-accent ticket header band with logo monogram, ID/date, and action slot (per mockup).
function TicketHeader({ req, children }) {
  const lc = req.lifecycle || {};
  return (
    <div className="ticket-header" style={{ background: 'linear-gradient(135deg, var(--ticket-accent, #b0202e), var(--ticket-accent-dark, #7d141e))', color: '#fff', borderRadius: 'var(--card-radius, 12px)', padding: '18px 22px', marginBottom: 16, boxShadow: '0 6px 20px rgba(176,32,46,.18)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ width: 46, height: 46, borderRadius: 10, background: 'rgba(255,255,255,.16)', display: 'grid', placeItems: 'center', flex: '0 0 auto' }}><Logo size={26} color="#fff" /></div>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ fontSize: 11, opacity: .85, textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 600 }}>Recruitment Request Ticket</div>
          <h1 style={{ margin: '2px 0 6px', fontSize: 22, fontWeight: 700, color: '#fff' }}>{req.title}</h1>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 12.5 }}>
            <span style={{ background: 'rgba(255,255,255,.2)', padding: '3px 10px', borderRadius: 20, fontWeight: 700, letterSpacing: '.3px' }}>{req.ticketNo}</span>
            <span style={{ opacity: .9 }}>Req Date {fmtDateShort(lc.createdAt || req.createdAt)}</span>
            <span style={{ opacity: .6 }}>·</span>
            <span style={{ background: 'rgba(255,255,255,.92)', color: 'var(--ticket-accent-dark, #7d141e)', padding: '3px 10px', borderRadius: 20, fontWeight: 700, textTransform: 'capitalize' }}>{req.displayStatus || req.status?.replace(/_/g, ' ')}</span>
            {req.priority && <span style={{ background: 'rgba(0,0,0,.18)', padding: '3px 10px', borderRadius: 20, fontWeight: 600, textTransform: 'capitalize' }}>{req.priority} priority</span>}
            {req.health && <span style={{ background: 'rgba(255,255,255,.16)', padding: '3px 10px', borderRadius: 20, fontWeight: 600 }}>{req.health.label}</span>}
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

function AttachmentRow({ req, onReload }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function onPick(e) {
    const file = e.target.files?.[0]; if (!file) return;
    setBusy(true);
    try { await api.upload(`/requests/${req.id}/attachment`, file); toast('Attachment uploaded'); onReload && onReload(); }
    catch (err) { toast(err.message, 'error'); } finally { setBusy(false); e.target.value = ''; }
  }
  async function view() { try { await api.download(`/requests/${req.id}/attachment`); } catch (e) { toast(e.message, 'error'); } }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      {req.hasAttachment ? (
        <>
          <span className="chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><FileGlyph /> {req.attachmentName || 'Attachment'}</span>
          <button className="btn btn-sm btn-secondary" onClick={view}>View / Download</button>
        </>
      ) : <span className="muted" style={{ fontSize: 13 }}>No attachment uploaded.</span>}
      <label className="btn btn-sm btn-ghost" style={{ cursor: 'pointer' }}>
        {busy ? 'Uploading…' : (req.hasAttachment ? 'Replace' : '+ Upload attachment')}
        <input type="file" style={{ display: 'none' }} onChange={onPick} disabled={busy} accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,.txt" />
      </label>
    </div>
  );
}

// Health indicator (green/amber/red) from the backend-computed request health.
function HealthBadge({ health }) {
  if (!health) return null;
  const map = { green: 'var(--success)', amber: 'var(--warning)', red: 'var(--critical)' };
  const c = map[health.level] || map.green;
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: c, fontWeight: 600, fontSize: 12.5 }}>
    <span style={{ width: 8, height: 8, borderRadius: '50%', background: c, flex: '0 0 auto' }} />{health.label}</span>;
}

// Lifecycle milestone strip + computed durations (always visible on the workspace).
function LifecycleStrip({ req }) {
  const lc = req.lifecycle || {};
  const items = [
    ['Created', lc.createdAt], ['Approved', lc.approvedAt], ['Posted', lc.postingDate],
    ['1st Candidate', lc.firstCandidateAt], ['1st Shortlist', lc.firstShortlistAt],
    ['1st Interview', lc.firstInterviewAt], ['1st Offer', lc.firstOfferAt], ['Closed', lc.closingDate],
  ];
  const dToTarget = lc.daysToTargetJoin;
  return (
    <div className="card card-pad" style={{ marginBottom: 14, padding: '12px 16px' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'center' }}>
        {items.map(([label, val]) => (
          <div key={label} style={{ minWidth: 90 }}>
            <div className="muted" style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.4px' }}>{label}</div>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: val ? 'var(--text-dark)' : 'var(--text-gray)' }}>{val ? fmtDateShort(val) : '—'}</div>
          </div>
        ))}
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 16 }}>
          <div style={{ textAlign: 'right' }}><div className="muted" style={{ fontSize: 10.5 }}>DAYS OPEN</div><div style={{ fontWeight: 700, fontSize: 16, color: 'var(--primary)' }}>{lc.daysOpen ?? '—'}</div></div>
          <div style={{ textAlign: 'right' }}><div className="muted" style={{ fontSize: 10.5 }}>SINCE APPROVAL</div><div style={{ fontWeight: 700, fontSize: 16, color: 'var(--primary)' }}>{lc.daysSinceApproval ?? '—'}</div></div>
          <div style={{ textAlign: 'right' }}><div className="muted" style={{ fontSize: 10.5 }}>TO TARGET JOIN</div><div style={{ fontWeight: 700, fontSize: 16, color: dToTarget != null && dToTarget < 0 ? 'var(--critical)' : 'var(--primary)' }}>{dToTarget == null ? '—' : (dToTarget < 0 ? `${dToTarget}d` : `${dToTarget}d`)}</div></div>
        </div>
      </div>
    </div>
  );
}

function OverviewTab({ req, onReload, btns, embedded }) {
  const inner = (
      <div className={embedded ? '' : 'card card-pad'}>
        {!embedded && <div className="section-title" style={{ marginTop: 0 }}>Ticket Details</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
          <FieldChip label="Req ID">{req.ticketNo}</FieldChip>
          <FieldChip label="Req Date">{fmtDateShort(req.lifecycle?.createdAt || req.createdAt)}</FieldChip>
          <FieldChip label="Justification"><span style={{ textTransform: 'capitalize' }}>{(req.justification || '—').replace(/_/g, ' ')}</span></FieldChip>
          <FieldChip label="Position">{req.title}</FieldChip>
          <FieldChip label="Department">{req.department?.name}</FieldChip>
          <FieldChip label="Project">{req.project?.name}</FieldChip>
          <FieldChip label="Location">{req.location || req.site?.name}</FieldChip>
          <FieldChip label="Hiring Manager">{req.hiringManager?.name || '—'}</FieldChip>
          <FieldChip label="Headcount">{req.headcountFilled ?? 0} / {req.headcount}</FieldChip>
          <FieldChip label="Priority"><span style={{ textTransform: 'capitalize' }}>{req.priority || '—'}</span></FieldChip>
          <FieldChip label="Target Join Date">{fmtDateShort(req.targetJoinDate)}</FieldChip>
          <FieldChip label="Recruiter (Owner)">{req.owner?.name || 'Unassigned'}</FieldChip>
        </div>
        <div className="section-title">Attachment</div>
        <AttachmentRow req={req} onReload={onReload} />
        {embedded && req.requester && <div style={{ marginTop: 12 }}><Info label="Requested by">{req.requester.name}</Info></div>}
      </div>
  );
  if (embedded) return inner;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
      {inner}
      <div className="card card-pad">
        <div className="section-title" style={{ marginTop: 0 }}>Seats ({req.headcountFilled ?? 0}/{req.headcount})</div>
        {(req.seats || []).map((seat) => (
          <div key={seat.id} className="row-between" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
            <span>Seat #{seat.seat_no}</span>
            <Badge variant={seat.status === 'filled' ? 'success' : seat.status === 'cancelled' ? 'critical' : 'soft'}>{seat.status}</Badge>
          </div>
        ))}
        {req.requester && <div style={{ marginTop: 12 }}><Info label="Requested by">{req.requester.name}</Info></div>}
      </div>
    </div>
  );
}
function JDTab({ req }) {
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="card card-pad">
        <div className="section-title" style={{ marginTop: 0 }}>Key Responsibilities</div>
        <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{req.keyResponsibilities || <span className="muted">No responsibilities provided.</span>}</div>
      </div>
      <div className="card card-pad">
        <div className="section-title" style={{ marginTop: 0 }}>Key Requirements</div>
        <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{req.keyRequirements || <span className="muted">No requirements provided.</span>}</div>
        {(req.requiredSkills || []).length > 0 && (
          <>
            <div className="section-title">Skills</div>
            <div>{req.requiredSkills.map((s, i) => <span key={i} className="chip">{s}</span>)}</div>
          </>
        )}
      </div>
    </div>
  );
}
function ApprovalsTab({ req }) {
  const appr = req.approvals || [];
  if (!appr.length) return <div className="card"><Empty icon="🛡" text="No approval yet — submit the request for HR Director approval." /></div>;
  return (
    <div className="card"><table>
      <thead><tr><th>Step</th><th>Approver Role</th><th>Decision</th><th>Approver</th><th>Comment</th><th>Decided</th></tr></thead>
      <tbody>{appr.map((a) => (
        <tr key={a.id}><td>{a.level}</td><td>{a.name}</td>
          <td><Badge variant={a.decision === 'approved' ? 'success' : a.decision === 'rejected' ? 'critical' : 'warning'}>{a.decision}</Badge></td>
          <td className="muted">{a.approver_id ? '#' + a.approver_id : '—'}</td><td className="muted">{a.comment || '—'}</td><td className="muted">{fmtDate(a.decided_at)}</td></tr>
      ))}</tbody>
    </table></div>
  );
}
function TimelineTab({ req }) {
  const acts = (req.activity || []).filter((a) => a.type !== 'hold_meta');
  if (!acts.length) return <div className="card"><Empty icon="📜" text="No activity yet." /></div>;
  return (
    <div className="card card-pad">
      {acts.map((a) => (
        <div key={a.id} style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--secondary)', marginTop: 6, flex: '0 0 auto' }} />
          <div style={{ flex: 1 }}>
            <div><strong style={{ textTransform: 'capitalize' }}>{a.type.replace(/_/g, ' ')}</strong>{a.note ? ' — ' + a.note : ''}</div>
            <div className="muted" style={{ fontSize: 12 }}>{a.actor_name || 'System'} · {fmtDate(a.occurred_at)}{a.from_status ? ` · ${a.from_status} → ${a.to_status}` : ''}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
/* ============================ PHASE 3: Application statuses + pipeline ============================ */
const APP_STATUS = {
  // New workspace stage list
  new: { label: 'New', variant: 'soft' },
  screened: { label: 'Screened', variant: 'info' },
  shortlisted: { label: 'Shortlisted', variant: 'info' },
  interview_1: { label: 'Interview 1', variant: 'info' },
  interview_2: { label: 'Interview 2', variant: 'info' },
  final_interview: { label: 'Final Interview', variant: 'info' },
  offer_preparation: { label: 'Offer Preparation', variant: 'warning' },
  offer_sent: { label: 'Offer Sent', variant: 'warning' },
  offer_accepted: { label: 'Offer Accepted', variant: 'success' },
  joined: { label: 'Hired', variant: 'success' },
  rejected: { label: 'Rejected', variant: 'critical' },
  withdrawn: { label: 'Withdrawn', variant: 'critical' },
  on_hold: { label: 'On Hold', variant: 'warning' },
  offer_rejected: { label: 'Offer Rejected', variant: 'critical' },
  // legacy labels so older data still renders cleanly
  applied: { label: 'New', variant: 'soft' },
  cv_screening: { label: 'Screened', variant: 'info' },
  phone_interview: { label: 'Interview 1', variant: 'info' },
  technical_interview: { label: 'Interview 1', variant: 'info' },
  client_interview: { label: 'Interview 2', variant: 'info' },
  reference_check: { label: 'Final Interview', variant: 'warning' },
};
// Ordered stage columns for the workspace (new list only — legacy keys excluded from columns).
const APP_ORDER = ['new', 'screened', 'shortlisted', 'interview_1', 'interview_2', 'final_interview',
  'offer_preparation', 'offer_sent', 'offer_accepted', 'joined', 'rejected', 'withdrawn', 'on_hold'];
const REASON_STATUSES = ['rejected', 'on_hold', 'withdrawn', 'offer_rejected'];
const TERMINAL_APP = ['joined', 'rejected', 'withdrawn'];
function AppStatusBadge({ status }) { const s = APP_STATUS[status] || { label: status, variant: 'soft' }; return <Badge variant={s.variant}>{s.label}</Badge>; }
function MatchScore({ score }) {
  if (score == null) return <span className="muted">—</span>;
  const color = score >= 80 ? 'var(--success)' : score >= 50 ? 'var(--warning)' : 'var(--critical)';
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
    <span style={{ width: 36, height: 6, background: '#eef1f4', borderRadius: 3, overflow: 'hidden', display: 'inline-block' }}>
      <span style={{ display: 'block', height: '100%', width: score + '%', background: color }} /></span>
    <span style={{ fontWeight: 600, fontSize: 12 }}>{score}</span></span>;
}

function RequestPipeline({ request, user, btns }) {
  const toast = useToast();
  const [apps, setApps] = useState(null);
  const [view, setView] = useState('kanban'); // kanban | list | compact
  const [selected, setSelected] = useState(new Set());
  const [quickView, setQuickView] = useState(null);
  const [moveModal, setMoveModal] = useState(null); // {appIds, toStatus?}
  const [linkOpen, setLinkOpen] = useState(false);
  const [scheduleApp, setScheduleApp] = useState(null); // application to schedule an interview for
  const [offerApp, setOfferApp] = useState(null); // application to generate an offer for
  const [pf, setPf] = useState({ q: '', stage: '', recruiter: '', sort: 'last' }); // candidate search/filter/sort
  const [noteApp, setNoteApp] = useState(null); // application to set next-action on

  const load = useCallback(async () => { setApps((await api.get('/applications/request/' + request.id)).applications); }, [request.id]);
  useEffect(() => { load(); }, [load]);

  // Apply candidate search/filter/sort to the loaded applications.
  const visibleApps = useMemo(() => {
    let list = apps || [];
    const q = pf.q.trim().toLowerCase();
    if (q) list = list.filter((a) => (a.candidate?.fullName || '').toLowerCase().includes(q) || (a.candidate?.employer || a.candidate?.currentCompany || '').toLowerCase().includes(q));
    if (pf.stage) list = list.filter((a) => a.status === pf.stage);
    if (pf.recruiter) list = list.filter((a) => String(a.recruiter?.id) === pf.recruiter);
    list = [...list].sort((x, y) => {
      if (pf.sort === 'name') return (x.candidate?.fullName || '').localeCompare(y.candidate?.fullName || '');
      if (pf.sort === 'match') return (y.matchScore ?? -1) - (x.matchScore ?? -1);
      return String(y.lastActivityAt || '').localeCompare(String(x.lastActivityAt || '')); // last updated
    });
    return list;
  }, [apps, pf]);
  const recruiterOptions = useMemo(() => {
    const m = new Map(); (apps || []).forEach((a) => { if (a.recruiter) m.set(a.recruiter.id, a.recruiter.name); });
    return [...m.entries()];
  }, [apps]);

  const canMove = btns.move_stage?.visible;
  const canLink = btns.link_candidate?.visible;
  const canBulk = user.permissions.includes('application.bulk_action');

  async function move(appId, status, reason) {
    try { await api.post(`/applications/${appId}/move`, { status, reason }); toast('Stage updated'); load(); }
    catch (e) { toast(e.message, 'error'); }
  }
  function requestMove(appId, status) {
    if (REASON_STATUSES.includes(status)) setMoveModal({ appIds: [appId], toStatus: status, reason: true });
    else move(appId, status);
  }
  async function bulkMove(status, reason) {
    try {
      const r = await api.post('/applications/bulk', { ids: [...selected], action: 'move', status, reason });
      const skipped = (r.skipped || []).length;
      toast(`${r.affected} updated${skipped ? `, ${skipped} skipped` : ''}`, skipped ? 'error' : 'success');
      setSelected(new Set()); load();
    } catch (e) { toast(e.message, 'error'); }
  }
  function toggleSel(id) { setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); }

  if (!apps) return <Skeleton rows={6} />;

  const cols = APP_ORDER;
  return (
    <div>
      <div className="toolbar">
        <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
          {['kanban', 'list', 'compact'].map((v) => <button key={v} className={'btn btn-sm ' + (view === v ? '' : 'btn-secondary')} style={{ borderRadius: 0, textTransform: 'capitalize' }} onClick={() => setView(v)}>{v}</button>)}
        </div>
        <input placeholder="Search name / employer…" value={pf.q} onChange={(e) => setPf((f) => ({ ...f, q: e.target.value }))} style={{ minWidth: 180 }} />
        <select value={pf.stage} onChange={(e) => setPf((f) => ({ ...f, stage: e.target.value }))}>
          <option value="">All stages</option>{APP_ORDER.map((s) => <option key={s} value={s}>{APP_STATUS[s].label}</option>)}</select>
        <select value={pf.recruiter} onChange={(e) => setPf((f) => ({ ...f, recruiter: e.target.value }))}>
          <option value="">All recruiters</option>{recruiterOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
        <select value={pf.sort} onChange={(e) => setPf((f) => ({ ...f, sort: e.target.value }))}>
          <option value="last">Sort: Last updated</option><option value="name">Name</option><option value="match">Match score</option></select>
        <div className="spacer" />
        {apps && <span className="muted" style={{ fontSize: 12 }}>{visibleApps.length}/{apps.length}</span>}
        {canLink && <button className="btn btn-sm" onClick={() => setLinkOpen(true)}>+ {btns.link_candidate.label}</button>}
      </div>

      {canBulk && selected.size > 0 && (
        <div className="card card-pad" style={{ marginBottom: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
          <strong>{selected.size} selected</strong>
          <select id="bulkStatus" className="" style={{ padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6 }}>
            {cols.map((s) => <option key={s} value={s}>{APP_STATUS[s].label}</option>)}</select>
          <button className="btn btn-sm" onClick={() => { const st = document.getElementById('bulkStatus').value; if (REASON_STATUSES.includes(st)) setMoveModal({ appIds: [...selected], toStatus: st, reason: true, bulk: true }); else bulkMove(st); }}>Apply Bulk Move</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      {apps.length === 0 ? <div className="card"><Empty icon="🧑‍💼" text="No candidates linked yet. Use 'Link to Request' to add candidates." /></div>
        : visibleApps.length === 0 ? <div className="card"><Empty icon="🔍" text="No candidates match the current filters." /></div>
        : view === 'kanban' ? (
          <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 12 }}>
            {cols.map((st) => {
              const items = visibleApps.filter((a) => a.status === st);
              if (items.length === 0 && !['new', 'screened', 'shortlisted', 'interview_1', 'offer_sent', 'joined'].includes(st)) return null;
              return (
                <div key={st} style={{ minWidth: 250, flex: '0 0 250px' }}>
                  <div className="row-between" style={{ marginBottom: 8 }}><strong style={{ fontSize: 13 }}>{APP_STATUS[st].label}</strong><span className="chip">{items.length}</span></div>
                  {items.map((a) => <PipelineCard key={a.id} app={a} canMove={canMove} canBulk={canBulk} selected={selected.has(a.id)} onSelect={() => toggleSel(a.id)} onView={() => setQuickView(a)} onMove={(s) => requestMove(a.id, s)} onSchedule={() => setScheduleApp(a)} onOffer={() => setOfferApp(a)} onNote={() => setNoteApp(a)} btns={btns} />)}
                </div>
              );
            })}
          </div>
        ) : view === 'list' ? (
          <div style={{ display: 'grid', gap: 10 }}>
            {visibleApps.map((a) => <PipelineCard key={a.id} app={a} wide canMove={canMove} canBulk={canBulk} selected={selected.has(a.id)} onSelect={() => toggleSel(a.id)} onView={() => setQuickView(a)} onMove={(s) => requestMove(a.id, s)} onSchedule={() => setScheduleApp(a)} onOffer={() => setOfferApp(a)} onNote={() => setNoteApp(a)} btns={btns} />)}
          </div>
        ) : (
          <div className="card" style={{ overflowX: 'auto' }}><table>
            <thead><tr>{canBulk && <th></th>}<th>Candidate</th><th>Employer / Project</th><th>Exp</th><th>Education</th><th>Match</th><th>Stage</th><th>Recruiter</th><th>Next Action</th><th>Last Update</th><th></th></tr></thead>
            <tbody>{visibleApps.map((a) => (
              <tr key={a.id}>
                {canBulk && <td><input type="checkbox" checked={selected.has(a.id)} onChange={() => toggleSel(a.id)} /></td>}
                <td><strong>{a.candidate?.fullName}</strong><div className="muted">{a.candidate?.candidateNo}</div></td>
                <td>{a.candidate?.employer || a.candidate?.currentCompany || '—'}<div className="muted">{a.candidate?.currentProject || ''}</div></td>
                <td>{a.candidate?.yearsExperience ?? '—'}y</td>
                <td style={{ fontSize: 12 }}>{a.candidate?.university || '—'}<div className="muted">{[a.candidate?.major, a.candidate?.graduationYear].filter(Boolean).join(' · ')}</div></td>
                <td><MatchScore score={a.matchScore} /></td>
                <td><AppStatusBadge status={a.status} /></td>
                <td className="muted">{a.recruiter?.name || '—'}</td>
                <td style={{ fontSize: 12 }}>{a.nextAction || <span className="muted">—</span>}{a.nextActionDate ? <div className="muted">{fmtDateShort(a.nextActionDate)}</div> : null}</td>
                <td className="muted">{fmtDateShort(a.lastActivityAt)}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {canMove && !TERMINAL_APP.includes(a.status) && <StageSelect value={a.status} onChange={(s) => requestMove(a.id, s)} />}
                  {canMove && <button className="btn btn-ghost btn-sm" title="Set next action" aria-label="Set next action" onClick={() => setNoteApp(a)}>Note</button>}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}

      {quickView && <CandidateQuickView app={quickView} user={user} onClose={() => setQuickView(null)} onChanged={load} />}
      {noteApp && <NextActionModal app={noteApp} onClose={() => setNoteApp(null)} onSaved={() => { setNoteApp(null); load(); }} />}
      {moveModal && <Confirm title="Provide a reason" message={`Set status to "${APP_STATUS[moveModal.toStatus].label}". This is recorded in the audit trail.`} requireReason danger
        onConfirm={(reason) => { const m = moveModal; setMoveModal(null); m.bulk ? bulkMove(m.toStatus, reason) : move(m.appIds[0], m.toStatus, reason); }} onClose={() => setMoveModal(null)} />}
      {linkOpen && <LinkCandidateModal requestId={request.id} user={user} onClose={() => setLinkOpen(false)} onLinked={() => { setLinkOpen(false); load(); }} />}
      {scheduleApp && <ScheduleInterviewModal application={scheduleApp} onClose={() => setScheduleApp(null)} onScheduled={() => { setScheduleApp(null); load(); }} />}
      {offerApp && <CreateOfferModal application={offerApp} onClose={() => setOfferApp(null)} onCreated={() => { setOfferApp(null); load(); }} />}
    </div>
  );
}

function StageSelect({ value, onChange }) {
  return <select value={value} onChange={(e) => onChange(e.target.value)} style={{ padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}>
    {APP_ORDER.map((s) => <option key={s} value={s}>{APP_STATUS[s].label}</option>)}</select>;
}

function NextActionModal({ app, onClose, onSaved }) {
  const toast = useToast();
  const [nextAction, setNextAction] = useState(app.nextAction || '');
  const [nextActionDate, setNextActionDate] = useState(app.nextActionDate ? String(app.nextActionDate).slice(0, 10) : '');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try { await api.post(`/applications/${app.id}/next-action`, { nextAction, nextActionDate: nextActionDate || null }); toast('Next action saved'); onSaved(); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }
  return (
    <Modal title={`Next Action — ${app.candidate?.fullName || ''}`} onClose={onClose}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn" onClick={save} disabled={busy}>Save</button></>}>
      <div className="field"><label>Next Action</label><input value={nextAction} onChange={(e) => setNextAction(e.target.value)} placeholder="e.g. Schedule technical interview" /></div>
      <div className="field"><label>Due Date</label><input type="date" value={nextActionDate} onChange={(e) => setNextActionDate(e.target.value)} /></div>
    </Modal>
  );
}

function PipelineCard({ app, wide, canMove, canBulk, selected, onSelect, onView, onMove, onSchedule, onOffer, onNote, btns }) {
  const cand = app.candidate || {};
  const [menu, setMenu] = useState(false);
  return (
    <div className="card card-pad" style={{ marginBottom: 10, padding: 12, position: 'relative' }}>
      <div className="row-between" style={{ marginBottom: 6 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {canBulk && <input type="checkbox" checked={selected} onChange={onSelect} onClick={(e) => e.stopPropagation()} />}
          <strong style={{ fontSize: 13.5 }}>{cand.fullName}</strong>
        </div>
        <MatchScore score={app.matchScore} />
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{cand.currentPosition || '—'}{cand.currentCompany ? ' · ' + cand.currentCompany : ''}</div>
      <div style={{ fontSize: 11.5, color: 'var(--text-gray)', marginBottom: 8 }}>
        {cand.yearsExperience != null && <span>{cand.yearsExperience}y exp · </span>}
        {cand.location && <span>{cand.location} · </span>}
        {cand.noticePeriod && <span>{cand.noticePeriod}</span>}
        {cand.salaryVisible && cand.expectedSalary != null && <span> · Exp. salary {cand.expectedSalary}</span>}
      </div>
      <div className="row-between">
        <AppStatusBadge status={app.status} />
        <div style={{ display: 'flex', gap: 4 }}>
          <button className="btn btn-ghost btn-sm" onClick={onView}>View</button>
          {canMove && !TERMINAL_APP.includes(app.status) && <button className="btn btn-secondary btn-sm" onClick={() => setMenu((m) => !m)}>Actions ▾</button>}
        </div>
      </div>
      {menu && (
        <div className="menu" style={{ right: 12, top: 'auto' }} onMouseLeave={() => setMenu(false)}>
          {btns.shortlist_candidate?.visible && <div className="menu-item" onClick={() => { setMenu(false); onMove('shortlisted'); }}>Shortlist</div>}
          {btns.send_to_hm?.visible && <div className="menu-item" onClick={() => { setMenu(false); onMove('final_interview'); }}>Send to Hiring Manager (Final)</div>}
          <div className="menu-item" onClick={() => { setMenu(false); onMove('interview_1'); }}>Move to Interview 1</div>
          {onNote && <div className="menu-item" onClick={() => { setMenu(false); onNote(); }}>Set Next Action</div>}
          {btns.hold_candidate?.visible && <div className="menu-item" onClick={() => { setMenu(false); onMove('on_hold'); }}>Put On Hold</div>}
          {btns.reject_candidate?.visible && <div className="menu-item" style={{ color: 'var(--critical)' }} onClick={() => { setMenu(false); onMove('rejected'); }}>Reject</div>}
          {btns.schedule_interview?.visible && <div className="menu-item" onClick={() => { setMenu(false); onSchedule(); }}>Schedule Interview</div>}
          {btns.generate_offer?.visible && <div className="menu-item" onClick={() => { setMenu(false); onOffer(); }}>Generate Offer</div>}
        </div>
      )}
    </div>
  );
}

function CandidateQuickView({ app, user, onClose, onChanged }) {
  const c = app.candidate || {};
  const toast = useToast();
  const [tab, setTab] = useState('profile'); // profile | assessment
  const [cand, setCand] = useState(c);
  const [resumeBusy, setResumeBusy] = useState(false);
  const canEditCand = user?.permissions?.includes('candidate.edit');
  const canFeedback = user?.permissions?.includes('interview.feedback');

  async function viewResume() { try { await api.download(`/candidates/${c.id}/resume`); } catch (e) { toast(e.message, 'error'); } }
  async function uploadResume(e) {
    const file = e.target.files?.[0]; if (!file) return;
    setResumeBusy(true);
    try { const r = await api.upload(`/candidates/${c.id}/resume`, file); setCand((x) => ({ ...x, hasResume: true, resumeName: r.candidate?.resumeName })); toast('Resume uploaded'); onChanged && onChanged(); }
    catch (err) { toast(err.message, 'error'); } finally { setResumeBusy(false); e.target.value = ''; }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: 560, marginLeft: 'auto', height: '100vh', borderRadius: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="modal-head" style={{ borderTop: '4px solid var(--ticket-accent, #b0202e)' }}>
          <div>
            <h3 style={{ margin: 0 }}>{c.fullName}</h3>
            <div className="muted" style={{ fontSize: 12 }}>{c.candidateNo} · {app.applicationNo} · <AppStatusBadge status={app.status} /></div>
          </div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div style={{ display: 'flex', gap: 4, padding: '0 16px', borderBottom: '1px solid var(--border)' }}>
          {[['profile', 'Candidate'], ['assessment', 'Interview Assessment']].map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)} className="btn btn-ghost" style={{ border: 'none', borderBottom: tab === k ? '2px solid var(--ticket-accent, #b0202e)' : '2px solid transparent', borderRadius: 0, color: tab === k ? 'var(--ticket-accent, #b0202e)' : 'var(--text-gray)', fontWeight: tab === k ? 700 : 500 }}>{label}</button>
          ))}
        </div>
        <div className="modal-body" style={{ flex: 1, overflowY: 'auto' }}>
          {tab === 'profile' ? (
            <>
              <div style={{ background: 'var(--ticket-chip-bg, #fbeef0)', border: '1px solid var(--ticket-chip-border, #f3d6db)', borderRadius: 10, padding: '12px 14px', marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--ticket-accent, #b0202e)', fontWeight: 700 }}>Resume</div>
                  <div style={{ fontWeight: 600, marginTop: 2 }}>{cand.hasResume ? (cand.resumeName || 'Attached résumé') : <span className="muted">No résumé attached</span>}</div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {cand.hasResume && <button className="btn btn-sm btn-secondary" onClick={viewResume}>View / Download</button>}
                  {canEditCand && <label className="btn btn-sm btn-ghost" style={{ cursor: 'pointer' }}>{resumeBusy ? 'Uploading…' : (cand.hasResume ? 'Replace' : '+ Upload')}<input type="file" style={{ display: 'none' }} onChange={uploadResume} disabled={resumeBusy} accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,.txt" /></label>}
                </div>
              </div>
              <div className="form-grid">
                <Info label="Current Position">{c.currentPosition}</Info>
                <Info label="Employer">{c.employer || c.currentCompany}</Info>
                <Info label="Current Project">{c.currentProject}</Info>
                <Info label="Experience">{c.yearsExperience != null ? c.yearsExperience + ' years' : '—'}</Info>
                <Info label="University">{c.university}</Info>
                <Info label="Major">{c.major}</Info>
                <Info label="Graduation Year">{c.graduationYear}</Info>
                <Info label="Location">{c.location}</Info>
                <Info label="Notice Period">{c.noticePeriod}</Info>
                <Info label="Match Score"><MatchScore score={app.matchScore} /></Info>
                <Info label="Source">{app.source || c.source}</Info>
              </div>
              {app.rejectionReason && <Info label="Rejection Reason">{app.rejectionReason}</Info>}
              {app.onHoldReason && <Info label="On Hold Reason">{app.onHoldReason}</Info>}
            </>
          ) : (
            <AssessmentPanel app={app} canFeedback={canFeedback} />
          )}
        </div>
      </div>
    </div>
  );
}

// Interview assessment: HR + technical evaluations (Big-Five + technical competency,
// critical flags, recommendation, fit) plus the shared final decision. Matches the PDF form.
function AssessmentPanel({ app, canFeedback }) {
  const toast = useToast();
  const [meta, setMeta] = useState(null);
  const [bundle, setBundle] = useState(null);
  const [evalType, setEvalType] = useState('hr'); // hr | technical

  const load = useCallback(async () => {
    try { setBundle((await api.get('/assessments/application/' + app.id)).assessment); } catch (e) { toast(e.message, 'error'); }
  }, [app.id]);
  useEffect(() => { api.get('/assessments/meta').then(setMeta).catch(() => {}); load(); }, [load]);

  if (!meta || !bundle) return <Skeleton rows={6} />;
  if (!bundle.unlocked) return <Empty icon="🔒" text="Interview assessment unlocks once this candidate is moved to an interview stage in the pipeline." />;

  const existing = bundle[evalType];
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {[['hr', 'HR / Behavioral'], ['technical', 'Technical']].map(([k, label]) => (
          <button key={k} className={'tag-toggle' + (evalType === k ? ' on' : '')} onClick={() => setEvalType(k)}>
            {label}{bundle[k]?.submitted ? ' ✓' : ''}
          </button>
        ))}
      </div>
      <p className="muted" style={{ fontSize: 11.5, marginTop: 0 }}>{meta.scoreGuide}</p>

      <EvaluationForm
        key={evalType}
        type={evalType}
        meta={meta}
        existing={existing}
        readOnly={!canFeedback}
        onSaved={() => { toast('Evaluation saved'); load(); }}
        appId={app.id}
      />

      <FinalDecisionBox bundle={bundle} meta={meta} canFeedback={canFeedback} appId={app.id} onSaved={() => { toast('Final decision recorded'); load(); }} />
    </div>
  );
}

function ScoreRow({ label, hint, value, onChange, readOnly }) {
  const opts = ['', '1', '2', '3', '4', '5', 'na'];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'center', padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
      <div><div style={{ fontWeight: 600, fontSize: 13 }}>{label}</div>{hint && <div className="muted" style={{ fontSize: 11, lineHeight: 1.4 }}>{hint}</div>}</div>
      <select value={value ?? ''} disabled={readOnly} onChange={(e) => onChange(e.target.value)} style={{ padding: '5px 8px', border: '1px solid var(--border)', borderRadius: 6, minWidth: 70 }}>
        {opts.map((o) => <option key={o} value={o}>{o === '' ? '—' : o === 'na' ? 'N/A' : o}</option>)}
      </select>
    </div>
  );
}

function EvaluationForm({ type, meta, existing, readOnly, onSaved, appId }) {
  const toast = useToast();
  const criteria = type === 'hr' ? meta.behavioralCriteria : meta.technicalCriteria;
  const stored = type === 'hr' ? existing?.behavioral : existing?.technical;
  const [scores, setScores] = useState(() => {
    const init = {}; criteria.forEach((cr) => { init[cr.key] = stored?.[cr.key]?.score != null ? String(stored[cr.key].score) : ''; });
    return init;
  });
  const [flags, setFlags] = useState(() => {
    const init = {}; (meta.criticalFlags || []).forEach((f) => { init[f.key] = !!existing?.criticalFlags?.[f.key]; }); return init;
  });
  const [rec, setRec] = useState(existing?.recommendation || '');
  const [fit, setFit] = useState((type === 'hr' ? existing?.behavioralFit : existing?.technicalFit) || '');
  const [justification, setJustification] = useState((type === 'hr' ? existing?.behavioralJustification : existing?.technicalJustification) || '');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    const scoreObj = {}; Object.entries(scores).forEach(([k, v]) => { if (v) scoreObj[k] = { score: v === 'na' ? null : Number(v) }; });
    const body = { evaluatorType: type, criticalFlags: flags, recommendation: rec || null };
    if (type === 'hr') { body.behavioral = scoreObj; body.behavioralFit = fit || null; body.behavioralJustification = justification; }
    else { body.technical = scoreObj; body.technicalFit = fit || null; body.technicalJustification = justification; }
    try { await api.post('/assessments/application/' + appId, body); onSaved(); }
    catch (e) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  }

  return (
    <div className="card card-pad" style={{ marginBottom: 14 }}>
      <div className="section-title" style={{ marginTop: 0 }}>{type === 'hr' ? 'Behavioral (Big-Five)' : 'Technical Competency'}</div>
      {criteria.map((cr) => (
        <ScoreRow key={cr.key} label={cr.label} hint={cr.hint} value={scores[cr.key]} readOnly={readOnly} onChange={(v) => setScores((s) => ({ ...s, [cr.key]: v }))} />
      ))}

      <div className="section-title">Critical Flags</div>
      {(meta.criticalFlags || []).map((f) => (
        <label key={f.key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '4px 0', fontSize: 13 }}>
          <input type="checkbox" checked={flags[f.key]} disabled={readOnly} onChange={(e) => setFlags((x) => ({ ...x, [f.key]: e.target.checked }))} style={{ marginTop: 2 }} />
          <span>{f.label}</span>
        </label>
      ))}

      <div className="form-grid" style={{ marginTop: 12 }}>
        <div className="field"><label>Recommendation</label>
          <select value={rec} disabled={readOnly} onChange={(e) => setRec(e.target.value)}>
            <option value="">— Select —</option>{meta.recommendations.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select></div>
        <div className="field"><label>{type === 'hr' ? 'Behavioral Fit' : 'Technical Fit'}</label>
          <select value={fit} disabled={readOnly} onChange={(e) => setFit(e.target.value)}>
            <option value="">— Select —</option>{meta.fits.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select></div>
      </div>
      <div className="field"><label>Justification / Notes</label>
        <textarea rows="3" value={justification} disabled={readOnly} onChange={(e) => setJustification(e.target.value)} placeholder="Evidence, examples, rationale…" /></div>

      {!readOnly && <button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : (existing ? 'Update ' : 'Submit ') + (type === 'hr' ? 'HR Evaluation' : 'Technical Evaluation')}</button>}
      {existing?.evaluatorName && <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>Last saved by {existing.evaluatorName}{existing.updatedAt ? ' · ' + fmtDate(existing.updatedAt) : ''}</div>}
    </div>
  );
}

function FinalDecisionBox({ bundle, meta, canFeedback, appId, onSaved }) {
  const toast = useToast();
  const fd = bundle.finalDecision;
  const [decision, setDecision] = useState(fd?.decision || '');
  const [notes, setNotes] = useState(fd?.notes || '');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try { await api.post(`/assessments/application/${appId}/final`, { decision, notes }); onSaved(); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }
  return (
    <div className="card card-pad" style={{ borderTop: '3px solid var(--ticket-accent, #b0202e)' }}>
      <div className="section-title" style={{ marginTop: 0 }}>Final Decision (shared — recruiter &amp; technical interviewer)</div>
      <div className="field"><label>Decision</label>
        <select value={decision} disabled={!canFeedback} onChange={(e) => setDecision(e.target.value)}>
          <option value="">— Select —</option>{meta.finalDecisions.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select></div>
      <div className="field"><label>Notes</label><textarea rows="2" value={notes} disabled={!canFeedback} onChange={(e) => setNotes(e.target.value)} /></div>
      {canFeedback && <button className="btn" onClick={save} disabled={busy || !decision}>{busy ? 'Saving…' : 'Record Final Decision'}</button>}
      {fd?.decidedByName && <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>Decided by {fd.decidedByName}{fd.decidedAt ? ' · ' + fmtDate(fd.decidedAt) : ''}</div>}
    </div>
  );
}
function AssignModal({ recruiters, onClose, onAssign }) {
  const [ownerId, setOwnerId] = useState('');
  return (
    <Modal title="Assign Recruiter" onClose={onClose}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={!ownerId} onClick={() => onAssign(Number(ownerId))}>Assign</button></>}>
      <div className="field"><label>Recruiter / Owner</label>
        <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}><option value="">— Select —</option>{recruiters.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></div>
    </Modal>
  );
}

/* ----------------------------- Link candidate to request ----------------------------- */
function LinkCandidateModal({ requestId, user, onClose, onLinked }) {
  const toast = useToast();
  const [mode, setMode] = useState('existing'); // existing | new
  const [candidates, setCandidates] = useState([]);
  const [meta, setMeta] = useState(null);
  const [sel, setSel] = useState({ candidateId: '', initialStatus: 'applied', matchScore: '', source: '' });
  const [nc, setNc] = useState({ fullName: '', email: '', phone: '', currentPosition: '', currentCompany: '', yearsExperience: '', location: '', noticePeriod: '', source: '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/candidates').then((r) => setCandidates(r.candidates)).catch(() => {}); api.get('/candidates/meta/form').then(setMeta).catch(() => {}); }, []);

  async function save() {
    setBusy(true);
    try {
      const body = mode === 'existing'
        ? { requestId, candidateId: Number(sel.candidateId), initialStatus: sel.initialStatus, matchScore: sel.matchScore || null, source: sel.source }
        : { requestId, initialStatus: sel.initialStatus, matchScore: sel.matchScore || null, newCandidate: nc };
      await api.post('/applications', body);
      toast('Candidate linked to request'); onLinked();
    } catch (e) { toast(e.message + (e.data?.duplicates ? ' (duplicate exists)' : ''), 'error'); } finally { setBusy(false); }
  }
  return (
    <Modal title="Link Candidate to Request" onClose={onClose} wide
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn" onClick={save} disabled={busy || (mode === 'existing' && !sel.candidateId) || (mode === 'new' && !nc.fullName)}>{busy ? 'Linking…' : 'Link'}</button></>}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button className={'tag-toggle' + (mode === 'existing' ? ' on' : '')} onClick={() => setMode('existing')}>Existing candidate</button>
        <button className={'tag-toggle' + (mode === 'new' ? ' on' : '')} onClick={() => setMode('new')}>Create new &amp; link</button>
      </div>
      {mode === 'existing' ? (
        <div className="field"><label>Candidate</label>
          <select value={sel.candidateId} onChange={(e) => setSel((s) => ({ ...s, candidateId: e.target.value }))}>
            <option value="">— Select —</option>{candidates.map((c) => <option key={c.id} value={c.id}>{c.fullName} ({c.candidateNo}) — {c.currentPosition || '—'}</option>)}</select></div>
      ) : (
        <div className="form-grid">
          <div className="field"><label>Full Name *</label><input value={nc.fullName} onChange={(e) => setNc((s) => ({ ...s, fullName: e.target.value }))} /></div>
          <div className="field"><label>Email</label><input value={nc.email} onChange={(e) => setNc((s) => ({ ...s, email: e.target.value }))} /></div>
          <div className="field"><label>Phone</label><input value={nc.phone} onChange={(e) => setNc((s) => ({ ...s, phone: e.target.value }))} /></div>
          <div className="field"><label>Current Position</label><input value={nc.currentPosition} onChange={(e) => setNc((s) => ({ ...s, currentPosition: e.target.value }))} /></div>
          <div className="field"><label>Current Company</label><input value={nc.currentCompany} onChange={(e) => setNc((s) => ({ ...s, currentCompany: e.target.value }))} /></div>
          <div className="field"><label>Experience (years)</label><input type="number" value={nc.yearsExperience} onChange={(e) => setNc((s) => ({ ...s, yearsExperience: e.target.value }))} /></div>
        </div>
      )}
      <div className="form-grid" style={{ marginTop: 12 }}>
        <div className="field"><label>Initial Status</label><select value={sel.initialStatus} onChange={(e) => setSel((s) => ({ ...s, initialStatus: e.target.value }))}>{APP_ORDER.slice(0, 10).map((s) => <option key={s} value={s}>{APP_STATUS[s].label}</option>)}</select></div>
        <div className="field"><label>Match Score (0–100)</label><input type="number" min="0" max="100" value={sel.matchScore} onChange={(e) => setSel((s) => ({ ...s, matchScore: e.target.value }))} /></div>
        <div className="field"><label>Source</label><input value={sel.source} onChange={(e) => setSel((s) => ({ ...s, source: e.target.value }))} placeholder="referral, agency…" /></div>
      </div>
    </Modal>
  );
}

/* ----------------------------- Candidates page ----------------------------- */
function CandidatesPage({ user }) {
  const [candidates, setCandidates] = useState(null);
  const [filters, setFilters] = useState({ q: '', source: '', location: '', minExp: '', maxExp: '', noticePeriod: '', currentCompany: '', tag: '' });
  const [selectedId, setSelectedId] = useState(null);
  const [creating, setCreating] = useState(false);
  const btns = useResolvedButtons();

  const load = useCallback(async () => {
    setCandidates(null);
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => { if (v) params.set(k, v); });
    setCandidates((await api.get('/candidates?' + params.toString())).candidates);
  }, [filters]);
  useEffect(() => { load(); }, [load]);

  if (selectedId) return <CandidateProfile id={selectedId} user={user} btns={btns} onBack={() => { setSelectedId(null); load(); }} />;

  return (
    <div>
      <PageHead crumb="Recruitment / Talent Pool" title="Candidate Database" sub="The person record. Application status lives on each candidate's application to a request — never on the candidate."
        actions={<>
          {btns.import_candidates?.visible && <button className="btn btn-ghost" onClick={() => alert('Import is a Phase 4 placeholder.')}>Import</button>}
          {btns.add_candidate?.visible && <button className="btn" onClick={() => setCreating(true)}>+ {btns.add_candidate.label}</button>}
        </>} />
      <div className="toolbar">
        <input placeholder="Search name / id / company / email…" value={filters.q} onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} style={{ minWidth: 240 }} />
        <input placeholder="Location" value={filters.location} onChange={(e) => setFilters((f) => ({ ...f, location: e.target.value }))} style={{ width: 120 }} />
        <input placeholder="Company" value={filters.currentCompany} onChange={(e) => setFilters((f) => ({ ...f, currentCompany: e.target.value }))} style={{ width: 120 }} />
        <input placeholder="Min exp" type="number" value={filters.minExp} onChange={(e) => setFilters((f) => ({ ...f, minExp: e.target.value }))} style={{ width: 80 }} />
        <input placeholder="Max exp" type="number" value={filters.maxExp} onChange={(e) => setFilters((f) => ({ ...f, maxExp: e.target.value }))} style={{ width: 80 }} />
        <input placeholder="Tag" value={filters.tag} onChange={(e) => setFilters((f) => ({ ...f, tag: e.target.value }))} style={{ width: 100 }} />
        <div className="spacer" />
        {candidates && <span className="muted">{candidates.length} candidates</span>}
      </div>
      <div className="card">
        {!candidates ? <Skeleton /> : candidates.length === 0 ? <Empty icon="👤" text="No candidates found." /> : (
          <table>
            <thead><tr><th>ID</th><th>Name</th><th>Position / Company</th><th>Exp</th><th>Location</th><th>Notice</th>{user.permissions.includes('salary.view') && <th>Expected</th>}<th>Source</th><th>Owner</th><th>Apps</th><th></th></tr></thead>
            <tbody>{candidates.map((c) => (
              <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => setSelectedId(c.id)}>
                <td><strong>{c.candidateNo}</strong></td>
                <td>{c.fullName}{c.tags?.length ? <div>{c.tags.slice(0, 3).map((t) => <span key={t} className="chip">{t}</span>)}</div> : null}</td>
                <td>{c.currentPosition || '—'}<div className="muted">{c.currentCompany}</div></td>
                <td>{c.yearsExperience ?? '—'}y</td>
                <td>{c.location || '—'}</td>
                <td>{c.noticePeriod || '—'}</td>
                {user.permissions.includes('salary.view') && <td>{c.expectedSalary ?? '—'}</td>}
                <td>{c.source || '—'}</td>
                <td className="muted">{c.ownerRecruiter?.name || '—'}</td>
                <td><span className="chip">{c.applicationCount}</span></td>
                <td><button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); setSelectedId(c.id); }}>Open</button></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {creating && <CandidateForm user={user} onClose={() => setCreating(false)} onSaved={(id) => { setCreating(false); load(); setSelectedId(id); }} />}
    </div>
  );
}

function CandidateForm({ user, candidate, onClose, onSaved }) {
  const toast = useToast();
  const isNew = !candidate;
  const [meta, setMeta] = useState(null);
  const [f, setF] = useState({
    fullName: candidate?.fullName || '', email: candidate?.email || '', phone: candidate?.phone || '',
    nationality: candidate?.nationality || '', location: candidate?.location || '', linkedinUrl: candidate?.linkedinUrl || '',
    currentCompany: candidate?.currentCompany || '', currentPosition: candidate?.currentPosition || '',
    yearsExperience: candidate?.yearsExperience ?? '', expectedSalary: candidate?.expectedSalary ?? '',
    noticePeriod: candidate?.noticePeriod || '', source: candidate?.source || '',
    tags: (candidate?.tags || []).join(', '),
  });
  const [busy, setBusy] = useState(false);
  const [dups, setDups] = useState([]);
  const [override, setOverride] = useState({ on: false, reason: '' });
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  useEffect(() => { api.get('/candidates/meta/form').then(setMeta); }, []);

  // live duplicate check
  useEffect(() => {
    const t = setTimeout(async () => {
      if (!f.email && !f.phone && !f.linkedinUrl) { setDups([]); return; }
      try { const r = await api.post('/candidates/check-duplicate', { email: f.email, phone: f.phone, linkedinUrl: f.linkedinUrl, excludeId: candidate?.id }); setDups(r.duplicates); }
      catch {}
    }, 500);
    return () => clearTimeout(t);
  }, [f.email, f.phone, f.linkedinUrl]);

  async function save() {
    setBusy(true);
    try {
      const body = { ...f, tags: f.tags ? f.tags.split(',').map((s) => s.trim()).filter(Boolean) : [] };
      if (dups.length && isNew) { body.overrideDuplicate = true; body.overrideReason = override.reason; }
      if (isNew) { const r = await api.post('/candidates', body); toast('Candidate created: ' + r.candidate.candidateNo); onSaved(r.candidate.id); }
      else { const r = await api.put('/candidates/' + candidate.id, body); toast('Candidate updated'); onSaved(candidate.id); }
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }
  const blockSave = isNew && dups.length && !override.reason.trim();
  return (
    <Modal title={isNew ? 'Add Candidate' : 'Edit Candidate'} onClose={onClose} wide
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn" onClick={save} disabled={busy || blockSave}>{busy ? 'Saving…' : 'Save'}</button></>}>
      {dups.length > 0 && (
        <div className="error-banner">
          Possible duplicate: {dups.map((d) => `${d.fullName} (${d.candidateNo})`).join(', ')}.
          {isNew && <div style={{ marginTop: 8 }}>
            {user.permissions.includes('candidate.merge')
              ? <input placeholder="Reason to continue anyway (required)" value={override.reason} onChange={(e) => setOverride({ on: true, reason: e.target.value })} style={{ width: '100%', padding: 8, border: '1px solid var(--border)', borderRadius: 6 }} />
              : <span className="muted">You don't have permission to override — use the existing candidate instead.</span>}
          </div>}
        </div>
      )}
      <div className="form-grid">
        <div className="field"><label>Full Name *</label><input value={f.fullName} onChange={(e) => set('fullName', e.target.value)} /></div>
        <div className="field"><label>Email</label><input value={f.email} onChange={(e) => set('email', e.target.value)} /></div>
        <div className="field"><label>Phone</label><input value={f.phone} onChange={(e) => set('phone', e.target.value)} /></div>
        <div className="field"><label>Nationality</label><input value={f.nationality} onChange={(e) => set('nationality', e.target.value)} /></div>
        <div className="field"><label>Location</label><input value={f.location} onChange={(e) => set('location', e.target.value)} /></div>
        <div className="field"><label>LinkedIn URL</label><input value={f.linkedinUrl} onChange={(e) => set('linkedinUrl', e.target.value)} /></div>
        <div className="field"><label>Current Company</label><input value={f.currentCompany} onChange={(e) => set('currentCompany', e.target.value)} /></div>
        <div className="field"><label>Current Position</label><input value={f.currentPosition} onChange={(e) => set('currentPosition', e.target.value)} /></div>
        <div className="field"><label>Years of Experience</label><input type="number" value={f.yearsExperience} onChange={(e) => set('yearsExperience', e.target.value)} /></div>
        <div className="field"><label>Notice Period</label><select value={f.noticePeriod} onChange={(e) => set('noticePeriod', e.target.value)}><option value="">—</option>{(meta?.noticePeriods || []).map((n) => <option key={n}>{n}</option>)}</select></div>
        <div className="field"><label>Source</label><select value={f.source} onChange={(e) => set('source', e.target.value)}><option value="">—</option>{(meta?.sources || []).map((s) => <option key={s}>{s}</option>)}</select></div>
        {meta?.canSeeSalary && <div className="field"><label>Expected Salary</label><input type="number" value={f.expectedSalary} onChange={(e) => set('expectedSalary', e.target.value)} /></div>}
        <div className="field full"><label>Tags (comma-separated)</label><input value={f.tags} onChange={(e) => set('tags', e.target.value)} placeholder="mechanical, senior, hvac" /></div>
        <div className="field full"><label>CV / Attachments</label><div className="muted" style={{ padding: '8px 0' }}>File upload UI is a Phase 4 placeholder — document metadata can be recorded via the profile.</div></div>
      </div>
    </Modal>
  );
}

/* ----------------------------- Candidate Profile (6 tabs) ----------------------------- */
function CandidateProfile({ id, user, btns, onBack }) {
  const toast = useToast();
  const [c, setC] = useState(null);
  const [tab, setTab] = useState('overview');
  const [editing, setEditing] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);

  const load = useCallback(async () => { setC((await api.get('/candidates/' + id)).candidate); }, [id]);
  useEffect(() => { load(); }, [id]);
  if (!c) return <Skeleton rows={8} />;

  const TABS = [['overview', 'Overview'], ['cv', 'CV & Attachments'], ['applications', `Applications (${c.applications?.length || 0})`], ['interviews', 'Interviews'], ['offers', 'Offers'], ['notes', 'Notes & Activity']];
  return (
    <div>
      <div className="breadcrumb"><a href="#" onClick={(e) => { e.preventDefault(); onBack(); }}>← Talent Pool</a></div>
      <div className="page-head">
        <div><h1 className="page-title">{c.fullName}</h1>
          <p className="page-sub"><strong>{c.candidateNo}</strong> · {c.currentPosition || '—'}{c.currentCompany ? ' @ ' + c.currentCompany : ''} · {c.applicationCount} application(s)</p></div>
        <div style={{ display: 'flex', gap: 8 }}>
          {btns.edit_candidate?.visible && <button className="btn btn-secondary" onClick={() => setEditing(true)}>Edit</button>}
          {btns.add_note?.visible && <button className="btn btn-secondary" onClick={() => setNoteOpen(true)}>Add Note</button>}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', marginBottom: 18, flexWrap: 'wrap' }}>
        {TABS.map(([k, label]) => <button key={k} onClick={() => setTab(k)} className="btn btn-ghost" style={{ border: 'none', borderBottom: tab === k ? '2px solid var(--secondary)' : '2px solid transparent', borderRadius: 0, color: tab === k ? 'var(--secondary)' : 'var(--text-gray)', fontWeight: tab === k ? 700 : 500 }}>{label}</button>)}
      </div>

      {tab === 'overview' && (
        <div className="card card-pad"><div className="form-grid">
          <Info label="Full Name">{c.fullName}</Info><Info label="Email">{c.email}</Info><Info label="Phone">{c.phone}</Info>
          <Info label="Nationality">{c.nationality}</Info><Info label="Location">{c.location}</Info>
          <Info label="LinkedIn">{c.linkedinUrl ? <a href={c.linkedinUrl} target="_blank" rel="noreferrer">Profile</a> : '—'}</Info>
          <Info label="Current Company">{c.currentCompany}</Info><Info label="Current Position">{c.currentPosition}</Info>
          <Info label="Experience">{c.yearsExperience != null ? c.yearsExperience + ' years' : '—'}</Info>
          <Info label="Notice Period">{c.noticePeriod}</Info><Info label="Source">{c.source}</Info>
          {c.salaryVisible ? <Info label="Expected Salary">{c.expectedSalary ?? '—'}</Info> : <Info label="Expected Salary"><span className="muted">Restricted</span></Info>}
          <Info label="Owner Recruiter">{c.ownerRecruiter?.name}</Info>
          <div className="full"><Info label="Tags">{(c.tags || []).length ? c.tags.map((t) => <span key={t} className="chip">{t}</span>) : '—'}</Info></div>
        </div></div>
      )}
      {tab === 'cv' && (
        <div className="card card-pad">
          <div className="section-title" style={{ marginTop: 0 }}>Documents</div>
          {(c.documents || []).length === 0 ? <Empty icon="📄" text="No documents. (Embedded CV viewer & upload arrive in Phase 4.)" /> : (
            <table><thead><tr><th>Type</th><th>File</th><th>Uploaded</th></tr></thead>
              <tbody>{c.documents.map((d) => <tr key={d.id}><td><span className="chip">{d.doc_type}</span></td><td>{d.file_name}</td><td className="muted">{fmtDate(d.uploaded_at)}</td></tr>)}</tbody></table>
          )}
        </div>
      )}
      {tab === 'applications' && (
        <div className="card">
          {(c.applications || []).length === 0 ? <Empty icon="🎫" text="Not linked to any request yet." /> : (
            <table><thead><tr><th>Application</th><th>Ticket</th><th>Position</th><th>Project</th><th>Status</th><th>Recruiter</th><th>Last Activity</th></tr></thead>
              <tbody>{c.applications.map((a) => (
                <tr key={a.id}><td><strong>{a.applicationNo}</strong></td><td>{a.ticketNo}</td><td>{a.position}</td><td>{a.project?.name || '—'}</td>
                  <td><AppStatusBadge status={a.status} /></td><td className="muted">{a.recruiter?.name || '—'}</td><td className="muted">{fmtDateShort(a.lastActivityAt)}</td></tr>
              ))}</tbody></table>
          )}
          <div className="card-pad muted">Each row is an independent <strong>Application</strong> — the same candidate can sit at different stages across requests.</div>
        </div>
      )}
      {tab === 'interviews' && (
        <div className="card">
          {(c.interviews || []).length === 0 ? <Empty icon="📅" text="No interviews for this candidate (or none assigned to you)." /> : (
            <table><thead><tr><th>Interview</th><th>Request</th><th>Type / Mode</th><th>Round</th><th>Scheduled</th><th>Status</th><th>Outcome</th></tr></thead>
              <tbody>{c.interviews.map((iv) => (
                <tr key={iv.id}><td><strong>{iv.interviewNo}</strong></td><td>{iv.ticketNo}</td><td>{iv.interviewType} / {iv.mode}</td><td>{iv.round}</td>
                  <td className="muted">{fmtDate(iv.scheduledAt)}</td><td><IvStatusBadge status={iv.status} /></td>
                  <td>{iv.overallOutcome ? <Badge variant={(IV_OUTCOME[iv.overallOutcome] || {}).variant || 'soft'}>{(IV_OUTCOME[iv.overallOutcome] || {}).label}</Badge> : '—'}</td></tr>
              ))}</tbody></table>
          )}
          <div className="card-pad muted">Interviews link to a specific application/request; their status is independent of the application's pipeline status.</div>
        </div>
      )}
      {tab === 'offers' && (
        <div className="card">
          {(c.offers || []).length === 0 ? <Empty icon="📑" text="No offers for this candidate." /> : (
            <table><thead><tr><th>Offer</th><th>Request</th><th>Position</th><th>Salary</th><th>Status</th><th>Joining</th></tr></thead>
              <tbody>{c.offers.map((o) => (
                <tr key={o.id}><td><strong>{o.offerNo}</strong></td><td>{o.ticketNo}</td><td>{o.positionTitle}</td>
                  <td><SalaryCell visible={o.salaryVisible} value={o.salaryOffered} currency={o.currency} /></td>
                  <td><OfferStatusBadge status={o.status} /></td><td className="muted">{fmtDateShort(o.joiningDate)}</td></tr>
              ))}</tbody></table>
          )}
          <div className="card-pad muted">Offers link to a specific application/request; salary is shown only to authorized roles.</div>
        </div>
      )}
      {tab === 'notes' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div className="card"><div className="card-head"><h3>Notes</h3></div><div className="card-pad">
            {(c.notes || []).length === 0 ? <p className="muted">No notes.</p> : c.notes.map((n) => (
              <div key={n.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                <div>{n.body}</div><div className="muted" style={{ fontSize: 12 }}><span className="chip">{n.note_type}</span> {n.author_name} · {fmtDate(n.created_at)}</div>
              </div>
            ))}
          </div></div>
          <div className="card"><div className="card-head"><h3>Activity</h3></div><div className="card-pad">
            {(c.activity || []).map((a) => <div key={a.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}><strong style={{ textTransform: 'capitalize' }}>{a.type.replace(/_/g, ' ')}</strong>{a.note ? ' — ' + a.note : ''}<div className="muted" style={{ fontSize: 11 }}>{a.actor_name} · {fmtDate(a.occurred_at)}</div></div>)}
          </div></div>
        </div>
      )}

      {editing && <CandidateForm user={user} candidate={c} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load(); }} />}
      {noteOpen && <NoteModal candidateId={c.id} onClose={() => setNoteOpen(false)} onSaved={() => { setNoteOpen(false); load(); }} />}
    </div>
  );
}
function NoteModal({ candidateId, onClose, onSaved }) {
  const toast = useToast();
  const [body, setBody] = useState(''); const [noteType, setNoteType] = useState('note'); const [busy, setBusy] = useState(false);
  async function save() { setBusy(true); try { await api.post(`/candidates/${candidateId}/notes`, { body, noteType }); toast('Note added'); onSaved(); } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); } }
  return (
    <Modal title="Add Note" onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn" onClick={save} disabled={busy || !body.trim()}>Save</button></>}>
      <div className="field"><label>Type</label><select value={noteType} onChange={(e) => setNoteType(e.target.value)}><option value="note">Recruiter note</option><option value="assessment">Assessment</option></select></div>
      <div className="field"><label>Note</label><textarea rows="4" value={body} onChange={(e) => setBody(e.target.value)} /></div>
    </Modal>
  );
}

/* ============================ PHASE 4: Interviews & Feedback ============================ */
const IV_STATUS = {
  scheduled: { label: 'Scheduled', variant: 'info' },
  completed: { label: 'Completed', variant: 'success' },
  no_show: { label: 'No Show', variant: 'critical' },
  cancelled: { label: 'Cancelled', variant: 'critical' },
  rescheduled: { label: 'Rescheduled', variant: 'warning' },
};
const IV_OUTCOME = { positive: { label: 'Positive', variant: 'success' }, negative: { label: 'Negative', variant: 'critical' }, mixed: { label: 'Mixed', variant: 'warning' } };
const REC_LABEL = { strong_yes: 'Strong Yes', yes: 'Yes', no: 'No', strong_no: 'Strong No' };
function IvStatusBadge({ status }) { const s = IV_STATUS[status] || { label: status, variant: 'soft' }; return <Badge variant={s.variant}>{s.label}</Badge>; }

function ScheduleInterviewModal({ application, onClose, onScheduled }) {
  const toast = useToast();
  const [meta, setMeta] = useState(null);
  const [f, setF] = useState({ interviewType: 'technical', mode: 'video', scheduledAt: '', durationMin: 60, round: 1, locationOrLink: '', panel: [] });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  useEffect(() => { api.get('/interviews/meta/form').then(setMeta); }, []);
  function togglePanel(id) { setF((s) => ({ ...s, panel: s.panel.includes(id) ? s.panel.filter((x) => x !== id) : [...s.panel, id] })); }

  async function save() {
    setBusy(true);
    try {
      await api.post('/interviews', {
        applicationId: application.id, interviewType: f.interviewType, mode: f.mode,
        scheduledAt: f.scheduledAt ? new Date(f.scheduledAt).toISOString() : null,
        durationMin: Number(f.durationMin), round: Number(f.round), locationOrLink: f.locationOrLink,
        panel: f.panel.map((id, i) => ({ interviewerId: id, isLead: i === 0 })),
      });
      toast('Interview scheduled'); onScheduled();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }
  if (!meta) return <Modal title="Schedule Interview" onClose={onClose}><Skeleton /></Modal>;
  return (
    <Modal title={`Schedule Interview — ${application.candidate?.fullName || ''}`} onClose={onClose} wide
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn" onClick={save} disabled={busy || !f.scheduledAt || f.panel.length === 0}>{busy ? 'Scheduling…' : 'Schedule'}</button></>}>
      <p className="muted" style={{ marginTop: 0 }}>Links to application <strong>{application.applicationNo}</strong>. Scheduling does <strong>not</strong> change the application's pipeline status.</p>
      <div className="form-grid">
        <div className="field"><label>Type</label><select value={f.interviewType} onChange={(e) => set('interviewType', e.target.value)}>{meta.types.map((t) => <option key={t} value={t}>{t}</option>)}</select></div>
        <div className="field"><label>Mode</label><select value={f.mode} onChange={(e) => set('mode', e.target.value)}>{meta.modes.map((m) => <option key={m} value={m}>{m}</option>)}</select></div>
        <div className="field"><label>Date &amp; Time *</label><input type="datetime-local" value={f.scheduledAt} onChange={(e) => set('scheduledAt', e.target.value)} /></div>
        <div className="field"><label>Duration (min)</label><input type="number" value={f.durationMin} onChange={(e) => set('durationMin', e.target.value)} /></div>
        <div className="field"><label>Round</label><input type="number" min="1" value={f.round} onChange={(e) => set('round', e.target.value)} /></div>
        <div className="field"><label>Location / Link</label><input value={f.locationOrLink} onChange={(e) => set('locationOrLink', e.target.value)} placeholder="Meet link or room" /></div>
      </div>
      <div className="section-title">Panel (interviewers) *</div>
      <div>{meta.interviewers.map((u) => <span key={u.id} className={'tag-toggle' + (f.panel.includes(u.id) ? ' on' : '')} onClick={() => togglePanel(u.id)}>{u.name}</span>)}</div>
      <p className="muted" style={{ marginTop: 8 }}>First selected is the lead. Only selected interviewers will see this interview and may submit feedback.</p>
    </Modal>
  );
}

function InterviewsPage({ user }) {
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState({ status: '', q: '' });
  const [selected, setSelected] = useState(null);
  const load = useCallback(async () => {
    setData(null);
    const params = new URLSearchParams();
    Object.entries(filter).forEach(([k, v]) => { if (v) params.set(k, v); });
    setData(await api.get('/interviews?' + params.toString()));
  }, [filter]);
  useEffect(() => { load(); }, [load]);

  if (selected) return <InterviewDetail id={selected} user={user} onBack={() => { setSelected(null); load(); }} />;

  return (
    <div>
      <PageHead crumb="Recruitment / Interviews" title={data?.scoped ? 'My Interviews' : 'Interviews'}
        sub={data?.scoped ? 'You see only interviews where you are on the panel.' : 'All interviews. Each links to an application, candidate and request; interview status is separate from application status.'} />
      <div className="toolbar">
        <input placeholder="Search interview no / type…" value={filter.q} onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))} style={{ minWidth: 220 }} />
        <select value={filter.status} onChange={(e) => setFilter((f) => ({ ...f, status: e.target.value }))}>
          <option value="">All statuses</option>{Object.entries(IV_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
        <div className="spacer" />
        {data && <span className="muted">{data.interviews.length} interviews</span>}
      </div>
      <div className="card">
        {!data ? <Skeleton /> : data.interviews.length === 0 ? <Empty icon="📅" text="No interviews." /> : (
          <table>
            <thead><tr><th>Interview</th><th>Candidate</th><th>Request</th><th>Type / Mode</th><th>Scheduled</th><th>Status</th><th>Outcome</th><th>App Status</th></tr></thead>
            <tbody>{data.interviews.map((iv) => (
              <tr key={iv.id} style={{ cursor: 'pointer' }} onClick={() => setSelected(iv.id)}>
                <td><strong>{iv.interviewNo}</strong><div className="muted">R{iv.round}</div></td>
                <td>{iv.candidate?.fullName}<div className="muted">{iv.candidate?.currentPosition || ''}</div></td>
                <td>{iv.request?.ticketNo}<div className="muted">{iv.request?.title}</div></td>
                <td>{iv.interviewType}<div className="muted">{iv.mode}</div></td>
                <td className="muted">{fmtDate(iv.scheduledAt)}</td>
                <td><IvStatusBadge status={iv.status} /></td>
                <td>{iv.overallOutcome ? <Badge variant={(IV_OUTCOME[iv.overallOutcome] || {}).variant || 'soft'}>{(IV_OUTCOME[iv.overallOutcome] || {}).label || iv.overallOutcome}</Badge> : <span className="muted">—</span>}</td>
                <td><span className="muted" title="Application pipeline status (separate)">{iv.application?.status ? <AppStatusBadge status={iv.application.status} /> : '—'}</span></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function InterviewDetail({ id, user, onBack }) {
  const toast = useToast();
  const [iv, setIv] = useState(null);
  const [fbOpen, setFbOpen] = useState(false);
  const [action, setAction] = useState(null);
  const btns = useResolvedButtons();
  const load = useCallback(async () => { setIv((await api.get('/interviews/' + id)).interview); }, [id]);
  useEffect(() => { load(); }, [id]);
  if (!iv) return <Skeleton rows={8} />;

  async function setStatus(status, reason) {
    try { await api.post(`/interviews/${id}/status`, { status, reason }); toast('Interview ' + status); load(); }
    catch (e) { toast(e.message, 'error'); }
  }
  const canEdit = btns.cancel_interview?.visible || btns.complete_interview?.visible;
  const canFeedback = btns.add_feedback?.visible;
  const active = !['cancelled', 'completed'].includes(iv.status);

  return (
    <div>
      <div className="breadcrumb"><a href="#" onClick={(e) => { e.preventDefault(); onBack(); }}>← Interviews</a></div>
      <div className="page-head">
        <div><h1 className="page-title">{iv.interviewType} interview — {iv.candidate?.fullName}</h1>
          <p className="page-sub"><strong>{iv.interviewNo}</strong> · <IvStatusBadge status={iv.status} /> · {fmtDate(iv.scheduledAt)}</p></div>
        <div style={{ display: 'flex', gap: 8 }}>
          {canFeedback && iv.status !== 'cancelled' && <button className="btn" onClick={() => setFbOpen(true)}>{iv.myFeedback ? 'Update My Feedback' : 'Add Feedback'}</button>}
          {btns.complete_interview?.visible && ['scheduled', 'rescheduled'].includes(iv.status) && <button className="btn btn-secondary" onClick={() => setStatus('completed')}>Mark Completed</button>}
          {btns.complete_interview?.visible && ['scheduled', 'rescheduled'].includes(iv.status) && <button className="btn btn-secondary" onClick={() => setStatus('no_show', 'Candidate did not attend')}>Mark No-Show</button>}
          {btns.cancel_interview?.visible && active && <button className="btn btn-danger" onClick={() => setAction({ title: 'Cancel Interview', run: (reason) => { setAction(null); setStatus('cancelled', reason); } })}>Cancel</button>}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className="card card-pad">
          <div className="section-title" style={{ marginTop: 0 }}>Links</div>
          <Info label="Candidate">{iv.candidate?.fullName} ({iv.candidate?.candidateNo})</Info>
          <Info label="Request">{iv.request?.ticketNo} — {iv.request?.title}</Info>
          <Info label="Application">{iv.application?.applicationNo} · <strong>pipeline:</strong> {iv.application?.status ? <AppStatusBadge status={iv.application.status} /> : '—'}</Info>
          <p className="muted">↑ The application's pipeline status is shown for context and is <strong>not</strong> changed by this interview.</p>
          <div className="section-title">Details</div>
          <Info label="Type / Mode">{iv.interviewType} · {iv.mode}</Info>
          <Info label="Round">{iv.round}</Info>
          <Info label="Duration">{iv.durationMin} min</Info>
          <Info label="Location / Link">{iv.locationOrLink || '—'}</Info>
          <Info label="Organizer">{iv.organizer?.name}</Info>
          {iv.cancelReason && <Info label="Cancel Reason">{iv.cancelReason}</Info>}
          <div className="section-title">Panel</div>
          <div>{iv.panel.map((m) => <span key={m.id} className="chip">{m.name}{m.isLead ? ' (lead)' : ''}</span>)}</div>
        </div>

        <div className="card card-pad">
          <div className="row-between"><div className="section-title" style={{ marginTop: 0 }}>Feedback</div>
            {iv.overallOutcome && <Badge variant={(IV_OUTCOME[iv.overallOutcome] || {}).variant || 'soft'}>{(IV_OUTCOME[iv.overallOutcome] || {}).label}</Badge>}</div>
          {(iv.feedback || []).length === 0 ? <p className="muted">No feedback yet.</p> : iv.feedback.map((f) => (
            <div key={f.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
              <div className="row-between"><strong>{f.interviewerName}</strong>{f.recommendation && <Badge variant={['strong_yes', 'yes'].includes(f.recommendation) ? 'success' : 'critical'}>{REC_LABEL[f.recommendation]}</Badge>}</div>
              {f.overallScore != null && <div className="muted">Score: {f.overallScore}/5</div>}
              {f.comments && <div style={{ marginTop: 4 }}>{f.comments}</div>}
              <div className="muted" style={{ fontSize: 11 }}>{fmtDate(f.submittedAt)}</div>
            </div>
          ))}
          <div className="section-title">Activity</div>
          {(iv.activity || []).map((a) => <div key={a.id} style={{ fontSize: 12.5, padding: '4px 0' }}><strong style={{ textTransform: 'capitalize' }}>{a.type.replace(/_/g, ' ')}</strong>{a.note ? ' — ' + a.note : ''} <span className="muted">· {a.actor_name} · {fmtDate(a.occurred_at)}</span></div>)}
        </div>
      </div>

      {fbOpen && <FeedbackModal interviewId={id} onClose={() => setFbOpen(false)} onSaved={() => { setFbOpen(false); load(); }} />}
      {action && <Confirm title={action.title} message="Provide a reason. Recorded in the audit trail." requireReason danger onConfirm={action.run} onClose={() => setAction(null)} />}
    </div>
  );
}

function FeedbackModal({ interviewId, onClose, onSaved }) {
  const toast = useToast();
  const [f, setF] = useState({ recommendation: 'yes', overallScore: 4, comments: '' });
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try { await api.post(`/interviews/${interviewId}/feedback`, { recommendation: f.recommendation, overallScore: Number(f.overallScore), comments: f.comments }); toast('Feedback submitted'); onSaved(); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }
  return (
    <Modal title="Interview Feedback" onClose={onClose}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn" onClick={save} disabled={busy}>Submit</button></>}>
      <div className="field"><label>Recommendation</label><select value={f.recommendation} onChange={(e) => setF((s) => ({ ...s, recommendation: e.target.value }))}>{Object.entries(REC_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
      <div className="field"><label>Overall Score (0–5)</label><input type="number" min="0" max="5" step="0.5" value={f.overallScore} onChange={(e) => setF((s) => ({ ...s, overallScore: e.target.value }))} /></div>
      <div className="field"><label>Comments</label><textarea rows="4" value={f.comments} onChange={(e) => setF((s) => ({ ...s, comments: e.target.value }))} /></div>
    </Modal>
  );
}

/* ============================ PHASE 5: Offers & Joining ============================ */
const OFFER_STATUS = {
  draft: { label: 'Draft', variant: 'soft' },
  pending_approval: { label: 'Pending Approval', variant: 'warning' },
  approved: { label: 'Approved', variant: 'success' },
  rejected_by_approver: { label: 'Rejected by Approver', variant: 'critical' },
  sent: { label: 'Sent', variant: 'info' },
  accepted: { label: 'Accepted', variant: 'success' },
  rejected_by_candidate: { label: 'Rejected by Candidate', variant: 'critical' },
  withdrawn: { label: 'Withdrawn', variant: 'critical' },
  joined: { label: 'Joined', variant: 'success' },
};
function OfferStatusBadge({ status }) { const s = OFFER_STATUS[status] || { label: status, variant: 'soft' }; return <Badge variant={s.variant}>{s.label}</Badge>; }
function SalaryCell({ visible, value, currency }) {
  if (!visible) return <span className="muted" title="Restricted">Restricted</span>;
  return <span>{value != null ? `${value} ${currency || ''}` : '—'}</span>;
}

function CreateOfferModal({ application, onClose, onCreated }) {
  const toast = useToast();
  const [meta, setMeta] = useState(null);
  const [f, setF] = useState({ positionTitle: application.position || '', salaryOffered: '', currency: 'EGP', benefits: '', joiningDate: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  useEffect(() => { api.get('/offers/meta/form').then(setMeta).catch(() => {}); }, []);
  async function save() {
    setBusy(true);
    try {
      const body = { applicationId: application.id, ...f };
      if (body.salaryOffered === '') body.salaryOffered = null;
      const r = await api.post('/offers', body);
      toast('Offer created: ' + r.offer.offerNo); onCreated();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }
  return (
    <Modal title={`Generate Offer — ${application.candidate?.fullName || ''}`} onClose={onClose} wide
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn" onClick={save} disabled={busy}>{busy ? 'Creating…' : 'Create Offer'}</button></>}>
      <p className="muted" style={{ marginTop: 0 }}>Links to application <strong>{application.applicationNo}</strong>. Creating an offer moves the application to <strong>Offer Preparation</strong>.</p>
      <div className="form-grid">
        <div className="field full"><label>Position Title</label><input value={f.positionTitle} onChange={(e) => set('positionTitle', e.target.value)} /></div>
        {meta?.canEditSalary && <>
          <div className="field"><label>Salary Offered</label><input type="number" value={f.salaryOffered} onChange={(e) => set('salaryOffered', e.target.value)} /></div>
          <div className="field"><label>Currency</label><input value={f.currency} onChange={(e) => set('currency', e.target.value)} /></div>
        </>}
        <div className="field"><label>Joining Date</label><input type="date" value={f.joiningDate} onChange={(e) => set('joiningDate', e.target.value)} /></div>
        <div className="field full"><label>Benefits</label><input value={f.benefits} onChange={(e) => set('benefits', e.target.value)} placeholder="Housing, transport, medical…" /></div>
        <div className="field full"><label>Notes</label><textarea rows="3" value={f.notes} onChange={(e) => set('notes', e.target.value)} /></div>
      </div>
      {meta && !meta.canEditSalary && <p className="muted">Salary fields are hidden — your role cannot set offer salary.</p>}
    </Modal>
  );
}

function OffersPage({ user }) {
  const [offers, setOffers] = useState(null);
  const [filter, setFilter] = useState({ status: '', q: '', joiningFrom: '', joiningTo: '' });
  const [selected, setSelected] = useState(null);
  const load = useCallback(async () => {
    setOffers(null);
    const params = new URLSearchParams();
    Object.entries(filter).forEach(([k, v]) => { if (v) params.set(k, v); });
    setOffers((await api.get('/offers?' + params.toString())).offers);
  }, [filter]);
  useEffect(() => { load(); }, [load]);

  if (selected) return <OfferDetail id={selected} user={user} onBack={() => { setSelected(null); load(); }} />;
  return (
    <div>
      <PageHead crumb="Recruitment / Offers" title="Offers" sub="Offer preparation, approval, result tracking and joining. Salary is shown only to authorized roles." />
      <div className="toolbar">
        <input placeholder="Search offer no / position…" value={filter.q} onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))} style={{ minWidth: 220 }} />
        <select value={filter.status} onChange={(e) => setFilter((f) => ({ ...f, status: e.target.value }))}>
          <option value="">All statuses</option>{Object.entries(OFFER_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
        <label className="muted" style={{ fontSize: 12 }}>Joining from <input type="date" value={filter.joiningFrom} onChange={(e) => setFilter((f) => ({ ...f, joiningFrom: e.target.value }))} /></label>
        <div className="spacer" />
        {offers && <span className="muted">{offers.length} offers</span>}
      </div>
      <div className="card">
        {!offers ? <Skeleton /> : offers.length === 0 ? <Empty icon="📑" text="No offers." /> : (
          <table>
            <thead><tr><th>Offer</th><th>Candidate</th><th>Request</th><th>Position</th><th>Project</th><th>Salary</th><th>Status</th><th>Prepared By</th><th>Approved By</th><th>Joining</th></tr></thead>
            <tbody>{offers.map((o) => (
              <tr key={o.id} style={{ cursor: 'pointer' }} onClick={() => setSelected(o.id)}>
                <td><strong>{o.offerNo}</strong></td>
                <td>{o.candidate?.fullName}</td>
                <td>{o.request?.ticketNo}</td>
                <td>{o.positionTitle}</td>
                <td>{o.project?.name || '—'}</td>
                <td><SalaryCell visible={o.salaryVisible} value={o.salaryOffered} currency={o.currency} /></td>
                <td><OfferStatusBadge status={o.status} /></td>
                <td className="muted">{o.preparedBy?.name || '—'}</td>
                <td className="muted">{o.approvedBy?.name || '—'}</td>
                <td className="muted">{fmtDateShort(o.joiningDate)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function OfferDetail({ id, user, onBack }) {
  const toast = useToast();
  const [o, setO] = useState(null);
  const [action, setAction] = useState(null);
  const btns = useResolvedButtons();
  const load = useCallback(async () => { setO((await api.get('/offers/' + id)).offer); }, [id]);
  useEffect(() => { load(); }, [id]);
  if (!o) return <Skeleton rows={8} />;

  async function act(path, body, okMsg) {
    try { const r = await api.post(`/offers/${id}/${path}`, body || {}); setO(r.offer); toast(okMsg); }
    catch (e) { toast(e.message, 'error'); }
  }
  const s = o.status;
  return (
    <div>
      <div className="breadcrumb"><a href="#" onClick={(e) => { e.preventDefault(); onBack(); }}>← Offers</a></div>
      <div className="page-head">
        <div><h1 className="page-title">Offer — {o.candidate?.fullName}</h1>
          <p className="page-sub"><strong>{o.offerNo}</strong> · <OfferStatusBadge status={o.status} /> · {o.request?.ticketNo}</p></div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: 520 }}>
          {btns.submit_offer?.visible && s === 'draft' && <button className="btn" onClick={() => act('submit', {}, 'Submitted for approval')}>Submit for Approval</button>}
          {btns.approve_offer?.visible && s === 'pending_approval' && <button className="btn" onClick={() => act('approve', {}, 'Approved')}>Approve</button>}
          {btns.reject_offer_approval?.visible && s === 'pending_approval' && <button className="btn btn-danger" onClick={() => setAction({ title: 'Reject Offer (Approver)', path: 'reject-approval', body: (r) => ({ reason: r }), msg: 'Offer rejected' })}>Reject</button>}
          {btns.send_offer?.visible && s === 'approved' && <button className="btn" onClick={() => act('send', {}, 'Offer sent')}>Send Offer</button>}
          {btns.accept_offer?.visible && s === 'sent' && <button className="btn" onClick={() => act('result', { result: 'accepted' }, 'Marked accepted')}>Mark Accepted</button>}
          {btns.reject_offer_candidate?.visible && ['sent', 'accepted'].includes(s) && <button className="btn btn-danger" onClick={() => setAction({ title: 'Mark Rejected by Candidate', path: 'result', body: (r) => ({ result: 'rejected_by_candidate', reason: r }), msg: 'Marked rejected by candidate' })}>Rejected by Candidate</button>}
          {btns.withdraw_offer?.visible && !['joined', 'withdrawn', 'rejected_by_candidate'].includes(s) && <button className="btn btn-danger" onClick={() => setAction({ title: 'Withdraw Offer', path: 'result', body: (r) => ({ result: 'withdrawn', reason: r }), msg: 'Offer withdrawn' })}>Withdraw</button>}
          {btns.mark_joined?.visible && s === 'accepted' && <button className="btn" onClick={() => act('result', { result: 'joined' }, 'Marked joined')}>Mark Joined</button>}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className="card card-pad">
          <div className="section-title" style={{ marginTop: 0 }}>Offer</div>
          <Info label="Candidate">{o.candidate?.fullName} ({o.candidate?.candidateNo})</Info>
          <Info label="Request">{o.request?.ticketNo} — {o.request?.title}</Info>
          <Info label="Application">{o.application?.applicationNo} · <strong>pipeline:</strong> {o.application?.status ? <AppStatusBadge status={o.application.status} /> : '—'}</Info>
          <Info label="Position">{o.positionTitle}</Info>
          <Info label="Project">{o.project?.name}</Info>
          {o.salaryVisible
            ? <Info label="Salary Offered">{o.salaryOffered != null ? `${o.salaryOffered} ${o.currency}` : '—'}</Info>
            : <Info label="Salary Offered"><span className="muted">Restricted</span></Info>}
          {o.salaryVisible && <Info label="Benefits">{o.benefits || '—'}</Info>}
          <Info label="Joining Date">{fmtDateShort(o.joiningDate)}</Info>
          <Info label="Prepared By">{o.preparedBy?.name}</Info>
          <Info label="Approved By">{o.approvedBy?.name || '—'}</Info>
          {o.rejectionReason && <Info label="Rejection Reason">{o.rejectionReason}</Info>}
          {o.withdrawalReason && <Info label="Withdrawal Reason">{o.withdrawalReason}</Info>}
          {o.notes && <Info label="Notes">{o.notes}</Info>}
        </div>
        <div className="card card-pad">
          <div className="section-title" style={{ marginTop: 0 }}>Approval Timeline</div>
          {(o.approvals || []).length === 0 ? <p className="muted">Not submitted for approval yet.</p> : (
            <table><thead><tr><th>Level</th><th>Stage</th><th>Decision</th><th>By</th><th>When</th></tr></thead>
              <tbody>{o.approvals.map((a) => <tr key={a.id}><td>{a.level}</td><td>{a.name}</td><td><Badge variant={a.decision === 'approved' ? 'success' : a.decision === 'rejected' ? 'critical' : 'warning'}>{a.decision}</Badge></td><td className="muted">{a.approver_id ? '#' + a.approver_id : '—'}</td><td className="muted">{fmtDate(a.decided_at)}</td></tr>)}</tbody></table>
          )}
          <div className="section-title">Activity</div>
          {(o.activity || []).map((a) => <div key={a.id} style={{ fontSize: 12.5, padding: '4px 0' }}><strong style={{ textTransform: 'capitalize' }}>{a.type.replace(/_/g, ' ')}</strong>{a.note ? ' — ' + a.note : ''} <span className="muted">· {a.actor_name} · {fmtDate(a.occurred_at)}</span></div>)}
        </div>
      </div>

      {action && <Confirm title={action.title} message="Provide a reason. Recorded in the audit trail." requireReason danger
        onConfirm={(r) => { const a = action; setAction(null); act(a.path, a.body(r), a.msg); }} onClose={() => setAction(null)} />}
    </div>
  );
}

/* ----------------------------- Root App ----------------------------- */
function App() {
  const [booting, setBooting] = useState(true);
  const [user, setUser] = useState(null);
  const [branding, setBranding] = useState(null);

  const loadBranding = useCallback(async () => {
    try { const { branding } = await api.get('/settings/branding'); setBranding(branding); applyBranding(branding); return branding; }
    catch { return null; }
  }, []);

  useEffect(() => {
    (async () => {
      await loadBranding();
      if (api.token) { try { const { user } = await api.get('/auth/me'); setUser(user); } catch { api.setToken(null); } }
      setBooting(false);
    })();
  }, []);

  async function onLogin(u) { setUser(u); await loadBranding(); }
  async function onLogout() { try { await api.post('/auth/logout', {}); } catch {} api.setToken(null); setUser(null); }

  if (booting) return <div className="boot-loading">Loading Arabtec Recruitment Hub…</div>;
  if (!user) return <Login branding={branding} onLogin={onLogin} />;
  return (
    <AppCtx.Provider value={{ user }}>
      <Shell user={user} branding={branding} onLogout={onLogout} refreshBranding={loadBranding} />
    </AppCtx.Provider>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <ToastProvider><App /></ToastProvider>
);
