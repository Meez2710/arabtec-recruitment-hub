/* Arabtec Recruitment Hub — Phase 1 SPA (React via Babel standalone).
   Single-file app: API client, auth, shell, dashboard, and admin modules.
   Permissions/buttons are resolved from the server; UI also hides what the
   user can't use, but the server is the source of truth (RBAC in logic). */
const { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext } = React;

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
  del(p) { return this.call(p, { method: 'DELETE' }); },
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
// Expose the existing authenticated client to approved drop-in page modules.
window.ARABTEC_API = api;

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
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4.2-4.2',
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
// Set true when the admin has uploaded a custom logo (read from branding on load).
// A cache-busting version stamp forces the browser to re-fetch after a replace.
let HAS_CUSTOM_LOGO = false;
let LOGO_VERSION = Date.now();
function customLogoUrl() { return '/api/admin-ui/logo?v=' + LOGO_VERSION; }
function setHasCustomLogo(v, version) {
  HAS_CUSTOM_LOGO = !!v;
  if (version) LOGO_VERSION = version;
  // Keep the browser tab favicon in sync with the uploaded logo.
  try {
    let link = document.querySelector("link[rel='icon']");
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
    if (HAS_CUSTOM_LOGO) { link.type = 'image/png'; link.href = customLogoUrl(); }
    // Must match the <link rel=icon> in index.html. This line used to point at
    // /logo.svg — a hand-drawn approximation of the mark with the wordmark baked
    // in — and because it runs on every boot it silently overrode the correct
    // icon set in the HTML. That is what put the wrong logo in the browser tab.
    else { link.type = 'image/svg+xml'; link.href = '/arabtec-favicon.svg'; }
  } catch {}
}
function Logo({ size = 28, color = 'var(--brand)', withText = false, textColor }) {
  // A custom uploaded logo replaces the built-in mark everywhere.
  if (HAS_CUSTOM_LOGO) {
    return <img src={customLogoUrl()} alt="Logo" style={{ height: withText ? size * 1.0 : size, maxWidth: size * 3.2, objectFit: 'contain', display: 'block' }} onError={(e) => { e.target.style.display = 'none'; }} />;
  }
  // Built-in mark = /arabtec-logo.svg, the brand vector itself (600x396). It is
  // rendered with object-fit:contain inside a square-ish box, so it keeps its
  // true 1.515 aspect ratio at every size and can never be squashed.
  // The `color` prop does not apply to a supplied asset and is unused here.
  const mark = (
    <img src="/arabtec-logo.svg" alt="Arabtec"
      style={{ width: size, maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' }} />
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
  // WHAT BRANDING MAY DRIVE, AND WHAT IT MAY NOT.
  //
  // These are written as INLINE styles on <html>, so they beat every rule in
  // every stylesheet — including the Arabtec design system. That is correct for
  // a tenant's own colours and wrong for everything else, because the seeded
  // rows predate the design system and still hold its previous defaults: a
  // system font stack, 6px/8px radii, and off-palette status colours. Left in
  // the map they silently reverted the design system at runtime, which is why
  // the product kept rendering in the old typeface however the CSS was edited.
  //
  // Same reasoning the line below already applies to --bg, generalised.
  const map = {
    primary_color: '--primary', secondary_color: '--secondary', accent_color: '--accent',
    button_color: '--button',
  };
  for (const [k, cssVar] of Object.entries(map)) if (b[k]) r.setProperty(cssVar, b[k]);
  // Typography, geometry, neutrals and status colours belong to the design
  // system. Status colours especially: a configurable "success" that is not
  // green is not branding, it is a defect. Cleared rather than ignored, so a
  // value stored by an older build stops applying on the next load.
  for (const owned of ['--font', '--radius', '--card-radius', '--surface',
    '--text-dark', '--text-gray', '--border', '--success', '--warning', '--critical']) {
    r.removeProperty(owned);
  }
  // Page background (--bg) is OWNED BY THE STYLESHEET (warm off-white #f6f3ec).
  // We deliberately do NOT let branding's background_color drive it: legacy/stale
  // rows carry cool greys/whites (e.g. #f6f7f9) that made the page look grey.
  // Always clear any inline override so the stylesheet off-white wins.
  r.removeProperty('--bg');
  // The Control Center "Primary Color" (stored as button_color) drives the brand
  // accent app-wide: buttons, links, nav highlight, the ticket left-accent, focus rings.
  const primary = b.button_color || b.primary_color;
  if (primary) {
    r.setProperty('--brand', primary);
    r.setProperty('--ticket-accent', primary);
    r.setProperty('--brand-dark', shadeColor(primary, -14)); // darker hover
    r.setProperty('--ticket-accent-dark', shadeColor(primary, -14));
  }
  document.title = (b.company_name || 'Arabtec Recruitment Hub');
}
// Lighten/darken a hex color by percent (-100..100). Used to derive the hover shade.
function shadeColor(hex, percent) {
  try {
    const h = hex.replace('#', '');
    const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    let r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16);
    const f = (v) => Math.max(0, Math.min(255, Math.round(v + (percent / 100) * 255)));
    return '#' + [f(r), f(g), f(b)].map((v) => v.toString(16).padStart(2, '0')).join('');
  } catch { return hex; }
}

/* ----------------------------- Auth context ----------------------------- */
const AppCtx = createContext(null);
const useApp = () => useContext(AppCtx);

function can(user, perm) { return user?.permissions?.includes(perm); }

/* ----------------------------- Display formatters -----------------------------
   DISPLAY ONLY. These never touch stored values, API payloads, search params or
   filters — the backend remains the source of truth for ticket_no and for the
   separate project / site / location fields. */

// Shorten a request code for display: REQ-2026-00001 → RQ-26-001
// Also handles REQ-2026-0001 and REQ-2026-001 (all → RQ-26-001).
// Any string that does not match PREFIX-YYYY-DIGITS is returned unchanged.
function shortReqCode(code) {
  if (!code || typeof code !== 'string') return code;
  const m = code.trim().match(/^[A-Za-z]+-(\d{4})-(\d+)$/);
  if (!m) return code;                                  // unknown format → leave as-is
  const yy = m[1].slice(-2);                            // 2026 → 26
  const seq = String(parseInt(m[2], 10));               // 00001 → "1"
  return `RQ-${yy}-${seq.padStart(3, '0')}`;            // → RQ-26-001
}

// Inverse of shortReqCode for SEARCH INPUT ONLY: expand a displayed short code back
// to the stored form so the existing server-side `q` (which matches ticket_no) can
// find it.  RQ-26-001 → REQ-2026-00001
// Anything that is not an unambiguous short code is returned untouched, so ordinary
// text searches ("Site Engineer") and full stored codes are unaffected.
// Assumes the default 'REQ' prefix and 5-digit zero padding (see Requests.nextTicketNo).
function expandReqCode(input) {
  if (!input || typeof input !== 'string') return input;
  const m = input.trim().match(/^rq-(\d{2}|\d{4})-(\d{1,5})$/i);
  if (!m) return input;                                   // not a short code → unchanged
  const yr = m[1].length === 2 ? `20${m[1]}` : m[1];      // 26 → 2026 (4-digit passes through)
  return `REQ-${yr}-${m[2].padStart(5, '0')}`;            // → REQ-2026-00001
}

// One compact place label for a request: Project · Site · Location.
// Duplicates are removed and empty parts skipped; returns '—' when nothing is set.
function placeLabel(r) {
  if (!r) return '—';
  const parts = [r.project?.name, r.site?.name, r.location]
    .map((p) => (typeof p === 'string' ? p.trim() : p))
    .filter(Boolean);
  const seen = new Set();
  const uniq = parts.filter((p) => {
    const k = String(p).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  return uniq.length ? uniq.join(' · ') : '—';
}

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
/**
 * Collect a short free-text reason before a destructive action.
 *
 * Replaces window.prompt(), which was used for exactly this. Three problems
 * with the native dialog: it cannot be styled, it blocks the whole tab, and
 * Chrome suppresses repeated dialogs from the same page — so a recruiter
 * rejecting several candidates in a row silently stops being asked, and the
 * call goes out with no reason and comes back 400.
 */
function ReasonModal({ title, label, confirmLabel, placeholder, onClose, onConfirm }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.focus(); }, []);
  const ok = reason.trim().length > 0;

  async function confirm() {
    if (!ok || busy) return;
    setBusy(true);
    try { await onConfirm(reason.trim()); } finally { setBusy(false); }
  }

  return (
    <Modal title={title} onClose={onClose}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-danger" onClick={confirm} disabled={!ok || busy}>
          {busy ? 'Working…' : (confirmLabel || 'Confirm')}
        </button>
      </>}>
      <div className="field">
        <label htmlFor="reason-input">{label}</label>
        <textarea id="reason-input" ref={ref} rows={3} value={reason}
          placeholder={placeholder || 'This is recorded on the candidate and is visible to the team.'}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) confirm(); }} />
        {/* Stated, not enforced by a silent disable with no explanation. */}
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          A reason is required. It is stored with the decision so the call can be explained later.
        </div>
      </div>
    </Modal>
  );
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
function Empty({ icon, text, title, action }) {
  return (
    <div className="empty">
      <div className="ico" aria-hidden="true">
        {icon
          ? <span style={{ fontSize: 26, lineHeight: 1, opacity: .55 }}>{icon}</span>
          : (
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: .5 }}>
              <path d="M3 7l9-4 9 4-9 4-9-4zM3 7v10l9 4 9-4V7M3 12l9 4 9-4" />
            </svg>
          )}
      </div>
      {title && <h4 className="empty-title">{title}</h4>}
      <p>{text}</p>
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

// Distinct treatment for a failed load — so "couldn't reach the server" never
// looks identical to "no results". Keeps the caller's optional retry action.
function ErrorState({ text, action }) {
  return (
    <div className="empty">
      <div className="ico" aria-hidden="true" style={{ color: 'var(--danger, #D01827)' }}>
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
        </svg>
      </div>
      <h4 className="empty-title">Couldn’t load this</h4>
      <p>{text || 'Something went wrong reaching the server. Try again in a moment.'}</p>
      {action && <div className="empty-action">{action}</div>}
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
      const { token, user, mustChangePassword } = await api.post('/auth/login', { email, password, remember });
      // Keep the flag on the object the app renders from, so the forced-rotation
      // screen engages immediately rather than after the next /auth/me.
      api.setToken(token); onLogin({ ...user, mustChangePassword: !!mustChangePassword });
    } catch (e) { setErr(e.message || 'Login failed'); } finally { setBusy(false); }
  }
  async function doForgot() {
    try { const r = await api.post('/auth/forgot-password', { email }); setForgot(r.message); }
    catch (e) { setForgot(e.message); }
  }
  const name = branding?.company_name || 'Arabtec Recruitment Hub';
  return (
    <div className="login-wrap">
      {/* Left visual panel — artwork comes from /bgats.png via .login-brand in styles.css.
          The wordmark is intentionally NOT repeated here (it already appears in the image);
          a small platform label is used instead. */}
      <div className="login-brand">
        <span className="login-brand-label">ATS Platform</span>
        <h1>Hiring, smarter than ever.</h1>
        <p>End-to-end recruitment tracking. Create requests, manage candidates, and move them through your hiring pipeline.</p>
      </div>
      <div className="login-form-side">
        <form className="login-card" onSubmit={submit}>
          <h2>Sign in</h2>
          <p className="sub">Use your {name} account.</p>
          {err && <div className="error-banner">{err}</div>}
          {forgot && <div className="success-banner">{forgot}</div>}
          <div className="field"><label>Work Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@arabtec.com" autoComplete="username" autoFocus required /></div>
          <div className="field"><label>Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoComplete="current-password" required /></div>
          <div className="row-between" style={{ marginBottom: 20 }}>
            <label className="checkbox"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember me</label>
            <a href="#" onClick={(e) => { e.preventDefault(); doForgot(); }}>Forgot password?</a>
          </div>
          <button className="btn btn-block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <p className="login-note">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M12 3l7 4v5c0 4.5-3 8-7 9-4-1-7-4.5-7-9V7z" />
            </svg>
            <span>Secure sign-in. Repeated failed attempts are rate-limited and the account is temporarily locked.</span>
          </p>
        </form>
      </div>
    </div>
  );
}

/* ----------------------------- Navigation config ----------------------------- */
const NAV = [
  /* Order follows the approved internal UI reference (§02): Workspace first,
     Administration second. Route keys and permissions are unchanged. */
  { section: 'Workspace' },
  { key: 'dashboard', label: 'Dashboard', icon: 'dashboard', perm: 'dashboard.view' },
  { key: 'requests', label: 'Hiring Requests', icon: 'ticket', anyPerm: ['request.view_all', 'request.view_own'] },
  { key: 'candidates', label: 'Talent Pool', icon: 'user', perm: 'candidate.view' },
  { key: 'candidateReview', label: 'Candidate Review', icon: 'shield', perm: 'candidate.view' },
  { key: 'interviews', label: 'Interviews', icon: 'calendar', anyPerm: ['interview.view_all', 'interview.view_assigned'] },
  { key: 'offers', label: 'Offers', icon: 'doc', perm: 'offer.view' },
  { key: 'reports', label: 'Reports', icon: 'scroll', perm: 'dashboard.view' },
  { section: 'Administration' },
  { key: 'projects', label: 'Projects', icon: 'hardhat', perm: null },
  { key: 'sites', label: 'Sites', icon: 'pin', perm: null },
  { key: 'departments', label: 'Departments', icon: 'building', perm: null },
  { key: 'notifications', label: 'Notification Settings', icon: 'bell', perm: 'notification.manage' },
  { key: 'users', label: 'Users', icon: 'users', perm: 'user.manage' },
  { key: 'roles', label: 'Roles & Permissions', icon: 'shield', perm: 'role.manage' },
  { key: 'control', label: 'Control Center', icon: 'gear', perm: 'app.manage_ui' },
  { key: 'branding', label: 'Branding Settings', icon: 'palette', perm: 'branding.manage' },
  { key: 'buttons', label: 'Button Settings', icon: 'button', perm: 'button.manage' },
  { key: 'workflow', label: 'Workflow Settings', icon: 'flow', perm: 'workflow.manage' },
  { key: 'system', label: 'System Settings', icon: 'gear', perm: 'system.manage' },
  { key: 'audit', label: 'Audit Log', icon: 'scroll', perm: 'audit.view' },
];

/* ----------------------------- Shell ----------------------------- */
/* ----------------------------- Notification bell ----------------------------- */
function NotificationBell({ onNavigate }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);

  const load = useCallback(async () => {
    try {
      const r = await api.get('/notifications');
      setItems(r.notifications || []);
      setUnread(r.unreadCount || 0);
    } catch { /* ignore — never break the shell */ }
  }, []);

  // Poll every 45s (and once on mount). Cheap in-app polling; no websockets needed.
  useEffect(() => {
    load();
    const id = setInterval(load, 45000);
    return () => clearInterval(id);
  }, [load]);

  const openPanel = () => { setOpen((o) => !o); if (!open) load(); };

  const markAll = async () => {
    try { await api.post('/notifications/read-all'); } catch {}
    setItems((xs) => xs.map((n) => ({ ...n, isRead: true })));
    setUnread(0);
  };

  const clickItem = async (n) => {
    if (!n.isRead) {
      try { await api.post('/notifications/' + n.id + '/read'); } catch {}
      setUnread((u) => Math.max(0, u - 1));
      setItems((xs) => xs.map((x) => (x.id === n.id ? { ...x, isRead: true } : x)));
    }
    // Deep-link to the related record where we know the route.
    if (n.linkType === 'request' && onNavigate) onNavigate('requests');
    setOpen(false);
  };

  return (
    <div className="notif" style={{ position: 'relative' }}>
      <button className="icon-btn" onClick={openPanel} title="Notifications" aria-label="Notifications">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 01-3.4 0" />
        </svg>
        {unread > 0 && <span className="notif-dot">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="notif-panel" onClick={(e) => e.stopPropagation()}>
          <div className="notif-head">
            <strong>Notifications</strong>
            {unread > 0 && <button className="linklike" onClick={markAll}>Mark all read</button>}
          </div>
          <div className="notif-list">
            {items.length === 0
              ? <div className="notif-empty">You're all caught up.</div>
              : items.slice(0, 20).map((n) => (
                <div key={n.id} className={'notif-item' + (n.isRead ? '' : ' unread')} onClick={() => clickItem(n)}>
                  <div className="notif-title">{n.title}</div>
                  {n.body && <div className="notif-body">{n.body}</div>}
                  <div className="notif-time">{timeAgo(n.createdAt)}</div>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Ctrl/Cmd+K command palette. Plain React on purpose: this frontend has no build
// step (app.jsx is compiled in-browser by Babel), so an npm package like `cmdk`
// cannot be used. Same interaction model: overlay, live search, arrow keys, Enter.
// Replaces a decorative "Ctrl K" badge that previously did nothing.
function CommandPalette({ open, onClose, onPick }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const reqRef = useRef(0);

  useEffect(() => { if (open) { setQ(''); setRows([]); setActive(0); setTimeout(() => inputRef.current && inputRef.current.focus(), 20); } }, [open]);

  // Debounced search. A stale response can never overwrite a newer one.
  useEffect(() => {
    if (!open) return;
    const term = q.trim();
    if (!term) { setRows([]); setBusy(false); return; }
    setBusy(true);
    const myReq = ++reqRef.current;
    const t = setTimeout(async () => {
      try {
        const r = await api.get('/candidates?q=' + encodeURIComponent(term) + '&pageSize=8');
        if (myReq !== reqRef.current) return;
        setRows(r.candidates || []);
        setActive(0);
      } catch { if (myReq === reqRef.current) setRows([]); }
      finally { if (myReq === reqRef.current) setBusy(false); }
    }, 180);
    return () => clearTimeout(t);
  }, [q, open]);

  if (!open) return null;

  function keyDown(e) {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, Math.max(rows.length - 1, 0))); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); return; }
    if (e.key === 'Enter' && rows[active]) { e.preventDefault(); onPick(rows[active]); }
  }

  return (
    <div className="cmdk-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Search candidates">
        <div className="cmdk-input">
          <Icon name="search" size={15} />
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={keyDown}
            autoFocus
            placeholder="Search candidates by name, email, phone, company…" aria-label="Search candidates" />
          <span className="kbd">Esc</span>
        </div>
        <div className="cmdk-list">
          {!q.trim() && <div className="cmdk-hint">Type to search the Talent Pool. ↑↓ to move, Enter to open.</div>}
          {q.trim() && busy && <div className="cmdk-hint">Searching…</div>}
          {q.trim() && !busy && rows.length === 0 && <div className="cmdk-hint">No candidates match “{q.trim()}”.</div>}
          {rows.map((c, i) => (
            <div key={c.id} className={'cmdk-row' + (i === active ? ' is-active' : '')}
              onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); onPick(c); }}>
              <span className="cmdk-av">{initials(c.fullName)}</span>
              <span className="cmdk-txt">
                <span className="cmdk-name">{c.fullName}</span>
                <span className="cmdk-sub">
                  {c.candidateNo}
                  {c.currentPosition ? ' · ' + c.currentPosition : ''}
                  {c.currentCompany ? ' · ' + c.currentCompany : ''}
                </span>
              </span>
              <ParseQuality status={c.parseStatus} confidence={c.parseConfidence} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* Counts shown on the sidebar and used by the dashboard.
   Fetched ONCE per session in the Shell and handed down, so the dashboard does
   not repeat the same `/dashboard` call a moment later. Every figure is already
   role-scoped by the API. */
function useWorkCounts(user) {
  const [counts, setCounts] = useState({ dash: null, intakes: null });
  const reload = useCallback(() => {
    const jobs = [
      can(user, 'dashboard.view') ? api.get('/dashboard').catch(() => null) : Promise.resolve(null),
      can(user, 'candidate.view') ? api.get('/candidates/intakes').catch(() => null) : Promise.resolve(null),
    ];
    Promise.all(jobs).then(([dash, intake]) => {
      setCounts({ dash: dash || null, intakes: intake ? (intake.intakes || []).length : null });
    });
  }, [user.id]);
  useEffect(reload, [reload]);
  return [counts, reload];
}
function navCount(key, counts) {
  const d = counts.dash;
  if (key === 'candidateReview') return counts.intakes || null;
  if (!d) return null;
  if (key === 'interviews') return d.kpis.upcomingInterviews || null;
  if (key === 'offers') {
    const n = (d.offersByStatus || []).filter((o) => o.status === 'pending_approval').reduce((s, o) => s + o.count, 0);
    return n || null;
  }
  if (key === 'requests') return d.kpis.openRequests || null;
  return null;
}

/* ============================== ANYHELP ====================================
   One floating dock, two tabs, both wired to real backends.

   TEAM — the hiring-request conversation, `/api/thread/request/:id`. This is the
     SAME thread the request page renders, with the same server-side rules: you
     may read it if you can view the request, and post only if you are a
     participant. The dock does not create a second messaging subsystem, and it
     never shows a message as sent until the server has returned it. The backend
     scopes a conversation to a hiring request, so the dock asks which request
     when the page you are on is not already one.

   ANYHELP — the assistant, wired to the product's existing Anthropic-backed
     endpoints. A full audit of every branch in this repository (see the report
     accompanying this change) found exactly two AI HTTP surfaces on main:

        GET  /api/candidates/smart-search?q=…          → plain-English talent search
        POST /api/requests/:id/suggest-candidates      → AI shortlist for a request

     There is NO conversational endpoint, on main or on any feature branch, so
     the dock does not pretend there is one: free text is routed to whichever of
     the two real capabilities fits, and everything shown comes back from the
     server. When neither fits, the dock says so in a clearly-labelled UI notice
     rather than generating an answer.

     Both endpoints run under the caller's own token and re-use the same scoping
     and salary rules as every other listing, so the assistant cannot surface a
     record the user could not already open. The dock renders results as text
     nodes (never HTML), and it holds no write capability at all — which is why
     there is no "confirm this action" step to fake.

   TO CONNECT A REAL CONVERSATIONAL BACKEND: implement `anyhelpAsk` below against
   the new endpoint and return the same shape. Nothing else in this component
   needs to change; the status vocabulary already covers proposed/confirming/
   executing/done/failed for a backend that can act.
   ========================================================================= */
const ANYHELP_TEAM_NOTE = 'Team chat is the hiring-request conversation. It is stored on the request, so what is said here stays on the record.';
const ANYHELP_AI_NOTE = 'anyhelp reads. It searches the talent pool in plain English and ranks candidates against a request. It cannot change records, stages, salary or approvals.';

function anyhelpTime(iso) {
  const d = iso ? new Date(iso) : new Date();
  return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/* The assistant's single transport. Returns
     { role, text, items? }            → an answer the server produced, or
     throws                            → the server's own refusal / failure.
   Every branch here calls a real endpoint. Nothing is generated locally except
   the two explicitly-labelled "not available" notices. */
async function anyhelpAsk(text, { user, requestId }) {
  const wantsShortlist = /shortlist|suggest|rank|who (should|could) (i|we)|best candidates?/i.test(text);

  if (wantsShortlist && requestId) {
    if (!can(user, 'candidate.view')) {
      return { role: 'Not available', kind: 'system', text: 'Your role cannot view candidates, so a shortlist is not something anyhelp can show you.' };
    }
    const r = await api.post(`/requests/${requestId}/suggest-candidates`, { limit: 5 });
    const items = (r.suggestions || []).map((s) => ({
      title: s.fullName,
      sub: [s.score != null ? `Score ${s.score}` : null, s.currentPosition, s.currentCompany, s.reason]
        .filter(Boolean).join(' · '),
    }));
    return {
      role: 'AI shortlist', kind: 'ai', items,
      text: items.length
        ? `${items.length} candidate${items.length === 1 ? '' : 's'} from your talent pool, ranked against this request`
          + (r.poolCapped ? ', drawn from a capped pool rather than the whole database' : '')
          + '. Nothing is linked until you link it on the request itself.'
        : 'The shortlist ran against your talent pool and matched nobody for this request. An empty answer is a real answer.',
    };
  }

  if (!can(user, 'candidate.view')) {
    return { role: 'Not available', kind: 'system', text: 'Your role cannot search the talent pool, and there is no other assistant capability connected yet.' };
  }
  const r = await api.get('/candidates/smart-search?q=' + encodeURIComponent(text) + '&pageSize=5');
  const items = (r.candidates || []).map((c) => ({
    title: c.fullName,
    sub: [c.currentPosition, c.currentCompany, c.location,
      c.yearsExperience != null ? `${c.yearsExperience}y` : null].filter(Boolean).join(' · ') || '—',
  }));
  const total = r.pagination ? r.pagination.total : items.length;
  return {
    role: 'Talent pool search', kind: 'ai', items,
    text: (r.interpretation ? `Read as: ${r.interpretation}. ` : '')
      + (items.length
        ? `${total} match${total === 1 ? '' : 'es'} in the talent pool${total > items.length ? `, showing the first ${items.length}` : ''}.`
        : 'Nobody in the talent pool matches that.'),
  };
}

/* The backend's own words beat a generic sentence: a 503 "AI is not configured"
   is far more useful to a recruiter than "something went wrong". */
function serverReason(e) {
  const detail = e && e.data && e.data.detail;
  return [e && e.message, detail && detail !== e.message ? detail : null].filter(Boolean).join(' — ')
    || 'That request failed. Nothing was changed.';
}

function AnyhelpDock({ user, route, context, onNavigate }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('anyhelp');
  const [draft, setDraft] = useState('');
  // Explicit status vocabulary, so the dock can never imply an outcome the
  // backend has not reported: idle | thinking | sending | failed.
  const [status, setStatus] = useState('idle');

  const [thread, setThread] = useState({ state: 'idle', posts: [], error: '' });
  const [aiLog, setAiLog] = useState([]);
  // Team chat is per hiring request. When the page is not a request, the user
  // picks one from the requests they can already see — no new visibility.
  const [pickable, setPickable] = useState(null);
  const [pickedId, setPickedId] = useState(null);

  const threadRef = useRef(null);
  const dockRef = useRef(null);
  const fabRef = useRef(null);
  const contextRequestId = context && context.requestId;
  const requestId = contextRequestId || pickedId;
  const canSeeRequests = can(user, 'request.view_all') || can(user, 'request.view_own');

  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) { if (e.key === 'Escape') { setOpen(false); if (fabRef.current) fabRef.current.focus(); } }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (open && dockRef.current) { const t = dockRef.current.querySelector('textarea, button'); if (t) t.focus(); }
  }, [open]);

  // A request opened on the page always wins over one picked in the dock.
  useEffect(() => { if (contextRequestId) setPickedId(null); }, [contextRequestId]);

  const loadThread = useCallback(() => {
    if (!requestId) { setThread({ state: 'idle', posts: [], error: '' }); return; }
    setThread((t) => ({ ...t, state: 'loading' }));
    api.get(`/thread/request/${requestId}`)
      .then((r) => setThread({ state: 'ready', posts: r.posts || [], error: '' }))
      .catch((e) => setThread({ state: 'error', posts: [], error: serverReason(e) }));
  }, [requestId]);

  useEffect(() => { if (open && tab === 'team') loadThread(); }, [open, tab, loadThread]);

  // Only fetch the picker list when it is actually needed.
  useEffect(() => {
    if (!open || tab !== 'team' || requestId || pickable || !canSeeRequests) return;
    api.get('/requests?pageSize=25')
      .then((r) => setPickable(r.requests || []))
      .catch(() => setPickable([]));
  }, [open, tab, requestId, pickable, canSeeRequests]);

  useEffect(() => { const el = threadRef.current; if (el) el.scrollTop = el.scrollHeight; }, [thread.posts, aiLog, tab, open, status]);

  async function sendTeam(text) {
    setStatus('sending');
    try {
      // The post is rendered only from the server's response — never optimistically.
      await api.post(`/thread/request/${requestId}`, { body: text });
      setDraft('');
      const r = await api.get(`/thread/request/${requestId}`);
      setThread({ state: 'ready', posts: r.posts || [], error: '' });
      setStatus('idle');
    } catch (e) {
      // The draft is kept so nothing the user typed is lost on a refusal.
      setThread((t) => ({ ...t, error: serverReason(e) }));
      setStatus('failed');
    }
  }

  async function sendAnyhelp(text) {
    setAiLog((l) => [...l, { who: user.fullName, role: 'You', time: anyhelpTime(), text, kind: 'mine' }]);
    setDraft('');
    setStatus('thinking');
    try {
      const answer = await anyhelpAsk(text, { user, requestId: contextRequestId });
      setAiLog((l) => [...l, { who: 'anyhelp', time: anyhelpTime(), ...answer }]);
      setStatus('idle');
    } catch (e) {
      setAiLog((l) => [...l, { who: 'anyhelp', role: 'Failed', kind: 'failed', time: anyhelpTime(), text: serverReason(e) }]);
      setStatus('failed');
    }
  }

  function submit(e) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || status === 'thinking' || status === 'sending') return;
    if (tab === 'team') sendTeam(text); else sendAnyhelp(text);
  }

  const busy = status === 'thinking' || status === 'sending';
  const teamPosts = (thread.posts || []).filter((p) => p.type === 'message' || p.type === 'system');
  const contextLine = requestId && !contextRequestId
    ? { title: 'Team conversation', meta: 'On the hiring request you picked' }
    : { title: context.title, meta: context.meta };

  return (
    <>
      <button ref={fabRef} type="button" className={'anyhelp-fab' + (open ? ' is-open' : '')}
        onClick={() => setOpen(true)} aria-expanded={open} aria-controls="anyhelp-dock"
        aria-label="Open anyhelp">
        <span className="anyhelp-fab-mark" aria-hidden="true">a</span>
        <span className="anyhelp-fab-copy"><strong>anyhelp</strong><small>Team + AI</small></span>
      </button>

      {open && (
        <aside id="anyhelp-dock" ref={dockRef} className="anyhelp-dock" role="dialog" aria-label="anyhelp">
          <header className="anyhelp-head">
            <div><p className="anyhelp-kicker">anyhelp</p>
              <strong>{tab === 'team' ? 'Team conversation' : 'Assistant'}</strong></div>
            <button className="icon-btn" onClick={() => { setOpen(false); if (fabRef.current) fabRef.current.focus(); }} aria-label="Close anyhelp">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </header>

          <div className="anyhelp-context">
            <span>{contextLine.title}</span>
            <small>{contextLine.meta}</small>
          </div>

          <div className="anyhelp-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'team'} className={tab === 'team' ? 'on' : ''}
              onClick={() => setTab('team')}>Team</button>
            <button role="tab" aria-selected={tab === 'anyhelp'} className={tab === 'anyhelp' ? 'on' : ''}
              onClick={() => setTab('anyhelp')}>anyhelp</button>
          </div>

          <div className="anyhelp-notice">{tab === 'team' ? ANYHELP_TEAM_NOTE : ANYHELP_AI_NOTE}</div>

          <div className="anyhelp-thread" ref={threadRef}>
            {tab === 'team' ? (
              !requestId ? (
                <div className="anyhelp-empty">
                  <p style={{ margin: '0 0 10px' }}>Team chat lives on a hiring request. Pick the one you want to talk about.</p>
                  {!canSeeRequests ? <span>Your role does not include hiring requests.</span>
                    : pickable == null ? <span>Loading your requests…</span>
                      : !pickable.length ? <span>You have no hiring requests to talk about yet.</span>
                        : (
                          <>
                            <label className="sr-only" htmlFor="anyhelp-request">Hiring request</label>
                            <select id="anyhelp-request" value="" onChange={(e) => setPickedId(Number(e.target.value) || null)}>
                              <option value="">Choose a hiring request…</option>
                              {pickable.map((r) => (
                                <option key={r.id} value={r.id}>{shortReqCode(r.ticketNo)} · {r.title}</option>
                              ))}
                            </select>
                          </>
                        )}
                </div>
              ) : thread.state === 'loading' ? <div className="anyhelp-empty">Loading the conversation…</div>
                : thread.state === 'error' ? (
                  <div className="anyhelp-msg failed"><div className="anyhelp-who"><b>Not loaded</b></div>
                    <p>{thread.error}</p>
                    <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={loadThread}>Try again</button></div>
                ) : !teamPosts.length ? <div className="anyhelp-empty">No messages on this request yet. Say the first thing.</div>
                  : teamPosts.map((p) => (
                    <article key={p.id} className={'anyhelp-msg' + (p.author && p.author.id === user.id ? ' mine' : '') + (p.type === 'system' ? ' system' : '')}>
                      <div className="anyhelp-who"><b>{(p.author && p.author.name) || 'System'}</b>
                        <span>{ROLE_NAMES[p.author && p.author.role] || (p.author && p.author.role) || ''} · {anyhelpTime(p.createdAt)}</span></div>
                      <p>{p.body}</p>
                    </article>
                  ))
            ) : (
              aiLog.length === 0
                ? <div className="anyhelp-empty">
                  Ask in plain English — “quantity surveyors in Cairo with 8+ years”.
                  {contextRequestId ? ' With a hiring request open you can also ask for a shortlist.' : ''}
                </div>
                : aiLog.map((m, i) => (
                  <article key={i} className={'anyhelp-msg ' + (m.kind === 'mine' ? 'mine' : m.kind === 'ai' ? 'ai' : m.kind)}>
                    <div className="anyhelp-who"><b>{m.who}</b><span>{m.role} · {m.time}</span></div>
                    <p>{m.text}</p>
                    {m.items && m.items.length > 0 && (
                      <>
                        <ul className="anyhelp-results">
                          {m.items.map((it, j) => <li key={j}><strong>{it.title}</strong><small>{it.sub}</small></li>)}
                        </ul>
                        <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => onNavigate('candidates')}>Open Talent Pool</button>
                      </>
                    )}
                  </article>
                ))
            )}
            {status === 'thinking' && <div className="anyhelp-status" aria-live="polite">anyhelp is reading your talent pool…</div>}
            {status === 'sending' && <div className="anyhelp-status" aria-live="polite">Sending…</div>}
            {tab === 'team' && status === 'failed' && thread.error && (
              <div className="anyhelp-status failed" aria-live="assertive">Not sent — {thread.error}</div>
            )}
          </div>

          <form className="anyhelp-composer" onSubmit={submit}>
            <label className="sr-only" htmlFor="anyhelp-input">Message anyhelp</label>
            <textarea id="anyhelp-input" rows="2" value={draft} onChange={(e) => setDraft(e.target.value)}
              disabled={busy || (tab === 'team' && !requestId)}
              placeholder={tab === 'team'
                ? (requestId ? 'Message the team on this request…' : 'Pick a hiring request first…')
                : 'Ask anyhelp about your talent pool…'} />
            <button className="btn" type="submit" disabled={busy || !draft.trim() || (tab === 'team' && !requestId)}>
              {busy ? 'Working…' : 'Send'}
            </button>
          </form>
        </aside>
      )}
    </>
  );
}

/* ----------------------------- Shell ----------------------------- */
function Shell({ user, branding, onLogout, refreshBranding }) {
  // Self-service password change, reachable from the user menu.
  const [pwdOpen, setPwdOpen] = useState(false);
  const [route, setRoute] = useState('dashboard');
  // The params a dashboard card (or any other cross-page jump) handed to the
  // destination page — e.g. { priority: 'critical' } for "Critical roles".
  // Reset to null on every navigation that doesn't supply one, so a stale
  // filter from a previous jump can never leak into an unrelated visit.
  const [routeParams, setRouteParams] = useState(null);
  const [collapsed, setCollapsed] = useState(branding?.sidebar_mode === 'collapsed');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);   // drawer, <=900px
  const [moreOpen, setMoreOpen] = useState(false);             // bottom-sheet "More"
  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const density = branding?.table_density || 'comfortable';
  const [counts] = useWorkCounts(user);
  const persona = personaFor(user);
  const roleCode = primaryRole(user);

  // Ctrl/Cmd+K from anywhere. Ignored while typing in a field so it never steals
  // a keystroke from a form the recruiter is filling in.
  useEffect(() => {
    function onKey(e) {
      if (!((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K'))) return;
      const t = e.target;
      const tag = t && t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
      e.preventDefault();
      setPaletteOpen(true);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Any route change closes the mobile chrome, so a drawer never survives a jump.
  // `params` is optional and destination-specific — a dashboard card passes the
  // filter it wants the landing page pre-scoped to; a plain nav click passes
  // nothing, which clears whatever the previous jump left behind.
  const go = useCallback((r, params = null) => {
    setRoute(r); setRouteParams(params); setMobileNavOpen(false); setMoreOpen(false);
  }, []);

  const visibleNav = NAV.filter((n) => n.section || (n.anyPerm ? n.anyPerm.some((p) => can(user, p)) : (!n.perm || can(user, n.perm))));
  const navItems = visibleNav.filter((n) => !n.section);
  // Five-item bottom bar: the four most-used sections this role can reach, plus More.
  const primaryMobile = navItems.slice(0, 4);

  const CandidateReviewPage = window.ArabtecCandidateIntakeReviewPage;
  const Page = {
    dashboard: <Dashboard user={user} onNavigate={go} dash={counts.dash} />,
    reports: <ReportsPage user={user} />,
    requests: <RequestsPage user={user} initialFilters={route === 'requests' ? routeParams : null} />,
    candidates: <CandidatesPage user={user} onNavigate={go} initialFilters={route === 'candidates' ? routeParams : null} />,
    candidateReview: CandidateReviewPage ? <CandidateReviewPage user={user} /> : <div className="error-banner">Candidate Review module failed to load.</div>,
    interviews: <InterviewsPage user={user} initialFilters={route === 'interviews' ? routeParams : null} />,
    offers: <OffersPage user={user} initialFilters={route === 'offers' ? routeParams : null} />,
    users: can(user, 'user.manage')
      ? <UsersPage user={user} />
      : <Forbidden what="User Management" need="System Admin" />,
    roles: <RolesPage user={user} />,
    projects: <ProjectsPage user={user} />,
    sites: <SitesPage user={user} />,
    departments: <DepartmentsPage user={user} />,
    control: <ControlCenterPage user={user} branding={branding} refreshBranding={refreshBranding} />,
    branding: <BrandingPage user={user} branding={branding} refreshBranding={refreshBranding} />,
    buttons: <ButtonsPage user={user} />,
    workflow: <WorkflowPage user={user} />,
    system: <SystemPage user={user} />,
    notifications: can(user, 'notification.manage')
      ? <NotificationsPanel user={user} />
      : <Forbidden what="Notification Settings" need="HR, Recruitment or System Admin" />,
    audit: <AuditPage user={user} />,
  }[route] || <Dashboard user={user} onNavigate={go} dash={counts.dash} />;

  // What anyhelp is looking at. Kept deliberately small: the dock never claims
  // more context than the page actually has. RequestDetail publishes the open
  // request id, which is what turns the Team tab into a real thread.
  const [ctx, setCtx] = useState({ id: null, label: null });
  useEffect(() => {
    const sync = () => setCtx({ id: window.__atsOpenRequestId || null, label: window.__atsOpenRequestLabel || null });
    sync();
    window.addEventListener('ats:context', sync);
    return () => window.removeEventListener('ats:context', sync);
  }, [route]);
  const anyhelpContext = {
    requestId: ctx.id,
    title: ctx.id
      ? (ctx.label || 'Hiring request')
      : ((NAV.find((n) => n.key === route) || {}).label || 'Workspace'),
    meta: ROLE_SCOPE[roleCode] || 'Access follows your role.',
  };

  return (
    <div className="shell" style={{ '--sidebar-w': collapsed ? '72px' : '236px' }}>
      {mobileNavOpen && <button className="sidebar-scrim" aria-label="Close menu" onClick={() => setMobileNavOpen(false)} />}
      <aside className={'sidebar' + (collapsed ? ' collapsed' : '') + (mobileNavOpen ? ' mobile-open' : '')}>
        <div className="sidebar-head" style={collapsed ? { justifyContent: 'center' } : null}>
          <span className="side-mark"><Logo size={30} /></span>
          {!collapsed && (
            <span className="side-txt">
              <strong>{branding?.app_name || 'Arabtec'}</strong>
              <span>Recruitment Hub</span>
            </span>
          )}
        </div>
        <nav className="nav" aria-label="Main navigation">
          {visibleNav.map((n, i) => {
            if (n.section) return !collapsed && <div key={'s' + i} className="nav-section">{n.section}</div>;
            const c = navCount(n.key, counts);
            return (
              <button key={n.key} className={'nav-item' + (route === n.key ? ' active' : '')}
                onClick={() => go(n.key)} title={n.label} aria-current={route === n.key ? 'page' : undefined}>
                <span className="nav-icon"><Icon name={n.icon} size={17} /></span>
                {!collapsed && <span>{n.label}</span>}
                {!collapsed && c ? <span className="nav-count">{c}</span> : null}
              </button>
            );
          })}
        </nav>
        {!collapsed && (
          <div className="scope-card">
            <strong>{ROLE_NAMES[roleCode] || roleCode} scope</strong>
            <p>{ROLE_SCOPE[roleCode] || 'Access follows your role'}. Access is enforced by your role, not by this menu.</p>
          </div>
        )}
      </aside>

      <div className="main">
        <header className="topbar">
          <button className="icon-btn menu-btn" onClick={() => setMobileNavOpen(true)} title="Open menu" aria-label="Open menu">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
          </button>
          <button className="icon-btn collapse-btn" onClick={() => setCollapsed((c) => !c)} title="Toggle sidebar" aria-label="Toggle sidebar">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
          </button>
          <div className="tb-brand">
            <span className="bn">
              <strong>Recruitment Hub</strong>
              <span>{branding?.company_name || 'Arabtec Construction'}</span>
            </span>
          </div>
          {/* Global search. Opens the Ctrl+K palette — no longer a dead placeholder. */}
          <button type="button" className="gsearch" onClick={() => setPaletteOpen(true)}
            title="Search candidates (Ctrl K)">
            <Icon name="search" size={14} />
            <span className="gsearch-label">Search candidates</span>
            <span className="kbd">Ctrl K</span>
          </button>
          <div className="spacer" />
          <NotificationBell onNavigate={go} />
          <div className="profile" onClick={() => setMenuOpen((o) => !o)}>
            <div className="avatar">{initials(user.fullName)}</div>
            <div>
              <div className="profile-name">{user.fullName}</div>
              <div className="profile-role">{ROLE_NAMES[roleCode] || roleCode}</div>
            </div>
            {menuOpen && (
              <div className="menu" onClick={(e) => e.stopPropagation()}>
                <div className="menu-item" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                  <strong>{user.fullName}</strong><span className="muted">{user.email}</span>
                </div>
                <div style={{ borderTop: '1px solid var(--border)' }} />
                <div className="menu-item" onClick={() => { setMenuOpen(false); setPwdOpen(true); }} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Icon name="shield" size={15} /> Change Password
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
        <main id="main-content" className={'content density-' + density} tabIndex="-1">
          <ErrorBoundary page resetKey={route}>{Page}</ErrorBoundary>
        </main>

        {pwdOpen && (
          <Modal title="Change password" onClose={() => setPwdOpen(false)}>
            <ChangePasswordForm onDone={() => setPwdOpen(false)} onCancel={() => setPwdOpen(false)} />
          </Modal>
        )}

        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          onPick={(c) => {
            // Hand the id to the Talent Pool, then navigate. CandidatesPage picks
            // this up on mount (pending id) or live (event) if already mounted.
            window.__atsPendingCandidateId = c.id;
            setPaletteOpen(false);
            go('candidates');
            window.dispatchEvent(new CustomEvent('ats:open-candidate', { detail: { id: c.id } }));
          }}
        />
      </div>

      {/* Five-item bottom navigation. Below 900px this replaces the sidebar; the
          sidebar itself becomes the drawer behind the menu button. */}
      <nav className="mobile-nav" aria-label="Primary">
        {primaryMobile.map((n) => (
          <button key={n.key} className={route === n.key ? 'active' : ''} onClick={() => go(n.key)}
            aria-current={route === n.key ? 'page' : undefined}>
            <Icon name={n.icon} size={18} />
            <span>{n.label}</span>
          </button>
        ))}
        <button className={moreOpen ? 'active' : ''} onClick={() => setMoreOpen((o) => !o)} aria-expanded={moreOpen}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
          <span>More</span>
        </button>
      </nav>

      {moreOpen && (
        <div className="more-sheet" role="dialog" aria-label="All sections">
          <div className="nav-section">All available sections</div>
          <div className="more-grid">
            {navItems.map((n) => (
              <button key={n.key} className={route === n.key ? 'active' : ''} onClick={() => go(n.key)}>{n.label}</button>
            ))}
          </div>
        </div>
      )}

      <AnyhelpDock user={user} route={route} context={anyhelpContext} onNavigate={go} />
    </div>
  );
}

/* ----------------------------- Dashboard ----------------------------- */
/* ---- tiny inline-SVG chart helpers (no external libraries) ---- */
// Approved palette: one green ramp, amber for "waiting", red for "over".
// Blue is not an accent in this design system.
const CHART_COLORS = ['#008064', '#00664F', '#4E9C88', '#8A5A00', '#E09600', '#D01827', '#6F6A64', '#8A867F'];
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
  const order = ['sourced', 'matched', 'shortlisted', 'interviewing', 'waiting_feedback', 'issuing_offer', 'offer_sent', 'joined'];
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

// Canonical pipeline stage → swatch color, for the inline funnel mini-bar and reports.
// Grouped by phase so the bar reads left→right as candidates progress.
// Approved palette: the pipeline reads as one green ramp that deepens as a
// candidate advances, amber where the process is waiting on a person, red at
// the end. Blue carried no meaning here and is retired.
const STAGE_COLORS = {
  sourced: '#8A867F', matched: '#4E9C88', shortlisted: '#008064', interviewing: '#00664F',
  waiting_feedback: '#E09600', issuing_offer: '#8A5A00', offer_sent: '#8A5A00', joined: '#00664F',
  unmatched: '#C7C4BF', on_hold: '#6F6A64', rejected: '#D01827', offer_declined: '#B01420',
};
const FUNNEL_ORDER = ['sourced', 'matched', 'shortlisted', 'interviewing', 'waiting_feedback', 'issuing_offer', 'offer_sent', 'joined'];

// Compact, Workable-style pipeline funnel rendered on each request card.
// Shows total candidates + a proportional stacked bar across active stages.
function FunnelMini({ pipeline }) {
  const byStage = (pipeline && pipeline.byStage) || {};
  const total = (pipeline && pipeline.total) || 0;
  const segs = FUNNEL_ORDER.map((s) => ({ s, c: byStage[s] || 0 })).filter((x) => x.c > 0);
  const segTotal = segs.reduce((a, b) => a + b.c, 0) || 1;
  return (
    <div className="funnel-mini">
      <div className="fm-head">
        <span className="fm-label">Pipeline</span>
        <span className="fm-total">{total} candidate{total === 1 ? '' : 's'}</span>
      </div>
      {segs.length === 0 ? (
        <div className="fm-empty">No candidates sourced yet</div>
      ) : (
        <>
          <div className="fm-track">
            {segs.map(({ s, c }) => (
              <span key={s} className="fm-seg" title={`${(APP_STATUS[s] || {}).label || s}: ${c}`}
                style={{ width: (c / segTotal * 100) + '%', background: STAGE_COLORS[s] || '#9aa3ad' }} />
            ))}
          </div>
          <div className="fm-legend">
            {segs.slice(0, 4).map(({ s, c }) => (
              <span key={s} className="fm-leg"><span className="fm-dot" style={{ background: STAGE_COLORS[s] || '#9aa3ad' }} />{(APP_STATUS[s] || {}).label || s} {c}</span>
            ))}
            {segs.length > 4 && <span className="fm-leg">+{segs.length - 4} more</span>}
          </div>
        </>
      )}
    </div>
  );
}

// ---- Dashboard visual building blocks -------------------------------------
// Presentation only. Every number rendered here comes from the existing
// GET /dashboard response; nothing is fabricated or extrapolated.
const APP_STAGE_COLORS = {
  sourced: '#8A867F', screening: '#4E9C88', interview_hr: '#008064',
  interview_technical: '#00664F', offer: '#8A5A00', hired: '#00664F',
  rejected: '#D01827', offer_declined: '#B01420',
};

function DashKpi({ label, value, unit, hint, icon, tone }) {
  return (
    <div className="dash-kpi" style={{ '--kc': tone }}>
      <div className="dash-kpi-top">
        <span className="dash-kpi-label">{label}</span>
        <span className="dash-ico"><Icon name={icon} size={15} /></span>
      </div>
      <div className="dash-kpi-val">{value}{unit ? <small>{unit}</small> : null}</div>
      <div className="dash-kpi-hint">{hint}</div>
    </div>
  );
}

function DashBars({ rows, empty, icon = '📊' }) {
  if (!rows || !rows.length) return <Empty icon={icon} text={empty} />;
  const max = Math.max(...rows.map((r) => r.count), 1);
  return (
    <div className="dash-bars">
      {rows.map((r, i) => (
        <div className="dash-bar" key={i}>
          <span className="dash-bar-l" title={r.label}>{r.label}</span>
          <span className="dash-bar-track">
            <span className="dash-bar-fill" style={{ width: `${(r.count / max) * 100}%`, background: r.color || 'var(--action-primary)' }} />
          </span>
          <strong className="dash-bar-n">{r.count}</strong>
        </div>
      ))}
    </div>
  );
}

function DashFunnel({ data }) {
  const order = ['sourced', 'screening', 'interview_hr', 'offer', 'hired'];
  // /dashboard returns the API's canonical statuses (matched, interviewing,
  // issuing_offer, joined…). Fold them onto board columns via pipelineStage,
  // otherwise everything except Sourced reads 0.
  const map = {};
  for (const d of data || []) {
    const key = pipelineStage(d.status);
    map[key] = (map[key] || 0) + d.count;
  }
  const rows = order.map((s) => ({ status: s, count: map[s] || 0 }));
  const closed = (map.rejected || 0) + (map.offer_declined || 0);
  const live = rows.reduce((s, r) => s + r.count, 0);
  if (!live && !closed) return <Empty icon="🔻" text="No candidates in the pipeline yet. Import CVs against a hiring request to get started." />;
  const top = Math.max(...rows.map((r) => r.count), 1);
  const entered = rows[0].count || live;
  return (
    <div>
      {rows.map((r) => (
        <div className="dash-frow" key={r.status}>
          <span className="dash-fl"><i style={{ background: APP_STAGE_COLORS[r.status] }} />{(APP_STATUS[r.status] || {}).label || r.status}</span>
          <span className="dash-ftrack">
            <span className="dash-fbar" style={{ width: `${(r.count / top) * 100}%`, background: APP_STAGE_COLORS[r.status] }} />
          </span>
          <strong className="dash-fn">{r.count}</strong>
          <span className="dash-fp">{entered ? Math.round((r.count / entered) * 100) + '%' : '—'}</span>
        </div>
      ))}
      {closed > 0 && (
        <div className="dash-frow dash-frow-muted">
          <span className="dash-fl"><i style={{ background: APP_STAGE_COLORS.rejected }} />Rejected / Declined</span>
          <span className="dash-ftrack"><span className="dash-fbar" style={{ width: `${(closed / top) * 100}%`, background: APP_STAGE_COLORS.rejected, opacity: .55 }} /></span>
          <strong className="dash-fn">{closed}</strong>
          <span className="dash-fp" />
        </div>
      )}
    </div>
  );
}

function DashListRow({ tone, icon, title, meta, right }) {
  return (
    <div className="dash-lrow">
      <span className={'dash-ico dash-ico-' + tone}><Icon name={icon} size={15} /></span>
      <div className="dash-lmain"><strong>{title}</strong><div className="dash-lmeta">{meta}</div></div>
      {right != null && <span className="dash-lright">{right}</span>}
    </div>
  );
}

/* ===========================================================================
   ROLE-BASED DASHBOARDS
   ---------------------------------------------------------------------------
   The approved mockup ships five personas. Production has nine real roles, and
   the REAL role is what selects the dashboard — the mockup's persona picker was
   a prototype control and is deliberately not shipped.

   This mapping is PRESENTATION ONLY. It decides which composition a user sees;
   it grants nothing. Every figure still comes from an endpoint that scopes
   itself server-side from the caller's permissions (`/dashboard` returns
   scope:'all' or scope:'own'; `/requests` and `/interviews` filter the same
   way), so hiding a card can never be the thing that keeps data private.
   =========================================================================== */
const PERSONA_BY_ROLE = {
  system_admin: 'director',        // full permissions → the widest real view
  hr_director: 'director',
  hr_manager: 'manager',
  recruitment_manager: 'manager',
  recruiter: 'recruiter',
  hiring_manager: 'recruiter',     // own-scope, action-led
  project_manager: 'recruiter',
  interviewer: 'interviewer',
  viewer: 'executive',             // read-only, org-wide, no candidate identity
};
// Highest-privilege role wins when a user holds more than one.
const ROLE_RANK = ['system_admin', 'hr_director', 'hr_manager', 'recruitment_manager',
  'recruiter', 'project_manager', 'hiring_manager', 'interviewer', 'viewer'];
function primaryRole(user) {
  const held = user?.roles || [];
  return ROLE_RANK.find((r) => held.includes(r)) || held[0] || 'viewer';
}
function personaFor(user) { return PERSONA_BY_ROLE[primaryRole(user)] || 'recruiter'; }

/* What this role can reach, in the user's own words. Shown in the sidebar so a
   recruiter is never left guessing why a list looks short. */
const ROLE_SCOPE = {
  system_admin: 'Full platform configuration and governance',
  hr_director: 'Hiring plan, approvals and governance',
  hr_manager: 'Recruitment policy, approvals and offer management',
  recruitment_manager: 'All recruitment operations',
  recruiter: 'Own requests and linked candidates',
  hiring_manager: 'Own requests, shortlists and interview feedback',
  project_manager: 'Project headcount and project visibility',
  interviewer: 'Assigned interviews only',
  viewer: 'Read-only reporting visibility',
};

// ---- Shared dashboard pieces (presentation only) ---------------------------
function DashHead({ eyebrow, title, sub, actions }) {
  return (
    <div className="dash-head">
      <div>
        <div className="dash-eyebrow">{eyebrow}</div>
        <h1 className="page-title">{title}</h1>
        <p className="page-sub">{sub}</p>
      </div>
      <div className="dash-actions">{actions}</div>
    </div>
  );
}

// `onClick` is optional. Present, this renders as a real button — keyboard-
// reachable, screen-reader-announced, with the same hover lift the ticket
// cards use. Absent, it renders exactly as before: a plain div, no pointer
// cursor. A card that looks clickable and isn't is worse than one that looks
// inert, so the two states are never allowed to look alike.
function KpiCard({ label, value, meta, tone, onClick }) {
  const cls = 'dash-kpi' + (tone ? ' ' + tone : '') + (onClick ? ' dash-kpi-link' : '');
  const body = <>
    <span className="dash-kpi-label">{label}</span>
    <div className="dash-kpi-val">{value}</div>
    <div className="dash-kpi-hint">{meta}</div>
  </>;
  if (!onClick) return <div className={cls}>{body}</div>;
  return <button type="button" className={cls} onClick={onClick}>{body}</button>;
}

/* One row of "what is waiting on you": the signal, what it is, why it matters,
   and the single action that moves it. Never decorative — every row navigates
   to the record it names. */
function ActionItem({ tone, title, meta, why, cta, onCta }) {
  return (
    <div className="action-item">
      <span className={'signal ' + tone} />
      <div className="action-copy">
        <strong>{title}</strong>
        <span>{meta}</span>
        {why && <em className={tone}>{why}</em>}
      </div>
      {cta && <button className="btn btn-sm" onClick={onCta}>{cta}</button>}
    </div>
  );
}

function EventCard({ tone, title, meta }) {
  return <div className={'event' + (tone ? ' ' + tone : '')}><strong>{title}</strong><span>{meta}</span></div>;
}

function RoleRow({ r, onOpen }) {
  const h = r.health || {};
  const tone = h.level === 'red' ? 'risk' : h.level === 'amber' ? 'warn' : 'good';
  const filled = r.headcount ? Math.round((r.headcountFilled / r.headcount) * 100) : 0;
  return (
    <div className="role-row">
      <div>
        <span className="cell-title">{r.title}</span>
        <span className="cell-meta">{shortReqCode(r.ticketNo)} · {(r.project || {}).name || 'No project'}</span>
      </div>
      <div><Badge variant={tone === 'risk' ? 'critical' : tone === 'warn' ? 'warning' : 'success'}>{h.label || '—'}</Badge></div>
      <div>
        <span className="progress"><span style={{ width: filled + '%' }} /></span>
        <span className="cell-meta">{r.headcountFilled} of {r.headcount} seats · {(r.pipeline || {}).total || 0} in pipeline</span>
      </div>
      <div style={{ textAlign: 'right' }}>
        <span className="idle">{h.daysOpen == null ? '—' : h.daysOpen + 'd'}</span>
        {onOpen && <button className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => onOpen(r)}>Open</button>}
      </div>
    </div>
  );
}

// Small date helpers used by the action lists. Presentation only.
const OPEN_REQ_STATUS = ['pending_approval', 'sourcing', 'in_progress', 'partially_filled',
  'on_hold', 'reopened', 'draft', 'budget_validation', 'approved', 'in_sourcing'];
function isOpenReq(r) { return OPEN_REQ_STATUS.includes(r.status); }
function daysUntil(iso) { if (!iso) return null; const d = (new Date(iso) - Date.now()) / 86400000; return isNaN(d) ? null : d; }
function isToday(iso) { if (!iso) return false; const d = new Date(iso); const n = new Date(); return d.toDateString() === n.toDateString(); }
function timeOf(iso) { if (!iso) return '—'; const d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
/* "today at 14:00" / "tomorrow" / "12 Oct" — a recruiter reads urgency, not a timestamp. */
function fmtWhen(iso) {
  if (!iso) return '—';
  const d = new Date(iso); if (isNaN(d)) return '—';
  const days = Math.floor((new Date(d.toDateString()) - new Date(new Date().toDateString())) / 86400000);
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (days === 0) return `today at ${t}`;
  if (days === 1) return `tomorrow at ${t}`;
  if (days === -1) return `yesterday`;
  if (days < 0) return `${Math.abs(days)} days ago`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ` at ${t}`;
}

/* Fetch exactly what a persona renders — nothing more. `/dashboard` is the one
   call every persona shares; requests and interviews are pulled only by the
   compositions that show them. */
function useDashboardData(user, persona, sharedDash) {
  const [state, setState] = useState({ loading: true, err: null, d: null, requests: [], interviews: [] });
  // Exposed as `reload` so a persona composition that mutates something the
  // dashboard shows (Assign, Pause…) can pull the fresh numbers back in,
  // rather than leaving the KPIs and tables stale until the next full visit.
  const reload = useCallback(() => {
    let cancelled = false;
    // `sharedDash` is the /dashboard payload the Shell already fetched for the
    // sidebar counts. Reusing it is the difference between one call and two.
    const wantsDashboard = !sharedDash && can(user, 'dashboard.view') && persona !== 'interviewer';
    const wantsRequests = persona !== 'interviewer'
      && (can(user, 'request.view_all') || can(user, 'request.view_own'));
    const wantsInterviews = (persona === 'recruiter' || persona === 'interviewer')
      && (can(user, 'interview.view_all') || can(user, 'interview.view_assigned'));

    Promise.all([
      wantsDashboard ? api.get('/dashboard').catch((e) => ({ __err: e.message })) : null,
      wantsRequests ? api.get('/requests?pageSize=100').catch(() => null) : null,
      wantsInterviews ? api.get('/interviews').catch(() => null) : null,
    ]).then(([d, rq, iv]) => {
      if (cancelled) return;
      if (d && d.__err) { setState({ loading: false, err: d.__err, d: null, requests: [], interviews: [] }); return; }
      setState({
        loading: false, err: null, d: d || sharedDash || null,
        requests: (rq && rq.requests) || [], interviews: (iv && iv.interviews) || [],
      });
    });
    return () => { cancelled = true; };
  }, [user.id, persona, !!sharedDash]);
  useEffect(reload, [reload]);
  return { ...state, reload };
}

function DashboardSkeleton() {
  return (
    <div>
      <div className="dash-kpi-row">{[0, 1, 2].map((i) => (
        <div className="dash-kpi dash-kpi-skel" key={i}>
          <div className="skeleton" style={{ width: '52%' }} />
          <div className="skeleton" style={{ width: '34%', height: 26, margin: '12px 0 8px' }} />
          <div className="skeleton" style={{ width: '66%' }} />
        </div>))}
      </div>
      <div className="dash-grid-2"><div className="card"><Skeleton rows={7} /></div><div className="card"><Skeleton rows={7} /></div></div>
    </div>
  );
}

/* --------------------------------- RECRUITER ------------------------------ */
function RecruiterDashboard({ user, data, onNavigate }) {
  const { d, requests, interviews } = data;
  // `ownerId == null` used to be included here, which put every unassigned
  // request in the ORG under "My roles" for every recruiter — unassigned work
  // is the manager's queue to route, not something already on a recruiter's
  // desk. Genuinely theirs only: they own it, or they raised it.
  const mine = requests.filter((r) => isOpenReq(r) && (r.ownerId === user.id || r.requesterId === user.id));
  const owned = requests.filter((r) => isOpenReq(r) && r.ownerId === user.id);
  const scheduled = interviews.filter((i) => i.status === 'scheduled');
  const thisWeek = scheduled.filter((i) => { const n = daysUntil(i.scheduledAt); return n != null && n >= 0 && n <= 7; })
    .sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)));
  const feedbackDue = interviews.filter((i) => i.status === 'completed' && !i.overallOutcome);
  const stalled = owned.filter((r) => (r.health || {}).level === 'red' || r.slaBreached);
  const noPipeline = owned.filter((r) => !((r.pipeline || {}).total));
  const attention = owned.filter((r) => (r.health || {}).level === 'amber');
  const overdue = feedbackDue.length + stalled.length;
  const todays = scheduled.filter((i) => isToday(i.scheduledAt));

  // Every CTA below opens the exact record it names — an interview via its id
  // (InterviewsPage's `openId` initialFilters key), a request via the existing
  // openRequest() deep-link. Nothing here lands on a generic, unfiltered list.
  const actions = [];
  for (const i of feedbackDue.slice(0, 3)) {
    actions.push({ tone: 'risk', title: `Submit interview feedback — ${(i.candidate || {}).fullName || 'Candidate'}`,
      meta: `${(i.request || {}).title || 'Role'} · ${i.interviewNo}`, why: 'Blocks the hiring decision',
      cta: 'Open', onCta: () => onNavigate('interviews', { openId: i.id }) });
  }
  for (const r of stalled.slice(0, 3)) {
    actions.push({ tone: 'risk', title: `Escalate ${shortReqCode(r.ticketNo)} — ${r.title}`,
      meta: `${(r.pipeline || {}).total || 0} in pipeline · open ${(r.health || {}).daysOpen ?? '—'} days`,
      why: r.slaBreached ? 'SLA breached' : 'Target join date at risk', cta: 'Open role', onCta: () => openRequest(r.id, onNavigate) });
  }
  for (const r of noPipeline.slice(0, 2)) {
    actions.push({ tone: 'warn', title: `No candidates yet — ${r.title}`,
      meta: `${shortReqCode(r.ticketNo)} · ${r.headcount} seat${r.headcount === 1 ? '' : 's'} to fill`,
      why: 'Sourcing has not started', cta: 'Source', onCta: () => openRequest(r.id, onNavigate) });
  }
  for (const i of thisWeek.slice(0, 2)) {
    actions.push({ tone: 'warn', title: `Confirm panel — ${(i.candidate || {}).fullName || 'Candidate'}`,
      meta: `${(i.request || {}).title || 'Role'} · ${fmtWhen(i.scheduledAt)}`,
      why: 'Interview this week', cta: 'Open', onCta: () => onNavigate('interviews', { openId: i.id }) });
  }
  if (d && d.myWork.myPendingOfferApprovals) {
    actions.push({ tone: 'warn', title: `${d.myWork.myPendingOfferApprovals} offer approval${d.myWork.myPendingOfferApprovals === 1 ? '' : 's'} waiting`,
      meta: 'Offers held for a decision', why: 'Waiting on you', cta: 'Open offers', onCta: () => onNavigate('offers', { status: 'pending_approval' }) });
  }
  for (const r of attention.slice(0, 2)) {
    actions.push({ tone: 'good', title: `Keep ${shortReqCode(r.ticketNo)} moving`,
      meta: `${r.title} · ${(r.pipeline || {}).total || 0} in pipeline`,
      why: (r.health || {}).label || 'Needs attention', cta: 'Open role', onCta: () => openRequest(r.id, onNavigate) });
  }

  const healthy = owned.length - stalled.length - attention.length;
  const offerCount = (statuses) => (d ? (d.offersByStatus || []).filter((o) => statuses.includes(o.status)).reduce((s, o) => s + o.count, 0) : 0);
  // `d` for a recruiter is already scoped to their own requests (request.view_own),
  // so this is already "my offers to issue" — no extra client filter needed.
  const offersToIssue = offerCount(['draft', 'approved']);

  return (
    <div>
      <DashHead eyebrow="Recruiter workspace" title="Your next actions"
        sub="Every item here links to a hiring request, a candidate, an interview or an offer."
        actions={<>
          <button className="btn btn-secondary" onClick={() => onNavigate('requests')}>Open my roles</button>
          {can(user, 'candidate.add') && <button className="btn" onClick={() => onNavigate('candidates')}>Add candidate</button>}
        </>} />

      <div className="dash-kpi-row">
        <KpiCard label="Overdue actions" value={overdue} tone={overdue ? 'kpi-risk' : ''}
          meta={stalled.length ? `Oldest role open ${Math.max(...stalled.map((r) => (r.health || {}).daysOpen || 0))} days` : 'Nothing overdue'}
          onClick={() => onNavigate('interviews', { status: 'completed' })} />
        <KpiCard label="Interviews this week" value={thisWeek.length}
          meta={thisWeek.length ? `Next: ${fmtWhen(thisWeek[0].scheduledAt)}` : 'None scheduled'}
          onClick={() => onNavigate('interviews', { thisWeek: true })} />
        <KpiCard label="Assigned open roles" value={owned.length}
          meta={`${owned.filter((r) => r.priority === 'critical').length} critical · ${attention.length} need attention`}
          onClick={() => onNavigate('requests', { owner: String(user.id) })} />
        <KpiCard label="Offers to issue" value={offersToIssue}
          meta={d?.myWork.myPendingOfferApprovals ? `${d.myWork.myPendingOfferApprovals} more waiting on an approver` : 'None waiting on an approver'}
          onClick={() => onNavigate('offers', { toIssue: true })} />
      </div>

      <div className="dash-grid-2">
        <section className="card">
          <div className="card-head"><div><h3>Waiting on you</h3></div><span className="dash-headnote">Sorted by what blocks others first</span></div>
          {actions.length === 0
            ? <Empty icon="✓" title="Nothing is waiting on you" text="No overdue feedback, no stalled roles, no unsourced requests in your scope." />
            : <>
              <div className="action-list">
                {actions.slice(0, 6).map((a, i) => (
                  <ActionItem key={i} tone={a.tone} title={a.title} meta={a.meta} why={a.why}
                    cta={a.cta} onCta={a.onCta} />
                ))}
              </div>
              {healthy > 0 && <div className="reassurance">{healthy} of {owned.length} of your roles are progressing normally.</div>}
            </>}
        </section>

        <aside className="card">
          <div className="card-head"><div><h3>Today</h3></div><span className="dash-headnote">Owned appointments</span></div>
          <div className="event-list">
            {todays.length === 0 && stalled.length === 0
              ? <Empty icon="🗓" text="Nothing is scheduled for today." />
              : <>
                {todays.map((i) => (
                  <EventCard key={i.id} tone="good"
                    title={`${timeOf(i.scheduledAt)} · ${(i.interviewType || '').toUpperCase()} interview`}
                    meta={`${(i.candidate || {}).fullName || 'Candidate'} · ${(i.request || {}).title || ''}`} />
                ))}
                {stalled.slice(0, 2).map((r) => (
                  <EventCard key={r.id} tone="risk"
                    title={`Overdue · ${shortReqCode(r.ticketNo)}`}
                    meta={`${r.title} · open ${(r.health || {}).daysOpen ?? '—'} days`} />
                ))}
              </>}
          </div>
        </aside>
      </div>

      <section className="card" style={{ marginTop: 16 }}>
        <div className="card-head"><div><h3>My roles</h3></div><span className="dash-headnote">Current status and how long each has been open</span></div>
        {mine.length === 0
          ? <Empty icon="🗂" text="No open hiring requests are assigned to you." />
          : <div className="role-health">{mine.slice(0, 8).map((r) => <RoleRow key={r.id} r={r} onOpen={(role) => openRequest(role.id, onNavigate)} />)}</div>}
      </section>
    </div>
  );
}

// Mirrors POST /requests/:id/assign's own rule in routes/requests.js exactly.
// Shared by every place an Assign/Reassign control can appear (the request's
// own header, the requests table, and this dashboard's attention list) so a
// request still pending approval is always disabled with the same reason,
// never left enabled to fail with a 409 the recruiter has to decode.
const ASSIGNABLE_STATUSES = ['sourcing', 'in_progress', 'reopened', 'partially_filled'];
function canAssignStatus(status) { return ASSIGNABLE_STATUSES.includes(status); }
const ASSIGN_BLOCKED_TITLE = 'This request must be approved before a recruiter can be assigned.';

/* ---------------------------- RECRUITMENT MANAGER ------------------------- */
// One line naming the real, worst reason a recruiter's book needs a look —
// never a generic "at risk", always the specific request and signal behind it.
// Returns null when nothing is wrong, which the caller reads as "On plan".
function overdueCauseFor(reqs) {
  const breached = reqs.find((r) => r.slaBreached);
  if (breached) return `SLA breached — ${shortReqCode(breached.ticketNo)}`;
  const red = reqs.find((r) => (r.health || {}).level === 'red');
  if (red) return `${shortReqCode(red.ticketNo)} — ${(red.health || {}).daysOpen ?? '—'}d past the health threshold`;
  const amber = reqs.find((r) => (r.health || {}).level === 'amber');
  if (amber) return `${shortReqCode(amber.ticketNo)} — approaching the health threshold`;
  return null;
}
// Same idea, for a single role in "Roles requiring attention" — the blocker
// column names the one reason THIS row is on the list.
function blockerFor(r) {
  if (!r.ownerId) return 'No recruiter assigned';
  if (r.slaBreached) return 'SLA breached';
  if ((r.health || {}).level === 'red') return `${(r.health || {}).daysOpen ?? '—'} days past the health threshold`;
  if ((r.health || {}).level === 'amber') return 'Approaching the health threshold';
  return 'No overdue action';
}
// Worst-first ordering: unowned and SLA-breached roles are the most urgent —
// nobody is working them and the clock has already run out — then red, then amber.
function severity(r) {
  if (r.slaBreached) return 4;
  if (!r.ownerId) return 3;
  if ((r.health || {}).level === 'red') return 2;
  if ((r.health || {}).level === 'amber') return 1;
  return 0;
}
const DAY_MS = 86400000;
function withinPastDays(iso, days) {
  if (!iso) return false;
  const age = Date.now() - new Date(iso).getTime();
  return !isNaN(age) && age >= 0 && age <= days * DAY_MS;
}

function ManagerDashboard({ user, data, onNavigate }) {
  const { d, requests } = data;
  const open = requests.filter(isOpenReq);
  const unassigned = open.filter((r) => !r.ownerId);
  const critical = open.filter((r) => r.priority === 'critical');
  const stalled = open.filter((r) => (r.health || {}).level === 'red' || r.slaBreached);
  const attentionNeeded = open.filter((r) => needsAction(r));
  const load = (d && d.recruiterLoad) || [];
  const pendingOffers = d ? (d.offersByStatus || []).filter((o) => o.status === 'pending_approval').reduce((s, o) => s + o.count, 0) : 0;
  // "To be issued" = approved and waiting to go out — not `pending_approval`,
  // which is waiting on someone else's decision, not the recruiter's action.
  const offersToIssue = d ? (d.offersByStatus || []).filter((o) => o.status === 'draft' || o.status === 'approved').reduce((s, o) => s + o.count, 0) : 0;
  const [assigning, setAssigning] = useState(null);
  const [recruiters, setRecruiters] = useState([]);
  const toast = useToast();
  useEffect(() => { api.get('/requests/meta/form').then((m) => setRecruiters(m.assignableRecruiters || [])).catch(() => {}); }, []);

  async function doAssign(ownerId) {
    try {
      await api.post(`/requests/${assigning.id}/assign`, { ownerId });
      toast(`Recruiter assigned to ${shortReqCode(assigning.ticketNo)}`);
      setAssigning(null);
      data.reload(); // the KPIs and both tables above are stale until this runs
    } catch (e) { toast(e.message, 'error'); }
  }

  // Card A rows: `d.recruiterLoad` (name + open-request count) enriched with
  // real pipeline numbers already sitting in `requests` — no second fetch.
  const workloadRows = load.map((rl) => {
    const owned = open.filter((r) => r.ownerId === rl.id);
    const applications = owned.reduce((s, r) => s + ((r.pipeline || {}).total || 0), 0);
    const byStage = (key) => owned.reduce((s, r) => s + (((r.pipeline || {}).byStage || {})[key] || 0), 0);
    const interviews = byStage('interviewing') + byStage('waiting_feedback');
    const offersOut = byStage('issuing_offer') + byStage('offer_sent');
    const overdue = owned.filter((r) => needsAction(r)).length;
    const cause = overdueCauseFor(owned);
    return { id: rl.id, name: rl.name, roles: rl.c, applications, interviews, offersOut, overdue, cause };
  });
  const healthyRecruiters = workloadRows.filter((w) => !w.cause).length;

  // Card B rows: unowned and at-risk roles, worst first.
  const attentionRows = [...unassigned, ...stalled.filter((r) => r.ownerId), ...attentionNeeded.filter((r) => r.ownerId && !stalled.includes(r))]
    .filter((r, i, arr) => arr.findIndex((x) => x.id === r.id) === i) // de-dupe a role matching more than one bucket
    .sort((a, b) => severity(b) - severity(a) || ((b.health || {}).daysOpen ?? 0) - ((a.health || {}).daysOpen ?? 0))
    .slice(0, 10);

  // "This week" — everything already loaded, nothing new fetched.
  const openedThisWeek = requests.filter((r) => withinPastDays(r.openedAt, 7)).length;
  const closedThisWeek = requests.filter((r) => withinPastDays(r.closedAt, 7)).length;
  const avgStageIdle = open.length
    ? Math.round(open.reduce((s, r) => s + (r.lifecycle?.stageIdleDays || 0), 0) / open.length) : null;
  const offerCount = (statuses) => (d ? (d.offersByStatus || []).filter((o) => statuses.includes(o.status)).reduce((s, o) => s + o.count, 0) : 0);
  const offersIssued = offerCount(['sent', 'accepted', 'rejected_by_candidate', 'withdrawn', 'joined']);
  const offersAccepted = offerCount(['accepted', 'joined']);
  const offersDeclined = offerCount(['rejected_by_candidate']);
  const aging = d ? d.aging : {};
  const agingOver60 = (aging['61-90'] || 0) + (aging['90+'] || 0);

  return (
    <div>
      <DashHead eyebrow="Recruitment operations" title="Team command"
        sub="The blocker, who owns it, and how long it has been sitting there."
        actions={<>
          <button className="btn btn-secondary" onClick={() => onNavigate('requests')}>All hiring requests</button>
          <button className="btn" onClick={() => onNavigate('reports')}>Reports</button>
        </>} />

      <div className="dash-kpi-row">
        <KpiCard label="Critical roles" value={critical.length} tone={critical.length ? 'kpi-risk' : ''}
          meta={`${stalled.length} past their health threshold`}
          onClick={() => onNavigate('requests', { priority: 'critical', openOnly: true })} />
        <KpiCard label="Unassigned requests" value={unassigned.length} tone={unassigned.length ? 'kpi-attn' : ''}
          meta={unassigned.length ? 'No recruiter is working these' : 'Every open role has an owner'}
          onClick={() => onNavigate('requests', { owner: 'unassigned', openOnly: true })} />
        <KpiCard label="Requests needing action" value={attentionNeeded.length} tone={attentionNeeded.length ? 'kpi-risk' : ''}
          meta={attentionNeeded.length ? `${stalled.length} overdue, ${attentionNeeded.length - stalled.length} approaching` : 'Nothing is overdue'}
          onClick={() => onNavigate('requests', { attention: true, openOnly: true })} />
        <KpiCard label="Offers to issue" value={offersToIssue}
          meta={pendingOffers ? `${pendingOffers} more waiting on an approver` : 'None waiting on an approver'}
          onClick={() => onNavigate('offers', { toIssue: true })} />
      </div>

      <div className="dash-grid-2">
        <section className="card">
          <div className="card-head"><div><h3>Recruiter workload</h3></div><span className="dash-headnote">Workload at a glance — no ranking.</span></div>
          <div className="card-pad">
            {!workloadRows.length
              ? <Empty icon="👥" text="No open request is assigned to a recruiter yet." />
              : <>
                <div className="table-wrap"><table className="table responsive-table">
                  <thead><tr><th>Recruiter</th><th>Workload</th><th>Commitments</th><th>Overdue</th><th>Status / Cause</th></tr></thead>
                  <tbody>{workloadRows.map((w) => (
                    <tr key={w.id} className="row-link" onClick={() => onNavigate('requests', { owner: String(w.id) })}>
                      <td data-label="Recruiter"><span className="cell-strong">{w.name}</span></td>
                      <td data-label="Workload" className="cell-sub-only">{w.roles} role{w.roles === 1 ? '' : 's'} · {w.applications} application{w.applications === 1 ? '' : 's'}</td>
                      <td data-label="Commitments" className="cell-sub-only">{w.interviews} interview{w.interviews === 1 ? '' : 's'} · {w.offersOut} offer{w.offersOut === 1 ? '' : 's'}</td>
                      <td data-label="Overdue"><span className={w.overdue ? 'cell-strong' : 'cell-sub-only'}>{w.overdue}</span></td>
                      <td data-label="Status / Cause">
                        <Badge variant={w.cause ? 'critical' : 'success'}>{w.cause ? 'At risk' : 'On plan'}</Badge>
                        <div className="cell-sub">{w.cause || 'No overdue action'}</div>
                      </td>
                    </tr>
                  ))}</tbody>
                </table></div>
                <div className="reassurance">{healthyRecruiters} of {workloadRows.length} recruiter{workloadRows.length === 1 ? '' : 's'} {workloadRows.length === 1 ? 'is' : 'are'} progressing normally{workloadRows.length - healthyRecruiters ? `; ${workloadRows.length - healthyRecruiters} need${workloadRows.length - healthyRecruiters === 1 ? 's' : ''} direct intervention.` : '.'}</div>
              </>}
          </div>
        </section>

        <section className="card">
          <div className="card-head"><div><h3>This week</h3></div><span className="dash-headnote">Figures already on this page, in one place</span></div>
          <div className="card-pad dash-sla-rows">
            <div className="dash-kv"><span>Requests opened</span><strong>{openedThisWeek}</strong></div>
            <div className="dash-kv"><span>Requests closed</span><strong>{closedThisWeek}</strong></div>
            <div className="dash-kv"><span>Average stage-idle (open roles)</span><strong>{avgStageIdle == null ? '—' : avgStageIdle + 'd'}</strong></div>
            <div className="dash-kv"><span>Offers issued</span><strong>{offersIssued}</strong></div>
            <div className="dash-kv"><span>Offers accepted</span><strong>{offersAccepted}</strong></div>
            <div className="dash-kv"><span>Offers declined</span><strong>{offersDeclined}</strong></div>
            <div className="dash-kv"><span>Time to fill</span><strong>{d?.kpis.timeToFillDays == null ? '—' : d.kpis.timeToFillDays + 'd'}</strong></div>
            <div className="dash-kv"><span>Offer acceptance</span><strong>{d?.kpis.offerAcceptanceRate == null ? '—' : d.kpis.offerAcceptanceRate + '%'}</strong></div>
            {/* No day-range filter exists server-side, so these route through the
                same health-threshold filter the KPI cards use above — an honest
                approximation (amber/red thresholds default to 30/45 days), not a
                literal 31-60/60+ query. */}
            <button type="button" className="dash-kv dash-kv-link" onClick={() => onNavigate('requests', { openOnly: true })}>
              <span>Aging 0–30 days</span><strong>{aging['0-30'] || 0}</strong>
            </button>
            <button type="button" className="dash-kv dash-kv-link" onClick={() => onNavigate('requests', { openOnly: true, attention: true })}>
              <span>Aging 31–60 days</span><strong>{aging['31-60'] || 0}</strong>
            </button>
            <button type="button" className="dash-kv dash-kv-link" onClick={() => onNavigate('requests', { openOnly: true, attention: true })}>
              <span>Aging 60+ days</span><strong>{agingOver60}</strong>
            </button>
          </div>
        </section>
      </div>

      <section className="card" style={{ marginTop: 16 }}>
        <div className="card-head"><div><h3>Roles requiring attention</h3></div><span className="dash-headnote">Stage-idle time replaces total days open.</span></div>
        {!attentionRows.length
          ? <Empty icon="✓" title="Nothing needs escalation" text="No stalled, unassigned or at-risk requests right now." />
          : <div className="table-wrap"><table className="table responsive-table">
            <thead><tr><th>Role</th><th>Owner</th><th>Stage / Idle</th><th>Blocker</th><th>Next action</th></tr></thead>
            <tbody>{attentionRows.map((r) => (
              <tr key={r.id} className="row-link" onClick={() => openRequest(r.id, onNavigate)}>
                <td data-label="Role">
                  <span className="cell-strong">{r.title}</span>
                  <div className="cell-sub">{shortReqCode(r.ticketNo)} · {placeLabel(r)} · <PriorityBadge p={r.priority} /></div>
                </td>
                <td data-label="Owner" onClick={(e) => e.stopPropagation()}>
                  {r.owner ? r.owner.name
                    : canAssignStatus(r.status)
                      ? <button className="btn btn-ghost btn-sm" onClick={() => setAssigning(r)}>Assign recruiter</button>
                      : <button className="btn btn-ghost btn-sm" disabled title={ASSIGN_BLOCKED_TITLE}>Assign recruiter</button>}
                </td>
                <td data-label="Stage / Idle"><span className="cell-strong">{r.displayStatus}</span><div className="cell-sub">{r.lifecycle?.stageIdleDays == null ? '—' : r.lifecycle.stageIdleDays + 'd idle'}</div></td>
                <td data-label="Blocker"><span className="cell-strong">{blockerFor(r)}</span></td>
                <td data-label="Next action" onClick={(e) => e.stopPropagation()}>
                  {!r.owner
                    ? (canAssignStatus(r.status)
                      ? <button className="btn btn-secondary btn-sm" onClick={() => setAssigning(r)}>Assign recruiter</button>
                      : <button className="btn btn-secondary btn-sm" disabled title={ASSIGN_BLOCKED_TITLE}>Assign recruiter</button>)
                    : <button className="btn btn-secondary btn-sm" onClick={() => openRequest(r.id, onNavigate)}>Open role</button>}
                </td>
              </tr>
            ))}</tbody>
          </table></div>}
      </section>

      {assigning && <AssignModal recruiters={recruiters} onClose={() => setAssigning(null)} onAssign={doAssign} />}
    </div>
  );
}

/* Group open requests into plan rows. Derived entirely from the requests the
   caller can already see — this is a re-presentation, not a new data source. */
function planRows(requests, key) {
  const map = new Map();
  for (const r of requests) {
    const name = (r[key] || {}).name || 'Unassigned';
    const row = map.get(name) || { name, planned: 0, filled: 0, open: 0, critical: 0 };
    row.planned += r.headcount || 0;
    row.filled += r.headcountFilled || 0;
    if (isOpenReq(r)) row.open += 1;
    if (r.priority === 'critical' && isOpenReq(r)) row.critical += 1;
    map.set(name, row);
  }
  return [...map.values()].sort((a, b) => b.planned - a.planned);
}

function PlanTable({ rows, unit }) {
  if (!rows.length) return <Empty icon="📋" text="No hiring requests to summarise yet." />;
  return (
    <div className="table-wrap">
      <table className="table responsive-table">
        <thead><tr><th>{unit}</th><th>Planned seats</th><th>Filled</th><th>Open roles</th><th>Progress</th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const pct = r.planned ? Math.round((r.filled / r.planned) * 100) : 0;
            return (
              <tr key={r.name}>
                <td data-label={unit}><span className="cell-strong">{r.name}</span>{r.critical ? <span className="cell-sub">{r.critical} critical</span> : null}</td>
                <td data-label="Planned seats">{r.planned}</td>
                <td data-label="Filled">{r.filled}</td>
                <td data-label="Open roles">{r.open}</td>
                <td data-label="Progress">
                  <span className="progress" style={{ minWidth: 90, display: 'block' }}><span style={{ width: pct + '%' }} /></span>
                  <span className="cell-sub">{pct}%</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* --------------------------------- HR DIRECTOR ---------------------------- */
function DirectorDashboard({ user, data, onNavigate }) {
  const { d, requests } = data;
  const k = (d && d.kpis) || {};
  const open = requests.filter(isOpenReq);
  const awaitingApproval = requests.filter((r) => ['pending_approval', 'draft', 'budget_validation'].includes(r.status));
  const pendingOffers = d ? (d.offersByStatus || []).filter((o) => o.status === 'pending_approval').reduce((s, o) => s + o.count, 0) : 0;
  const overdue = (d ? (d.aging['61-90'] || 0) + (d.aging['90+'] || 0) : 0);

  return (
    <div>
      <DashHead eyebrow="Hiring plan and governance" title="Hiring plan and recruitment health"
        sub="Demand against delivery, and the decisions that are waiting on you."
        actions={<>
          <button className="btn btn-secondary" onClick={() => onNavigate('reports')}>Reports</button>
          {can(user, 'offer.approve') && <button className="btn" onClick={() => onNavigate('offers')}>Offer approvals</button>}
        </>} />

      <div className="dash-kpi-row">
        <KpiCard label="Planned seats" value={k.headcountTotal ?? '—'} meta="Across every hiring request in scope" />
        <KpiCard label="Seats filled" value={k.headcountFilled ?? '—'} meta={`${k.fillRate ?? 0}% of the plan`} />
        <KpiCard label="Waiting on a decision" value={awaitingApproval.length + pendingOffers}
          tone={(awaitingApproval.length + pendingOffers) ? 'kpi-attn' : ''}
          meta={`${awaitingApproval.length} request${awaitingApproval.length === 1 ? '' : 's'} · ${pendingOffers} offer${pendingOffers === 1 ? '' : 's'}`} />
      </div>

      <section className="card">
        <div className="card-head"><div><h3>Hiring plan by project</h3></div><span className="dash-headnote">Planned versus filled</span></div>
        <div className="card-pad"><PlanTable rows={planRows(requests, 'project')} unit="Project" /></div>
      </section>

      <div className="dash-grid-2" style={{ marginTop: 16 }}>
        <section className="card">
          <div className="card-head"><div><h3>Recruitment health</h3></div><span className="dash-headnote">Open requests by age</span></div>
          <div className="card-pad">
            {!d ? <Empty icon="🗓" text="No data." /> : (
              <div className="dash-sla-rows">
                <div className="dash-kv"><span><i style={{ background: 'var(--green)' }} />On track <em>0–30 days</em></span><strong>{d.aging['0-30'] || 0}</strong></div>
                <div className="dash-kv"><span><i style={{ background: 'var(--warning)' }} />At risk <em>31–60 days</em></span><strong>{d.aging['31-60'] || 0}</strong></div>
                <div className="dash-kv"><span><i style={{ background: 'var(--brand)' }} />Overdue <em>60+ days</em></span><strong>{overdue}</strong></div>
                <div className="dash-kv" style={{ marginTop: 10 }}><span>Average time to fill</span><strong>{k.timeToFillDays == null ? '—' : k.timeToFillDays + ' days'}</strong></div>
                <div className="dash-kv"><span>Offer acceptance</span><strong>{k.offerAcceptanceRate == null ? '—' : k.offerAcceptanceRate + '%'}</strong></div>
              </div>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card-head"><div><h3>Waiting on your decision</h3></div><span className="dash-headnote">Requests and offers held for approval</span></div>
        {!awaitingApproval.length && !pendingOffers
          ? <Empty icon="✓" title="Nothing is waiting on you" text="No hiring request or offer is held for a decision." />
          : <div className="action-list">
            {awaitingApproval.slice(0, 6).map((r) => (
              <ActionItem key={r.id} tone="warn" title={`Approve ${shortReqCode(r.ticketNo)} — ${r.title}`}
                meta={`${(r.project || {}).name || 'No project'} · ${r.headcount} seat${r.headcount === 1 ? '' : 's'}`}
                why="Sourcing cannot start until this is approved" cta="Open request" onCta={() => onNavigate('requests')} />
            ))}
            {pendingOffers > 0 && (
              <ActionItem tone="warn" title={`${pendingOffers} offer${pendingOffers === 1 ? '' : 's'} awaiting approval`}
                meta="Offers held pending a decision" why="Candidates are waiting" cta="Open offers" onCta={() => onNavigate('offers')} />
            )}
          </div>}
        </section>
      </div>

      <section className="card" style={{ marginTop: 16 }}>
        <div className="card-head"><div><h3>Open roles</h3></div><span className="dash-headnote">{open.length} in scope</span></div>
        {!open.length ? <Empty icon="🗂" text="No open hiring requests." />
          : <div className="role-health">{open.slice(0, 8).map((r) => <RoleRow key={r.id} r={r} onOpen={(role) => openRequest(role.id, onNavigate)} />)}</div>}
      </section>
    </div>
  );
}

/* ------------------------------ COO / EXECUTIVE --------------------------- */
/* Aggregate only. No candidate identity appears on this composition — the
   executive view answers "are we hiring to plan", not "who is in the pipeline". */
function ExecutiveDashboard({ user, data, onNavigate }) {
  const { d, requests } = data;
  const k = (d && d.kpis) || {};
  const remaining = Math.max((k.headcountTotal || 0) - (k.headcountFilled || 0), 0);
  const criticalOpen = requests.filter((r) => isOpenReq(r) && r.priority === 'critical');

  return (
    <div>
      <DashHead eyebrow="Executive workforce overview" title="Hiring progress against the approved plan"
        sub="Delivery against plan. Aggregate figures only — no candidate names in this view."
        actions={can(user, 'report.export') ? <button className="btn" onClick={() => onNavigate('reports')}>Reports</button> : null} />

      <div className="dash-kpi-row">
        <KpiCard label="Planned" value={k.headcountTotal ?? '—'} meta="Approved workforce plan" />
        <KpiCard label="Filled" value={k.headcountFilled ?? '—'} meta={`${k.fillRate ?? 0}% of plan`} />
        <KpiCard label="Remaining" value={remaining} tone={remaining ? 'kpi-attn' : ''}
          meta={`${requests.filter(isOpenReq).length} open request${requests.filter(isOpenReq).length === 1 ? '' : 's'}`} />
      </div>

      <section className="card">
        <div className="card-head"><div><h3>One hiring-progress view</h3></div><span className="dash-headnote">By project</span></div>
        <div className="card-pad"><PlanTable rows={planRows(requests, 'project')} unit="Project" /></div>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <div className="card-head"><div><h3>Critical vacancies</h3></div><span className="dash-headnote">Roles flagged critical and still open</span></div>
        {!criticalOpen.length
          ? <Empty icon="✓" title="No critical vacancies" text="Nothing flagged critical is still open." />
          : <div className="table-wrap">
            <table className="table responsive-table">
              <thead><tr><th>Role</th><th>Project</th><th>Seats</th><th>Days open</th><th>Health</th></tr></thead>
              <tbody>
                {criticalOpen.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Role"><span className="cell-strong">{r.title}</span></td>
                    <td data-label="Project">{(r.project || {}).name || '—'}</td>
                    <td data-label="Seats">{r.headcountFilled} / {r.headcount}</td>
                    <td data-label="Days open">{(r.health || {}).daysOpen ?? '—'}</td>
                    <td data-label="Health"><ReqHealth health={r.health} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>}
      </section>

      <div className="dash-grid-2" style={{ marginTop: 16 }}>
        <section className="card">
          <div className="card-head"><div><h3>Time to fill</h3></div></div>
          <div className="card-pad"><div className="dash-kpi-val">{k.timeToFillDays == null ? '—' : k.timeToFillDays}</div>
            <div className="dash-kpi-hint">{k.timeToFillDays == null ? 'No filled requests yet' : 'Average days across filled requests'}</div></div>
        </section>
        <section className="card">
          <div className="card-head"><div><h3>Offer acceptance</h3></div></div>
          <div className="card-pad"><div className="dash-kpi-val">{k.offerAcceptanceRate == null ? '—' : k.offerAcceptanceRate + '%'}</div>
            <div className="dash-kpi-hint">{k.offerAcceptanceRate == null ? 'No decided offers yet' : 'Accepted of decided offers'}</div></div>
        </section>
      </div>
    </div>
  );
}

/* --------------------------- TECHNICAL INTERVIEWER ------------------------ */
function InterviewerDashboard({ user, data, onNavigate }) {
  const { interviews } = data;
  const scheduled = interviews.filter((i) => i.status === 'scheduled');
  const upcoming = scheduled.filter((i) => { const n = daysUntil(i.scheduledAt); return n == null || n >= 0; })
    .sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)));
  const feedbackDue = interviews.filter((i) => i.status === 'completed' && !i.overallOutcome);
  const done = interviews.filter((i) => i.status === 'completed' && i.overallOutcome);

  return (
    <div>
      <DashHead eyebrow="Interview panel" title="Your interviews"
        sub="Only interviews you are on the panel for. Salary and offer terms are not part of this view."
        actions={<button className="btn" onClick={() => onNavigate('interviews')}>All my interviews</button>} />

      <div className="dash-kpi-row">
        <KpiCard label="Scheduled" value={upcoming.length} meta={upcoming.length ? `Next: ${fmtWhen(upcoming[0].scheduledAt)}` : 'Nothing scheduled'} />
        <KpiCard label="Feedback due" value={feedbackDue.length} tone={feedbackDue.length ? 'kpi-risk' : ''}
          meta={feedbackDue.length ? 'A hiring decision is waiting on these' : 'Nothing outstanding'} />
        <KpiCard label="Completed" value={done.length} meta="Interviews you have already assessed" />
      </div>

      <section className="card">
        <div className="card-head"><div><h3>Pending assessments</h3></div><span className="dash-headnote">Feedback the panel is waiting on</span></div>
        {!feedbackDue.length
          ? <Empty icon="✓" title="No assessment is outstanding" text="Every interview you have run has feedback recorded." />
          : <div className="action-list">
            {feedbackDue.map((i) => (
              <ActionItem key={i.id} tone="risk" title={`Submit feedback — ${(i.candidate || {}).fullName || 'Candidate'}`}
                meta={`${(i.request || {}).title || 'Role'} · ${i.interviewNo} · ${fmtWhen(i.scheduledAt)}`}
                why="Blocks the hiring decision" cta="Open interview" onCta={() => onNavigate('interviews')} />
            ))}
          </div>}
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <div className="card-head"><div><h3>Upcoming</h3></div><span className="dash-headnote">Assigned to you</span></div>
        {!upcoming.length
          ? <Empty icon="🗓" text="No interviews are scheduled for you." />
          : <div className="event-list">
            {upcoming.slice(0, 8).map((i) => (
              <EventCard key={i.id} tone={isToday(i.scheduledAt) ? 'warn' : ''}
                title={`${fmtWhen(i.scheduledAt)} · ${(i.interviewType || '').toUpperCase()}`}
                meta={`${(i.candidate || {}).fullName || 'Candidate'} · ${(i.request || {}).title || ''} · ${i.mode || ''}`} />
            ))}
          </div>}
      </section>
    </div>
  );
}

/* Dispatcher. The real authenticated role picks the composition. */
function Dashboard({ user, onNavigate, dash }) {
  const persona = personaFor(user);
  const data = useDashboardData(user, persona, dash);

  if (!can(user, 'dashboard.view') && persona !== 'interviewer') {
    return <Forbidden what="Dashboard" need="dashboard.view" />;
  }
  if (data.loading) {
    return (<div>
      <DashHead eyebrow="Recruitment workspace" title="Loading…" sub="Fetching your scoped recruitment overview." />
      <DashboardSkeleton />
    </div>);
  }
  if (data.err) {
    return (<div>
      <DashHead eyebrow="Recruitment workspace" title="Dashboard unavailable" sub={data.err} />
      <div className="card"><div className="dash-state">
        <div className="dash-state-ico"><Icon name="shield" size={26} /></div>
        <h3>Dashboard unavailable</h3><p>{data.err}</p>
      </div></div>
    </div>);
  }

  const props = { user, data, onNavigate };
  if (persona === 'manager') return <ManagerDashboard {...props} />;
  if (persona === 'director') return <DirectorDashboard {...props} />;
  if (persona === 'executive') return <ExecutiveDashboard {...props} />;
  if (persona === 'interviewer') return <InterviewerDashboard {...props} />;
  return <RecruiterDashboard {...props} />;
}

/* ----------------------------- Reports / analytics ----------------------------- */
// A horizontal bar metric row (label · proportional fill · value).
function MetricBar({ rows, labeler = (s) => s, max }) {
  const items = (rows || []).filter((r) => r.count > 0);
  if (!items.length) return <Empty icon="📊" text="No data yet." />;
  const m = max || Math.max(...items.map((r) => r.count), 1);
  return <div>{items.map((r, i) => (
    <div className="metric-row" key={i}>
      <span className="mr-label">{labeler(r.status)}</span>
      <span className="mr-track"><span className="mr-fill" style={{ width: (r.count / m * 100) + '%', background: STAGE_COLORS[r.status] || CHART_COLORS[i % CHART_COLORS.length] }} /></span>
      <span className="mr-val">{r.count}</span>
    </div>
  ))}</div>;
}
// A proportional, tapering hiring-funnel with stage-to-stage conversion %.
function ReportFunnel({ data }) {
  const map = Object.fromEntries((data || []).map((d) => [d.status, d.count]));
  const rows = FUNNEL_ORDER.filter((s) => map[s] != null).map((s) => ({ status: s, count: map[s] }));
  if (!rows.length) return <Empty icon="🔻" text="No applications yet." />;
  const max = Math.max(...rows.map((r) => r.count), 1);
  return <div>{rows.map((r, i) => {
    const prev = i > 0 ? rows[i - 1].count : null;
    const conv = prev ? Math.round(r.count / prev * 100) : null;
    return (
      <div key={r.status}>
        {conv != null && <div className="report-conv">↓ {conv}% conversion</div>}
        <div className="report-funnel-step" style={{ width: Math.max(28, r.count / max * 100) + '%', background: STAGE_COLORS[r.status] || CHART_COLORS[i % CHART_COLORS.length] }}>
          <span>{(APP_STATUS[r.status] || {}).label || r.status}</span><span>{r.count}</span>
        </div>
      </div>
    );
  })}</div>;
}
function ReportsPage({ user }) {
  const toast = useToast();
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (!can(user, 'dashboard.view')) { setErr('You do not have analytics access.'); return; }
    api.get('/dashboard').then(setD).catch((e) => setErr(e.message));
  }, []);

  function exportCsv() {
    if (!d) return;
    const lines = [['Report', 'Category', 'Count']];
    d.requestsByStatus.forEach((r) => lines.push(['Requests by Status', (REQ_STATUS[r.status] || {}).label || r.status, r.count]));
    d.applicationsByStatus.forEach((r) => lines.push(['Hiring Funnel', (APP_STATUS[r.status] || {}).label || r.status, r.count]));
    d.offersByStatus.forEach((r) => lines.push(['Offer Outcomes', (OFFER_STATUS[r.status] || {}).label || r.status, r.count]));
    Object.entries(d.aging).forEach(([k, v]) => lines.push(['Requisition Aging', k + ' days', v]));
    const k = d.kpis;
    [['Open Requests', k.openRequests], ['Fill Rate %', k.fillRate], ['Total Applications', k.totalApplications],
     ['Offer Acceptance %', k.offerAcceptanceRate ?? ''], ['Joined', k.joined], ['Avg Time-to-Fill (days)', k.timeToFillDays ?? '']]
      .forEach(([kk, vv]) => lines.push(['KPI', kk, vv]));
    const csv = lines.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `arabtec-recruitment-report-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    toast('Report exported');
  }

  if (err) return (
    <div>
      <PageHead crumb="Overview / Reports" title="Recruitment Reports" sub="Read-only analytics · No salary data." />
      <div className="card"><div className="dash-state">
        <div className="dash-state-ico"><Icon name="shield" size={26} /></div>
        <h3>Reports unavailable</h3><p>{err}</p>
      </div></div>
    </div>
  );
  if (!d) return (
    <div>
      <PageHead crumb="Overview / Reports" title="Recruitment Reports" sub="Loading analytics…" />
      <div className="dash-kpi-row">{[0, 1, 2, 3].map((i) => <div className="dash-kpi dash-kpi-skel" key={i}><div className="skeleton" style={{ width: '52%' }} /><div className="skeleton" style={{ width: '34%', height: 26, margin: '12px 0 8px' }} /><div className="skeleton" style={{ width: '66%' }} /></div>)}</div>
      <div className="report-grid"><div className="card"><Skeleton rows={6} /></div><div className="card"><Skeleton rows={6} /></div></div>
    </div>
  );
  const k = d.kpis;
  const agingData = Object.entries(d.aging).map(([status, count]) => ({ status, count }));

  return (
    <div>
      <PageHead crumb="Overview / Reports" title="Recruitment Reports"
        sub={(d.scope === 'all' ? 'Organization-wide' : 'Your scope') + ' · Hiring funnel, time-to-fill, sources and outcomes. Read-only · No salary data.'}
        actions={<>
          <Badge variant="info">{d.scope === 'all' ? 'Org-wide' : 'My scope'}</Badge>
          <button className="btn btn-secondary" onClick={exportCsv}>Export CSV</button>
        </>} />

      <div className="dash-kpi-row">
        <DashKpi label="Avg Time-to-Fill" value={k.timeToFillDays == null ? '—' : k.timeToFillDays} unit={k.timeToFillDays == null ? null : ' days'} hint={k.timeToFillDays == null ? 'no filled requests yet' : 'across filled requests'} icon="scroll" tone="var(--brand-primary)" />
        <DashKpi label="Fill Rate" value={k.fillRate} unit="%" hint={`${k.headcountFilled} of ${k.headcountTotal} seats filled`} icon="dashboard" tone="var(--action-success)" />
        <DashKpi label="Offer Acceptance" value={k.offerAcceptanceRate == null ? '—' : k.offerAcceptanceRate} unit={k.offerAcceptanceRate == null ? null : '%'} hint={k.offerAcceptanceRate == null ? 'no decided offers yet' : 'accepted of decided'} icon="shield" tone="var(--action-success)" />
        <DashKpi label="Joined" value={k.joined} hint="candidates hired" icon="user" tone="var(--action-primary)" />
      </div>

      <div className="report-grid">
        <div className="card">
          <div className="card-head"><h3>Hiring Funnel</h3><span className="dash-headnote">{d.scope === 'all' ? 'All requests' : 'Your requests'}</span></div>
          <div className="card-pad"><DashFunnel data={d.applicationsByStatus} /></div>
        </div>
        <div className="card">
          <div className="card-head"><h3>Requests by Status</h3></div>
          <div className="card-pad"><DashBars
            rows={(d.requestsByStatus || []).map((r, i) => ({ label: (REQ_STATUS[r.status] || {}).label || r.status, count: r.count, color: CHART_COLORS[i % CHART_COLORS.length] })).sort((a, b) => b.count - a.count)}
            empty="No hiring requests yet." /></div>
        </div>
        <div className="card">
          <div className="card-head"><h3>Requisition Aging</h3><span className="dash-headnote">open requests</span></div>
          <div className="card-pad"><DashBars
            rows={agingData.map((r) => ({ label: r.status + ' days', count: r.count, color: r.status === '0-30' ? 'var(--action-success)' : r.status === '31-60' ? 'var(--warning)' : 'var(--danger)' }))}
            empty="No open requests to age." /></div>
        </div>
        <div className="card">
          <div className="card-head"><h3>Offer Outcomes</h3></div>
          <div className="card-pad"><DashBars
            rows={(d.offersByStatus || []).map((r, i) => ({ label: (OFFER_STATUS[r.status] || {}).label || r.status, count: r.count, color: CHART_COLORS[i % CHART_COLORS.length] })).sort((a, b) => b.count - a.count)}
            empty="No offers raised yet." /></div>
        </div>
        {d.scope === 'all' && (
          <div className="card full">
            <div className="card-head"><h3>Recruiter Load</h3><span className="dash-headnote">open requests per recruiter</span></div>
            <div className="card-pad"><DashBars
              rows={(d.recruiterLoad || []).map((r) => ({ label: r.name, count: r.c, color: 'var(--brand-primary)' }))}
              empty="No requests are assigned to a recruiter yet." /></div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------------------- Users page ----------------------------- */
function PageHead({ crumb, title, sub, actions }) {
  return (
    <div className="page-head">
      <div className="page-head-main">
        {crumb && <div className="breadcrumb">{crumb}</div>}
        <h1 className="page-title">{title}</h1>
        {sub && <p className="page-sub">{sub}</p>}
      </div>
      {actions && <div className="page-head-actions">{actions}</div>}
    </div>
  );
}

// Segmented view switcher shared by the list pages (Cards / Table, Board / Table).
function ViewToggle({ value, onChange, options }) {
  return (
    <div className="view-toggle" role="tablist">
      {options.map(([k, label]) => (
        <button key={k} role="tab" aria-selected={value === k}
          className={'view-toggle-btn' + (value === k ? ' active' : '')}
          onClick={() => onChange(k)}>{label}</button>
      ))}
    </div>
  );
}

// Compact "N results" pill used at the right edge of every filter bar.
function CountPill({ n, total, noun }) {
  if (n == null) return null;
  const label = total != null && total !== n ? `${n} of ${total}` : `${n}`;
  return <span className="count-pill">{label} <em>{n === 1 ? noun : noun + 's'}</em></span>;
}

// SLA / aging indicator for a hiring request. Reads the `health` object the
// requests API already returns ({ level, label, daysOpen }); renders nothing
// when the API did not supply it.
function ReqHealth({ health, compact }) {
  if (!health || !health.level) return <span className="muted">—</span>;
  const tone = health.level === 'red' ? 'red' : health.level === 'amber' ? 'amber' : 'green';
  return (
    <span className={'sla sla-' + tone} title={health.label}>
      <i />{compact ? '' : health.label}
      {health.daysOpen != null && <em>{health.daysOpen}d</em>}
    </span>
  );
}

// Mirrors backend src/lib/passwords.js so the browser shows the same rules. The
// server remains the authority — this is guidance, never the gate.
const PASSWORD_MIN = 12;
const PASSWORD_RULES = [
  { label: `At least ${PASSWORD_MIN} characters`, test: (v) => v.length >= PASSWORD_MIN },
  { label: 'An uppercase letter', test: (v) => /[A-Z]/.test(v) },
  { label: 'A lowercase letter', test: (v) => /[a-z]/.test(v) },
  { label: 'A number', test: (v) => /[0-9]/.test(v) },
  { label: 'A symbol', test: (v) => /[^A-Za-z0-9]/.test(v) },
];
function passwordChecklist(v) { return PASSWORD_RULES.map((r) => ({ label: r.label, ok: r.test(v || '') })); }

function PasswordRules({ value }) {
  return (
    <ul className="pw-rules">
      {passwordChecklist(value).map((r, i) => (
        <li key={i} className={r.ok ? 'ok' : ''}><span>{r.ok ? '✓' : '○'}</span>{r.label}</li>
      ))}
    </ul>
  );
}

/**
 * Change-password form. Used both for self-service (from the user menu) and for
 * the forced rotation screen. Nothing is logged, stored or toasted.
 */
function ChangePasswordForm({ forced, onDone, onCancel }) {
  const toast = useToast();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const allOk = passwordChecklist(next).every((r) => r.ok);
  const matches = next.length > 0 && next === confirm;

  function clear() { setCur(''); setNext(''); setConfirm(''); setErr(null); }

  async function submit(e) {
    if (e) e.preventDefault();
    setErr(null);
    if (!allOk) { setErr('New password does not meet the requirements below.'); return; }
    if (!matches) { setErr('New password and confirmation do not match.'); return; }
    setBusy(true);
    try {
      await api.post('/auth/change-password', { currentPassword: cur, newPassword: next });
      clear();
      toast('Password changed');
      onDone();
    } catch (e2) { setErr(e2.message || 'Could not change the password.'); }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} autoComplete="off">
      {err && <div className="error-banner" style={{ marginBottom: 14 }}>{err}</div>}
      <div className="field">
        <label>{forced ? 'Temporary password' : 'Current password'}</label>
        <div className="pw-input">
          <input type={show ? 'text' : 'password'} value={cur} autoComplete="current-password"
            onChange={(e) => setCur(e.target.value)} required />
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShow((v) => !v)}>{show ? 'Hide' : 'Show'}</button>
        </div>
      </div>
      <div className="field">
        <label>New password</label>
        <input type={show ? 'text' : 'password'} value={next} autoComplete="new-password"
          onChange={(e) => setNext(e.target.value)} required />
      </div>
      <div className="field">
        <label>Confirm new password</label>
        <input type={show ? 'text' : 'password'} value={confirm} autoComplete="new-password"
          onChange={(e) => setConfirm(e.target.value)} required />
        {confirm.length > 0 && !matches && <p className="field-hint" style={{ color: 'var(--danger)' }}>Passwords do not match.</p>}
      </div>
      <PasswordRules value={next} />
      <div className="row" style={{ gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
        {onCancel && <button type="button" className="btn btn-ghost" onClick={() => { clear(); onCancel(); }}>Cancel</button>}
        <button type="submit" className="btn" disabled={busy || !allOk || !matches}>{busy ? 'Saving…' : 'Change password'}</button>
      </div>
    </form>
  );
}

// Full-screen gate. Rendered INSTEAD of the app shell while the account carries
// must_change_password, so no page, route or API call is reachable until the
// password is rotated. The server enforces the same rule independently.
function ForcedPasswordChange({ user, onDone, onLogout }) {
  return (
    <div className="forced-pw-wrap">
      <div className="forced-pw-card card">
        <div className="forced-pw-head">
          <h1>Choose a new password</h1>
          <p>
            Your account uses a temporary password. For security you must set your own
            password before using {'\u00A0'}the Recruitment Hub.
          </p>
          <p className="muted" style={{ fontSize: 12.5 }}>Signed in as <strong>{user.email}</strong></p>
        </div>
        <ChangePasswordForm forced onDone={onDone} />
        <div className="forced-pw-foot">
          <button className="btn btn-ghost btn-sm" onClick={onLogout}>Sign out instead</button>
        </div>
      </div>
    </div>
  );
}

// Shown when a route is reached without the permission that owns it. The nav item
// is already filtered, but a direct route change must not fall through to the page.
function Forbidden({ what, need }) {
  return (
    <div>
      <PageHead crumb="Access" title="Not authorised" />
      <div className="card"><div className="dash-state">
        <div className="dash-state-ico"><Icon name="shield" size={26} /></div>
        <h3>{what} is restricted</h3>
        <p>Your account does not have permission to open this page. {need ? `It is limited to ${need}.` : ''}</p>
      </div></div>
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
  const [resetTarget, setResetTarget] = useState(null);   // user whose password is being reset
  const [otp, setOtp] = useState(null);                   // { title, email, roleNames, password }
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
  // Opens the reset dialog. The old implementation posted immediately, discarded the
  // returned temporaryPassword and reported "reset to default" — there is no default.
  function resetPwd(u) { setResetTarget(u); }
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
                      <button className="btn btn-ghost btn-sm" onClick={() => resetPwd(u)}>Reset Password</button>{' '}
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
        onClose={() => setEditing(null)}
        onSaved={(res) => {
          setEditing(null); load();
          // Only present when the server generated the password (admin left it blank).
          if (res && res.temporaryPassword) {
            setOtp({
              title: 'User created — temporary password',
              email: (res.user && res.user.email) || '',
              roleNames: ((res.user && res.user.roles) || []).map((r) => r.name).join(', '),
              password: res.temporaryPassword,
            });
          }
        }} />}

      {resetTarget && <ResetPasswordModal target={resetTarget}
        onClose={() => setResetTarget(null)}
        onGenerated={(pwd) => {
          const t = resetTarget; setResetTarget(null); load();
          setOtp({
            title: 'Temporary password generated',
            email: t.email,
            roleNames: (t.roles || []).map((r) => r.name).join(', '),
            password: pwd,
          });
        }}
        onSet={() => { setResetTarget(null); load(); toast('Password reset'); }} />}

      {otp && <OneTimePasswordDialog {...otp} onClose={() => setOtp(null)} />}
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

// Shows a server-generated temporary password EXACTLY once. The value lives only in
// this component's props for the lifetime of the dialog: it is never logged, never put
// in a toast, and never written to localStorage/sessionStorage.
function OneTimePasswordDialog({ title, email, roleNames, password, onClose }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true); setTimeout(() => setCopied(false), 2000);
    } catch { toast('Could not copy — select the password and copy manually.', 'error'); }
  }
  return (
    <Modal title={title} onClose={onClose}
      footer={<button className="btn" onClick={onClose}>Done</button>}>
      <div className="otp-warn">
        <strong>This password is shown once.</strong> Copy it now — it cannot be retrieved
        later. Share it with the user through a separate channel.
      </div>
      <div className="otp-meta">
        <div><span>User</span><strong>{email}</strong></div>
        {roleNames ? <div><span>Role</span><strong>{roleNames}</strong></div> : null}
      </div>
      <div className="otp-box">
        <code className="otp-value">{password}</code>
        <button className="btn btn-secondary btn-sm" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <p className="muted" style={{ marginTop: 12, fontSize: 12.5 }}>
        The user must set their own password at first login.
      </p>
    </Modal>
  );
}

// Reset flow: the admin either lets the server generate a temporary password, or sets
// one themselves. Replaces the old "reset to default" call, which was misleading —
// there is no default password.
function ResetPasswordModal({ target, onClose, onGenerated, onSet }) {
  const toast = useToast();
  const [mode, setMode] = useState('generate');   // generate | choose
  const [pwd, setPwd] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (mode === 'choose' && !pwd.trim()) { toast('Enter a password or switch to Generate.', 'error'); return; }
    setBusy(true);
    try {
      const body = mode === 'choose' ? { newPassword: pwd } : {};
      const r = await api.post(`/users/${target.id}/reset-password`, body);
      setPwd('');                                  // clear from component state immediately
      if (r && r.temporaryPassword) onGenerated(r.temporaryPassword);
      else onSet();
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={`Reset password — ${target.fullName}`} onClose={() => { setPwd(''); onClose(); }}
      footer={<>
        <button className="btn btn-ghost" onClick={() => { setPwd(''); onClose(); }}>Cancel</button>
        <button className="btn" onClick={submit} disabled={busy}>{busy ? 'Resetting…' : 'Reset password'}</button>
      </>}>
      <p className="muted" style={{ marginTop: 0 }}>
        This signs {target.fullName} out of all sessions and forces them to choose a new
        password at next login.
      </p>
      <label className="radio-row">
        <input type="radio" name="pwmode" checked={mode === 'generate'} onChange={() => { setMode('generate'); setPwd(''); }} />
        <span><strong>Generate a temporary password</strong><em>Shown once, on the next screen.</em></span>
      </label>
      <label className="radio-row">
        <input type="radio" name="pwmode" checked={mode === 'choose'} onChange={() => setMode('choose')} />
        <span><strong>Set a temporary password myself</strong><em>Minimum 8 characters, using at least three of: lowercase, uppercase, number, symbol.</em></span>
      </label>
      {mode === 'choose' && (
        <div className="field" style={{ marginTop: 12 }}>
          <label>New temporary password</label>
          <div className="pw-input">
            <input type={show ? 'text' : 'password'} value={pwd} autoComplete="new-password"
              onChange={(e) => setPwd(e.target.value)} placeholder="Enter a temporary password" />
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShow((v) => !v)}>{show ? 'Hide' : 'Show'}</button>
          </div>
        </div>
      )}
    </Modal>
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
  // Held only until submit, then cleared. Never logged, stored or echoed back.
  const [initialPassword, setInitialPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const toggleArr = (k, v) => setF((s) => ({ ...s, [k]: s[k].includes(v) ? s[k].filter((x) => x !== v) : [...s[k], v] }));

  async function save() {
    setBusy(true);
    try {
      const payload = { ...f, departmentId: f.departmentId || null };
      // Only send `password` when the admin actually typed one; blank means
      // "let the server generate a temporary password and return it once".
      if (isNew && initialPassword.trim()) payload.password = initialPassword;
      let res = null;
      if (isNew) res = await api.post('/users', payload);
      else await api.put('/users/' + user.id, payload);
      setInitialPassword('');                       // clear before anything else
      toast(isNew ? 'User created' : 'User updated');
      onSaved(res);                                 // parent surfaces temporaryPassword
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }
  return (
    <Modal title={isNew ? 'Create User' : 'Edit User'} onClose={() => { setInitialPassword(''); onClose(); }} wide
      footer={<><button className="btn btn-ghost" onClick={() => { setInitialPassword(''); onClose(); }}>Cancel</button><button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></>}>
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
      {isNew && <>
        <div className="section-title">Initial password</div>
        <div className="field" style={{ maxWidth: 440 }}>
          <label>Initial password</label>
          <div className="pw-input">
            <input type={showPwd ? 'text' : 'password'} value={initialPassword} autoComplete="new-password"
              onChange={(e) => setInitialPassword(e.target.value)} placeholder="Leave blank to generate one" />
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowPwd((v) => !v)}>{showPwd ? 'Hide' : 'Show'}</button>
          </div>
          <p className="field-hint">Optional. Leave blank to generate a temporary password — it is shown once, immediately after the user is created. Either way the user must set their own password at first login.</p>
        </div>
      </>}
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
      <div className="roles-grid">
        <div className="card"><div className="card-pad">
          {roles.map((r) => (
            <button key={r.id} className={'nav-item' + (selected?.id === r.id ? ' active' : '')} onClick={() => pick(r)} aria-current={selected?.id === r.id ? 'true' : undefined}>
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
          <div className="table-wrap"><table className="responsive-table"><thead><tr><th>Code</th><th>Name</th><th>Client</th><th>Location</th><th>Status</th><th>Sites</th><th>PM</th>{canManage && <th></th>}</tr></thead>
            <tbody>{rows.map((p) => (
              <tr key={p.id}><td data-label="Code"><strong>{p.code}</strong></td><td data-label="Name">{p.name}</td><td data-label="Client">{p.clientName || '—'}</td><td data-label="Location">{p.location || '—'}</td>
                <td data-label="Status"><StatusBadge status={p.status} /></td><td data-label="Sites">{p.siteCount}</td><td data-label="PM">{p.projectManager?.name || '—'}</td>
                {canManage && <td className="cell-actions"><button className="btn btn-secondary btn-sm" onClick={() => setEditing(p)}>Edit</button></td>}</tr>
            ))}</tbody></table></div>
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
          <div className="table-wrap"><table className="responsive-table"><thead><tr><th>Code</th><th>Name</th><th>Project</th><th>Location</th><th>Status</th><th>Site Manager</th>{canManage && <th></th>}</tr></thead>
            <tbody>{rows.map((s) => (
              <tr key={s.id}><td data-label="Code"><strong>{s.code}</strong></td><td data-label="Name">{s.name}</td><td data-label="Project">{s.project?.name || '—'}</td><td data-label="Location">{s.location || '—'}</td>
                <td data-label="Status"><StatusBadge status={s.status} /></td><td data-label="Site Manager">{s.siteManager?.name || '—'}</td>
                {canManage && <td className="cell-actions"><button className="btn btn-secondary btn-sm" onClick={() => setEditing(s)}>Edit</button></td>}</tr>
            ))}</tbody></table></div>
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
          <div className="table-wrap"><table className="responsive-table"><thead><tr><th>Code</th><th>Name</th><th>Head</th><th>Status</th>{canManage && <th></th>}</tr></thead>
            <tbody>{rows.map((d) => (
              <tr key={d.id}><td data-label="Code"><strong>{d.code}</strong></td><td data-label="Name">{d.name}</td><td data-label="Head">{d.head?.name || '—'}</td>
                <td data-label="Status"><StatusBadge status={d.status} /></td>
                {canManage && <td className="cell-actions"><button className="btn btn-secondary btn-sm" onClick={() => setEditing(d)}>Edit</button></td>}</tr>
            ))}</tbody></table></div>
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
/* Reusable: render admin-defined custom fields on a form. `values` is an object
   keyed by fieldKey; `onChange(key, val)` updates it. Loads definitions for the entity. */
function useCustomFields(entity) {
  const [defs, setDefs] = useState([]);
  useEffect(() => { api.get('/admin-ui/custom-fields/' + entity).then((r) => setDefs(r.fields.filter((f) => f.visible))).catch(() => setDefs([])); }, [entity]);
  return defs;
}
function CustomFieldsInputs({ defs, values, onChange }) {
  if (!defs || !defs.length) return null;
  return <>{defs.map((f) => {
    const v = values[f.fieldKey] ?? '';
    const label = f.label + (f.required ? ' *' : '');
    if (f.fieldType === 'textarea') return <div key={f.fieldKey} className="field full"><label>{label}</label><textarea value={v} onChange={(e) => onChange(f.fieldKey, e.target.value)} /></div>;
    if (f.fieldType === 'select') return <div key={f.fieldKey} className="field"><label>{label}</label><select value={v} onChange={(e) => onChange(f.fieldKey, e.target.value)}><option value="">—</option>{(f.options || []).map((o) => <option key={o}>{o}</option>)}</select></div>;
    if (f.fieldType === 'checkbox') return <div key={f.fieldKey} className="field"><label>{label}</label><input type="checkbox" checked={v === 'true' || v === true} onChange={(e) => onChange(f.fieldKey, e.target.checked ? 'true' : 'false')} /></div>;
    const type = f.fieldType === 'number' ? 'number' : f.fieldType === 'date' ? 'date' : 'text';
    return <div key={f.fieldKey} className="field"><label>{label}</label><input type={type} value={v} onChange={(e) => onChange(f.fieldKey, e.target.value)} /></div>;
  })}</>;
}

/* ============================ SUPER-ADMIN CONTROL CENTER ============================ */
function ControlCenterPage({ user, branding, refreshBranding }) {
  const [tab, setTab] = useState('buttons');
  const TABS = [['buttons', 'Buttons'], ['notifications', 'Notifications'], ['branding', 'Branding & Logo'],
    ['fields', 'Built-in Fields'], ['custom', 'Custom Fields']];
  return (
    <div>
      <PageHead crumb="Configuration / Control Center" title="Control Center"
        sub="Super-admin control of the whole app: turn buttons on/off, choose which notifications and emails go out and to whom, upload the logo, show or hide any built-in field, and add your own custom fields." />
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', marginBottom: 18, flexWrap: 'wrap' }}>
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className="btn btn-ghost"
            style={{ border: 'none', borderBottom: tab === k ? '2px solid var(--secondary)' : '2px solid transparent', borderRadius: 0, color: tab === k ? 'var(--secondary)' : 'var(--text-gray)', fontWeight: tab === k ? 700 : 500 }}>{label}</button>
        ))}
      </div>
      {tab === 'buttons' && <ButtonsPanel user={user} />}
      {tab === 'notifications' && <NotificationsPanel user={user} />}
      {tab === 'branding' && <BrandingLogoPanel user={user} branding={branding} refreshBranding={refreshBranding} />}
      {tab === 'fields' && <BuiltinFieldsPanel user={user} />}
      {tab === 'custom' && <CustomFieldsPanel user={user} />}
    </div>
  );
}

// --- Buttons panel (reuses the existing button registry) ---
function ButtonsPanel({ user }) {
  const toast = useToast();
  const [rows, setRows] = useState(null);   // edited working copy
  const [orig, setOrig] = useState(null);   // last-saved snapshot (to detect changes)
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const b = (await api.get('/settings/buttons')).buttons;
    setRows(b); setOrig(JSON.parse(JSON.stringify(b)));
  }, []);
  useEffect(() => { load(); }, []);
  // Edit locally only; nothing is saved until "Save Changes" is clicked.
  function edit(key, patch) {
    setRows((rs) => rs.map((b) => b.buttonKey === key ? { ...b, ...patch } : b));
  }
  const FLAGS = ['label', 'visible', 'enabled', 'confirmRequired', 'reasonRequired'];
  function changedKeys() {
    if (!orig) return [];
    const om = Object.fromEntries(orig.map((b) => [b.buttonKey, b]));
    return rows.filter((b) => FLAGS.some((f) => b[f] !== om[b.buttonKey][f]));
  }
  async function saveAll() {
    const changed = changedKeys();
    if (!changed.length) { toast('No changes to save'); return; }
    setBusy(true);
    try {
      for (const b of changed) {
        await api.put('/settings/buttons/' + b.buttonKey, { label: b.label, visible: b.visible, enabled: b.enabled, confirmRequired: b.confirmRequired, reasonRequired: b.reasonRequired });
      }
      toast(`Saved ${changed.length} button${changed.length > 1 ? 's' : ''} ✓`);
      await load();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }
  if (!rows) return <Skeleton rows={8} />;
  const filtered = rows.filter((b) => !q || (b.label + b.buttonKey + b.screen).toLowerCase().includes(q.toLowerCase()));
  const dirty = changedKeys().length;
  return (
    <div className="card card-pad">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
        <input placeholder="Search buttons…" value={q} onChange={(e) => setQ(e.target.value)} style={{ padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6, width: 260 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {dirty > 0 && <span className="muted" style={{ fontSize: 12.5 }}>{dirty} unsaved change{dirty > 1 ? 's' : ''}</span>}
          {dirty > 0 && <button className="btn btn-ghost btn-sm" onClick={load} disabled={busy}>Discard</button>}
          <button className="btn" onClick={saveAll} disabled={busy || dirty === 0}>{busy ? 'Saving…' : 'Save Changes'}</button>
        </div>
      </div>
      <table><thead><tr><th>Button</th><th>Screen</th><th>Label</th><th>Visible</th><th>Enabled</th><th>Confirm</th><th>Reason</th></tr></thead>
        <tbody>{filtered.map((b) => (
          <tr key={b.buttonKey}>
            <td><strong>{b.label}</strong><div className="muted" style={{ fontSize: 11 }}>{b.buttonKey}</div></td>
            <td><span className="chip">{b.screen}</span></td>
            <td><input value={b.label} onChange={(e) => edit(b.buttonKey, { label: e.target.value })} style={{ width: 130, padding: 4, border: '1px solid var(--border)', borderRadius: 5 }} /></td>
            {['visible', 'enabled', 'confirmRequired', 'reasonRequired'].map((flag) => (
              <td key={flag}><input type="checkbox" checked={!!b[flag]} onChange={(e) => edit(b.buttonKey, { [flag]: e.target.checked })} /></td>
            ))}
          </tr>
        ))}</tbody></table>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>Toggle what you need, then click <strong>Save Changes</strong>. Nothing is applied until you save.</div>
    </div>
  );
}

// --- Notifications panel -----------------------------------------------------
// One row per catalogued event: on/off, the two channels, and who it reaches.
// Saves per-row so a mis-tick never takes the whole page with it, and every
// change is written to the audit log by the API.
function NotificationsPanel({ user }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(() => new Set());
  // notification.manage, not system.manage: who a rejection email reaches is a
  // recruiting decision. The four HR/recruitment roles hold it (see permissions.js).
  const canEdit = can(user, 'notification.manage');

  const load = useCallback(() => {
    api.get('/settings/notifications').then(setData).catch((e) => setErr(e.message));
  }, []);
  useEffect(load, [load]);

  async function patch(eventKey, change) {
    if (!canEdit) return;
    setSaving((s) => new Set(s).add(eventKey));
    // Optimistic only in the sense that the row shows "saving"; the value shown
    // afterwards is whatever the server returns, never what we hoped it would be.
    try {
      const r = await api.put(`/settings/notifications/${eventKey}`, change);
      setData((d) => ({ ...d, notifications: d.notifications.map((n) => (n.eventKey === eventKey ? r.notification : n)) }));
    } catch (e) {
      toast(e.message || 'Could not save that setting.', 'error');
      load();   // resync, so the checkbox can never show a state the server rejected
    } finally {
      setSaving((s) => { const n = new Set(s); n.delete(eventKey); return n; });
    }
  }

  function toggleRecipient(n, token) {
    const next = n.recipients.includes(token)
      ? n.recipients.filter((r) => r !== token)
      : [...n.recipients, token];
    patch(n.eventKey, { recipients: next });
  }

  if (err) return <div className="error-banner">{err}</div>;
  if (!data) return <div className="card"><Skeleton rows={8} /></div>;

  const categories = [...new Set(data.notifications.map((n) => n.category))];
  const external = new Set(data.externalRecipients || []);

  return (
    <div>
      {!data.emailConfigured && (
        <div className="notice notice-warn card-pad" style={{ marginBottom: 14 }}>
          <strong>No mailbox is configured.</strong> In-app alerts still work; anything ticked
          for email is recorded but will not send until SMTP is set up in System Settings.
        </div>
      )}
      {!canEdit && (
        <div className="notice notice-info card-pad" style={{ marginBottom: 14 }}>
          You can see how notifications are configured. Changing them needs the
          System Settings permission.
        </div>
      )}

      {categories.map((cat) => (
        <section className="card" key={cat} style={{ marginBottom: 16 }}>
          <div className="card-head"><h3>{cat}</h3>
            <span className="dash-headnote">{data.notifications.filter((n) => n.category === cat).length} events</span></div>
          <div className="table-wrap">
            <table className="table responsive-table">
              <thead><tr>
                <th style={{ minWidth: 260 }}>Event</th>
                <th style={{ width: 70 }}>On</th>
                <th style={{ width: 80 }}>In-app</th>
                <th style={{ width: 80 }}>Email</th>
                <th>Send to</th>
              </tr></thead>
              <tbody>
                {data.notifications.filter((n) => n.category === cat).map((n) => {
                  const busy = saving.has(n.eventKey);
                  const off = !n.enabled;
                  return (
                    <tr key={n.eventKey} style={busy ? { opacity: .55 } : null}>
                      <td data-label="Event">
                        <span className="cell-strong">{n.label}</span>
                        <span className="cell-sub">{n.description}</span>
                        {n.externalRecipients.length > 0 && n.enabled && n.email && (
                          <span className="badge badge-warning" style={{ marginTop: 6 }}>Reaches candidates</span>
                        )}
                      </td>
                      <td data-label="On">
                        <input type="checkbox" checked={n.enabled} disabled={!canEdit || busy}
                          aria-label={`Enable ${n.label}`}
                          onChange={(e) => patch(n.eventKey, { enabled: e.target.checked })} />
                      </td>
                      <td data-label="In-app">
                        <input type="checkbox" checked={n.inApp} disabled={!canEdit || busy || off}
                          aria-label={`In-app alert for ${n.label}`}
                          onChange={(e) => patch(n.eventKey, { inApp: e.target.checked })} />
                      </td>
                      <td data-label="Email">
                        <input type="checkbox" checked={n.email} disabled={!canEdit || busy || off}
                          aria-label={`Email for ${n.label}`}
                          onChange={(e) => patch(n.eventKey, { email: e.target.checked })} />
                      </td>
                      <td data-label="Send to">
                        <div className="recip-grid">
                          {Object.entries(data.recipients).map(([token, label]) => (
                            <label key={token} className={'recip' + (external.has(token) ? ' recip-external' : '')}
                              title={label}>
                              <input type="checkbox" checked={n.recipients.includes(token)}
                                disabled={!canEdit || busy || off}
                                onChange={() => toggleRecipient(n, token)} />
                              <span>{label.split(' — ')[0]}</span>
                            </label>
                          ))}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      <p className="muted" style={{ fontSize: 12 }}>
        Recipients are roles relative to the record, not named people — “Requester” means
        whoever raised that particular request. Settings survive releases, and every change
        is written to the audit log.
      </p>
    </div>
  );
}

// --- Branding + logo panel ---
function BrandingLogoPanel({ user, branding, refreshBranding }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [logoVersion, setLogoVersion] = useState(Date.now());
  const [f, setF] = useState({ app_name: branding?.app_name || 'Arabtec', button_color: branding?.button_color || '#d2232a' });
  const hasLogo = branding?.logo_stored_name;
  async function saveBranding() {
    setBusy(true);
    try { await api.put('/settings/branding', { branding: f }); toast('Branding saved'); refreshBranding && refreshBranding(); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }
  async function uploadLogo(e) {
    const file = e.target.files?.[0]; if (!file) return;
    setBusy(true);
    try { await api.upload('/admin-ui/logo', file); toast('Logo uploaded'); setLogoVersion(Date.now()); refreshBranding && refreshBranding(); }
    catch (err) { toast(err.message, 'error'); } finally { setBusy(false); e.target.value = ''; }
  }
  async function removeLogo() {
    setBusy(true);
    try { await api.del('/admin-ui/logo'); toast('Logo removed'); setLogoVersion(Date.now()); refreshBranding && refreshBranding(); }
    catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
      <div className="card card-pad">
        <div className="section-title" style={{ marginTop: 0 }}>Logo</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 12 }}>
          <div style={{ width: 96, height: 72, border: '1px solid var(--border)', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fff', overflow: 'hidden' }}>
            {hasLogo ? <img src={`/api/admin-ui/logo?v=${logoVersion}`} alt="Logo" style={{ maxWidth: '100%', maxHeight: '100%' }} /> : <Logo size={40} withText />}
          </div>
          <div>
            <label className="btn btn-sm" style={{ cursor: 'pointer' }}>{busy ? 'Uploading…' : (hasLogo ? 'Replace Logo' : '+ Upload Logo')}
              <input type="file" style={{ display: 'none' }} accept=".png,.jpg,.jpeg,.svg" onChange={uploadLogo} disabled={busy} /></label>
            {hasLogo && <button className="btn btn-sm btn-ghost" style={{ marginLeft: 8 }} onClick={removeLogo} disabled={busy}>Remove</button>}
            <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>PNG, JPG or SVG. Shown app-wide and on the login screen.</div>
          </div>
        </div>
      </div>
      <div className="card card-pad">
        <div className="section-title" style={{ marginTop: 0 }}>Identity</div>
        <div className="field"><label>App Name</label><input value={f.app_name} onChange={(e) => setF((s) => ({ ...s, app_name: e.target.value }))} /></div>
        <div className="field"><label>Primary Color</label><input type="color" value={f.button_color} onChange={(e) => setF((s) => ({ ...s, button_color: e.target.value }))} style={{ width: 60, height: 32, padding: 2 }} /></div>
        <button className="btn" onClick={saveBranding} disabled={busy} style={{ marginTop: 10 }}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}

// --- Built-in field visibility panel ---
function BuiltinFieldsPanel({ user }) {
  const toast = useToast();
  const [form, setForm] = useState('request');
  const [fields, setFields] = useState(null);
  const [orig, setOrig] = useState(null);
  const [busy, setBusy] = useState(false);
  const FORMS = [['request', 'Recruitment Request'], ['candidate', 'Candidate'], ['offer', 'Offer'], ['interview', 'Interview']];
  const load = useCallback(async (frm) => {
    const fs = (await api.get('/admin-ui/fields/' + frm)).fields;
    setFields(fs); setOrig(JSON.parse(JSON.stringify(fs)));
  }, []);
  useEffect(() => { setFields(null); load(form); }, [form]);
  function edit(fieldKey, patch) {
    setFields((fs) => fs.map((f) => f.fieldKey === fieldKey ? { ...f, ...patch } : f));
  }
  function changed() {
    if (!orig) return [];
    const om = Object.fromEntries(orig.map((f) => [f.fieldKey, f]));
    return fields.filter((f) => ['visible', 'required', 'label'].some((k) => f[k] !== om[f.fieldKey][k]));
  }
  async function saveAll() {
    const ch = changed();
    if (!ch.length) { toast('No changes to save'); return; }
    setBusy(true);
    try {
      for (const f of ch) await api.put(`/admin-ui/fields/${form}/${f.fieldKey}`, { visible: f.visible, required: f.required, label: f.label || null });
      toast(`Saved ${ch.length} field${ch.length > 1 ? 's' : ''} ✓`);
      await load(form);
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }
  const dirty = fields ? changed().length : 0;
  return (
    <div className="card card-pad">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
        <div><label className="muted" style={{ marginRight: 8 }}>Form:</label>
          <select value={form} onChange={(e) => setForm(e.target.value)} style={{ padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6 }}>
            {FORMS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select></div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {dirty > 0 && <span className="muted" style={{ fontSize: 12.5 }}>{dirty} unsaved</span>}
          {dirty > 0 && <button className="btn btn-ghost btn-sm" onClick={() => load(form)} disabled={busy}>Discard</button>}
          <button className="btn" onClick={saveAll} disabled={busy || dirty === 0}>{busy ? 'Saving…' : 'Save Changes'}</button>
        </div>
      </div>
      {!fields ? <Skeleton rows={6} /> : (
        <table><thead><tr><th>Field</th><th>Visible</th><th>Required</th><th>Custom Label</th></tr></thead>
          <tbody>{fields.map((fl) => (
            <tr key={fl.fieldKey}>
              <td><strong>{fl.defaultLabel}</strong><div className="muted" style={{ fontSize: 11 }}>{fl.fieldKey}</div></td>
              <td><input type="checkbox" checked={fl.visible} onChange={(e) => edit(fl.fieldKey, { visible: e.target.checked })} /></td>
              <td><input type="checkbox" checked={fl.required} onChange={(e) => edit(fl.fieldKey, { required: e.target.checked })} /></td>
              <td><input value={fl.label || ''} placeholder={fl.defaultLabel} onChange={(e) => edit(fl.fieldKey, { label: e.target.value })} style={{ width: 150, padding: 4, border: '1px solid var(--border)', borderRadius: 5 }} /></td>
            </tr>
          ))}</tbody></table>
      )}
      <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>Toggle visibility/required or rename, then click <strong>Save Changes</strong>. Nothing applies until you save.</div>
    </div>
  );
}

// --- Custom fields panel ---
function CustomFieldsPanel({ user }) {
  const toast = useToast();
  const [entity, setEntity] = useState('candidate');
  const [fields, setFields] = useState(null);
  const [adding, setAdding] = useState(false);
  const [nf, setNf] = useState({ label: '', fieldType: 'text', required: false, options: '' });
  const ENTITIES = [['candidate', 'Candidate'], ['request', 'Recruitment Request']];
  const TYPES = ['text', 'textarea', 'number', 'date', 'select', 'checkbox'];
  const load = useCallback(async (e) => setFields((await api.get('/admin-ui/custom-fields/' + e)).fields), []);
  useEffect(() => { setFields(null); load(entity); }, [entity]);
  async function create() {
    if (!nf.label.trim()) { toast('Label is required', 'error'); return; }
    try {
      await api.post('/admin-ui/custom-fields/' + entity, { label: nf.label, fieldType: nf.fieldType, required: nf.required, options: nf.fieldType === 'select' ? nf.options : null });
      toast('Custom field added'); setAdding(false); setNf({ label: '', fieldType: 'text', required: false, options: '' }); load(entity);
    } catch (e) { toast(e.message, 'error'); }
  }
  async function remove(key) {
    if (!confirm('Delete this custom field and all its saved values?')) return;
    try { await api.del(`/admin-ui/custom-fields/${entity}/${key}`); toast('Deleted'); load(entity); }
    catch (e) { toast(e.message, 'error'); }
  }
  async function toggle(key, patch) {
    try { await api.put(`/admin-ui/custom-fields/${entity}/${key}`, patch); load(entity); }
    catch (e) { toast(e.message, 'error'); }
  }
  return (
    <div className="card card-pad">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div><label className="muted" style={{ marginRight: 8 }}>Entity:</label>
          <select value={entity} onChange={(e) => setEntity(e.target.value)} style={{ padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6 }}>
            {ENTITIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select></div>
        <button className="btn btn-sm" onClick={() => setAdding((a) => !a)}>{adding ? 'Cancel' : '+ Add Custom Field'}</button>
      </div>
      {adding && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 12, background: 'var(--ticket-chip-bg, #fbeef0)' }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="field" style={{ margin: 0 }}><label>Label</label><input value={nf.label} onChange={(e) => setNf((s) => ({ ...s, label: e.target.value }))} placeholder="e.g. Iqama Number" /></div>
            <div className="field" style={{ margin: 0 }}><label>Type</label><select value={nf.fieldType} onChange={(e) => setNf((s) => ({ ...s, fieldType: e.target.value }))}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select></div>
            {nf.fieldType === 'select' && <div className="field" style={{ margin: 0 }}><label>Options (comma-sep)</label><input value={nf.options} onChange={(e) => setNf((s) => ({ ...s, options: e.target.value }))} placeholder="A, B, C" /></div>}
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13 }}><input type="checkbox" checked={nf.required} onChange={(e) => setNf((s) => ({ ...s, required: e.target.checked }))} /> Required</label>
            <button className="btn btn-sm" onClick={create}>Add</button>
          </div>
        </div>
      )}
      {!fields ? <Skeleton rows={4} /> : fields.length === 0 ? <Empty icon="➕" text="No custom fields yet. Add one above." /> : (
        <table><thead><tr><th>Label</th><th>Key</th><th>Type</th><th>Required</th><th>Visible</th><th></th></tr></thead>
          <tbody>{fields.map((cf) => (
            <tr key={cf.fieldKey}>
              <td><strong>{cf.label}</strong></td>
              <td className="muted" style={{ fontSize: 11 }}>{cf.fieldKey}</td>
              <td><span className="chip">{cf.fieldType}</span></td>
              <td><input type="checkbox" checked={cf.required} onChange={(e) => toggle(cf.fieldKey, { required: e.target.checked })} /></td>
              <td><input type="checkbox" checked={cf.visible} onChange={(e) => toggle(cf.fieldKey, { visible: e.target.checked })} /></td>
              <td><button className="btn btn-sm btn-ghost" onClick={() => remove(cf.fieldKey)}>Delete</button></td>
            </tr>
          ))}</tbody></table>
      )}
      <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>Custom fields appear on the {entity === 'candidate' ? 'Add/Edit Candidate' : 'Create/Edit Request'} form and save with the record.</div>
    </div>
  );
}

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
// Simplified request states (Phase 0). Legacy keys kept as aliases so any
// un-migrated rows still render a sensible label.
const REQ_STATUS = {
  pending_approval: { label: 'Pending Approval', variant: 'warning' },
  sourcing: { label: 'Sourcing', variant: 'info' },
  in_progress: { label: 'In Progress', variant: 'info' },
  partially_filled: { label: 'Partially Filled', variant: 'info' },
  filled: { label: 'Filled', variant: 'success' },
  closed: { label: 'Closed', variant: 'soft' },
  on_hold: { label: 'On Hold', variant: 'warning' },
  rejected: { label: 'Rejected', variant: 'critical' },
  cancelled: { label: 'Cancelled', variant: 'critical' },
  expired: { label: 'Expired', variant: 'soft' },
  reopened: { label: 'Reopened', variant: 'info' },
  // legacy aliases
  draft: { label: 'Pending Approval', variant: 'warning' },
  budget_validation: { label: 'Pending Approval', variant: 'warning' },
  approved: { label: 'Sourcing', variant: 'info' },
  in_sourcing: { label: 'Sourcing', variant: 'info' },
};
const PRIORITY = {
  low: { label: 'Low', variant: 'soft' }, medium: { label: 'Medium', variant: 'info' },
  high: { label: 'High', variant: 'warning' }, critical: { label: 'Critical', variant: 'critical' },
};
function PriorityBadge({ p }) { const x = PRIORITY[p] || { label: p, variant: 'soft' }; return <Badge variant={x.variant}>{x.label}</Badge>; }
// Request status badge — reuses the existing REQ_STATUS label/variant vocabulary.
function ReqStatusBadge({ status, displayStatus }) {
  const x = REQ_STATUS[status];
  if (!x && !displayStatus) return <span className="muted">—</span>;
  return <Badge variant={(x || {}).variant || 'soft'}>{(x || {}).label || displayStatus}</Badge>;
}
// Table-shaped loading placeholder, so list pages do not flash a bare card.
// Two-line date cell: weekday+date on top, time below. Falls back cleanly to
// an em-dash when the API returned no timestamp.
function DateCell({ value, dateOnly }) {
  if (!value) return <span className="muted">—</span>;
  const dt = new Date(value);
  if (isNaN(dt)) return <span className="muted">—</span>;
  const d = dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const t = dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return <span className="datecell"><span className="cell-strong">{d}</span>{!dateOnly && <span className="cell-sub">{t}</span>}</span>;
}
function ListSkeleton({ rows = 6 }) {
  return (
    <div className="card flush list-skel">
      <div className="list-skel-head" />
      {Array.from({ length: rows }).map((_, i) => (
        <div className="list-skel-row" key={i}>
          <div className="skeleton" style={{ width: 70 }} />
          <div className="skeleton" style={{ flex: 1, maxWidth: 260 }} />
          <div className="skeleton" style={{ width: 110 }} />
          <div className="skeleton" style={{ width: 76 }} />
        </div>
      ))}
    </div>
  );
}

// Resolve admin-controlled buttons for current user from the server.
// Retries a transient failure so detail-page action bars don't silently and
// permanently disappear when this one secondary fetch hiccups.
function useResolvedButtons() {
  const [map, setMap] = useState({});
  useEffect(() => {
    let cancelled = false;
    const load = (attempt = 0) => api.get('/settings/buttons/resolved')
      .then((r) => { if (cancelled) return; const m = {}; r.buttons.forEach((b) => { m[b.buttonKey] = b; }); setMap(m); })
      .catch(() => { if (!cancelled && attempt < 2) setTimeout(() => load(attempt + 1), 1500); });
    load();
    return () => { cancelled = true; };
  }, []);
  return map;
}

// Ticket card for the Hiring Requests board.
//
// Layout contract (why this is structured rather than free-flowing): every card is
// a flex column of FIXED rows — rail, head, title, meta, pipeline, footer — so the
// same element lands at the same vertical position on every card in the grid. The
// title is clamped to two lines and each meta value to one, which is what keeps the
// rows aligned when content lengths differ. The footer is pushed down with
// margin-top:auto so status/SLA sit on a common baseline. Grid stretch does the
// rest. No data or actions were changed.
function RequestTicketCard({ r, onOpen }) {
  const place = placeLabel(r);
  const dept = r.department?.name || '—';
  return (
    <div className="card ticket-card rq-card" onClick={onOpen}>
      <span className="rq-rail" aria-hidden="true" />
      <div className="rq-body">
        <div className="rq-head">
          <span className="code-pill" title={r.ticketNo}>{shortReqCode(r.ticketNo)}</span>
          <PriorityBadge p={r.priority} />
        </div>

        <h3 className="rq-title" title={r.title}>{r.title}</h3>

        <dl className="rq-meta">
          <div><dt>Dept</dt><dd title={dept}>{dept}</dd></div>
          <div><dt>Project / Site</dt><dd title={place}>{place}</dd></div>
          {r.headcount != null && <div><dt>Headcount</dt><dd>{r.headcountFilled ?? 0} of {r.headcount}</dd></div>}
        </dl>

        <div className="rq-pipe">{r.pipeline ? <FunnelMini pipeline={r.pipeline} /> : null}</div>

        <div className="rq-foot">
          <ReqStatusBadge status={r.status} displayStatus={r.displayStatus} />
          {r.health && <ReqHealth health={r.health} />}
        </div>
      </div>
    </div>
  );
}

// A request "needs action" the same way ManagerDashboard already judges it:
// overdue on health, or the SLA clock itself has tripped. One definition,
// reused by the dashboard card, this toggle, and the filter chip's label.
function needsAction(r) { return (r.health || {}).level === 'red' || (r.health || {}).level === 'amber' || !!r.slaBreached; }

function RequestsPage({ user, initialFilters }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  // Approved layout is the table: it is what a recruiter scans down. Cards stay
  // one click away for people who prefer them.
  const [view, setView] = useState('table'); // table | cards
  // `owner`, `attention` and `openOnly` are NOT sent to the API — `owner` maps
  // onto the server's `ownerId` param (see the outgoing params below); `attention`
  // and `openOnly` are judged from fields every row already carries, the same way
  // the dashboards derive them, so a client-side filter keeps the server's query
  // surface from growing for something that isn't a real column.
  const [filters, setFilters] = useState(() => ({
    q: '', status: '', priority: '', sort: 'created', dir: 'desc',
    owner: '', attention: false, openOnly: false,
    ...(initialFilters || {}),
  }));
  const [selectedId, setSelectedId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [assigning, setAssigning] = useState(null); // request row being assigned/reassigned
  const [recruiters, setRecruiters] = useState([]);
  const btns = useResolvedButtons();

  // Arriving from a dashboard card hands a fresh `initialFilters` object each
  // time — apply it whenever its identity changes, not just on first mount, so
  // a second card click while this page happens to already be current still lands.
  useEffect(() => {
    if (!initialFilters) return;
    setFilters((f) => ({ ...f, ...initialFilters }));
  }, [initialFilters]);

  useEffect(() => {
    api.get('/requests/meta/form').then((m) => setRecruiters(m.assignableRecruiters || [])).catch(() => {});
  }, []);

  // Opened from elsewhere (a Talent Pool request link), the same way the Ctrl+K
  // palette opens a candidate: pending id when mounting fresh, event when the
  // page is already mounted.
  useEffect(() => {
    if (window.__atsPendingRequestId) {
      setSelectedId(window.__atsPendingRequestId);
      window.__atsPendingRequestId = null;
    }
    function onOpen(e) { if (e.detail && e.detail.id) setSelectedId(e.detail.id); }
    window.addEventListener('ats:open-request', onOpen);
    return () => window.removeEventListener('ats:open-request', onOpen);
  }, []);

  const load = useCallback(async () => {
    setData(null);
    const params = new URLSearchParams();
    // Only the outgoing `q` is normalized (RQ-26-001 → REQ-2026-00001) so the stored
    // ticket_no can be matched; the text the user typed is left as-is in the input.
    // `attention`/`openOnly` are deliberately excluded — they filter client-side, below.
    Object.entries(filters).forEach(([k, v]) => {
      if (k === 'attention' || k === 'openOnly' || !v) return;
      params.set(k === 'owner' ? 'ownerId' : k, k === 'q' ? expandReqCode(v) : v);
    });
    setData(await api.get('/requests?' + params.toString()));
  }, [filters]);
  useEffect(() => { load(); }, [load]);

  if (selectedId) return <RequestDetail id={selectedId} user={user} btns={btns} onBack={() => { setSelectedId(null); load(); }} />;

  const canCreate = btns.create_request?.visible;
  const canAssign = btns.assign_recruiter?.visible;

  // Client-side pass over the server-filtered rows for the two toggles that
  // aren't real columns — see the `filters` state comment above.
  const shown = (data ? data.requests : []).filter((r) => {
    if (filters.openOnly && !isOpenReq(r)) return false;
    if (filters.attention && !needsAction(r)) return false;
    return true;
  });

  // Removable filter chips — the same visual pattern as the Talent Pool's
  // (`.filter-chips` / `.chip-filter`), but built by hand rather than off a flat
  // label map: `owner` needs a name resolved from the recruiter list, and the
  // two toggles aren't string values at all.
  const ownerName = filters.owner === 'unassigned' ? 'Unassigned'
    : filters.owner ? (recruiters.find((r) => String(r.id) === String(filters.owner)) || {}).name || `#${filters.owner}` : null;
  const activeChips = [
    filters.status && ['status', `Status: ${(REQ_STATUS[filters.status] || {}).label || filters.status}`, () => setFilters((f) => ({ ...f, status: '' }))],
    filters.priority && ['priority', `Priority: ${(PRIORITY[filters.priority] || {}).label || filters.priority}`, () => setFilters((f) => ({ ...f, priority: '' }))],
    ownerName && ['owner', `Owner: ${ownerName}`, () => setFilters((f) => ({ ...f, owner: '' }))],
    filters.attention && ['attention', 'Needs action', () => setFilters((f) => ({ ...f, attention: false }))],
    filters.openOnly && ['openOnly', 'Open only', () => setFilters((f) => ({ ...f, openOnly: false }))],
  ].filter(Boolean);

  return (
    <div>
      <PageHead crumb="Recruitment / Requests" title="Hiring Requests"
        sub="Every hiring need is a controlled ticket with approvals, ownership, SLA and audit trail."
        actions={<>
          <ViewToggle value={view} onChange={setView} options={[['cards', 'Cards'], ['table', 'Table']]} />
          {canCreate && <button className="btn" onClick={() => setCreating(true)}>{btns.create_request.label}</button>}
        </>} />

      <div className="toolbar">
        <input placeholder="Search title / ticket / discipline…" value={filters.q} onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} style={{ minWidth: 240 }} />
        <select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
          <option value="">All statuses</option>{Object.entries(REQ_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
        <select value={filters.priority} onChange={(e) => setFilters((f) => ({ ...f, priority: e.target.value }))}>
          <option value="">All priorities</option>{Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
        <select value={filters.owner} onChange={(e) => setFilters((f) => ({ ...f, owner: e.target.value }))} aria-label="Owner">
          <option value="">All owners</option>
          <option value="unassigned">Unassigned</option>
          {recruiters.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <label className="switch" title="Requests past their health threshold or SLA">
          <input type="checkbox" checked={filters.attention} onChange={(e) => setFilters((f) => ({ ...f, attention: e.target.checked }))} />
          Needs action
        </label>
        <label className="switch" title="Hide closed, filled, cancelled and rejected requests">
          <input type="checkbox" checked={filters.openOnly} onChange={(e) => setFilters((f) => ({ ...f, openOnly: e.target.checked }))} />
          Open only
        </label>
        <select value={filters.sort} onChange={(e) => setFilters((f) => ({ ...f, sort: e.target.value }))}>
          <option value="created">Sort: Created</option><option value="priority">Priority</option><option value="title">Title</option><option value="status">Status</option><option value="ticket">Ticket No</option></select>
        <button className="btn btn-ghost btn-sm" onClick={() => setFilters((f) => ({ ...f, dir: f.dir === 'desc' ? 'asc' : 'desc' }))}>{filters.dir === 'desc' ? '↓ Desc' : '↑ Asc'}</button>
        <div className="spacer" />
        <CountPill n={data ? shown.length : null} total={data ? data.requests.length : null} noun="request" />
      </div>

      {activeChips.length > 0 && (
        <div className="filter-chips">
          {activeChips.map(([k, label, clear]) => (
            <span key={k} className="chip-filter">
              {label}
              <button aria-label={`Remove ${label} filter`} onClick={clear}>✕</button>
            </span>
          ))}
          <button className="btn btn-ghost btn-sm" onClick={() => setFilters((f) => ({ ...f, status: '', priority: '', owner: '', attention: false, openOnly: false }))}>Clear all</button>
        </div>
      )}

      {!data ? <ListSkeleton rows={6} /> : shown.length === 0 ? (
        <div className="card"><Empty icon="🎫"
          title={activeChips.length || filters.q ? 'No requests match these filters' : 'No hiring requests yet'}
          text={activeChips.length || filters.q
            ? 'Try clearing the search box or widening the filters above.'
            : 'Raise the first hiring request to start tracking approvals, candidates and SLA.'} /></div>
      ) : view === 'table' ? (
        <div className="card flush"><div className="table-wrap"><table className="table responsive-table">
          <thead><tr><th>Request</th><th>Position</th><th>Project / Site</th><th>Owner</th><th>Pipeline</th><th>Priority</th><th>Status</th><th>Idle</th><th>SLA</th></tr></thead>
          <tbody>{shown.map((r) => (
            <tr key={r.id} className="row-link" onClick={() => setSelectedId(r.id)}>
              <td data-label="Request"><span className="code-pill" title={r.ticketNo}>{shortReqCode(r.ticketNo)}</span></td>
              <td data-label="Position"><span className="cell-strong">{r.title}</span><div className="cell-sub">{r.department?.name || '—'}</div></td>
              <td data-label="Project / Site" className="cell-sub-only">{placeLabel(r)}</td>
              <td data-label="Owner" onClick={(e) => e.stopPropagation()}>
                {r.owner ? <span className="cell-sub-only">{r.owner.name}</span>
                  : !canAssign ? <span className="muted">Unassigned</span>
                  : canAssignStatus(r.status) ? <button className="btn btn-ghost btn-sm" onClick={() => setAssigning(r)}>Assign</button>
                  : <button className="btn btn-ghost btn-sm" disabled title={ASSIGN_BLOCKED_TITLE}>Assign</button>}
              </td>
              <td data-label="Pipeline">{r.pipeline ? <span className="pipe-count">{r.pipeline.total}<em>cand.</em></span> : <span className="muted">—</span>}</td>
              <td data-label="Priority"><PriorityBadge p={r.priority} /></td>
              <td data-label="Status"><ReqStatusBadge status={r.status} displayStatus={r.displayStatus} /></td>
              <td data-label="Idle" className="cell-sub-only">{r.lifecycle?.stageIdleDays == null ? '—' : r.lifecycle.stageIdleDays + 'd'}</td>
              <td data-label="SLA"><ReqHealth health={r.health} /></td>
            </tr>
          ))}</tbody>
        </table></div>
        <div className="reassurance">Requests without a warning are progressing normally.</div></div>
      ) : (
        <div className="ats-card-grid">
          {shown.map((r) => <RequestTicketCard key={r.id} r={r} onOpen={() => setSelectedId(r.id)} />)}
        </div>
      )}
      {creating && <RequestForm user={user} onClose={() => setCreating(false)} onSaved={(id) => { setCreating(false); load(); setSelectedId(id); }} />}
      {assigning && (
        <AssignModal recruiters={recruiters} onClose={() => setAssigning(null)}
          onAssign={async (ownerId) => {
            try {
              await api.post(`/requests/${assigning.id}/assign`, { ownerId });
              toast(`Recruiter assigned to ${shortReqCode(assigning.ticketNo)}`);
              setAssigning(null); load();
            } catch (e) { toast(e.message, 'error'); }
          }} />
      )}
    </div>
  );
}

// Create OR edit. `request` present => edit mode: prefill and PUT /requests/:id.
// Edit mode deliberately shows ONLY the fields PUT /:id actually persists
// (title, project, site, department, priority, custom fields). Rendering the
// create-only intake fields here would let a recruiter type changes the API
// silently discards.
function RequestForm({ user, request, onClose, onSaved }) {
  const toast = useToast();
  const editing = !!request;
  const [meta, setMeta] = useState(null);
  const [f, setF] = useState(editing
    ? {
      title: request.title || '', projectId: request.projectId ?? '', siteId: request.siteId ?? '',
      departmentId: request.departmentId ?? '', location: request.location || '', hiringManagerId: '',
      priority: request.priority || 'medium', keyResponsibilities: '', keyRequirements: '',
    }
    : { title: '', projectId: '', siteId: '', departmentId: '', location: '', hiringManagerId: '', priority: 'medium', keyResponsibilities: '', keyRequirements: '' });
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const customDefs = useCustomFields('request');
  const [customVals, setCustomVals] = useState(editing ? (request.customFields || {}) : {});
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  // UI-only: Site + Location are optional for the API, so they start collapsed to
  // reduce form density. Their values are still sent unchanged in the payload.
  const [moreLoc, setMoreLoc] = useState(false);
  useEffect(() => { api.get('/requests/meta/form').then(setMeta); }, []);
  const sites = meta ? meta.sites.filter((s) => !f.projectId || s.projectId === Number(f.projectId)) : [];

  async function save() {
    setBusy(true);
    try {
      if (editing) {
        // Only the keys PUT /requests/:id maps. Anything else would be ignored.
        const patch = {
          title: f.title, projectId: f.projectId, departmentId: f.departmentId,
          siteId: f.siteId === '' ? null : f.siteId, priority: f.priority,
          customFields: customVals,
        };
        const u = await api.put('/requests/' + request.id, patch);
        toast('Request updated: ' + shortReqCode(u.request.ticketNo));
        onSaved(u.request.id);
        return;
      }
      const body = { ...f, customFields: customVals };
      ['siteId', 'hiringManagerId'].forEach((k) => { if (body[k] === '') body[k] = null; });
      const r = await api.post('/requests', body);
      // Optional attachment upload (real file) after the request exists.
      if (file) { try { await api.upload(`/requests/${r.request.id}/attachment`, file); } catch (e) { toast('Request created, but attachment failed: ' + e.message, 'error'); } }
      toast('Request created: ' + shortReqCode(r.request.ticketNo));
      onSaved(r.request.id);
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }
  const modalTitle = editing ? 'Edit Recruitment Request' : 'New Recruitment Request';
  if (!meta) return <Modal title={modalTitle} onClose={onClose}><Skeleton /></Modal>;
  return (
    <Modal title={modalTitle} onClose={onClose} wide
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn" onClick={save} disabled={busy}>{busy ? (editing ? 'Saving…' : 'Creating…') : (editing ? 'Save Changes' : 'Create Request')}</button></>}>
      <p className="muted" style={{ marginTop: 0 }}>
        {editing
          ? `${shortReqCode(request.ticketNo)} — editing headcount, grade or salary band after approval sends the request back for re-approval.`
          : 'Req ID and Req Date are generated automatically on creation.'}
      </p>
      <div className="form-grid">
        <div className="field full"><label>Position *</label><input value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Site Engineer" /></div>
        {!editing && <div className="field"><label>Hiring Manager</label><select value={f.hiringManagerId} onChange={(e) => set('hiringManagerId', e.target.value)}><option value="">— None —</option>{meta.hiringManagers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>}
        <div className="field"><label>Department *</label><select value={f.departmentId} onChange={(e) => set('departmentId', e.target.value)}><option value="">— Select —</option>{meta.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></div>
        {/* Project stays the single required control (the API validates projectId).
            Site + Location are optional, so they live under "More location details"
            to keep the form calm. Internal state and payload are unchanged. */}
        <div className="field"><label>Project / Site *</label>
          <select value={f.projectId} onChange={(e) => set('projectId', e.target.value)}><option value="">— Select —</option>{meta.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <button type="button" className="linklike" style={{ marginTop: 6 }} onClick={() => setMoreLoc((v) => !v)}>
            {moreLoc ? '▲ Hide location details' : '▼ More location details'}
          </button>
        </div>
        {moreLoc && <div className="field"><label>Site</label><select value={f.siteId} onChange={(e) => set('siteId', e.target.value)}><option value="">— None —</option>{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>}
        {moreLoc && !editing && <div className="field"><label>Location</label><input value={f.location} onChange={(e) => set('location', e.target.value)} placeholder="e.g. New Cairo" /></div>}
        <div className="field"><label>Priority</label><select value={f.priority} onChange={(e) => set('priority', e.target.value)}>{Object.keys(PRIORITY).map((p) => <option key={p}>{p}</option>)}</select></div>
        {!editing && <div className="field full"><label>Key Responsibilities</label><textarea rows="3" value={f.keyResponsibilities} onChange={(e) => set('keyResponsibilities', e.target.value)} placeholder="Main duties for this role…" /></div>}
        {!editing && <div className="field full"><label>Key Requirements</label><textarea rows="3" value={f.keyRequirements} onChange={(e) => set('keyRequirements', e.target.value)} placeholder="Required experience, qualifications, skills…" /></div>}
        <CustomFieldsInputs defs={customDefs} values={customVals} onChange={(k, v) => setCustomVals((s) => ({ ...s, [k]: v }))} />
        {!editing && <div className="field full"><label>Attachment (Job Description / spec)</label>
          <input type="file" accept=".pdf,.doc,.docx,.png,.jpg,.jpeg" onChange={(e) => setFile(e.target.files?.[0] || null)} />
          {file && <div className="muted" style={{ marginTop: 4 }}>Selected: {file.name}</div>}
        </div>}
      </div>
    </Modal>
  );
}

/* ----------------------------- Request Detail (tabs) ----------------------------- */
/* ---------------- AI shortlist ----------------
   Advisory only. This ranks candidates who are ALREADY in the pool and writes
   nothing; linking one still goes through POST /applications, with the same
   permission, duplicate and request-status rules as every other link. A poor
   shortlist costs a scroll — that is why it is allowed to be wrong out loud. */

function ScoreBadge({ score }) {
  // Three bands, not a gradient: a recruiter reads "worth opening / maybe /
  // probably not", and a continuous colour ramp does not say that.
  const tone = score >= 85 ? 'strong' : score >= 60 ? 'fair' : 'weak';
  return <span className={'score-badge score-' + tone} title={`Match score ${score} of 100`}>{score}</span>;
}

function AiShortlistTab({ request, user }) {
  const toast = useToast();
  const [state, setState] = useState('idle');   // idle | loading | done | error
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [linking, setLinking] = useState(() => new Set());
  const [linked, setLinked] = useState(() => new Set());
  const canLink = user.permissions.includes('candidate.link');

  async function run() {
    setState('loading'); setError('');
    try {
      const r = await api.post(`/requests/${request.id}/suggest-candidates`, { limit: 10 });
      setData(r); setState('done');
    } catch (e) {
      // The server sends its own reason (no AI configured, rate limited, …).
      setError(e.message || 'Could not produce a shortlist.'); setState('error');
    }
  }

  async function link(s) {
    if (!canLink || linking.has(s.candidateId) || linked.has(s.candidateId)) return;
    setLinking((n) => new Set(n).add(s.candidateId));
    try {
      const r = await api.post('/applications', { candidateId: s.candidateId, requestId: request.id });
      setLinked((n) => new Set(n).add(s.candidateId));
      toast(`${s.fullName} linked to ${shortReqCode(r.application?.ticketNo) || 'this request'}`);
    } catch (e) {
      // Already applied, request not linkable, or no permission — the backend's
      // own words, never a fabricated success.
      toast(e.message || 'Could not link this candidate.', 'error');
    } finally {
      setLinking((n) => { const c = new Set(n); c.delete(s.candidateId); return c; });
    }
  }

  if (state === 'idle') {
    return (
      <div className="card card-pad">
        <Empty icon="✨" title="Find candidates for this request"
          text="Claude reads this requisition and ranks your talent pool against it, with a reason for each suggestion. Nothing is changed until you link someone."
          action={<button className="btn" onClick={run}>Suggest candidates</button>} />
      </div>
    );
  }
  if (state === 'loading') {
    return (
      <div className="card card-pad">
        <p className="muted" style={{ margin: 0 }}>Reading the requisition and comparing it against the talent pool…</p>
        <ListSkeleton rows={4} />
      </div>
    );
  }
  if (state === 'error') {
    return (
      <div className="card card-pad">
        <ErrorState text={error || 'The shortlist could not be generated.'}
          action={<button className="btn btn-secondary" onClick={run}>Try again</button>} />
      </div>
    );
  }

  const list = data?.suggestions || [];
  return (
    <div>
      <div className="toolbar">
        <span className="muted" style={{ fontSize: 12.5 }}>
          {list.length} suggestion{list.length === 1 ? '' : 's'} from {data.considered} candidate{data.considered === 1 ? '' : 's'}
          {data.poolCapped ? ' (most recent 300)' : ''}
        </span>
        <div className="spacer" />
        <button className="btn btn-ghost btn-sm" onClick={run}>Refresh</button>
      </div>

      {list.length === 0 ? (
        <div className="card card-pad">
          <Empty icon="🔍" title="Nobody in the pool fits this request yet"
            text="An empty shortlist is a real answer — it means no current candidate evidences what this role asks for. Import CVs or widen the requirements." />
        </div>
      ) : (
        <div className="card flush">
          <table className="table">
            <thead><tr>
              <th style={{ width: 56 }}>Match</th>
              <th>Candidate</th>
              <th>Why</th>
              <th>Not evidenced</th>
              <th style={{ width: 96 }}></th>
            </tr></thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.candidateId}>
                  <td><ScoreBadge score={s.score} /></td>
                  <td>
                    <span className="cell-strong">{s.fullName}</span>
                    <span className="cell-sub">{s.candidateNo}</span>
                    <span className="cell-sub">
                      {[s.currentPosition, s.currentCompany].filter(Boolean).join(' · ') || '—'}
                      {s.yearsExperience != null ? ` · ${s.yearsExperience}y` : ''}
                      {s.location ? ` · ${s.location}` : ''}
                    </span>
                  </td>
                  <td className="cell-sub-only" style={{ maxWidth: 320 }}>{s.reason}</td>
                  <td>
                    {s.missingRequirements?.length
                      ? <div className="miss-list">{s.missingRequirements.map((m, i) => <span key={i} className="chip chip-warn">{m}</span>)}</div>
                      : <span className="muted">—</span>}
                  </td>
                  <td>
                    {linked.has(s.candidateId)
                      ? <span className="muted">Linked</span>
                      : canLink
                        ? <button className="btn btn-sm" disabled={linking.has(s.candidateId)} onClick={() => link(s)}>
                            {linking.has(s.candidateId) ? 'Linking…' : 'Link'}
                          </button>
                        : <span className="muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
        Suggestions are advisory and were produced by {data.model}. Nothing here has changed a candidate record.
      </p>
    </div>
  );
}

function RequestDetail({ id, user, btns, onBack }) {
  const toast = useToast();
  const [req, setReq] = useState(null);
  const [tab, setTab] = useState('thread');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [action, setAction] = useState(null);
  const [editing, setEditing] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [recruiters, setRecruiters] = useState([]);

  const load = useCallback(async () => { setReq((await api.get('/requests/' + id)).request); }, [id]);
  useEffect(() => { load(); }, [id]);
  useEffect(() => { api.get('/requests/meta/form').then((m) => setRecruiters(m.assignableRecruiters || [])).catch(() => {}); }, []);

  // Tell anyhelp which hiring request is on screen, so its Team tab opens the
  // real thread for THIS request instead of guessing, and so the dock can name
  // what it is looking at. Cleared on unmount, so the dock never claims a
  // context the user has navigated away from.
  useEffect(() => {
    window.__atsOpenRequestId = id;
    window.dispatchEvent(new CustomEvent('ats:context'));
    return () => { window.__atsOpenRequestId = null; window.__atsOpenRequestLabel = null; window.dispatchEvent(new CustomEvent('ats:context')); };
  }, [id]);
  useEffect(() => {
    if (!req) return;
    window.__atsOpenRequestLabel = `${shortReqCode(req.ticketNo)} · ${req.title}`;
    window.dispatchEvent(new CustomEvent('ats:context'));
  }, [req && req.id, req && req.title]);

  async function doAction(path, body, okMsg) {
    try { const r = await api.post(`/requests/${id}/${path}`, body || {}); setReq(r.request); toast(okMsg); }
    catch (e) { toast(e.message, 'error'); }
  }
  function reasonAction(path, title, okMsg, danger) {
    setAction({ title, danger, run: (reason) => { setAction(null); doAction(path, { reason }, okMsg); } });
  }

  if (!req) return <Skeleton rows={8} />;
  const s = req.status;

  // Conversation-first ticket: the thread is the main view (like an email thread);
  // request details collapse at the top; everything else stays a tab away.
  const TABS = [
    ['thread', 'Conversation'], ['pipeline', 'Candidates'], ['suggest', 'AI Shortlist'],
    ['jd', 'Details'], ['timeline', 'Activity'],
  ];

  // Mirrors the backend's own rules exactly (POST /requests/:id/assign and
  // /hold in routes/requests.js) — never bypassed, only surfaced honestly:
  // a control the API would reject is disabled here, with the reason, rather
  // than left enabled to fail with a 409 the recruiter has to decode.
  // `canAssignStatus`/`ASSIGN_BLOCKED_TITLE` are shared with the requests
  // table and this dashboard's attention list, so the rule can't drift.
  const TERMINAL_STATUSES = ['closed', 'cancelled', 'rejected', 'filled', 'expired'];
  const PAUSABLE_STATUSES = ['pending_approval', 'sourcing', 'in_progress', 'partially_filled', 'reopened'];
  const canAssignNow = canAssignStatus(s);
  const assignLabel = req.ownerId ? 'Reassign' : 'Assign recruiter';

  return (
    <div>
      <div className="detail-back"><button className="back-link" onClick={onBack}>← Hiring Requests</button></div>

      <TicketHeader req={req}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: 560 }}>
          {btns.assign_recruiter?.visible && !TERMINAL_STATUSES.includes(s) && (
            canAssignNow
              ? <button className="btn btn-secondary" onClick={() => setAssigning(true)}>{assignLabel}</button>
              : <button className="btn btn-secondary" disabled title={ASSIGN_BLOCKED_TITLE}>{assignLabel}</button>
          )}
          {btns.hold_request?.visible && PAUSABLE_STATUSES.includes(s) && (
            <button className="btn btn-secondary" onClick={() => reasonAction('hold', 'Pause Request', 'Request paused', true)}>Pause</button>
          )}
          {btns.resume_request?.visible && s === 'on_hold' && (
            <button className="btn btn-secondary" onClick={() => doAction('resume', {}, 'Request resumed')}>Resume</button>
          )}
          {btns.edit_request?.visible && !['closed','cancelled','rejected','filled'].includes(s) && <button className="btn btn-secondary" onClick={() => { setEditing(true); }}>Edit</button>}
          {btns.close_request?.visible && !['closed','cancelled','rejected'].includes(s) && <button className="btn btn-secondary" onClick={() => reasonAction('close', 'Close Request', 'Request closed')}>Close</button>}
          {btns.reopen_request?.visible && ['closed','cancelled','filled'].includes(s) && <button className="btn btn-secondary" onClick={() => reasonAction('reopen', 'Reopen Request', 'Request reopened')}>Reopen</button>}
        </div>
      </TicketHeader>

      {/* Collapsible request "subject" details, pinned above the conversation */}
      <div className="card detail-disclosure">
        <button className="disclosure-btn" onClick={() => setDetailsOpen((o) => !o)} aria-expanded={detailsOpen}>
          <span className="disclosure-label">Request details</span>
          <span className="disclosure-hint">{req.department?.name || '—'} · {placeLabel(req)}</span>
          <span className="disclosure-caret">{detailsOpen ? 'Hide ▴' : 'Show ▾'}</span>
        </button>
        {detailsOpen && <div className="disclosure-body"><OverviewTab req={req} onReload={load} btns={btns} embedded /></div>}
      </div>

      <div className="tabbar" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k}
            className={'tabbar-btn' + (tab === k ? ' active' : '')}
            onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      {tab === 'thread' && <TicketThread req={req} user={user} />}
      {tab === 'pipeline' && <RequestPipeline request={req} user={user} btns={btns} />}
      {tab === 'suggest' && <AiShortlistTab request={req} user={user} />}
      {tab === 'jd' && <JDTab req={req} />}
      {tab === 'timeline' && <TimelineTab req={req} />}

      {action && <Confirm title={action.title} message="Please provide a reason. This will be recorded in the audit trail." requireReason danger={action.danger} confirmLabel="Confirm" onConfirm={action.run} onClose={() => setAction(null)} />}
      {editing && <RequestForm user={user} request={req} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load(); }} />}
      {assigning && (
        <AssignModal recruiters={recruiters} onClose={() => setAssigning(false)}
          onAssign={async (ownerId) => {
            try {
              await api.post(`/requests/${id}/assign`, { ownerId });
              toast(`Recruiter assigned to ${shortReqCode(req.ticketNo)}`);
              setAssigning(false); load();
            } catch (e) { toast(e.message, 'error'); }
          }} />
      )}
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

// Maps a workflow status label → status-chip color class.
function statusChipClass(status) {
  const s = (status || '').toLowerCase();
  if (s.includes('pending') || s.includes('approval') || s.includes('waiting')) return 'pending';
  if (s.includes('partially') || s.includes('partial')) return 'partial';
  if (s.includes('sourcing')) return 'sourcing';
  if (s.includes('in progress') || s.includes('progress') || s.includes('interview')) return 'progress';
  if (s.includes('reopen')) return 'reopened';
  if (s.includes('filled') || s.includes('joined')) return 'filled';
  if (s.includes('closed')) return 'closed';
  if (s.includes('expired')) return 'expired';
  if (s.includes('hold')) return 'hold';
  if (s.includes('reject') || s.includes('declined')) return 'rejected';
  if (s.includes('cancel')) return 'cancelled';
  return '';
}

function TicketHeader({ req, children }) {
  // The brand logo block was removed here: the sidebar already carries the mark,
  // and the red-outlined box fought with the new Shell. Identity now comes from
  // the ticket code pill. The left accent rail is navy, not red — red is reserved
  // for destructive actions and critical states.
  return (
    <div className="ticket-header-card">
      <div className="th-row">
        <div className="th-main">
          <div className="th-eyebrow">Hiring Request</div>
          <h1 className="th-title">{req.title}</h1>
          <div className="th-meta">
            <span className="code-pill" title={req.ticketNo}>{shortReqCode(req.ticketNo)}</span>
            <ReqStatusBadge status={req.status} displayStatus={req.displayStatus} />
            {req.priority && <PriorityBadge p={req.priority} />}
            {req.health && <ReqHealth health={req.health} />}
          </div>
          <div className="th-sub">
            <span><em>Department</em>{req.department?.name || '—'}</span>
            <span><em>Project / Site</em>{placeLabel(req)}</span>
            {req.headcount != null && <span><em>Headcount</em>{req.headcountFilled ?? 0} of {req.headcount}</span>}
          </div>
        </div>
        <div className="th-actions">{children}</div>
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
          <FieldChip label="Req ID"><span title={req.ticketNo}>{shortReqCode(req.ticketNo)}</span></FieldChip>
          <FieldChip label="Position">{req.title}</FieldChip>
          <FieldChip label="Department">{req.department?.name}</FieldChip>
          <FieldChip label="Project / Site">{placeLabel(req)}</FieldChip>
          <FieldChip label="Hiring Manager">{req.hiringManager?.name || '—'}</FieldChip>
          <FieldChip label="Priority"><span style={{ textTransform: 'capitalize' }}>{req.priority || '—'}</span></FieldChip>
          <FieldChip label="Recruiter">{req.owner?.name || 'Unassigned'}</FieldChip>
        </div>
        <div className="section-title">Attachment</div>
        <AttachmentRow req={req} onReload={onReload} />
      </div>
  );
  if (embedded) return inner;
  return inner;
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
  sourced:            { label: 'Sourced', variant: 'soft', column: 1 },
  screening:          { label: 'Screening', variant: 'info', column: 2 },
  interview_hr:       { label: '1st Interview (HR)', variant: 'info', column: 3 },
  interview_technical:{ label: '2nd Interview (Technical)', variant: 'info', column: 4 },
  offer:              { label: 'Offer', variant: 'warning', column: 5 },
  hired:              { label: 'Hired', variant: 'success', column: 6 },
  rejected:           { label: 'Rejected', variant: 'critical', column: 99 },
  offer_declined:     { label: 'Offer Declined', variant: 'critical', column: 99 },
  on_hold:            { label: 'On Hold', variant: 'warning', column: 99 },
  new:         { label: 'Sourced', variant: 'soft', column: 1 },
  applied:     { label: 'Sourced', variant: 'soft', column: 1 },
  matched:     { label: 'Screening', variant: 'info', column: 2 },
  screened:    { label: 'Screening', variant: 'info', column: 2 },
  cv_screening:{ label: 'Screening', variant: 'info', column: 2 },
  unmatched:   { label: 'Screening', variant: 'info', column: 2 },
  shortlisted: { label: 'Screening', variant: 'info', column: 2 },
  interviewing:{ label: '1st Interview (HR)', variant: 'info', column: 3 },
  interview_1: { label: '1st Interview (HR)', variant: 'info', column: 3 },
  interview_2: { label: '2nd Interview (Technical)', variant: 'info', column: 4 },
  technical_interview: { label: '2nd Interview (Technical)', variant: 'info', column: 4 },
  waiting_feedback: { label: '1st Interview (HR)', variant: 'info', column: 3 },
  issuing_offer: { label: 'Offer', variant: 'warning', column: 5 },
  offer_sent:  { label: 'Offer', variant: 'warning', column: 5 },
  offer_preparation: { label: 'Offer', variant: 'warning', column: 5 },
  joined:      { label: 'Hired', variant: 'success', column: 6 },
};
// Ordered stage columns for the pipeline (canonical list only).
// Board columns. `interview_technical` was removed: the API models a single
// `interviewing` stage, so that column could never be reached and any move to it
// was rejected with 400.
const APP_ORDER = ['sourced', 'screening', 'interview_hr', 'offer', 'hired'];

// WRITE-DIRECTION map: board column -> the status the API actually accepts.
// APP_STATUS above is the read direction (API status -> display column); this is
// its mirror. Without it the board posted display keys such as 'screening', which
// the API rejects as Invalid status — five of six moves silently failed.
// Targets verified against the API's own transition table:
//   sourced -> matched -> interviewing -> issuing_offer -> offer_sent -> joined
const APP_WRITE = {
  sourced: 'sourced',
  screening: 'matched',
  interview_hr: 'interviewing',
  offer: 'issuing_offer',
  hired: 'joined',
  rejected: 'rejected',
  offer_declined: 'offer_declined',
  on_hold: 'on_hold',
};
// Board key -> API status. Unmapped values pass through unchanged so canonical
// statuses coming from elsewhere in the app keep working.
const toApiStatus = (s) => APP_WRITE[s] || s;
const REASON_STATUSES = ['rejected', 'offer_declined', 'on_hold'];
// Canonical + display spellings: the API stores `joined`, the board labels it Hired.
const TERMINAL_APP = ['hired', 'joined', 'rejected', 'offer_declined'];
// Turn a failed move into a sentence a recruiter can act on. The API already
// returns human-readable reasons ("Cannot move from Sourced to Offer."); this only
// guards against an empty or non-textual error leaking into the UI.
function moveErrorText(e) {
  const m = (e && e.message ? String(e.message) : '').trim();
  if (!m || /^\s*[{[<]/.test(m)) return 'Could not move this candidate. Please try again.';
  return m;
}
// One write path for every pipeline (per-request board and the Talent Pool board).
// Optimistic splice, then the server's record, then exact rollback.
async function moveApplication({ appId, status, reason, list, setList, pending, setPending, toast }) {
  if (pending.has(appId)) return;
  const snapshot = list;
  setPending((p) => new Set(p).add(appId));
  setList((xs) => (xs || []).map((a) => (a.id === appId ? { ...a, status: toApiStatus(status) } : a)));
  try {
    const r = await api.post(`/applications/${appId}/move`, { status: toApiStatus(status), reason });
    if (r && r.application) {
      setList((xs) => (xs || []).map((a) => (a.id === appId ? { ...a, ...r.application } : a)));
    }
    toast(`Moved to ${(APP_STATUS[status] || {}).label || status}`);
  } catch (e) {
    setList(snapshot);
    toast(moveErrorText(e), 'error');
  } finally {
    setPending((p) => { const nx = new Set(p); nx.delete(appId); return nx; });
  }
}
function historyHoverTitle(h) {
  if (!h) return '';
  const n = Number(h.priorApplications);
  const times = !Number.isFinite(n) ? null : n === 1 ? 'once' : n + ' times';
  const outcome = h.lastOutcome ? ((APP_STATUS[h.lastOutcome] || {}).label || h.lastOutcome) : null;
  let when = null;
  if (h.lastSeenAt) {
    const d = new Date(h.lastSeenAt);
    if (!isNaN(d)) when = d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
  }
  const bits = [];
  if (times) bits.push('Applied ' + times + ' before');
  if (outcome || when) bits.push('last outcome: ' + [outcome, when].filter(Boolean).join(', '));
  return bits.join(' · ');
}
function HistoryBadge({ history, onOpen }) {
  if (!history || !history.returning) return null;
  const rehire = !!history.rehire;
  const title = historyHoverTitle(history);
  return (
    <button type="button" className="hist-badge-btn" title={title || undefined}
      onClick={(e) => { e.stopPropagation(); onOpen && onOpen(); }}>
      <Badge variant={rehire ? 'success' : 'info'}>{rehire ? 'Rehire' : 'Returning'}</Badge>
    </button>
  );
}
function pipelineStage(status) {
  const s = APP_STATUS[status];
  if (!s) return 'sourced';
  if (DISQUALIFIED_STAGES.includes(status)) return status;
  if (s.column === 1) return 'sourced';
  if (s.column === 2) return 'screening';
  // Columns 3 and 4 both fold into the single interview column: the API has one
  // `interviewing` stage, so a card must never land in a column that no longer
  // exists in APP_ORDER (it would vanish from the board).
  if (s.column === 3 || s.column === 4) return 'interview_hr';
  if (s.column === 5) return 'offer';
  if (s.column === 6) return 'hired';
  return status;
}
function AppStatusBadge({ status }) { const s = APP_STATUS[status] || { label: status, variant: 'soft' }; return <Badge variant={s.variant}>{s.label}</Badge>; }
// Source attribution chip (Workable pattern: "via LinkedIn / careers / referral").
// Maps free-text source values to a small set of branded chips.
function sourceClass(src) {
  const s = (src || '').toLowerCase();
  if (s.includes('linkedin')) return 'src-linkedin';
  if (s.includes('career') || s.includes('website') || s.includes('portal')) return 'src-careers';
  if (s.includes('refer')) return 'src-referral';
  if (s.includes('agency') || s.includes('manpower') || s.includes('supplier')) return 'src-agency';
  return 'src-direct';
}
function SourceChip({ source }) {
  if (!source) return <span className="muted" style={{ fontSize: 11.5 }}>No source</span>;
  return <span className={'src-chip ' + sourceClass(source)}><span className="src-dot" />{source}</span>;
}
// Group an application/candidate stage into qualified vs disqualified (Workable split).
const DISQUALIFIED_STAGES = ['rejected', 'offer_declined', 'on_hold'];
function isDisqualified(status) { return DISQUALIFIED_STAGES.includes(status); }
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
  const [pending, setPending] = useState(new Set()); // application ids with an in-flight move
  const [bulkBusy, setBulkBusy] = useState(false);

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
  // Import CVs mirrors Add Candidate visibility, and is additionally hidden for
  // terminal requests (the backend refuses to link to those anyway).
  const canImport = canLink && !['closed', 'cancelled', 'rejected', 'filled'].includes(request.status);
  const canBulk = user.permissions.includes('application.bulk_action');

  // ---- Stage movement -------------------------------------------------
  // POST /applications/:id/move returns the updated application, so a move needs
  // no refetch: we apply an optimistic status change (the card lands in the new
  // column immediately, no flicker), then splice the server's authoritative record
  // over it. On failure the previous list is restored exactly and the server's
  // message is surfaced. `pending` guards against double-submit and drives the
  // per-card busy state.
  async function move(appId, status, reason) {
    await moveApplication({
      appId, status, reason,
      list: apps, setList: setApps, pending, setPending, toast,
    });
  }
  function requestMove(appId, status) {
    if (pending.has(appId)) return;
    if (REASON_STATUSES.includes(status)) setMoveModal({ appIds: [appId], toStatus: status, reason: true });
    else move(appId, status);
  }
  async function bulkMove(status, reason) {
    if (bulkBusy) return;
    const ids = [...selected];
    setBulkBusy(true);
    setPending((p) => { const nx = new Set(p); ids.forEach((i) => nx.add(i)); return nx; });
    try {
      const r = await api.post('/applications/bulk', { ids, action: 'move', status: toApiStatus(status), reason });
      const skipped = (r.skipped || []).length;
      toast(`${r.affected} moved to ${(APP_STATUS[status] || {}).label || status}${skipped ? `, ${skipped} skipped` : ''}`, skipped ? 'error' : 'success');
      setSelected(new Set());
      await load();                                       // bulk can skip rows; refetch is the safe reconcile
    } catch (e) { toast(moveErrorText(e), 'error'); }
    finally {
      setBulkBusy(false);
      setPending((p) => { const nx = new Set(p); ids.forEach((i) => nx.delete(i)); return nx; });
    }
  }
  function toggleSel(id) { setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
  const [importOpen, setImportOpen] = useState(false);

  if (!apps) return <Skeleton rows={6} />;

  const cols = APP_ORDER;
  const activeApps = visibleApps.filter((a) => !isDisqualified(a.status));
  const disqualifiedCount = visibleApps.filter((a) => isDisqualified(a.status)).length;
  return (
    <div>
      {apps.length > 0 && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
          <span className="status-chip filled">Active {activeApps.length}</span>
          {disqualifiedCount > 0 && <span className="status-chip rejected">Disqualified {disqualifiedCount}</span>}
          <span className="meta-chip">Total {apps.length}</span>
        </div>
      )}
      <div className="toolbar">
        <ViewToggle value={view} onChange={setView} options={[['kanban', 'Board'], ['list', 'List'], ['compact', 'Table']]} />
        <input placeholder="Search name / employer…" value={pf.q} onChange={(e) => setPf((f) => ({ ...f, q: e.target.value }))} style={{ minWidth: 180 }} />
        <select value={pf.stage} onChange={(e) => setPf((f) => ({ ...f, stage: e.target.value }))}>
          <option value="">All stages</option>{APP_ORDER.map((s) => <option key={s} value={s}>{APP_STATUS[s].label}</option>)}</select>
        <select value={pf.recruiter} onChange={(e) => setPf((f) => ({ ...f, recruiter: e.target.value }))}>
          <option value="">All recruiters</option>{recruiterOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
        <select value={pf.sort} onChange={(e) => setPf((f) => ({ ...f, sort: e.target.value }))}>
          <option value="last">Sort: Last updated</option><option value="name">Name</option><option value="match">Match score</option></select>
        <div className="spacer" />
        <CountPill n={apps ? visibleApps.length : null} total={apps ? apps.length : null} noun="candidate" />
        {canImport && <button className="btn btn-secondary btn-sm" onClick={() => setImportOpen(true)}>Import CVs</button>}
        {canLink && <button className="btn btn-sm" onClick={() => setLinkOpen(true)}>{btns.link_candidate.label === 'Link to Request' ? 'Add Candidate' : btns.link_candidate.label}</button>}
      </div>

      {canBulk && selected.size > 0 && (
        <div className="card card-pad" style={{ marginBottom: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
          <strong>{selected.size} selected</strong>
          <select id="bulkStatus" className="" style={{ padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6 }}>
            {cols.map((s) => <option key={s} value={s}>{APP_STATUS[s].label}</option>)}</select>
          <button className="btn btn-sm" disabled={bulkBusy} onClick={() => { const st = document.getElementById('bulkStatus').value; if (REASON_STATUSES.includes(st)) setMoveModal({ appIds: [...selected], toStatus: st, reason: true, bulk: true }); else bulkMove(st); }}>{bulkBusy ? 'Moving…' : 'Apply Bulk Move'}</button>
          <button className="btn btn-ghost btn-sm" disabled={bulkBusy} onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      {apps.length === 0 ? <div className="card"><Empty icon="🧑‍💼" text="No candidates linked yet. Use 'Add Candidate' to add candidates." />
          {canImport && <div style={{ textAlign: 'center', paddingBottom: 18 }}><button className="btn btn-secondary btn-sm" onClick={() => setImportOpen(true)}>Import CVs</button></div>}</div>
        : visibleApps.length === 0 ? <div className="card"><Empty icon="🔍" text="No candidates match the current filters." /></div>
        : view === 'kanban' ? (
          <div className="kanban">
            {cols.map((st) => {
              const items = visibleApps.filter((a) => {
                const canonical = pipelineStage(a.status);
                return canonical === st && !isDisqualified(a.status);
              });
              return (
                <div key={st} className="kan-col">
                  <div className="kan-head">
                    <span className="kan-dot" style={{ background: APP_STAGE_COLORS[st] || 'var(--muted)' }} />
                    <span className="kan-title">{APP_STATUS[st].label}</span>
                    <span className="kan-count">{items.length}</span>
                  </div>
                  <div className="kan-body">
                    {items.length === 0
                      ? <div className="kan-empty">No candidates at this stage</div>
                      : items.map((a) => <PipelineCard key={a.id} app={a} pending={pending.has(a.id)} canMove={canMove} canBulk={canBulk} selected={selected.has(a.id)} onSelect={() => toggleSel(a.id)} onView={() => setQuickView(a)} onMove={(s) => requestMove(a.id, s)} onSchedule={() => setScheduleApp(a)} onOffer={() => setOfferApp(a)} onNote={() => setNoteApp(a)} btns={btns} />)}
                  </div>
                </div>
              );
            })}
          </div>
        ) : view === 'list' ? (
          <div className="pipe-list">
            {visibleApps.map((a) => <PipelineCard key={a.id} app={a} wide pending={pending.has(a.id)} canMove={canMove} canBulk={canBulk} selected={selected.has(a.id)} onSelect={() => toggleSel(a.id)} onView={() => setQuickView(a)} onMove={(s) => requestMove(a.id, s)} onSchedule={() => setScheduleApp(a)} onOffer={() => setOfferApp(a)} onNote={() => setNoteApp(a)} btns={btns} />)}
          </div>
        ) : (
          <div className="card" style={{ overflowX: 'auto' }}><table>
            <thead><tr>{canBulk && <th></th>}<th>Candidate</th><th>Employer / Project</th><th>Exp</th><th>Education</th><th>Match</th><th>Stage</th><th>Recruiter</th><th>Next Action</th><th>Last Update</th><th></th></tr></thead>
            <tbody>{visibleApps.map((a) => (
              <tr key={a.id} className={pending.has(a.id) ? 'row-pending' : ''} aria-busy={pending.has(a.id)}>
                {canBulk && <td><input type="checkbox" checked={selected.has(a.id)} disabled={pending.has(a.id)} onChange={() => toggleSel(a.id)} /></td>}
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
                  {canMove && !TERMINAL_APP.includes(a.status) && <StageSelect value={a.status} disabled={pending.has(a.id)} onChange={(s) => requestMove(a.id, s)} />}
                  {canMove && <button className="btn btn-ghost btn-sm" disabled={pending.has(a.id)} title="Set next action" aria-label="Set next action" onClick={() => setNoteApp(a)}>Note</button>}
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
      {importOpen && <ImportCvsModal request={request} onClose={() => setImportOpen(false)} onDone={load} />}
      {scheduleApp && <ScheduleInterviewModal application={scheduleApp} onClose={() => setScheduleApp(null)} onScheduled={() => { setScheduleApp(null); load(); }} />}
      {offerApp && <CreateOfferModal application={offerApp} onClose={() => setOfferApp(null)} onCreated={() => { setOfferApp(null); load(); }} />}
    </div>
  );
}

function StageSelect({ value, onChange, disabled }) {
  return <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}
    style={{ padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}>
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

function PipelineCard({ app, wide, pending, canMove, canBulk, selected, onSelect, onView, onMove, onSchedule, onOffer, onNote, btns, showRequest }) {
  const cand = app.candidate || {};
  const [menu, setMenu] = useState(false);
  // While a stage move is in flight the card dims, shows a "Moving…" chip and
  // every control that could fire a second request is disabled.
  useEffect(() => { if (pending) setMenu(false); }, [pending]);
  return (
    <div className={'pcard' + (wide ? ' pcard-wide' : '') + (selected ? ' selected' : '') + (pending ? ' pcard-pending' : '')} aria-busy={pending || undefined}>
      {pending && <span className="pcard-busy"><i className="spin" />Moving…</span>}
      <div className="pcard-top">
        {canBulk && <input className="pcard-check" type="checkbox" checked={selected} disabled={pending} onChange={onSelect} onClick={(e) => e.stopPropagation()} />}
        <span className="pcard-av">{initials(cand.fullName || '?')}</span>
        <div className="pcard-id">
          <span className="pcard-name" title={cand.fullName || cand.name}>{cand.fullName || cand.name || '—'}</span>
          <span className="pcard-role" title={(cand.currentPosition || '') + (cand.currentCompany ? ' · ' + cand.currentCompany : '')}>
            {cand.currentPosition || '—'}{cand.currentCompany ? ' · ' + cand.currentCompany : ''}
          </span>
        </div>
        <MatchScore score={app.matchScore} />
      </div>

      {/* Facts. Salary is deliberately not rendered on the board. */}
      <div className="pcard-facts">
        {showRequest && (app.request?.ticketNo || app.ticketNo) && (
          <span className="code-pill" title={app.request?.ticketNo || app.ticketNo}>
            {shortReqCode(app.request?.ticketNo || app.ticketNo)}
          </span>
        )}
        {cand.yearsExperience != null && <span className="fact">{cand.yearsExperience}y exp</span>}
        {cand.location && <span className="fact">{cand.location}</span>}
        {cand.noticePeriod && <span className="fact">{cand.noticePeriod}</span>}
      </div>

      <div className="pcard-status"><AppStatusBadge status={app.status} /></div>

      <div className="pcard-actions">
        <button className="btn btn-secondary btn-sm" disabled={pending} onClick={onView}>View</button>
        {canMove && !isDisqualified(app.status) && app.status !== 'hired' && <button className="btn btn-secondary btn-sm" disabled={pending} aria-expanded={menu} onClick={() => setMenu((m) => !m)}>Move ▾</button>}
        {/* Destructive action: use the danger variant (red text on a light plate).
            Previously this was `btn btn-sm` (solid blue primary) with only the text
            colour overridden inline, producing unreadable red-on-blue. */}
        {canMove && !isDisqualified(app.status) && <button className="btn btn-danger btn-sm" disabled={pending} onClick={() => onMove('rejected')}>Disqualify</button>}
      </div>
      {menu && (
        <div className="menu" style={{ right: 12, top: 'auto' }} onMouseLeave={() => setMenu(false)}>
          {APP_ORDER.filter(s => APP_STATUS[s].column > (APP_STATUS[pipelineStage(app.status)]?.column || 0)).map(stage => (
            <div key={stage} className="menu-item" onClick={() => { setMenu(false); onMove(stage); }}>Move to {APP_STATUS[stage].label}</div>
          ))}
          {onNote && <div className="menu-item" onClick={() => { setMenu(false); onNote(); }}>Set Next Action</div>}
          <div className="menu-item" style={{ color: 'var(--text-gray)' }} onClick={() => { setMenu(false); onMove('on_hold'); }}>Put On Hold</div>
          {btns.schedule_interview?.visible && <div className="menu-item" onClick={() => { setMenu(false); onSchedule(); }}>Schedule Interview</div>}
          {btns.generate_offer?.visible && <div className="menu-item" onClick={() => { setMenu(false); onOffer(); }}>Generate Offer</div>}
        </div>
      )}
    </div>
  );
}

const PIPELINE_CAP = 500;
async function fetchAllApplications(params) {
  const pageSize = 100;
  let page = 1;
  let items = [];
  let total = 0;
  let totalPages = 1;
  while (items.length < PIPELINE_CAP) {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v) qs.set(k, v); });
    qs.set('page', String(page));
    qs.set('pageSize', String(pageSize));
    const r = await api.get('/applications?' + qs.toString());
    const batch = r.items || r.applications || [];
    total = r.total != null ? r.total : (r.pagination ? r.pagination.total : items.length + batch.length);
    totalPages = r.totalPages != null ? r.totalPages : (r.pagination ? r.pagination.totalPages : 1);
    items = items.concat(batch);
    if (page >= totalPages || batch.length === 0) break;
    page++;
  }
  return { items, total, capped: items.length < total };
}
function TalentPipeline({
  user, btns, pipeFilters, setPipeFilters, q, setQ,
  linkRequests, unlinked, unlinkedTotal, hasMoreUnlinked,
  onOpenCards, onOpenCandidate, toast,
}) {
  const [apps, setApps] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [pending, setPending] = useState(new Set());
  const [moveModal, setMoveModal] = useState(null);
  const [total, setTotal] = useState(0);
  const [capped, setCapped] = useState(false);
  const canMove = btns.move_stage?.visible;
  const load = useCallback(async () => {
    setApps(null); setLoadError(null);
    try {
      const params = {
        q: q || undefined,
        status: pipeFilters.stage ? toApiStatus(pipeFilters.stage) : undefined,
        recruiterId: pipeFilters.recruiterId || undefined,
        requestId: pipeFilters.requestId || undefined,
        projectId: pipeFilters.projectId || undefined,
      };
      const r = await fetchAllApplications(params);
      setApps(r.items);
      setTotal(r.total);
      setCapped(r.capped);
    } catch (e) {
      setApps([]);
      setLoadError(e.message || 'Could not load the pipeline.');
    }
  }, [q, pipeFilters]);
  useEffect(() => { load(); }, [load]);
  async function move(appId, status, reason) {
    await moveApplication({
      appId, status, reason,
      list: apps, setList: setApps, pending, setPending, toast,
    });
  }
  function requestMove(appId, status) {
    if (pending.has(appId)) return;
    if (REASON_STATUSES.includes(status)) setMoveModal({ appId, toStatus: status });
    else move(appId, status);
  }
  const recruiterOptions = useMemo(() => {
    const m = new Map();
    (apps || []).forEach((a) => { if (a.recruiter) m.set(String(a.recruiter.id), a.recruiter.name); });
    return [...m.entries()];
  }, [apps]);
  const projectOptions = useMemo(() => {
    const m = new Map();
    (linkRequests || []).forEach((r) => { if (r.project) m.set(String(r.project.id), r.project.name); });
    (apps || []).forEach((a) => {
      const p = a.request && a.request.project;
      if (p && p.id) m.set(String(p.id), p.name || p);
    });
    return [...m.entries()];
  }, [apps, linkRequests]);
  if (loadError) {
    return <div className="card"><ErrorState text={loadError || 'The pipeline could not be loaded.'}
      action={<button className="btn" onClick={load}>Retry</button>} /></div>;
  }
  if (!apps) return <ListSkeleton rows={6} />;
  const cols = APP_ORDER;
  const activeApps = apps.filter((a) => !isDisqualified(a.status));
  return (
    <div>
      <div className="toolbar">
        <input placeholder="Search name / request…" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 200 }} />
        <select value={pipeFilters.stage} onChange={(e) => setPipeFilters((f) => ({ ...f, stage: e.target.value }))}>
          <option value="">All stages</option>
          {APP_ORDER.map((s) => <option key={s} value={s}>{APP_STATUS[s].label}</option>)}
        </select>
        <select value={pipeFilters.recruiterId} onChange={(e) => setPipeFilters((f) => ({ ...f, recruiterId: e.target.value }))}>
          <option value="">All recruiters</option>
          {recruiterOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <select value={pipeFilters.requestId} onChange={(e) => setPipeFilters((f) => ({ ...f, requestId: e.target.value }))}>
          <option value="">All requests</option>
          {(linkRequests || []).filter(isLinkable).map((r) => (
            <option key={r.id} value={r.id}>{shortReqCode(r.ticketNo)} · {r.title}</option>
          ))}
        </select>
        <select value={pipeFilters.projectId} onChange={(e) => setPipeFilters((f) => ({ ...f, projectId: e.target.value }))}>
          <option value="">All projects</option>
          {projectOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <div className="spacer" />
        <CountPill n={apps.length} total={total || null} noun="application" />
      </div>
      {capped && (
        <div className="notice notice-warn" style={{ marginBottom: 12 }}>
          Showing the first {apps.length} of {total} applications. Narrow the filters to see the rest — nothing was dropped silently.
        </div>
      )}
      {(unlinkedTotal > 0 || (unlinked && unlinked.length)) && (
        <div className="notice notice-info" style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span>{unlinkedTotal || unlinked.length} candidate{(unlinkedTotal || unlinked.length) === 1 ? '' : 's'} not on a request.
            {hasMoreUnlinked ? ' More are in the pool.' : ''}</span>
          <button className="btn btn-sm" onClick={onOpenCards}>View cards</button>
        </div>
      )}
      <div className="kanban">
        <div className="kan-col">
          <div className="kan-head">
            <span className="kan-dot" style={{ background: 'var(--muted)' }} />
            <span className="kan-title">Unlinked</span>
            <span className="kan-count">{unlinked ? unlinked.length : 0}</span>
          </div>
          <div className="kan-body">
            {!unlinked || unlinked.length === 0
              ? <div className="kan-empty">Everyone on this page is on a request</div>
              : unlinked.map((c) => (
                <div key={c.id} className="pcard" onClick={() => onOpenCandidate(c.id)} style={{ cursor: 'pointer' }}>
                  <div className="pcard-top">
                    <span className="pcard-av">{initials(c.fullName)}</span>
                    <div className="pcard-id">
                      <span className="pcard-name">{c.fullName}</span>
                      <span className="pcard-role">{c.currentPosition || '—'}</span>
                    </div>
                  </div>
                  <HistoryBadge history={c.history} onOpen={() => onOpenCandidate(c.id, { tab: 'activity', focusPrior: true })} />
                </div>
              ))}
          </div>
        </div>
        {cols.map((st) => {
          const items = activeApps.filter((a) => pipelineStage(a.status) === st);
          return (
            <div key={st} className="kan-col">
              <div className="kan-head">
                <span className="kan-dot" style={{ background: APP_STAGE_COLORS[st] || 'var(--muted)' }} />
                <span className="kan-title">{APP_STATUS[st].label}</span>
                <span className="kan-count">{items.length}</span>
              </div>
              <div className="kan-body">
                {items.length === 0
                  ? <div className="kan-empty">No candidates at this stage</div>
                  : items.map((a) => (
                    <PipelineCard key={a.id} app={a} showRequest pending={pending.has(a.id)}
                      canMove={canMove} canBulk={false} selected={false}
                      onSelect={() => {}}
                      onView={() => onOpenCandidate(a.candidate?.id || a.candidateId)}
                      onMove={(s) => requestMove(a.id, s)}
                      onSchedule={() => {}}
                      onOffer={() => {}}
                      onNote={() => {}}
                      btns={btns} />
                  ))}
              </div>
            </div>
          );
        })}
      </div>
      {moveModal && <Confirm title="Provide a reason" message={`Set status to "${APP_STATUS[moveModal.toStatus].label}". This is recorded in the audit trail.`} requireReason danger
        onConfirm={(reason) => { const m = moveModal; setMoveModal(null); move(m.appId, m.toStatus, reason); }}
        onClose={() => setMoveModal(null)} />}
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
  // D-02: re-run the parser against the résumé already on file.
  async function reparseResume() {
    setResumeBusy(true);
    try {
      const r = await api.post(`/candidates/${c.id}/reparse`, {});
      const n = r.proposal?.fields?.length || 0;
      toast(n ? `Re-parsed — ${n} field${n === 1 ? '' : 's'} proposed for review` : 'Re-parsed — nothing could be read from this file');
      onChanged && onChanged();
    } catch (err) { toast(err.message, 'error'); } finally { setResumeBusy(false); }
  }
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
                  {cand.hasResume && canEditCand && <button className="btn btn-sm btn-ghost" onClick={reparseResume} disabled={resumeBusy} title="Re-run the CV parser on the file already attached">{resumeBusy ? 'Working…' : 'Re-parse'}</button>}
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
/* Bulk CV import scoped to one request. FRONTEND-ONLY: it reuses the existing
   POST /candidates/parse-cv endpoint, which already accepts a `requestId` field and
   (when provided) creates the candidate, the application, stage history, activity
   and audit entries, with duplicate detection. Files are sent one at a time so a
   single bad file can never abort the batch. */
/**
 * Run `worker` over `items` with at most `limit` in flight.
 *
 * WHY THIS EXISTS. Reading a CV is a model call measured in seconds, so a
 * sequential loop over fifty files is a modal held open for several minutes.
 * Workers pull from a shared cursor rather than being handed a fixed slice, so
 * one slow scanned CV cannot leave the other workers idle.
 *
 * `limit` is deliberately small. The server applies one global rate limit
 * (300 requests/minute across ALL API traffic, shared with dashboard polling),
 * and every CV is one request — so the ceiling protects the rest of the app,
 * not just this modal.
 */
async function runPool(items, limit, worker, shouldStop) {
  let cursor = 0;
  const next = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      if (shouldStop && shouldStop()) return;
      await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
}

/** Matches backend/src/lib/upload.js — keep the two in step. */
const UPLOAD_MAX_MB = 20;
const UPLOAD_ACCEPT = '.pdf,.doc,.docx,.txt,.png,.jpg,.jpeg';
const UPLOAD_HINT = `Max ${UPLOAD_MAX_MB} MB per file · PDF, DOC, DOCX, TXT, PNG, JPG`;
const IMPORT_CONCURRENCY = 5;

function ImportCvsModal({ request, onClose, onDone }) {
  // `request` is optional. From the Talent Pool there is no requisition to
  // record the CV against, and /parse-cv accepts that — requestId only notes
  // which requisition the CV arrived against, it never creates an application.
  const toast = useToast();
  const [rows, setRows] = useState([]);      // [{ name, state, msg }]
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const cancelled = useRef(false);

  function pick(files) {
    const picked = Array.from(files || []);
    // Rejected here rather than at the server, so a 20 MB file does not spend a
    // minute uploading only to come back 413.
    setRows(picked.map((f) => (f.size > UPLOAD_MAX_MB * 1024 * 1024
      ? { file: f, name: f.name, state: 'failed', msg: `Larger than ${UPLOAD_MAX_MB} MB` }
      : { file: f, name: f.name, state: 'pending', msg: '' })));
    setDone(false);
  }

  async function run() {
    if (!rows.length || busy) return;
    cancelled.current = false;
    setBusy(true);
    let queued = 0, failed = 0, skipped = 0;

    const at = (i, patch) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));

    await runPool(rows, IMPORT_CONCURRENCY, async (row, i) => {
      if (row.state === 'failed') { failed++; return; }
      at(i, { state: 'importing' });
      try {
        // requestId records which requisition the CV arrived against. It does
        // NOT create an application — there is no candidate until a human has
        // reviewed the intake.
        const res = await api.uploadTo('/candidates/parse-cv', row.file,
          request ? { requestId: request.id } : {});
        const intake = res?.intake;
        if (intake) {
          queued++;
          const n = intake.fields?.length || 0;
          at(i, { state: 'queued', msg: `${n} field${n === 1 ? '' : 's'} read · awaiting review` });
        } else {
          // A real answer, not a crash: the reader looked and could support
          // nothing. The upload is kept and the reason is the server's own.
          skipped++;
          at(i, { state: 'skipped', msg: res?.reason || 'Nothing could be read from this file' });
        }
      } catch (e) {
        failed++;
        at(i, { state: 'failed', msg: e.message || 'Import failed' });
      }
    }, () => cancelled.current);

    setBusy(false); setDone(true);
    const stopped = cancelled.current;
    toast(
      `${stopped ? 'Import stopped' : 'Import finished'} — ${queued} awaiting review, ${skipped} unreadable, ${failed} failed`,
      failed && !queued ? 'error' : 'success',
    );
    onDone();   // refresh the pipeline behind the modal; modal stays open with results
  }

  const LABEL = {
    pending: 'Pending', importing: 'Reading…', queued: 'Awaiting review',
    skipped: 'Unreadable', failed: 'Failed',
  };
  const TONE = { queued: 'var(--success)', skipped: 'var(--warning)', failed: 'var(--critical)' };
  const doneCount = rows.filter((r) => r.state !== 'pending' && r.state !== 'importing').length;

  return (
    <Modal title={request ? "Import CVs to this Request" : "Import CVs"} onClose={onClose} wide
      footer={<>
        <button className="btn btn-ghost" onClick={() => { if (busy) { cancelled.current = true; } else { onClose(); } }}>
          {busy ? 'Stop' : (done ? 'Close' : 'Cancel')}
        </button>
        <button className="btn" onClick={run} disabled={busy || !rows.length || done}>
          {busy ? `Reading ${doneCount}/${rows.length}…` : `Import ${rows.length || ''}`.trim()}
        </button>
      </>}>
      {request && (
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          <strong>{shortReqCode(request.ticketNo)}</strong>{request.title ? ` · ${request.title}` : ''}
        </p>
      )}
      <div className="field">
        <label>CV files</label>
        <input type="file" multiple accept={UPLOAD_ACCEPT} disabled={busy}
          onChange={(e) => pick(e.target.files)} />
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          {UPLOAD_HINT} · up to {IMPORT_CONCURRENCY} read at once
        </div>
        {/* Says what actually happens. Each CV becomes a PENDING intake for
            Candidate Review; no candidate and no application exists until a
            human has confirmed the fields. */}
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          Each CV is read and queued for Candidate Review. No candidate is created until you approve it.
        </div>
      </div>
      {rows.length > 0 && (
        <table className="table" style={{ marginTop: 6 }}>
          <thead><tr><th>File</th><th style={{ width: 130 }}>Status</th><th>Details</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td style={{ wordBreak: 'break-all' }}>{r.name}</td>
                <td style={{ color: TONE[r.state] || 'var(--muted)', fontWeight: 600 }}>{LABEL[r.state]}</td>
                <td className="muted">{r.msg || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

function LinkCandidateModal({ requestId, user, onClose, onLinked }) {
  const toast = useToast();
  const [mode, setMode] = useState('existing'); // existing | new
  const [candidates, setCandidates] = useState([]);
  const [meta, setMeta] = useState(null);
  const [sel, setSel] = useState({ candidateId: '', initialStatus: 'sourced', matchScore: '', source: '' });
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
// The resume endpoint requires an Authorization header, so a plain <a href> will
// not work — fetch the blob, then hand it to the browser.
async function downloadResume(candidate, toast) {
  try {
    const res = await fetch(`/api/candidates/${candidate.id}/resume`, {
      headers: api.token ? { Authorization: 'Bearer ' + api.token } : {},
    });
    if (!res.ok) {
      const msg = res.status === 404 ? 'No CV stored for this candidate.' : 'Could not download the CV.';
      toast(msg, 'error'); return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = candidate.resumeName || `${candidate.candidateNo || 'candidate'}-cv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch { toast('Could not download the CV.', 'error'); }
}

// Sortable column header. Clicking toggles asc/desc; the active column shows the
// direction so the current sort is never ambiguous.
function SortTh({ label, col, sort, onSort, align }) {
  const active = sort.by === col;
  return (
    <th className={'sort-th' + (active ? ' active' : '')} style={align ? { textAlign: align } : null}
      onClick={() => onSort(col)} title={`Sort by ${label}`}
      role="columnheader" aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <span>{label}</span><i className="sort-caret">{active ? (sort.dir === 'asc' ? '▲' : '▼') : ''}</i>
    </th>
  );
}

// Parse quality, read-only. Colour tracks confidence so a recruiter can see at a
// glance which records came from a weak parse and may need checking.
function ParseQuality({ status, confidence }) {
  if (!status) return <span className="muted">—</span>;
  const tone = status === 'done' ? 'green' : status === 'review' ? 'amber' : status === 'failed' ? 'red' : 'grey';
  const pct = confidence == null ? null : Math.round(confidence * 100);
  return (
    <span className={'pq pq-' + tone} title={`Parse status: ${status}${pct != null ? ` · confidence ${pct}%` : ''}`}>
      <i />{status}{pct != null && <em>{pct}%</em>}
    </span>
  );
}

function Pager({ page, pageSize, total, totalPages, onPage, onPageSize }) {
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <div className="pager">
      <span className="pager-info">{from}–{to} of {total}</span>
      <div className="pager-controls">
        <button className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => onPage(1)}>First</button>
        <button className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Prev</button>
        <span className="pager-page">Page {page} of {totalPages}</span>
        <button className="btn btn-secondary btn-sm" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>Next</button>
        <button className="btn btn-secondary btn-sm" disabled={page >= totalPages} onClick={() => onPage(totalPages)}>Last</button>
        <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))} aria-label="Rows per page">
          {[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n} / page</option>)}
        </select>
      </div>
    </div>
  );
}

/* ---------------- Talent Pool → Hiring Request linking ----------------
   A link IS an application: POST /applications { candidateId, requestId }.
   No new relationship is introduced here — the same endpoint the pipeline
   already uses, with the same `candidate.link` permission and the same rules
   (a closed/cancelled/rejected/filled request refuses the link; one
   application per candidate per request). */

// Requests the backend will actually accept a link against. Mirrors the guard
// in POST /applications rather than inventing a second notion of "open".
const LINKABLE_BLOCKED = ['closed', 'cancelled', 'rejected', 'filled'];
const isLinkable = (r) => !LINKABLE_BLOCKED.includes(r.status);
function isActiveLink(link) {
  if (!link) return false;
  return !LINKABLE_BLOCKED.includes(link.requestStatus);
}
function activeLinkOf(c) {
  return (c && (c.links || []).find(isActiveLink)) || null;
}
function useViewportAnchor(open, wrapRef, { width = 320, minBelow = 300 } = {}) {
  const [anchor, setAnchor] = useState(null);
  useEffect(() => {
    if (!open) { setAnchor(null); return undefined; }
    const place = () => {
      const el = wrapRef.current;
      if (!el) return;
      const b = el.getBoundingClientRect();
      const left = Math.min(Math.max(8, b.left), window.innerWidth - width - 8);
      const below = window.innerHeight - b.bottom;
      const openUp = below < minBelow && b.top > below;
      setAnchor({ left, top: openUp ? undefined : b.bottom + 5, bottom: openUp ? window.innerHeight - b.top + 5 : undefined });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, width, minBelow]);
  return anchor;
}
function RequestPickList({ candidate, requests, q, setQ, picked, setPicked }) {
  const linkedIds = new Set((candidate.links || []).map((l) => l.requestId));
  const available = requests.filter((r) => isLinkable(r) && !linkedIds.has(r.id));
  const suggested = suggestRequests(candidate, available);
  const suggestedIds = new Set(suggested.map((r) => r.id));
  const needle = (q || '').trim().toLowerCase();
  const match = (r) => !needle
    || String(r.title || '').toLowerCase().includes(needle)
    || String(r.ticketNo || '').toLowerCase().includes(needle);
  const rest = available.filter((r) => !suggestedIds.has(r.id) && match(r));
  const shownSuggested = suggested.filter(match);
  return (
    <>
      <input className="rq-pop-search" placeholder="Search requests…" value={q}
        onChange={(e) => setQ(e.target.value)} autoFocus />
      <div className="rq-pop-list">
        {available.length === 0 && <div className="rq-pop-empty">No request is open for linking.</div>}
        {shownSuggested.length > 0 && <div className="rq-pop-label">Suggested</div>}
        {shownSuggested.map((r) => (
          <button key={r.id} className={'rq-pop-item' + (picked === r.id ? ' picked' : '')}
            onClick={() => setPicked(r.id)}>
            <strong>{shortReqCode(r.ticketNo)} — {r.title}</strong>
            <small>{[r.project?.name, r.department?.name].filter(Boolean).join(' · ') || '—'}</small>
          </button>
        ))}
        {rest.length > 0 && <div className="rq-pop-label">Available Requests</div>}
        {rest.map((r) => (
          <button key={r.id} className={'rq-pop-item' + (picked === r.id ? ' picked' : '')}
            onClick={() => setPicked(r.id)}>
            <strong>{shortReqCode(r.ticketNo)} — {r.title}</strong>
            <small>{[r.project?.name, r.department?.name].filter(Boolean).join(' · ') || '—'}</small>
          </button>
        ))}
      </div>
    </>
  );
}
// Withdraw-then-link. No /withdraw route on this backend; moving the old app to
// `rejected` (reason-required, terminal) is what frees the 409.
async function relinkToRequest(candidateId, fromLink, dest) {
  if (fromLink && fromLink.applicationId) {
    await api.post(`/applications/${fromLink.applicationId}/move`, {
      status: 'rejected',
      reason: `Moved to ${dest.ticketNo} (${dest.title})`,
    });
  }
  return api.post('/applications', { candidateId, requestId: dest.id });
}

/**
 * A cheap, explainable suggestion from data the API already returned.
 *
 * Token overlap between the candidate's current position and the request
 * title, with location as a weak tie-breaker. No service, no model — if the
 * evidence is thin the caller simply shows the plain list.
 */
function suggestRequests(candidate, requests) {
  const words = (s) => String(s || '').toLowerCase().match(/[a-z]{3,}/g) || [];
  const stop = new Set(['and', 'for', 'the', 'senior', 'junior', 'lead', 'chief', 'head']);
  const want = new Set(words(candidate.currentPosition).filter((w) => !stop.has(w)));
  if (want.size === 0) return [];
  return requests
    .map((r) => {
      const have = new Set(words(r.title).filter((w) => !stop.has(w)));
      let score = [...want].filter((w) => have.has(w)).length;
      if (score > 0 && candidate.location && r.location
        && String(r.location).toLowerCase() === String(candidate.location).toLowerCase()) score += 0.5;
      return { r, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => x.r);
}

/** Navigate to a request's detail view from anywhere (mirrors the palette). */
function openRequest(id, onNavigate) {
  window.__atsPendingRequestId = id;
  if (onNavigate) onNavigate('requests');
  window.dispatchEvent(new CustomEvent('ats:open-request', { detail: { id } }));
}

function LinkRequestCell({ candidate, requests, canLink, onNavigate, onLinked, onRelinked }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('link');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [blocking, setBlocking] = useState(null);
  const [confirmMove, setConfirmMove] = useState(null);
  const wrapRef = useRef(null);
  const popRef = useRef(null);
  const anchor = useViewportAnchor(open, wrapRef);
  const links = candidate.links || [];
  const active = activeLinkOf(candidate);
  useEffect(() => {
    if (!open) return undefined;
    const inside = (t) => (wrapRef.current && wrapRef.current.contains(t))
      || (popRef.current && popRef.current.contains(t));
    const onDown = (e) => { if (!inside(e.target)) { setOpen(false); setError(''); setBlocking(null); } };
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); setError(''); setBlocking(null); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  function captureConflict(e) {
    const br = e && e.status === 409 && e.data && e.data.blockingRequest;
    setError((e && (e.data && e.data.error || e.message)) || 'Could not link this candidate.');
    setBlocking(br || null);
  }
  async function confirmLink() {
    if (!picked) return;
    setBusy(true); setError(''); setBlocking(null);
    try {
      const req = requests.find((r) => r.id === picked) || null;
      await onLinked(candidate.id, req);
      setOpen(false); setPicked(null); setQ('');
    } catch (e) {
      captureConflict(e);
    } finally { setBusy(false); }
  }
  function beginMove(dest) {
    if (!dest) return;
    setConfirmMove({ dest, from: active });
  }
  async function doMove(dest) {
    setBusy(true); setError('');
    try {
      const r = await relinkToRequest(candidate.id, active, dest);
      // relinkToRequest already withdrew the old application and created the new
      // one — onRelinked is a refresh hook, not a second create.
      if (onRelinked) await onRelinked(candidate.id, dest, r);
      setOpen(false); setPicked(null); setQ(''); setBlocking(null);
    } catch (e) {
      captureConflict(e);
    } finally { setBusy(false); setConfirmMove(null); }
  }
  const pop = open && anchor && ReactDOM.createPortal(
    (
      <div className="rq-pop" ref={popRef} style={{ left: anchor.left, top: anchor.top, bottom: anchor.bottom }}
        role="dialog" aria-label={mode === 'move' ? `Move ${candidate.fullName} to another request` : `Link ${candidate.fullName} to a hiring request`}>
        <div className="rq-pop-head">{mode === 'move' ? 'Move to another request' : 'Link to Request'}</div>
        <RequestPickList candidate={candidate} requests={requests} q={q} setQ={setQ} picked={picked} setPicked={setPicked} />
        {error && (
          <div className="rq-pop-error">
            {error}
            {blocking && (
              <div style={{ marginTop: 8 }}>
                <button className="btn btn-sm" onClick={() => { setMode('move'); setError(''); }}>
                  Move to another request
                </button>
              </div>
            )}
          </div>
        )}
        <div className="rq-pop-foot">
          <button className="btn btn-ghost btn-sm" onClick={() => { setOpen(false); setError(''); setBlocking(null); }}>Cancel</button>
          <button className="btn btn-sm" disabled={!picked || busy} onClick={() => {
            const dest = requests.find((r) => r.id === picked);
            if (mode === 'move') beginMove(dest);
            else confirmLink();
          }}>
            {busy ? 'Working…' : (mode === 'move' ? 'Move' : 'Link')}
          </button>
        </div>
      </div>
    ), document.body);
  return (
    <div className="rq-linkwrap" ref={wrapRef} onClick={(e) => e.stopPropagation()}>
      {active ? (
        <div className="rq-links" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <button className="rq-link-chip"
            title={`${active.ticketNo || 'Request'} — ${active.requestTitle || ''} (${active.status})`}
            onClick={() => openRequest(active.requestId, onNavigate)}>
            {shortReqCode(active.ticketNo) || 'Request'}
            {active.requestTitle ? <span className="rq-link-sub">{active.requestTitle}</span> : null}
          </button>
          {canLink && (
            <button className="rq-link-btn" onClick={() => { setMode('move'); setOpen((v) => !v); setError(''); setBlocking(null); }}
              aria-haspopup="dialog" aria-expanded={open}>
              Move to another request ▾
            </button>
          )}
        </div>
      ) : canLink ? (
        <button className="rq-link-btn" onClick={() => { setMode('link'); setOpen((v) => !v); setError(''); setBlocking(null); }}
          aria-haspopup="dialog" aria-expanded={open}>Link to Request ▾</button>
      ) : <span className="muted">—</span>}
      {pop}
      {confirmMove && (
        <Confirm
          title="Move to another request"
          message={`Withdraw ${candidate.fullName} from ${shortReqCode(confirmMove.from?.ticketNo) || 'the current request'} (${confirmMove.from?.requestTitle || '—'}) and link them to ${shortReqCode(confirmMove.dest.ticketNo)} (${confirmMove.dest.title})? Closed history stays on the profile.`}
          confirmLabel="Move"
          danger
          onConfirm={() => doMove(confirmMove.dest)}
          onClose={() => setConfirmMove(null)} />
      )}
    </div>
  );
}

function CandidateActionMenu({ candidate, canScreen, canLink, sc, requests, onScreen, onFit, onUnfit, onLinked, onRelinked, onOpen, toast }) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState('menu');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [blocking, setBlocking] = useState(null);
  const [confirmMove, setConfirmMove] = useState(null);
  const wrapRef = useRef(null);
  const popRef = useRef(null);
  const anchor = useViewportAnchor(open, wrapRef, { width: 280, minBelow: 260 });
  const active = activeLinkOf(candidate);
  useEffect(() => {
    if (!open) return undefined;
    const inside = (t) => (wrapRef.current && wrapRef.current.contains(t))
      || (popRef.current && popRef.current.contains(t));
    const onDown = (e) => { if (!inside(e.target)) { setOpen(false); setPanel('menu'); setError(''); } };
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); setPanel('menu'); setError(''); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  function captureConflict(e) {
    const br = e && e.status === 409 && e.data && e.data.blockingRequest;
    setError((e && (e.data && e.data.error || e.message)) || 'Could not link this candidate.');
    setBlocking(br || null);
  }
  async function doLink() {
    if (!picked) return;
    setBusy(true); setError(''); setBlocking(null);
    try {
      const req = requests.find((r) => r.id === picked);
      await onLinked(candidate.id, req);
      setOpen(false); setPanel('menu'); setPicked(null);
    } catch (e) { captureConflict(e); }
    finally { setBusy(false); }
  }
  async function doMove(dest) {
    setBusy(true); setError('');
    try {
      const r = await relinkToRequest(candidate.id, active, dest);
      if (onRelinked) await onRelinked(candidate.id, dest, r);
      setOpen(false); setPanel('menu'); setPicked(null); setBlocking(null);
    } catch (e) { captureConflict(e); }
    finally { setBusy(false); setConfirmMove(null); }
  }
  function Item({ onClick, children }) {
    return <div className="menu-item" onClick={onClick}>{children}</div>;
  }
  return (
    <div className="cc-action-wrap" ref={wrapRef} onClick={(e) => e.stopPropagation()}>
      <button type="button" className="btn btn-secondary btn-sm" aria-haspopup="menu" aria-expanded={open}
        onClick={() => { setOpen((v) => !v); setPanel('menu'); setError(''); setBlocking(null); }}>
        Action ▾
      </button>
      {open && anchor && ReactDOM.createPortal(
        (
          <div className="rq-pop" ref={popRef} style={{ left: anchor.left, top: anchor.top, bottom: anchor.bottom, width: 280 }}
            role="menu" aria-label={`Actions for ${candidate.fullName}`}>
            {panel === 'menu' && (
              <>
                <div className="rq-pop-head">Action</div>
                <div className="rq-pop-list" style={{ paddingTop: 6 }}>
                  {canScreen && sc === 'new' && <Item onClick={() => { setOpen(false); onScreen(); }}>Screen</Item>}
                  {canScreen && sc !== 'fit' && <Item onClick={() => { setOpen(false); onFit(); }}>Mark fit</Item>}
                  {canScreen && sc !== 'unfit' && <Item onClick={() => { setOpen(false); onUnfit(); }}>Mark unfit</Item>}
                  {canLink && !active && <Item onClick={() => { setPanel('link'); setPicked(null); setQ(''); }}>Link to request</Item>}
                  {canLink && active && <Item onClick={() => { setPanel('move'); setPicked(null); setQ(''); }}>Move to another request</Item>}
                  {candidate.hasResume && <Item onClick={() => { setOpen(false); downloadResume(candidate, toast); }}>Download CV</Item>}
                  <Item onClick={() => { setOpen(false); onOpen(); }}>Open profile</Item>
                </div>
              </>
            )}
            {(panel === 'link' || panel === 'move') && (
              <>
                <div className="rq-pop-head">{panel === 'move' ? 'Move to another request' : 'Link to Request'}</div>
                <RequestPickList candidate={candidate} requests={requests} q={q} setQ={setQ} picked={picked} setPicked={setPicked} />
                {error && (
                  <div className="rq-pop-error">
                    {error}
                    {blocking && (
                      <div style={{ marginTop: 8 }}>
                        <button className="btn btn-sm" onClick={() => { setPanel('move'); setError(''); }}>Move to another request</button>
                      </div>
                    )}
                  </div>
                )}
                <div className="rq-pop-foot">
                  <button className="btn btn-ghost btn-sm" onClick={() => { setPanel('menu'); setError(''); }}>Back</button>
                  <button className="btn btn-sm" disabled={!picked || busy} onClick={() => {
                    const dest = requests.find((r) => r.id === picked);
                    if (panel === 'move') setConfirmMove({ dest });
                    else doLink();
                  }}>{busy ? 'Working…' : (panel === 'move' ? 'Move' : 'Link')}</button>
                </div>
              </>
            )}
          </div>
        ), document.body)}
      {confirmMove && (
        <Confirm
          title="Move to another request"
          message={`Withdraw ${candidate.fullName} from ${shortReqCode(active?.ticketNo) || 'the current request'} (${active?.requestTitle || '—'}) and link them to ${shortReqCode(confirmMove.dest.ticketNo)} (${confirmMove.dest.title})? Closed history stays on the profile.`}
          confirmLabel="Move" danger
          onConfirm={() => doMove(confirmMove.dest)}
          onClose={() => setConfirmMove(null)} />
      )}
    </div>
  );
}

function CandidatesPage({ user, onNavigate, initialFilters }) {
  const toast = useToast();
  const [candidates, setCandidates] = useState(null);
  const [filters, setFilters] = useState(() => ({
    q: '', source: '', location: '', minExp: '', maxExp: '', noticePeriod: '',
    currentCompany: '', tag: '', currentPosition: '', university: '',
    graduationFrom: '', graduationTo: '',
    ...(initialFilters || {}),
  }));
  const [pipeFilters, setPipeFilters] = useState(() => ({
    stage: '', recruiterId: '', requestId: '', projectId: '',
    ...(initialFilters || {}),
  }));
  // Arriving with a filter from elsewhere (nothing sends one yet, but the
  // mechanism matches every other list page) — apply it whenever its
  // identity changes, not just on first mount.
  useEffect(() => {
    if (!initialFilters) return;
    setFilters((f) => ({ ...f, ...initialFilters }));
    setPipeFilters((f) => ({ ...f, ...initialFilters }));
  }, [initialFilters]);
  // Plain-English search. It does not hold its own result list: it fills the
  // filters above and lets the existing load() run, so paging, tabs, sorting
  // and the table stay exactly as they were and the recruiter can hand-edit
  // whatever the model chose.
  const [ask, setAsk] = useState('');
  const [asking, setAsking] = useState(false);
  const [askedAs, setAskedAs] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [creating, setCreating] = useState(false);
  // AI-parsing add-candidate flow — independent of `creating` (manual entry).
  const [parsingCv, setParsingCv] = useState(false);
  // What ParseCvModal should open showing: null = fresh file picker, or a
  // backgrounded/tracked job to resume. Separate from bgParseJob below so the
  // primary "Parse CV" button always starts fresh even while one job is
  // already tracked in the background.
  const [resumeJob, setResumeJob] = useState(null);
  // The one parse allowed to run in the background at a time — set when
  // ParseCvModal's "Continue in background" hands off a job id, cleared on
  // save/dismiss. { jobId, fileName, file, status: 'processing'|'ready', result }
  const [bgParseJob, setBgParseJob] = useState(null);

  // Light poll for a backgrounded parse — only while the modal watching it is
  // CLOSED. ParseCvModal polls for itself while it's open; polling from both
  // places at once would just double the requests for nothing.
  useEffect(() => {
    if (!bgParseJob || bgParseJob.status !== 'processing' || parsingCv) return undefined;
    let cancelled = false;
    const check = async () => {
      let j;
      try { j = await api.get(`/candidates/parse-cv-async/${bgParseJob.jobId}`); }
      catch { return; } // transient — the next tick tries again
      if (cancelled || j.status === 'processing') return;
      if (j.status === 'error') {
        toast(j.message || 'Background parse failed.', 'error');
        setBgParseJob(null);
        return;
      }
      const r = j.payload;
      if (r?.preview?.length) {
        toast(`${bgParseJob.fileName || 'CV'} is parsed — click to review.`);
        setBgParseJob((b) => (b && b.jobId === bgParseJob.jobId
          ? { ...b, status: 'ready', result: { preview: r.preview, intake: r.intake } } : b));
      } else {
        toast(r?.reason || 'Nothing could be read from that CV.', 'error');
        setBgParseJob(null);
      }
    };
    const t = setInterval(check, 4000);
    return () => { cancelled = true; clearInterval(t); };
  }, [bgParseJob?.jobId, bgParseJob?.status, parsingCv, toast]);

  const [importOpen, setImportOpen] = useState(false);
  const [view, setView] = useState('pipeline'); // pipeline | cards | table
  const [profileTab, setProfileTab] = useState(null);
  const [profileFocusPrior, setProfileFocusPrior] = useState(false);
  const CAND_FILTER_KEYS = ['q', 'source', 'location', 'minExp', 'maxExp', 'noticePeriod',
    'currentCompany', 'tag', 'currentPosition', 'university', 'graduationFrom', 'graduationTo'];

  // Opened from the Ctrl+K palette. Covers both cases: page already mounted
  // (custom event) and page mounting fresh after navigation (pending id).
  useEffect(() => {
    if (window.__atsPendingCandidateId) {
      setSelectedId(window.__atsPendingCandidateId);
      window.__atsPendingCandidateId = null;
    }
    function onOpen(e) { if (e.detail && e.detail.id) setSelectedId(e.detail.id); }
    window.addEventListener('ats:open-candidate', onOpen);
    return () => window.removeEventListener('ats:open-candidate', onOpen);
  }, []);
  const [screenTab, setScreenTab] = useState('all'); // Database fitness-screen filter
  // Server-side paging/sorting. The API returns a `pagination` envelope; the UI no
  // longer fetches the whole table and slices it in the browser.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sort, setSort] = useState({ by: 'created', dir: 'desc' });
  const [pageInfo, setPageInfo] = useState({ total: 0, totalPages: 1, hasMore: false });
  const [loadError, setLoadError] = useState(null);
  const btns = useResolvedButtons();
  // Requests available for linking. Fetched once, and only for a user who may
  // link — a recruiter without `candidate.link` is shown no control at all
  // rather than a dropdown that would fail on submit.
  const canLink = can(user, 'candidate.link');
  const [linkRequests, setLinkRequests] = useState([]);
  // F2: selection for bulk actions. A Set because membership is the only query.
  const [selected, setSelected] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkUnfit, setBulkUnfit] = useState(false);
  const [unfitFor, setUnfitFor] = useState(null);
  const [bulkRequestId, setBulkRequestId] = useState('');

  useEffect(() => {
    if (!canLink) return;
    api.get('/requests').then((r) => setLinkRequests(r.requests || [])).catch(() => setLinkRequests([]));
  }, [canLink]);

  const load = useCallback(async () => {
    setCandidates(null); setLoadError(null);
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => { if (v && CAND_FILTER_KEYS.includes(k)) params.set(k, v); });
    if (screenTab !== 'all') params.set('screeningStatus', screenTab);
    params.set('page', String(page));
    params.set('pageSize', String(pageSize));
    params.set('sort', sort.by);
    params.set('dir', sort.dir);
    try {
      const r = await api.get('/candidates?' + params.toString());
      setCandidates(r.candidates);
      setPageInfo(r.pagination || { total: r.candidates.length, totalPages: 1, hasMore: false });
    } catch (e) {
      setCandidates([]);
      setLoadError(e.message || 'Could not load candidates.');
    }
  }, [filters, screenTab, page, pageSize, sort]);
  useEffect(() => { load(); }, [load]);
  // Any change to the query must return to page 1, otherwise the user can land on
  // an out-of-range page and see an empty table.
  useEffect(() => { setPage(1); }, [filters, screenTab, pageSize, sort]);

  // Hooks, not just callbacks: every one of these must run on EVERY render, so
  // they live before the early return below. Declaring them after it (as this
  // file used to) meant the hook count dropped the instant selectedId became
  // truthy — mid-render, on the transition into this very branch — which is
  // the textbook "Rendered fewer hooks than expected" crash. Pre-existing;
  // found while verifying the CV-parsing changes, fixed here as a pure
  // reorder — no behavior, naming or logic changed.
  const patchCandidate = useCallback((id, fn) => {
    setCandidates((cs) => (cs === null ? cs : cs.map((c) => (c.id === id ? fn(c) : c))));
  }, []);

  const linkCandidate = useCallback(async (candidateId, request) => {
    const requestId = request?.id;
    patchCandidate(candidateId, (c) => ({ ...c, links: [...(c.links || []), linkEntry(request, undefined)] }));
    try {
      const r = await api.post('/applications', { candidateId, requestId });
      patchCandidate(candidateId, (c) => ({
        ...c,
        links: (c.links || []).map((l) => (l.requestId === requestId && l.pending
          ? linkEntry(request, r.application) : l)),
      }));
      return r;
    } catch (e) {
      // Roll back exactly the provisional entry, never a real one.
      patchCandidate(candidateId, (c) => ({
        ...c, links: (c.links || []).filter((l) => !(l.requestId === requestId && l.pending)),
      }));
      throw e;
    }
  }, [patchCandidate]);

  const linkOne = useCallback(async (candidateId, request) => {
    const r = await linkCandidate(candidateId, request);
    toast(`Linked to ${shortReqCode(r.application?.ticketNo) || shortReqCode(request?.ticketNo) || 'request'}`);
  }, [linkCandidate, toast]);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  function openProfile(id, opts) {
    setProfileTab((opts && opts.tab) || 'overview');
    setProfileFocusPrior(!!(opts && opts.focusPrior));
    setSelectedId(id);
  }
  if (selectedId) return <CandidateProfile id={selectedId} user={user} btns={btns} onNavigate={onNavigate}
    initialTab={profileTab} focusPrior={profileFocusPrior}
    onBack={() => { setSelectedId(null); setProfileTab(null); setProfileFocusPrior(false); load(); }} />;

  // Database fitness-screen tabs (target flow: new → screening → fit | unfit).
  // NOTE: the source-attribution tab row (LinkedIn / Careers / Referral / Agency /
  // Direct) was removed — it duplicated the per-row Source chip and made the page
  // read as noise. Source is still shown on every candidate row and card.
  const SCREEN_TABS = [['all', 'All'], ['new', 'New'], ['screening', 'Screening'], ['fit', 'Fit'], ['unfit', 'Unfit']];
  const scOf = (c) => c.screeningStatus || 'new';
  const toggleSort = (col) => setSort((s) => ({ by: col, dir: s.by === col && s.dir === 'asc' ? 'desc' : 'asc' }));
  const FILTER_LABELS = {
    q: 'Search', location: 'Location', currentCompany: 'Company',
    minExp: 'Min exp', maxExp: 'Max exp', tag: 'Tag',
    currentPosition: 'Role', university: 'University',
    graduationFrom: 'Graduated from', graduationTo: 'Graduated to',
    stage: 'Stage', recruiterId: 'Recruiter', requestId: 'Request', projectId: 'Project',
  };
  const mergedForChips = { ...filters, ...pipeFilters };
  const activeFilters = Object.entries(mergedForChips)
    .filter(([k, v]) => v && FILTER_LABELS[k] && v !== true)
    .map(([k, v]) => {
      let shown = v;
      if (k === 'stage') shown = (APP_STATUS[v] || {}).label || v;
      if (k === 'requestId') {
        const r = linkRequests.find((x) => String(x.id) === String(v));
        shown = r ? `${shortReqCode(r.ticketNo)} · ${r.title}` : v;
      }
      if (k === 'projectId') {
        const r = linkRequests.find((x) => x.project && String(x.project.id) === String(v));
        shown = (r && r.project && r.project.name) || v;
      }
      return [k, `${FILTER_LABELS[k]}: ${shown}`];
    });
  const clearFilter = (k) => {
    if (k in pipeFilters) setPipeFilters((f) => ({ ...f, [k]: '' }));
    setFilters((f) => ({ ...f, [k]: '' }));
  };
  const clearAllFilters = () => {
    setFilters((f) => Object.fromEntries(Object.keys(f).map((k) => [k, ''])));
    setScreenTab('all');
    setAskedAs(null); setAsk('');
  };

  /**
   * Ask in plain English.
   *
   * The server translates the sentence into these same filters and returns what
   * it understood. Applying them to the existing state — rather than rendering a
   * separate result list — is what keeps this honest: the recruiter sees the
   * filters it chose, in the boxes they already use, and can correct any of them.
   */
  async function runAsk() {
    const query = ask.trim();
    if (!query || asking) return;
    setAsking(true);
    try {
      const r = await api.get('/candidates/smart-search?q=' + encodeURIComponent(query));
      setFilters((f) => ({
        ...Object.fromEntries(Object.keys(f).map((k) => [k, ''])),
        ...Object.fromEntries(Object.entries(r.filters || {}).map(([k, v]) => [k, v == null ? '' : String(v)])),
      }));
      setScreenTab(r.filters?.screeningStatus || 'all');
      setPage(1);
      setAskedAs(r.interpretation || '');
    } catch (e) {
      toast(e.message || 'Could not run that search.', 'error');
    } finally { setAsking(false); }
  }
  const screenCount = (key) => !candidates ? 0 : key === 'all' ? candidates.length : candidates.filter((c) => scOf(c) === key).length;
  // Filtering happens server-side; `shown` is simply the current page.
  const shown = candidates || [];

  /** A links[] entry shaped like the one GET /candidates builds server-side. */
  function linkEntry(request, application) {
    return {
      applicationId: application?.id ?? null,
      applicationNo: application?.applicationNo ?? null,
      requestId: request?.id ?? null,
      ticketNo: request?.ticketNo ?? null,
      requestTitle: request?.title ?? null,
      requestStatus: request?.status ?? null,
      status: application?.status ?? 'sourced',
      pending: application === undefined,
    };
  }

  /* ---------------------------- bulk actions ---------------------------- */

  function toggleSel(id) {
    setSelected((sel) => { const n = new Set(sel); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleAllShown(on) {
    setSelected(on ? new Set(shown.map((c) => c.id)) : new Set());
  }

  /** Fan out one call per candidate. There is no bulk endpoint; the cap keeps
      a fifty-row selection from spending the global rate budget at once. */
  async function bulkRun(label, worker) {
    setBulkBusy(true);
    const ids = [...selected];
    let ok = 0; const failures = [];
    await runPool(ids, 5, async (id) => {
      try { await worker(id); ok++; } catch (e) { failures.push(e.message || 'failed'); }
    });
    setBulkBusy(false);
    clearSelection();
    if (failures.length === 0) toast(`${label} ${ok} candidate${ok === 1 ? '' : 's'}`);
    else toast(`${label} ${ok}; ${failures.length} could not be done — ${failures[0]}`, ok ? 'warning' : 'error');
    load();
  }

  async function bulkLink() {
    const request = linkRequests.find((r) => String(r.id) === String(bulkRequestId));
    if (!request) return;
    const ids = [...selected];
    const skipIds = ids.filter((id) => {
      const c = (candidates || []).find((x) => x.id === id);
      return !!(c && activeLinkOf(c));
    });
    const work = ids.filter((id) => !skipIds.includes(id));
    if (work.length === 0) {
      toast(`Skipped ${skipIds.length} candidate${skipIds.length === 1 ? '' : 's'} already on a request`);
      setBulkRequestId('');
      return;
    }
    setBulkBusy(true);
    let ok = 0; const failures = [];
    for (const id of work) {
      try { await linkCandidate(id, request); ok++; } catch (e) { failures.push(e.message || 'failed'); }
    }
    setBulkBusy(false);
    clearSelection();
    const skipBit = skipIds.length ? `; skipped ${skipIds.length} already on a request` : '';
    if (failures.length === 0) toast(`Linked to ${shortReqCode(request.ticketNo)} — ${ok} candidate${ok === 1 ? '' : 's'}${skipBit}`);
    else toast(`Linked to ${shortReqCode(request.ticketNo)} — ${ok}; ${failures.length} could not be done — ${failures[0]}${skipBit}`, ok ? 'warning' : 'error');
    setBulkRequestId('');
    load();
  }

  async function setScreening(id, status, reason) {
    try {
      await api.post(`/candidates/${id}/screening`, { status, reason });
      toast(status === 'fit' ? 'Marked fit for position' : status === 'unfit' ? 'Marked unfit' : 'Screening updated');
      load();
    } catch (e) { toast(e.message, 'error'); }
  }
  // Map screening state → existing status-chip style + label.
  const SCREEN_CHIP = {
    new: ['closed', 'New'], screening: ['sourcing', 'Screening'], fit: ['filled', 'Fit'], unfit: ['rejected', 'Unfit'],
  };
  const canScreen = user.permissions.includes('candidate.edit');

  return (
    <div>
      <PageHead crumb="Recruitment / Talent Pool" title="Talent Pool"
        sub="One active request at a time. Closed applications stay on the profile as history."
        actions={<>
          <ViewToggle value={view} onChange={setView} options={[['pipeline', 'Pipeline'], ['cards', 'Cards'], ['table', 'Table']]} />
          {btns.add_candidate?.visible && (
            <button className="btn" onClick={() => { setResumeJob(null); setParsingCv(true); }}>Parse CV</button>
          )}
          {bgParseJob && (
            <button
              className="btn btn-secondary"
              onClick={() => { setResumeJob(bgParseJob); setParsingCv(true); }}
              title={bgParseJob.status === 'ready' ? 'Parsing finished — open to review and save' : 'Still reading — click to check on it'}
            >
              {bgParseJob.status === 'ready' ? `✓ ${bgParseJob.fileName || 'CV'} ready` : `${bgParseJob.fileName || 'CV'} — parsing…`}
            </button>
          )}
          {btns.add_candidate?.visible && (
            <button className="btn btn-ghost" style={{ fontSize: 11.5 }} onClick={() => setCreating(true)} title="Enter a candidate by hand, no CV reading">
              Add manually
            </button>
          )}
          {btns.add_candidate?.visible && (
            <span className="upload-cta">
              <button className="btn btn-secondary" onClick={() => setImportOpen(true)}>Bulk Upload CVs</button>
              <small className="upload-cta-hint">{UPLOAD_HINT}</small>
            </span>
          )}
          {btns.import_candidates?.visible && <button className="btn btn-secondary" onClick={async () => {
            const busy = toast;
            try { const r = await api.post('/candidates/inbox-scan', {}); toast(`Imported ${r.imported} CVs from inbox.${r.skipped ? ' Skipped ' + r.skipped + '.' : ''}`); load(); } catch (e) { toast('Scan failed: ' + e.message, 'error'); }
          }}>Scan CV Inbox</button>}
        </>} />
      <div className="toolbar ask-bar">
        <input className="ask-input" placeholder="Ask in plain English — e.g. quantity surveyors in Riyadh with 10+ years"
          value={ask} disabled={asking}
          onChange={(e) => setAsk(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') runAsk(); }} />
        <button className="btn" onClick={runAsk} disabled={asking || !ask.trim()}>
          {asking ? 'Searching…' : 'Ask'}
        </button>
      </div>
      {askedAs !== null && (
        <div className="ask-note">
          <span className="ask-note-label">Understood as</span>
          <span>{askedAs || 'no constraints — showing everyone'}</span>
          <button className="btn btn-ghost btn-sm" onClick={clearAllFilters}>Clear</button>
        </div>
      )}
      {view !== 'pipeline' && (
      <div className="toolbar">
        <input placeholder="Search name / id / company / email…" value={filters.q} onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} style={{ minWidth: 240 }} />
        <input placeholder="Location" value={filters.location} onChange={(e) => setFilters((f) => ({ ...f, location: e.target.value }))} style={{ width: 120 }} />
        <input placeholder="Company" value={filters.currentCompany} onChange={(e) => setFilters((f) => ({ ...f, currentCompany: e.target.value }))} style={{ width: 120 }} />
        <input placeholder="Grad from" type="number" value={filters.graduationFrom} onChange={(e) => setFilters((f) => ({ ...f, graduationFrom: e.target.value }))} style={{ width: 96 }} title="Graduation year from" />
        <input placeholder="Grad to" type="number" value={filters.graduationTo} onChange={(e) => setFilters((f) => ({ ...f, graduationTo: e.target.value }))} style={{ width: 88 }} title="Graduation year to" />
        <input placeholder="Tag" value={filters.tag} onChange={(e) => setFilters((f) => ({ ...f, tag: e.target.value }))} style={{ width: 100 }} />
        <div className="spacer" />
        <CountPill n={candidates ? shown.length : null} total={candidates ? candidates.length : null} noun="candidate" />
      </div>
      )}

      {/* Database fitness-screen tabs (new → screening → fit | unfit) */}
      {view !== 'pipeline' && (
      <div className="seg-tabs" title="Screen candidates for fitness before attaching them to a requisition">
        {SCREEN_TABS.map(([k, label]) => (
          <button key={k} className={'seg-tab' + (screenTab === k ? ' active' : '')} onClick={() => setScreenTab(k)}>
            {label}<span className="seg-count">{screenCount(k)}</span>
          </button>
        ))}
      </div>
      )}

      {activeFilters.length > 0 && (
        <div className="filter-chips">
          {activeFilters.map(([k, label]) => (
            <span key={k} className="chip-filter">
              {label}
              <button aria-label={`Remove ${label} filter`} onClick={() => clearFilter(k)}>✕</button>
            </span>
          ))}
          <button className="btn btn-ghost btn-sm" onClick={clearAllFilters}>Clear all</button>
        </div>
      )}

      {/* Bulk actions. Linking fifty candidates one popover at a time is three
          clicks each; this is the same work in one. Only shown in Table view,
          because that is the view a recruiter works in volume. */}
      {view === 'table' && selected.size > 0 && (
        <div className="bulk-bar">
          <strong>{selected.size} selected</strong>
          {canLink && (
            <>
              <select value={bulkRequestId} onChange={(e) => setBulkRequestId(e.target.value)}
                aria-label="Hiring request to link to" disabled={bulkBusy}>
                <option value="">Link to request…</option>
                {linkRequests.filter(isLinkable).map((r) => (
                  <option key={r.id} value={r.id}>{shortReqCode(r.ticketNo)} · {r.title}</option>
                ))}
              </select>
              <button className="btn btn-sm" disabled={bulkBusy || !bulkRequestId} onClick={bulkLink}>
                {bulkBusy ? 'Working…' : 'Link'}
              </button>
            </>
          )}
          {canScreen && (
            <>
              <button className="btn btn-sm" disabled={bulkBusy}
                onClick={() => bulkRun('Marked fit —', (id) => api.post(`/candidates/${id}/screening`, { status: 'fit' }))}>
                Mark fit
              </button>
              <button className="btn btn-danger btn-sm" disabled={bulkBusy} onClick={() => setBulkUnfit(true)}>
                Mark unfit
              </button>
            </>
          )}
          <div className="spacer" />
          <button className="btn btn-ghost btn-sm" disabled={bulkBusy} onClick={clearSelection}>Clear</button>
        </div>
      )}

      {loadError ? (
        <div className="card"><ErrorState text={loadError || 'Candidates could not be loaded.'}
          action={<button className="btn" onClick={load}>Retry</button>} /></div>
      ) : !candidates ? <ListSkeleton rows={7} /> : shown.length === 0 ? (
        <div className="card"><Empty icon="👤"
          title={screenTab !== 'all' || filters.q ? 'No candidates in this view' : 'The talent pool is empty'}
          text={screenTab !== 'all' || filters.q
            ? 'Try the All tab, or clear the search and filter fields above.'
            : 'Add a candidate manually, or import CVs against a hiring request to populate the pool.'} /></div>
      ) : view === 'table' ? (
        <div className="card flush"><div className="table-wrap">
          <table className="table responsive-table">
            <thead><tr>
              <th className="th-sel">
                <input type="checkbox" aria-label="Select all on this page"
                  checked={shown.length > 0 && shown.every((c) => selected.has(c.id))}
                  ref={(el) => { if (el) el.indeterminate = selected.size > 0 && !shown.every((c) => selected.has(c.id)); }}
                  onChange={(e) => toggleAllShown(e.target.checked)} />
              </th>
              <SortTh label="Candidate" col="name" sort={sort} onSort={toggleSort} />
              <SortTh label="Position" col="position" sort={sort} onSort={toggleSort} />
              <SortTh label="University" col="university" sort={sort} onSort={toggleSort} />
              <SortTh label="Graduation" col="graduation" sort={sort} onSort={toggleSort} />
              <SortTh label="Location" col="location" sort={sort} onSort={toggleSort} />
              <th className="th-request">Request</th>
              <th>Stage</th>
              <th>CV</th>
            </tr></thead>
            <tbody>{shown.map((c) => (
              <tr key={c.id} className={'row-link' + (selected.has(c.id) ? ' row-selected' : '')}
                onClick={() => openProfile(c.id)}>
                <td className="th-sel" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" aria-label={`Select ${c.fullName}`}
                    checked={selected.has(c.id)} onChange={() => toggleSel(c.id)} />
                </td>
                <td data-label="Candidate">
                  <div className="idcell">
                    <span className="idcell-av">{initials(c.fullName)}</span>
                    <span className="idcell-txt">
                      <span className="cell-strong">{c.fullName} <HistoryBadge history={c.history} onOpen={() => openProfile(c.id, { tab: 'activity', focusPrior: true })} /></span>
                      <span className="cell-sub">{c.candidateNo}</span>
                    </span>
                  </div>
                  {c.tags?.length ? <div className="idcell-tags">{c.tags.slice(0, 3).map((t) => <span key={t} className="chip">{t}</span>)}</div> : null}
                </td>
                <td data-label="Position">
                  <span className="cell-strong">{c.currentPosition || '—'}</span>
                  {c.currentCompany ? <span className="cell-sub">{c.currentCompany}</span> : null}
                </td>
                <td data-label="University">
                  <span className="cell-strong">{c.university || '—'}</span>
                  {c.major ? <span className="cell-sub">{c.major}</span> : null}
                </td>
                <td data-label="Graduation" className="cell-sub-only">{c.graduationYear ?? '—'}</td>
                <td data-label="Location" className="cell-sub-only">{c.location || '—'}</td>
                <td data-label="Request">
                  <LinkRequestCell candidate={c} requests={linkRequests} canLink={canLink}
                    onNavigate={onNavigate} onLinked={linkOne} onRelinked={() => load()} />
                </td>
                <td data-label="Stage"><span className={'status-chip ' + (SCREEN_CHIP[scOf(c)] || SCREEN_CHIP.new)[0]}>{(SCREEN_CHIP[scOf(c)] || SCREEN_CHIP.new)[1]}</span></td>
                <td data-label="CV" className="cell-actions" onClick={(e) => e.stopPropagation()}>
                  {c.hasResume
                    ? <button className="btn btn-ghost btn-sm" title={c.resumeName || 'Download CV'}
                        onClick={() => downloadResume(c, toast)}>Download</button>
                    : <span className="muted">—</span>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div></div>
      ) : view === 'pipeline' ? (
        <TalentPipeline
          user={user} btns={btns}
          pipeFilters={pipeFilters} setPipeFilters={setPipeFilters}
          q={filters.q} setQ={(value) => setFilters((f) => ({ ...f, q: value }))}
          linkRequests={linkRequests}
          unlinked={shown.filter((c) => !activeLinkOf(c))}
          unlinkedTotal={shown.filter((c) => !activeLinkOf(c)).length}
          hasMoreUnlinked={!!pageInfo.hasMore || (pageInfo.total > shown.length)}
          onOpenCards={() => setView('cards')}
          onOpenCandidate={openProfile}
          toast={toast} />
      ) : (
        <div className="cand-grid">
          {shown.map((c) => (
            <div key={c.id} className="card cand-card" onClick={() => openProfile(c.id)}>
              <div className="cc-face">
                <div className="cc-avatar">{initials(c.fullName)}</div>
                <div className="cc-id">
                  <div className="cc-name">
                    {c.fullName}
                    <HistoryBadge history={c.history} onOpen={() => openProfile(c.id, { tab: 'activity', focusPrior: true })} />
                  </div>
                  <div className="cc-headline">{c.currentPosition || '—'}</div>
                </div>
                <div className="cc-uni">
                  <div className="cc-uni-name" title={c.university || ''}>{c.university || '—'}</div>
                  <div className="cc-uni-major" title={c.major || ''}>{c.major || '—'}</div>
                </div>
              </div>
              <div className="cc-foot">
                <span className={c.graduationYear != null ? 'cc-grad' : 'cc-grad missing'}>
                  {c.graduationYear != null ? `Class of ${c.graduationYear}` : 'Graduation year not recorded'}
                </span>
                <CandidateActionMenu
                  candidate={c} canScreen={canScreen} canLink={canLink} sc={scOf(c)}
                  requests={linkRequests}
                  onScreen={() => setScreening(c.id, 'screening')}
                  onFit={() => setScreening(c.id, 'fit')}
                  onUnfit={() => setUnfitFor(c)}
                  onLinked={linkOne}
                  onRelinked={() => load()}
                  onOpen={() => openProfile(c.id)}
                  toast={toast} />
              </div>
            </div>
          ))}
        </div>
      )}
      {candidates && shown.length > 0 && view !== 'pipeline' && (
        <Pager page={page} pageSize={pageSize} total={pageInfo.total}
          totalPages={pageInfo.totalPages} onPage={setPage} onPageSize={setPageSize} />
      )}
      {unfitFor && (
        <ReasonModal title={`Mark ${unfitFor.fullName} unfit`}
          label="Reason this candidate is unfit"
          confirmLabel="Mark unfit"
          onClose={() => setUnfitFor(null)}
          onConfirm={async (reason) => { const c = unfitFor; setUnfitFor(null); await setScreening(c.id, 'unfit', reason); }} />
      )}
      {bulkUnfit && (
        <ReasonModal title={`Mark ${selected.size} candidate${selected.size === 1 ? '' : 's'} unfit`}
          label="Reason this candidate is unfit"
          confirmLabel="Mark unfit"
          onClose={() => setBulkUnfit(false)}
          onConfirm={async (reason) => {
            setBulkUnfit(false);
            await bulkRun('Marked unfit —',
              (id) => api.post(`/candidates/${id}/screening`, { status: 'unfit', reason }));
          }} />
      )}
      {creating && <CandidateForm user={user} onClose={() => setCreating(false)} onSaved={(id) => { setCreating(false); load(); setSelectedId(id); }} />}
      {parsingCv && (
        <ParseCvModal
          job={resumeJob}
          onClose={() => { setParsingCv(false); setResumeJob(null); }}
          onBackground={(j) => { setBgParseJob({ ...j, status: 'processing', result: null }); setParsingCv(false); setResumeJob(null); }}
          onSaved={(id) => {
            setParsingCv(false); setResumeJob(null);
            // Saving the job being tracked in the background clears the pill.
            setBgParseJob((b) => (resumeJob && b?.jobId === resumeJob.jobId ? null : b));
            load(); setSelectedId(id);
          }}
        />
      )}
      {importOpen && <ImportCvsModal onClose={() => setImportOpen(false)} onDone={load} />}
    </div>
  );
}

const PARSE_PREVIEW_STATUS_LABEL = {
  verified: 'Verified', likely: 'Likely (AI only)', rejected: 'Rejected', not_stated: 'Not stated in CV',
};

/**
 * EVERY field the reader saw for a parsed CV — not just the ones this form
 * auto-fills. A field that is simply blank is indistinguishable from one the
 * reader missed; this table exists so that distinction is never silent. Purely
 * informational: nothing here writes to the form, that stays the recruiter's.
 */
function ParsePreviewTable({ rows }) {
  if (!rows || !rows.length) return null;
  const sections = [];
  for (const r of rows) if (!sections.includes(r.section)) sections.push(r.section);
  return (
    <div className="parse-preview-panel">
      <div className="parse-preview-head">Full extraction preview — every field the reader looked for</div>
      <div className="review-table-wrap">
        <table className="review-table preview-table">
          <thead><tr><th>Field</th><th>Value</th><th>Status</th></tr></thead>
          <tbody>
            {sections.map((section) => (
              <React.Fragment key={section}>
                <tr className="preview-section-row"><td colSpan={3}>{section}</td></tr>
                {rows.filter((r) => r.section === section).map((r) => (
                  <tr key={r.field} className={`preview-status-row-${r.status}`}>
                    <td>{r.label}</td>
                    <td>{r.value == null ? <span className="muted">—</span> : <span className="parsed-value">{r.value}</span>}</td>
                    <td>
                      <span className={`preview-status-badge preview-status-${r.status}`}>
                        {PARSE_PREVIEW_STATUS_LABEL[r.status] || r.status}
                      </span>
                      {r.reason ? <small>{r.reason}</small> : null}
                    </td>
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * The original file next to the parsed table, so a recruiter can check a
 * value against the source without leaving this screen. Zoom is a CSS scale
 * on the preview element — enough to read a page clearly; it does not
 * re-render the PDF at higher resolution.
 */
function CvFilePreview({ fileUrl, fileName, mimeType }) {
  const [zoom, setZoom] = useState(1);
  const zoomOut = () => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(2)));
  const zoomIn = () => setZoom((z) => Math.min(2, +(z + 0.1).toFixed(2)));
  const isPdf = mimeType === 'application/pdf';
  const isImage = !!mimeType && mimeType.startsWith('image/');
  return (
    <div className="parse-review-cv">
      <div className="parse-review-cv-toolbar">
        <span className="parse-review-cv-name" title={fileName || ''}>{fileName || 'Original CV'}</span>
        {(isPdf || isImage) && fileUrl && (
          <div className="parse-review-zoom">
            <button type="button" onClick={zoomOut} aria-label="Zoom out">−</button>
            <span>{Math.round(zoom * 100)}%</span>
            <button type="button" onClick={zoomIn} aria-label="Zoom in">+</button>
          </div>
        )}
      </div>
      <div className="parse-review-cv-viewport">
        {!fileUrl ? (
          <div className="parse-review-cv-empty">No file to preview.</div>
        ) : isPdf ? (
          <iframe title="Original CV" src={fileUrl} className="parse-review-cv-frame" style={{ transform: `scale(${zoom})` }} />
        ) : isImage ? (
          <img src={fileUrl} alt={fileName || 'CV'} className="parse-review-cv-image" style={{ transform: `scale(${zoom})` }} />
        ) : (
          <div className="parse-review-cv-empty">
            Inline preview isn't available for this file type.
            <div style={{ marginTop: 10 }}>
              <a href={fileUrl} download={fileName || 'cv'} className="btn btn-secondary">Download {fileName || 'file'}</a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The interstitial between "Parse CV" and the editable form: every field the
 * reader saw, sized to actually be read, next to the document it came from.
 * Nothing here writes anything — `onContinue` reveals the existing
 * auto-filled form (untouched) for the recruiter's final edits and Save.
 */
/**
 * The result screen: every field the reader saw, next to the document it
 * came from, with ONE save action.
 *
 * `intake` is the PENDING record `/parse-cv` already raised — accepting every
 * one of its fields via the existing intake-review endpoint is what actually
 * creates the candidate. This calls no new backend logic; it is the same path
 * `intake-review.jsx`'s "Accept all" uses, just entered from Talent Pool.
 */
function CvParseReviewOverlay({ rows, intake, fileUrl, fileName, mimeType, onSaved, onCancel }) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const sections = [];
  for (const r of rows) if (!sections.includes(r.section)) sections.push(r.section);
  const needsRecheck = rows.filter((r) => r.status === 'likely' || r.status === 'rejected').map((r) => r.label);
  const notFound = rows.filter((r) => r.status === 'not_stated').map((r) => r.label);
  const canSave = !!(intake && intake.fields && intake.fields.length > 0);

  async function save() {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      const decisions = Object.fromEntries(intake.fields.map((f) => [f.field, true]));
      const r = await api.post(`/candidates/intakes/${intake.id}/review`, { decisions, version: intake.version });
      if (r.candidate) {
        toast(`Candidate created: ${r.candidate.candidateNo}`);
        onSaved(r.candidate.id);
      } else {
        toast('Could not create the candidate from this review.', 'error');
      }
    } catch (e) {
      toast(e.message || 'Could not save this candidate.', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="parse-review-panel">
        <div className="parse-review-head">
          <h3>Parsed CV — review before saving</h3>
          <button className="icon-btn" onClick={onCancel} aria-label="Close">✕</button>
        </div>
        <div className="parse-review-body">
          <div className="parse-review-results">
            <table className="parse-review-table">
              <tbody>
                {sections.map((section) => (
                  <React.Fragment key={section}>
                    <tr className="parse-review-section-row"><td colSpan={2}>{section}</td></tr>
                    {rows.filter((r) => r.section === section).map((r) => (
                      <tr key={r.field} title={r.reason || ''}>
                        <td>{r.label}</td>
                        <td>{r.value == null ? '—' : r.value}</td>
                      </tr>
                    ))}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
            {(needsRecheck.length > 0 || notFound.length > 0) && (
              <div className="parse-review-footnote">
                {needsRecheck.length > 0 && <div><strong>Needs a second look:</strong> {needsRecheck.join(' · ')}</div>}
                {notFound.length > 0 && <div><strong>Not found in this CV:</strong> {notFound.join(' · ')}</div>}
                {!canSave && <div><strong>Nothing here could be confirmed well enough to save automatically.</strong> Close this and use "Add manually" instead.</div>}
              </div>
            )}
          </div>
          <CvFilePreview fileUrl={fileUrl} fileName={fileName} mimeType={mimeType} />
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="btn" onClick={save} disabled={!canSave || saving}>{saving ? 'Saving…' : 'Save candidate'}</button>
        </div>
      </div>
    </div>
  );
}

/**
 * The primary "add candidate" entry point: pick a CV, watch it get read, then
 * save straight from the reviewed result. No manual fields anywhere in this
 * component — manual entry is CandidateForm, reached from its own smaller
 * button. Owns its own file/parse state rather than sharing CandidateForm's,
 * since the two are now fully independent flows.
 *
 * THE BIG LEVER: parsing runs on the server via /parse-cv-async, which
 * answers immediately with a job id instead of holding the request open for
 * the two Claude calls (10-20s). This component polls that job — but the
 * point isn't the polling, it's that the job keeps running on the server
 * whether or not anything is polling it. "Continue in background" hands the
 * job id (and the picked file, so the CV preview still works later) up to
 * CandidatesPage and closes this modal; CandidatesPage's own light poll picks
 * up from there and surfaces a pill when it's ready, so the recruiter is
 * never stuck watching a spinner they can't walk away from.
 *
 * `job` (optional): { jobId, fileName, file, status, result } handed back
 * down when reopening a backgrounded parse — `result` already present means
 * CandidatesPage's own poll finished it, so this skips straight to review.
 */
function ParseCvModal({ onClose, onSaved, onBackground, job }) {
  const toast = useToast();
  const [file, setFile] = useState(job?.file ?? null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(job?.result ?? null); // { preview, intake } once parsed
  const [jobId, setJobId] = useState(job?.jobId ?? null);
  const cancelledRef = useRef(false);
  useEffect(() => () => { cancelledRef.current = true; }, []);
  const fileUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (fileUrl) URL.revokeObjectURL(fileUrl); }, [fileUrl]);

  async function pollJob(id) {
    for (;;) {
      if (cancelledRef.current) return;
      let j;
      try {
        j = await api.get(`/candidates/parse-cv-async/${id}`);
      } catch (e) {
        if (!cancelledRef.current) { toast('Lost track of that parse: ' + e.message, 'error'); setBusy(false); }
        return;
      }
      if (cancelledRef.current) return;
      if (j.status === 'processing') { await new Promise((r) => setTimeout(r, 2000)); continue; }
      if (j.status === 'error') { toast(j.message || 'Parse failed.', 'error'); setBusy(false); return; }
      const r = j.payload;
      if (r?.preview?.length) setResult({ preview: r.preview, intake: r.intake });
      else toast(r?.reason || 'Nothing could be read from this file.', 'error');
      setBusy(false);
      return;
    }
  }

  // Resume a job handed down from CandidatesPage — once, on mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (job?.jobId && !job.result) { setBusy(true); pollJob(job.jobId); } }, []);

  async function parse() {
    if (!file || busy) return;
    setBusy(true);
    try {
      const started = await api.uploadTo('/candidates/parse-cv-async', file);
      if (!started?.jobId) { toast('Could not start parsing.', 'error'); setBusy(false); return; }
      setJobId(started.jobId);
      pollJob(started.jobId);
    } catch (e) {
      toast('Parse failed: ' + e.message, 'error');
      setBusy(false);
    }
  }

  if (result) {
    return (
      <CvParseReviewOverlay
        rows={result.preview}
        intake={result.intake}
        fileUrl={fileUrl}
        fileName={file?.name}
        mimeType={file?.type}
        onSaved={onSaved}
        onCancel={onClose}
      />
    );
  }

  return (
    <Modal title="Parse CV" onClose={onClose}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        {busy && jobId && (
          <button className="btn btn-secondary" onClick={() => onBackground({ jobId, fileName: file?.name, file })}>
            Continue in background
          </button>
        )}
        {!busy && <button className="btn" onClick={parse} disabled={!file}>Parse CV</button>}
      </>}>
      <div className="field full"><label>CV / Résumé</label>
        <input type="file" disabled={busy} onChange={(e) => setFile(e.target.files?.[0] || null)} accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,.txt" style={{ width: '100%' }} />
        <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
          {file ? `Selected: ${file.name} — click Parse CV to read it.` : 'Upload a CV. The reader finds the fields; you review and save on the next screen.'}
        </div>
      </div>
      {busy && <ParsingStatusLine />}
      {busy && (
        <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
          You don't have to wait here — "Continue in background" keeps this reading and lets you get back to work; you'll see it ready in Talent Pool.
        </div>
      )}
    </Modal>
  );
}

/** What the pipeline is genuinely doing, in the order it genuinely does it. */
const PARSE_STEPS = [
  'Reading the document…',
  'Identifying candidate details…',
  'Extracting work history and education…',
  'Verifying every field against the source…',
  'Finalizing the results…',
];

/**
 * Cosmetic only — cycles through PARSE_STEPS while the two parse calls are in
 * flight, so a 10-20 second wait reads as active, specific work instead of a
 * frozen button. Loops on the last step if the real call runs long, rather
 * than inventing a fake ETA.
 */
function ParsingStatusLine() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setStep((s) => Math.min(s + 1, PARSE_STEPS.length - 1)), 2600);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="parsing-status-line">
      <span className="parsing-status-dot" />
      {PARSE_STEPS[step]}
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
  // Manual entry only — AI parsing is a separate entry point (ParseCvModal).
  // A CV picked here is just a file to store alongside a hand-typed record.
  const [cvFile, setCvFile] = useState(null);
  const customDefs = useCustomFields('candidate');
  const [customVals, setCustomVals] = useState(candidate?.customFields || {});
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
      const body = { ...f, tags: f.tags ? f.tags.split(',').map((s) => s.trim()).filter(Boolean) : [], customFields: customVals };
      if (dups.length && isNew) { body.overrideDuplicate = true; body.overrideReason = override.reason; }
      let candId;
      if (isNew) { const r = await api.post('/candidates', body); candId = r.candidate.id; toast('Candidate created: ' + r.candidate.candidateNo); }
      else { await api.put('/candidates/' + candidate.id, body); candId = candidate.id; toast('Candidate updated'); }
      // Upload the CV (if chosen) to the candidate's résumé store — durable in the DB.
      if (cvFile && candId) {
        try { await api.uploadTo('/candidates/' + candId + '/resume', cvFile); }
        catch (e) { toast('Candidate saved, but CV upload failed: ' + e.message, 'error'); }
      }
      onSaved(candId);
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }
  const blockSave = isNew && dups.length && !override.reason.trim();
  return (
    <Modal title={isNew ? 'Add candidate manually' : 'Edit Candidate'} onClose={onClose} wide
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
        <div className="field full"><label>CV / Résumé (optional)</label>
          <input type="file" onChange={(e) => setCvFile(e.target.files?.[0] || null)} accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,.txt" style={{ width: '100%' }} />
          <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
            {cvFile ? `Selected: ${cvFile.name} — stored with this record, not read.` : 'Stored with the record for reference. Not read — use Parse CV from Talent Pool to have the AI read a CV.'}
          </div>
        </div>
        <CustomFieldsInputs defs={customDefs} values={customVals} onChange={(k, v) => setCustomVals((s) => ({ ...s, [k]: v }))} />
      </div>
    </Modal>
  );
}

// CV & Attachments tab on the candidate profile — résumé view/download/upload (durable in DB).
function CandidateCvTab({ c, user, btns, onChanged }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const canEdit = btns?.edit_candidate?.visible || user.permissions.includes('candidate.edit');
  async function view() { try { await api.download(`/candidates/${c.id}/resume`); } catch (e) { toast(e.message, 'error'); } }
  async function reparse() {
    setBusy(true);
    try {
      const r = await api.post(`/candidates/${c.id}/reparse`, {});
      const n = r.proposal?.fields?.length || 0;
      toast(n ? `Re-parsed — ${n} field${n === 1 ? '' : 's'} proposed for review` : 'Re-parsed — nothing could be read from this file');
      onChanged && onChanged();
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  }
  async function upload(e) {
    const file = e.target.files?.[0]; if (!file) return;
    setBusy(true);
    try { await api.uploadTo(`/candidates/${c.id}/resume`, file); toast('Résumé uploaded'); onChanged && onChanged(); }
    catch (err) { toast(err.message, 'error'); } finally { setBusy(false); e.target.value = ''; }
  }
  return (
    <div className="card card-pad">
      <div className="section-title" style={{ marginTop: 0 }}>Résumé / CV</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', background: 'var(--ticket-chip-bg, #fbeef0)', border: '1px solid var(--ticket-chip-border, #f3d6db)', borderRadius: 10, padding: '12px 14px' }}>
        <div style={{ flex: 1, minWidth: 160 }}>
          <div style={{ fontWeight: 600 }}>{c.hasResume ? (c.resumeName || 'Attached résumé') : <span className="muted">No résumé on file</span>}</div>
        </div>
        {c.hasResume && <button className="btn btn-sm btn-secondary" onClick={view}>View / Download</button>}
        {c.hasResume && canEdit && <button className="btn btn-sm btn-ghost" onClick={reparse} disabled={busy} title="Re-run the CV parser on the file already attached">{busy ? 'Working…' : 'Re-parse'}</button>}
        {canEdit && <label className="btn btn-sm btn-ghost" style={{ cursor: 'pointer' }}>{busy ? 'Uploading…' : (c.hasResume ? 'Replace' : '+ Upload CV')}<input type="file" style={{ display: 'none' }} onChange={upload} disabled={busy} accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,.txt" /></label>}
      </div>
      {(c.documents || []).length > 0 && (
        <>
          <div className="section-title">Other Documents</div>
          <table><thead><tr><th>Type</th><th>File</th><th>Uploaded</th></tr></thead>
            <tbody>{c.documents.map((d) => <tr key={d.id}><td><span className="chip">{d.doc_type}</span></td><td>{d.file_name}</td><td className="muted">{fmtDate(d.uploaded_at)}</td></tr>)}</tbody></table>
        </>
      )}
    </div>
  );
}

const ACT_CATS = [
  ['applications', 'Applications'],
  ['interviews', 'Interviews'],
  ['offers', 'Offers'],
  ['notes', 'Notes'],
  ['cv', 'CV & parsing'],
  ['privacy', 'Privacy'],
];
function actStamp(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function actCatForType(type) {
  const t = String(type || '').toLowerCase();
  if (t.includes('interview')) return 'interviews';
  if (t.includes('offer')) return 'offers';
  if (t.includes('note') || t.includes('assessment')) return 'notes';
  if (t.includes('parse') || t.includes('resume') || t.includes('cv') || t.includes('attach')) return 'cv';
  if (t.includes('consent') || t.includes('eras') || t.includes('retention') || t.includes('privacy')) return 'privacy';
  return 'applications';
}
function actIcon(cat) {
  return { applications: 'ticket', interviews: 'calendar', offers: 'doc', notes: 'scroll', cv: 'user', privacy: 'shield' }[cat] || 'scroll';
}
function buildActivityLog(c, { canSeeInterviews, canSeeOffers }) {
  const entries = [];
  const apps = c.applications || c.links || [];
  apps.forEach((app, i) => {
    const ticket = app.ticketNo || (app.request && app.request.ticketNo);
    const reqId = app.requestId || (app.request && app.request.id);
    const reqTitle = app.position || app.requestTitle || (app.request && app.request.title);
    (app.stageHistory || []).forEach((h, j) => {
      const from = (APP_STATUS[h.fromStatus] || {}).label || h.fromStatus || '—';
      const to = (APP_STATUS[h.toStatus] || {}).label || h.toStatus || '—';
      const actor = (h.actor && h.actor.name) || h.actor_name || 'System';
      const at = h.occurredAt || h.occurred_at;
      entries.push({
        id: `sh-${app.id || i}-${j}`,
        source: 'stageHistory',
        category: 'applications',
        at,
        actor,
        requestId: reqId,
        ticketNo: ticket,
        prior: TERMINAL_APP.includes(h.toStatus) || TERMINAL_APP.includes(app.status),
        sentence: `Moved from ${from} to ${to}` + (ticket ? ` on ${ticket}` : '') + (h.note ? ` — ${h.note}` : ''),
      });
    });
    const createdAt = app.createdAt || app.created_at || app.stageDate;
    if (createdAt) {
      entries.push({
        id: `app-${app.id || app.applicationId || i}`,
        source: 'application',
        category: 'applications',
        at: createdAt,
        actor: (app.recruiter && app.recruiter.name) || 'System',
        requestId: reqId,
        ticketNo: ticket,
        prior: TERMINAL_APP.includes(app.status),
        sentence: `Linked to ${ticket || 'a request'}` + (reqTitle ? ` (${reqTitle})` : '') + ` as ${((APP_STATUS[app.status] || {}).label || app.status || 'sourced')}`,
      });
    }
  });
  (c.activity || []).forEach((a) => {
    const type = a.type || '';
    if (type === 'application_status_changed' && (c.applications || []).some((app) => (app.stageHistory || []).length)) {
      return;
    }
    const cat = actCatForType(type);
    entries.push({
      id: `act-${a.id}`,
      source: 'activity',
      category: cat,
      at: a.occurred_at || a.occurredAt,
      actor: a.actor_name || (a.actor && a.actor.name) || 'System',
      requestId: a.requestId || a.request_id || null,
      ticketNo: a.ticketNo || a.ticket_no || null,
      sentence: (type || 'update').replace(/_/g, ' ') + (a.note ? ' — ' + a.note : ''),
    });
  });
  (c.notes || []).forEach((n) => {
    entries.push({
      id: `note-${n.id}`,
      source: 'note',
      category: 'notes',
      at: n.created_at || n.createdAt,
      actor: n.author_name || (n.author && n.author.name) || 'System',
      requestId: null,
      ticketNo: null,
      sentence: (n.note_type === 'assessment' ? 'Added an assessment' : 'Added a note') + (n.body ? ': ' + n.body : ''),
    });
  });
  if (canSeeInterviews) {
    (c.interviews || []).forEach((iv) => {
      entries.push({
        id: `iv-${iv.id}`,
        source: 'interview',
        category: 'interviews',
        at: iv.scheduledAt || iv.createdAt || iv.created_at,
        actor: (iv.organizer && iv.organizer.name) || 'System',
        requestId: iv.requestId || (iv.request && iv.request.id),
        ticketNo: iv.ticketNo || (iv.request && iv.request.ticketNo),
        sentence: `Interview ${iv.interviewNo || ''} (${iv.interviewType || '—'} / ${iv.mode || '—'})`
          + (iv.status ? ` — ${(IV_STATUS[iv.status] || {}).label || iv.status}` : '')
          + (iv.overallOutcome ? `, outcome ${(IV_OUTCOME[iv.overallOutcome] || {}).label || iv.overallOutcome}` : ''),
      });
    });
  }
  if (canSeeOffers) {
    (c.offers || []).forEach((o) => {
      entries.push({
        id: `off-${o.id}`,
        source: 'offer',
        category: 'offers',
        at: o.createdAt || o.created_at || o.joiningDate,
        actor: (o.preparedBy && o.preparedBy.name) || 'System',
        requestId: o.requestId || (o.request && o.request.id),
        ticketNo: o.ticketNo || (o.request && o.request.ticketNo),
        sentence: `Offer ${o.offerNo || ''}` + (o.positionTitle ? ` for ${o.positionTitle}` : '')
          + (o.status ? ` — ${(OFFER_STATUS[o.status] || {}).label || o.status}` : ''),
      });
    });
  }
  if (c.consentAt) entries.push({ id: 'privacy-consent', source: 'privacy', category: 'privacy', at: c.consentAt, actor: 'System', sentence: `Consent marked ${(c.consentStatus || 'unknown')}` });
  if (c.retentionUntil) entries.push({ id: 'privacy-retention', source: 'privacy', category: 'privacy', at: c.retentionUntil, actor: 'System', sentence: 'Retention until ' + actStamp(c.retentionUntil) });
  if (c.erasedAt) entries.push({ id: 'privacy-erased', source: 'privacy', category: 'privacy', at: c.erasedAt, actor: 'System', sentence: 'Personal data erased' });
  entries.sort((x, y) => {
    const dx = Date.parse(x.at || '') || 0;
    const dy = Date.parse(y.at || '') || 0;
    if (dy !== dx) return dy - dx;
    if (x.source !== y.source) return x.source < y.source ? -1 : 1;
    return String(x.id).localeCompare(String(y.id));
  });
  return entries;
}
function ActivityLog({ c, user, onNavigate, focusPrior }) {
  const canSeeInterviews = user.permissions.includes('interview.view_all') || user.permissions.includes('interview.view_assigned');
  const canSeeOffers = user.permissions.includes('offer.view');
  const hidden = [];
  if (!canSeeInterviews) hidden.push('interviews');
  if (!canSeeOffers) hidden.push('offers');
  const [cat, setCat] = useState('');
  const logRef = useRef(null);
  const priorRef = useRef(null);
  const entries = useMemo(
    () => buildActivityLog(c, { canSeeInterviews, canSeeOffers }),
    [c, canSeeInterviews, canSeeOffers],
  );
  const shown = cat ? entries.filter((e) => e.category === cat) : entries;
  useEffect(() => {
    if (!focusPrior) return;
    const el = priorRef.current || logRef.current;
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start' });
  }, [focusPrior, c && c.id]);
  const emptyAll = entries.length === 0;
  const emptyFilter = shown.length === 0 && !emptyAll;
  const cannotSeeFilter = cat && hidden.includes(cat);
  return (
    <div className="card">
      <div className="filter-chips" style={{ padding: '12px 16px 0' }}>
        <button className={'chip-filter' + (!cat ? ' on' : '')} onClick={() => setCat('')}>All</button>
        {ACT_CATS.map(([k, label]) => (
          <button key={k} className={'chip-filter' + (cat === k ? ' on' : '')} onClick={() => setCat(k)}>{label}</button>
        ))}
      </div>
      <div className="card-pad act-log" ref={logRef}>
        {cannotSeeFilter ? (
          <Empty icon="🔒" title="You cannot see this"
            text={cat === 'interviews'
              ? 'Interviews are hidden from your role — the list is empty because you cannot see it, not because nothing happened.'
              : 'Offers are hidden from your role — the list is empty because you cannot see it, not because nothing happened.'} />
        ) : emptyAll ? (
          hidden.length
            ? <Empty icon="📜" title="Nothing you can see has been recorded yet"
                text={`No activity is visible on this profile.${hidden.includes('interviews') ? ' Interviews are hidden from your role.' : ''}${hidden.includes('offers') ? ' Offers are hidden from your role.' : ''}`} />
            : <Empty icon="📜" title="Nothing has happened yet" text="When this candidate is linked, interviewed or noted, the events will land here in order." />
        ) : emptyFilter ? (
          <Empty icon="🔍" title="Nothing in this category" text="Try another chip, or All." />
        ) : shown.map((e) => {
          const isPrior = !!(focusPrior && e.prior && e.category === 'applications');
          return (
            <div key={e.id} className="act-item" ref={isPrior && !priorRef.current ? priorRef : undefined}>
              <span className="act-ico"><Icon name={actIcon(e.category)} size={15} /></span>
              <div>
                <div className="act-sentence">{e.sentence}</div>
                <div className="act-meta">
                  {e.actor} · {actStamp(e.at)}
                  {e.ticketNo && onNavigate && (
                    <> · <button className="linklike" onClick={() => openRequest(e.requestId, onNavigate)}>{shortReqCode(e.ticketNo) || e.ticketNo}</button></>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ----------------------------- Candidate Profile (6 tabs) ----------------------------- */
function CandidateProfile({ id, user, btns, onBack, onNavigate, initialTab, focusPrior }) {
  const toast = useToast();
  const [c, setC] = useState(null);
  const [tab, setTab] = useState(initialTab || 'overview');
  useEffect(() => { if (initialTab) setTab(initialTab); }, [initialTab]);
  const [editing, setEditing] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);

  const load = useCallback(async () => { setC((await api.get('/candidates/' + id)).candidate); }, [id]);
  useEffect(() => { load(); }, [id]);
  if (!c) return <Skeleton rows={8} />;

  const canPrivacy = can(user, 'candidate.privacy');
  const TABS = [['overview', 'Overview'], ['cv', 'CV & Attachments'], ['applications', `Applications (${c.applications?.length || 0})`], ['interviews', 'Interviews'], ['offers', 'Offers'], ['activity', 'Activity log']];
  if (canPrivacy) TABS.push(['privacy', 'Data & Privacy']);
  return (
    <div>
      <div className="breadcrumb"><a href="#" onClick={(e) => { e.preventDefault(); onBack(); }}>← Talent Pool</a></div>

      {/* Workable-style structured profile header over the existing record */}
      <div className="card" style={{ marginBottom: 16, padding: 0 }}>
        <div className="profile-header">
          <div className="ph-avatar">{initials(c.fullName)}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="ph-name">{c.fullName} <HistoryBadge history={c.history} onOpen={() => setTab('activity')} /></div>
            <div className="ph-headline">{c.currentPosition || '—'}{c.currentCompany ? ' · ' + c.currentCompany : ''}</div>
            <div className="ph-meta">
              <span className="meta-chip">{c.candidateNo}</span>
              <SourceChip source={c.source} />
              {c.yearsExperience != null && <span className="meta-chip">{c.yearsExperience}y exp</span>}
              {c.location && <span className="meta-chip">{c.location}</span>}
              {c.noticePeriod && <span className="meta-chip">Notice: {c.noticePeriod}</span>}
              <span className="meta-chip">{c.applicationCount} application{c.applicationCount === 1 ? '' : 's'}</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            {btns.edit_candidate?.visible && <button className="btn btn-secondary" onClick={() => setEditing(true)}>Edit</button>}
            {btns.add_note?.visible && <button className="btn btn-secondary" onClick={() => setNoteOpen(true)}>Add Note</button>}
          </div>
        </div>
        <div className="profile-tabs">
          {TABS.map(([k, label]) => <button key={k} onClick={() => setTab(k)} className={'profile-tab' + (tab === k ? ' active' : '')}>{label}</button>)}
        </div>
      </div>

      {tab === 'overview' && (
        <div className="card card-pad"><div className="form-grid">
          <Info label="Full Name">{c.fullName}</Info><Info label="Email">{c.email}</Info><Info label="Phone">{c.phone}</Info>
          <Info label="Nationality">{c.nationality}</Info><Info label="Location">{c.location}</Info>
          <Info label="LinkedIn">{c.linkedinUrl ? <a href={c.linkedinUrl} target="_blank" rel="noreferrer">Profile</a> : '—'}</Info>
          <Info label="Current Company">{c.currentCompany}</Info><Info label="Current Position">{c.currentPosition}</Info>
          <Info label="University">{c.university || '—'}</Info>
          <Info label="Major">{c.major || '—'}</Info>
          <Info label="Graduation Year">{c.graduationYear ?? '—'}</Info>
          <Info label="Experience">{c.yearsExperience != null ? c.yearsExperience + ' years' : '—'}</Info>
          <Info label="Notice Period">{c.noticePeriod}</Info><Info label="Source">{c.source}</Info>
          {c.salaryVisible ? <Info label="Expected Salary">{c.expectedSalary ?? '—'}</Info> : <Info label="Expected Salary"><span className="muted">Restricted</span></Info>}
          <Info label="Owner Recruiter">{c.ownerRecruiter?.name}</Info>
          <div className="full"><Info label="Tags">{(c.tags || []).length ? c.tags.map((t) => <span key={t} className="chip">{t}</span>) : '—'}</Info></div>
        </div></div>
      )}
      {tab === 'cv' && <CandidateCvTab c={c} user={user} btns={btns} onChanged={load} />}
      {tab === 'applications' && (
        <div className="card">
          {(c.applications || []).length === 0 ? <Empty icon="🎫" text="Not linked to any request yet." /> : (
            <table><thead><tr><th>Application</th><th>Ticket</th><th>Position</th><th>Project</th><th>Status</th><th>Recruiter</th><th>Last Activity</th></tr></thead>
              <tbody>{c.applications.map((a) => (
                <tr key={a.id}><td><strong>{a.applicationNo}</strong></td><td title={a.ticketNo}>{shortReqCode(a.ticketNo)}</td><td>{a.position}</td><td>{a.project?.name || '—'}</td>
                  <td><AppStatusBadge status={a.status} /></td><td className="muted">{a.recruiter?.name || '—'}</td><td className="muted">{fmtDateShort(a.lastActivityAt)}</td></tr>
              ))}</tbody></table>
          )}
          <div className="card-pad muted">One active request at a time. Closed applications stay visible here as history.</div>
        </div>
      )}
      {tab === 'interviews' && (
        <div className="card">
          {(c.interviews || []).length === 0 ? <Empty icon="📅" text="No interviews for this candidate (or none assigned to you)." /> : (
            <table><thead><tr><th>Interview</th><th>Request</th><th>Type / Mode</th><th>Round</th><th>Scheduled</th><th>Status</th><th>Outcome</th></tr></thead>
              <tbody>{c.interviews.map((iv) => (
                <tr key={iv.id}><td><strong>{iv.interviewNo}</strong></td><td title={iv.ticketNo}>{shortReqCode(iv.ticketNo)}</td><td>{iv.interviewType} / {iv.mode}</td><td>{iv.round}</td>
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
                <tr key={o.id}><td><strong>{o.offerNo}</strong></td><td title={o.ticketNo}>{shortReqCode(o.ticketNo)}</td><td>{o.positionTitle}</td>
                  <td><SalaryCell visible={o.salaryVisible} value={o.salaryOffered} currency={o.currency} /></td>
                  <td><OfferStatusBadge status={o.status} /></td><td className="muted">{fmtDateShort(o.joiningDate)}</td></tr>
              ))}</tbody></table>
          )}
          <div className="card-pad muted">Offers link to a specific application/request; salary is shown only to authorized roles.</div>
        </div>
      )}
      {tab === 'activity' && <ActivityLog c={c} user={user} onNavigate={onNavigate} focusPrior={focusPrior} />}

      {tab === 'privacy' && canPrivacy && <CandidatePrivacyTab c={c} onChanged={load} />}

      {editing && <CandidateForm user={user} candidate={c} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load(); }} />}
      {noteOpen && <NoteModal candidateId={c.id} onClose={() => setNoteOpen(false)} onSaved={() => { setNoteOpen(false); load(); }} />}
    </div>
  );
}
// GDPR/PDPL controls on the candidate profile — consent, data export, erasure.
function CandidatePrivacyTab({ c, onChanged }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const erased = c.candidateState === 'erased';
  const consentVariant = { given: 'success', withdrawn: 'critical', unknown: 'soft' }[c.consentStatus || 'unknown'];

  async function setConsent(status) {
    setBusy(true);
    try { await api.post(`/candidates/${c.id}/consent`, { status, source: 'manual' }); toast(`Consent marked ${status}`); onChanged(); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }
  async function exportData() {
    try { await api.download(`/candidates/${c.id}/export`, `${c.candidateNo}-data-export.json`); toast('Data export downloaded'); }
    catch (e) { toast(e.message, 'error'); }
  }
  async function erase() {
    const reason = window.prompt('This permanently anonymises all personal data for this candidate and deletes their CV. This cannot be undone.\n\nType a reason to confirm:');
    if (reason == null) return;
    setBusy(true);
    try { await api.post(`/candidates/${c.id}/erase`, { confirm: 'ERASE', reason }); toast('Personal data erased'); onChanged(); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }

  return (
    <div className="card card-pad">
      {erased && <div style={{ marginBottom: 16, padding: '10px 12px', borderRadius: 8, background: 'color-mix(in srgb, var(--warning, #F59E0B) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--warning, #F59E0B) 40%, transparent)', fontSize: 13 }}>This candidate's personal data was erased on {fmtDate(c.erasedAt)}. The record is retained (anonymised) for audit integrity.</div>}
      <div className="form-grid">
        <Info label="Consent status"><Badge variant={consentVariant}>{(c.consentStatus || 'unknown').replace(/^\w/, (m) => m.toUpperCase())}</Badge></Info>
        <Info label="Consent recorded">{c.consentAt ? fmtDate(c.consentAt) : '—'}</Info>
        <Info label="Retention until">{c.retentionUntil ? fmtDateShort(c.retentionUntil) : '—'}</Info>
        <Info label="Erased">{erased ? fmtDate(c.erasedAt) : 'No'}</Info>
      </div>

      {!erased && (
        <div style={{ marginTop: 20, display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <button className="btn btn-secondary" disabled={busy} onClick={() => setConsent('given')}>Mark consent given</button>
          <button className="btn btn-secondary" disabled={busy} onClick={() => setConsent('withdrawn')}>Mark consent withdrawn</button>
          <button className="btn btn-secondary" onClick={exportData}>Export data (JSON)</button>
          <button className="btn btn-danger" disabled={busy} onClick={erase}>Erase personal data…</button>
        </div>
      )}
      {erased && <div style={{ marginTop: 20 }}><button className="btn btn-secondary" onClick={exportData}>Export retained record</button></div>}
      <p className="muted" style={{ marginTop: 16, fontSize: 12 }}>
        Data-protection actions (GDPR / Egypt PDPL): record the candidate's consent to hold their data, export everything held about them for a subject-access request, or erase their personal data on request. All actions are written to the audit log.
      </p>
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
        <div className="field">
          <label>{f.mode === 'video' ? 'Google Meet link' : f.mode === 'phone' ? 'Phone number' : 'Location'}</label>
          <input value={f.locationOrLink} onChange={(e) => set('locationOrLink', e.target.value)}
            placeholder={f.mode === 'video' ? 'https://meet.google.com/abc-defg-hij' : f.mode === 'phone' ? '+20 100 000 0000' : 'Meeting room / site address'} />
          {f.mode === 'video' && (
            <div className="field-hint">Google Meet is the standard for video interviews. Paste the link from Google Calendar — it is sent verbatim in the candidate's invite email.</div>
          )}
        </div>
      </div>
      <div className="section-title">Panel (interviewers) *</div>
      <div>{meta.interviewers.map((u) => <span key={u.id} className={'tag-toggle' + (f.panel.includes(u.id) ? ' on' : '')} onClick={() => togglePanel(u.id)}>{u.name}</span>)}</div>
      <p className="muted" style={{ marginTop: 8 }}>First selected is the lead. Only selected interviewers will see this interview and may submit feedback.</p>
    </Modal>
  );
}

function InterviewsPage({ user, initialFilters }) {
  const [data, setData] = useState(null);
  // `thisWeek` is client-side only — there is no date-range param on
  // GET /interviews, so it filters the loaded rows below, the same way
  // RequestsPage's `openOnly`/`attention` do for the same reason.
  const [filter, setFilter] = useState({ status: '', q: '', thisWeek: false });
  // `openId` jumps straight to one interview (a dashboard action item always
  // names a specific one); a plain filter narrows the list instead.
  const [selected, setSelected] = useState(initialFilters?.openId ?? null);

  useEffect(() => {
    if (!initialFilters) return;
    if (initialFilters.openId) { setSelected(initialFilters.openId); return; }
    setFilter((f) => ({ ...f, ...initialFilters }));
  }, [initialFilters]);

  const load = useCallback(async () => {
    setData(null);
    const params = new URLSearchParams();
    Object.entries(filter).forEach(([k, v]) => { if (k !== 'thisWeek' && v) params.set(k, v); });
    setData(await api.get('/interviews?' + params.toString()));
  }, [filter]);
  useEffect(() => { load(); }, [load]);

  if (selected) return <InterviewDetail id={selected} user={user} onBack={() => { setSelected(null); load(); }} />;

  const shown = (data ? data.interviews : []).filter((iv) => {
    if (!filter.thisWeek) return true;
    if (iv.status !== 'scheduled') return false;
    const days = daysUntil(iv.scheduledAt);
    return days != null && days >= 0 && days <= 7;
  });

  return (
    <div>
      <PageHead crumb="Recruitment / Interviews" title={data?.scoped ? 'My Interviews' : 'Interviews'}
        sub={data?.scoped ? 'Interviews where you are on the panel.' : 'Every interview links to an application, candidate and request. Interview status is tracked separately from application status.'}
        actions={data?.scoped ? <Badge variant="info">My panel</Badge> : <Badge variant="info">All interviews</Badge>} />
      <div className="toolbar">
        <input placeholder="Search interview no / type…" value={filter.q} onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))} style={{ minWidth: 220 }} />
        <select value={filter.status} onChange={(e) => setFilter((f) => ({ ...f, status: e.target.value }))}>
          <option value="">All statuses</option>{Object.entries(IV_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
        <label className="switch" title="Scheduled interviews in the next 7 days">
          <input type="checkbox" checked={filter.thisWeek} onChange={(e) => setFilter((f) => ({ ...f, thisWeek: e.target.checked }))} />
          This week
        </label>
        <div className="spacer" />
        <CountPill n={data ? shown.length : null} total={data ? data.interviews.length : null} noun="interview" />
      </div>
      {!data ? <ListSkeleton rows={6} /> : shown.length === 0 ? (
        <div className="card"><Empty icon="📅"
          title={filter.q || filter.status || filter.thisWeek ? 'No interviews match these filters' : 'No interviews scheduled'}
          text={filter.q || filter.status || filter.thisWeek
            ? 'Try clearing the search box or the filters above.'
            : 'Interviews scheduled from a candidate\u2019s application will appear here with date, panel and outcome.'} /></div>
      ) : (
        <div className="card flush"><div className="table-wrap">
          <table className="table responsive-table">
            <thead><tr><th>Scheduled</th><th>Candidate</th><th>Request</th><th>Type / Mode</th><th>Interview</th><th>Status</th><th>Outcome</th><th>Application</th></tr></thead>
            <tbody>{shown.map((iv) => (
              <tr key={iv.id} className="row-link" onClick={() => setSelected(iv.id)}>
                <td data-label="Scheduled"><DateCell value={iv.scheduledAt} /></td>
                <td data-label="Candidate">
                  <div className="idcell">
                    <span className="idcell-av">{initials(iv.candidate?.fullName || '?')}</span>
                    <span className="idcell-txt">
                      <span className="cell-strong">{iv.candidate?.fullName || '—'}</span>
                      <span className="cell-sub">{iv.candidate?.currentPosition || '—'}</span>
                    </span>
                  </div>
                </td>
                <td data-label="Request"><span className="code-pill" title={iv.request?.ticketNo}>{shortReqCode(iv.request?.ticketNo)}</span><div className="cell-sub">{iv.request?.title || '—'}</div></td>
                <td data-label="Type / Mode"><span className="cell-strong">{iv.interviewType || '—'}</span><div className="cell-sub">{iv.mode || '—'}</div></td>
                <td data-label="Interview"><span className="cell-sub-only">{iv.interviewNo}</span><div className="cell-sub">Round {iv.round}</div></td>
                <td data-label="Status"><IvStatusBadge status={iv.status} /></td>
                <td data-label="Outcome">{iv.overallOutcome ? <Badge variant={(IV_OUTCOME[iv.overallOutcome] || {}).variant || 'soft'}>{(IV_OUTCOME[iv.overallOutcome] || {}).label || iv.overallOutcome}</Badge> : <span className="muted">—</span>}</td>
                <td data-label="Application" title="Application pipeline status (tracked separately)">{iv.application?.status ? <AppStatusBadge status={iv.application.status} /> : <span className="muted">—</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div></div>
      )}
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
          <Info label="Request"><span title={iv.request?.ticketNo}>{shortReqCode(iv.request?.ticketNo)}</span> — {iv.request?.title}</Info>
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

function OffersPage({ user, initialFilters }) {
  const [offers, setOffers] = useState(null);
  // `toIssue` is client-side — the API's `status` filter is a single exact
  // value, and "to issue" (draft + approved, not yet sent) spans two of them.
  const [filter, setFilter] = useState({ status: '', q: '', joiningFrom: '', joiningTo: '', toIssue: false });
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    if (!initialFilters) return;
    setFilter((f) => ({ ...f, ...initialFilters }));
  }, [initialFilters]);

  const load = useCallback(async () => {
    setOffers(null);
    const params = new URLSearchParams();
    Object.entries(filter).forEach(([k, v]) => { if (k !== 'toIssue' && v) params.set(k, v); });
    setOffers((await api.get('/offers?' + params.toString())).offers);
  }, [filter]);
  useEffect(() => { load(); }, [load]);

  if (selected) return <OfferDetail id={selected} user={user} onBack={() => { setSelected(null); load(); }} />;

  const shown = (offers || []).filter((o) => !filter.toIssue || o.status === 'draft' || o.status === 'approved');

  return (
    <div>
      <PageHead crumb="Recruitment / Offers" title="Offers"
        sub="Offer preparation, approval, result tracking and joining date. Compensation is not shown in this list."
        actions={<Badge variant="info">Read-only list</Badge>} />
      <div className="toolbar">
        <input placeholder="Search offer no / position…" value={filter.q} onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))} style={{ minWidth: 220 }} />
        <select value={filter.status} onChange={(e) => setFilter((f) => ({ ...f, status: e.target.value }))}>
          <option value="">All statuses</option>{Object.entries(OFFER_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
        <label className="switch" title="Approved and waiting to go out — not held for approval">
          <input type="checkbox" checked={filter.toIssue} onChange={(e) => setFilter((f) => ({ ...f, toIssue: e.target.checked }))} />
          To issue
        </label>
        <label className="muted" style={{ fontSize: 12 }}>Joining from <input type="date" value={filter.joiningFrom} onChange={(e) => setFilter((f) => ({ ...f, joiningFrom: e.target.value }))} /></label>
        <div className="spacer" />
        <CountPill n={offers ? shown.length : null} total={offers ? offers.length : null} noun="offer" />
      </div>
      {!offers ? <ListSkeleton rows={5} /> : shown.length === 0 ? (
        <div className="card"><Empty icon="📑"
          title={filter.q || filter.status || filter.joiningFrom || filter.toIssue ? 'No offers match these filters' : 'No offers raised yet'}
          text={filter.q || filter.status || filter.joiningFrom || filter.toIssue
            ? 'Try clearing the search box, status filter or joining-date range.'
            : 'Offers raised from a candidate\u2019s application will appear here with approval state and joining date.'} /></div>
      ) : (
        <div className="card flush"><div className="table-wrap">
          <table className="table responsive-table">
            <thead><tr><th>Offer</th><th>Candidate</th><th>Request</th><th>Position</th><th>Project</th><th>Status</th><th>Prepared by</th><th>Approved by</th><th>Joining</th></tr></thead>
            <tbody>{shown.map((o) => (
              <tr key={o.id} className="row-link" onClick={() => setSelected(o.id)}>
                <td data-label="Offer"><span className="code-pill">{o.offerNo}</span></td>
                <td data-label="Candidate">
                  <div className="idcell">
                    <span className="idcell-av">{initials(o.candidate?.fullName || '?')}</span>
                    <span className="idcell-txt"><span className="cell-strong">{o.candidate?.fullName || '—'}</span></span>
                  </div>
                </td>
                <td data-label="Request"><span className="code-pill" title={o.request?.ticketNo}>{shortReqCode(o.request?.ticketNo)}</span></td>
                <td data-label="Position"><span className="cell-strong">{o.positionTitle || '—'}</span></td>
                <td data-label="Project" className="cell-sub-only">{o.project?.name || '—'}</td>
                <td data-label="Status"><OfferStatusBadge status={o.status} /></td>
                <td data-label="Prepared by" className="cell-sub-only">{o.preparedBy?.name || '—'}</td>
                <td data-label="Approved by" className="cell-sub-only">{o.approvedBy?.name || '—'}</td>
                <td data-label="Joining"><DateCell value={o.joiningDate} dateOnly /></td>
              </tr>
            ))}</tbody>
          </table>
        </div></div>
      )}
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
          <p className="page-sub"><strong>{o.offerNo}</strong> · <OfferStatusBadge status={o.status} /> · <span title={o.request?.ticketNo}>{shortReqCode(o.request?.ticketNo)}</span></p></div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: 520 }}>
          {btns.send_offer?.visible && ['draft','approved'].includes(s) && <button className="btn" onClick={() => act('send', {}, 'Offer sent')}>Send Offer</button>}
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
          <Info label="Request"><span title={o.request?.ticketNo}>{shortReqCode(o.request?.ticketNo)}</span> — {o.request?.title}</Info>
          <Info label="Application">{o.application?.applicationNo} · <strong>pipeline:</strong> {o.application?.status ? <AppStatusBadge status={o.application.status} /> : '—'}</Info>
          <Info label="Position">{o.positionTitle}</Info>
          <Info label="Project">{o.project?.name}</Info>
          {o.salaryVisible
            ? <Info label="Salary Offered">{o.salaryOffered != null ? `${o.salaryOffered} ${o.currency}` : '—'}</Info>
            : <Info label="Salary Offered"><span className="muted">Restricted</span></Info>}
          {o.salaryVisible && <Info label="Benefits">{o.benefits || '—'}</Info>}
          <Info label="Joining Date">{fmtDateShort(o.joiningDate)}</Info>
          <Info label="Prepared By">{o.preparedBy?.name}</Info>
          {o.rejectionReason && <Info label="Rejection Reason">{o.rejectionReason}</Info>}
          {o.withdrawalReason && <Info label="Withdrawal Reason">{o.withdrawalReason}</Info>}
          {o.notes && <Info label="Notes">{o.notes}</Info>}
        </div>
        <div className="card card-pad">
          <div className="section-title" style={{ marginTop: 0 }}>Activity</div>
          {(o.activity || []).map((a) => <div key={a.id} style={{ fontSize: 12.5, padding: '4px 0' }}><strong style={{ textTransform: 'capitalize' }}>{a.type.replace(/_/g, ' ')}</strong>{a.note ? ' — ' + a.note : ''} <span className="muted">· {a.actor_name} · {fmtDate(a.occurred_at)}</span></div>)}
        </div>
      </div>

      {action && <Confirm title={action.title} message="Provide a reason. Recorded in the audit trail." requireReason danger
        onConfirm={(r) => { const a = action; setAction(null); act(a.path, a.body(r), a.msg); }} onClose={() => setAction(null)} />}
    </div>
  );
}

/* ----------------------------- Error boundary ----------------------------- */
// The whole SPA is one file with no build step and no framework-level recovery.
// Without this, any render-time exception unmounts everything and leaves a blank
// white page with no way back. `page` mode keeps the shell chrome so the user can
// still navigate away or sign out; the default (root) mode is a full-page notice.
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) {
    try {
      console.error(JSON.stringify({ level: 'error', msg: 'react.render_error', where: this.props.label || (this.props.page ? 'page' : 'root'), error: String(err && err.message || err), stack: (info && info.componentStack || '').slice(0, 2000) }));
    } catch { /* logging must never re-throw */ }
  }
  componentDidUpdate(prev) {
    // A route change should clear a page-level error so the next screen renders.
    if (this.props.page && this.state.err && prev.resetKey !== this.props.resetKey) this.setState({ err: null });
  }
  render() {
    if (!this.state.err) return this.props.children;
    const msg = String(this.state.err && this.state.err.message || this.state.err || 'Unexpected error');
    if (this.props.page) {
      return (
        <div className="card card-pad" style={{ margin: '24px auto', maxWidth: 560 }} role="alert">
          <h3 style={{ marginTop: 0 }}>This screen ran into a problem</h3>
          <p className="muted">The rest of the app is still working — use the menu to go somewhere else, or reload.</p>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn btn-sm" onClick={() => this.setState({ err: null })}>Try again</button>
            <button className="btn btn-sm btn-secondary" onClick={() => window.location.reload()}>Reload</button>
          </div>
          <details style={{ marginTop: 14 }}><summary className="muted" style={{ fontSize: 12, cursor: 'pointer' }}>Technical detail</summary>
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11, marginTop: 8, color: 'var(--muted)' }}>{msg}</pre></details>
        </div>
      );
    }
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, fontFamily: 'Arial, Helvetica, sans-serif', color: 'var(--ink, #1A1A1A)' }} role="alert">
        <div style={{ maxWidth: 460, textAlign: 'center' }}>
          <h2 style={{ margin: '0 0 8px' }}>Something went wrong</h2>
          <p style={{ margin: '0 0 16px', color: 'var(--muted, #6F6A64)' }}>The page hit an unexpected error. Reloading usually clears it. If it keeps happening, tell your administrator.</p>
          <button className="btn" onClick={() => window.location.reload()}>Reload the app</button>
          <details style={{ marginTop: 16, textAlign: 'left' }}><summary style={{ fontSize: 12, cursor: 'pointer', color: 'var(--muted, #6F6A64)' }}>Technical detail</summary>
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11, marginTop: 8, color: 'var(--muted, #6F6A64)' }}>{msg}</pre></details>
        </div>
      </div>
    );
  }
}

/* ----------------------------- Root App ----------------------------- */
function App() {
  const [booting, setBooting] = useState(true);
  const [user, setUser] = useState(null);
  const [branding, setBranding] = useState(null);

  const loadBranding = useCallback(async () => {
    try { const { branding } = await api.get('/settings/branding'); const ver = branding.logo_uploaded_at ? new Date(branding.logo_uploaded_at).getTime() : Date.now(); setHasCustomLogo(!!branding.logo_stored_name, ver); setBranding(branding); applyBranding(branding); return branding; }
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
  // Forced rotation: the shell is not rendered at all, so no route, page or
  // background fetch can run. Mirrors the server-side gate in requireAuth.
  if (user.mustChangePassword) {
    return (
      <ForcedPasswordChange
        user={user}
        onLogout={onLogout}
        onDone={async () => {
          try { const { user: fresh } = await api.get('/auth/me'); setUser(fresh); }
          catch { setUser((u) => ({ ...u, mustChangePassword: false })); }
        }}
      />
    );
  }
  return (
    <AppCtx.Provider value={{ user }}>
      <Shell user={user} branding={branding} onLogout={onLogout} refreshBranding={loadBranding} />
    </AppCtx.Provider>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <ErrorBoundary label="root">
    <ToastProvider><App /></ToastProvider>
  </ErrorBoundary>
);
