/* Arabtec Recruitment Hub — Phase 1 SPA (React via Babel standalone).
   Single-file app: API client, auth, shell, dashboard, and admin modules.
   Permissions/buttons are resolved from the server; UI also hides what the
   user can't use, but the server is the source of truth (RBAC in logic). */
const { useState, useEffect, useCallback, useMemo, useRef, useId, createContext, useContext } = React;

/* ----------------------------- API client ----------------------------- */
const TOKEN_KEY = 'arabtec_token';
const api = {
  token: localStorage.getItem(TOKEN_KEY) || null,
  setToken(t) { this.token = t; t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); },
  async call(path, { method = 'GET', body, signal } = {}) {
    const res = await fetch('/api' + path, {
      method, signal,
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
  // An authenticated HTML document (the offer letter), returned as text so it
  // can be shown in a sandboxed frame. Errors carry the server's message.
  async html(p, { method = 'GET', body, signal } = {}) {
    const res = await fetch('/api' + p, {
      method, signal,
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) { let msg = 'Request failed'; try { msg = JSON.parse(text).error || msg; } catch {} throw Object.assign(new Error(msg), { status: res.status }); }
    return text;
  },
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
const ICON_MARKS = {
  dashboard: <><rect x="3" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" /></>,
  ticket: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M9 3v3h6V3" /><path d="M8.5 11h7M8.5 15h4.5" /></>,
  user: <><path d="M12 12a4 4 0 100-8 4 4 0 000 8z" /><path d="M4 21a8 8 0 0116 0" /></>,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M3 20a6 6 0 0112 0" /><path d="M16 5.5a3.5 3.5 0 010 5M18.5 19.5a6 6 0 00-2.5-4.9" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>,
  doc: <><path d="M13.5 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8.5z" /><path d="M13.5 3v5.5H19" /><path d="M9 13h6M9 16.5h4" /></>,
  shield: <><path d="M12 3l7 2.5v5.8c0 4.3-2.9 7.2-7 8.7-4.1-1.5-7-4.4-7-8.7V5.5z" /><path d="M9.2 11.8l2 2 3.6-3.6" /></>,
  building: <><path d="M12 3l8 4.5-8 4.5-8-4.5z" /><path d="M4 12.5l8 4.5 8-4.5" /></>,
  pin: <><path d="M12 21c-4-4.5-6-7.7-6-10.5A6 6 0 0118 10.5C18 13.3 16 16.5 12 21z" /><circle cx="12" cy="10.5" r="2.25" /></>,
  hardhat: <><path d="M3 18h18v2H3z" /><path d="M5 18v-3a7 7 0 0114 0v3" /><path d="M10 5a2 2 0 014 0v3h-4z" /></>,
  palette: <><path d="M12 3a9 9 0 100 18c1.5 0 2-1 2-2s-.5-1.5-.5-2 .5-1 1.5-1H18a3 3 0 003-3c0-4-4-7-9-7z" /><path d="M7.5 12a1 1 0 100-2 1 1 0 000 2z" /><path d="M10.5 8a1 1 0 100-2 1 1 0 000 2z" /><path d="M15 8a1 1 0 100-2 1 1 0 000 2z" /></>,
  button: <><path d="M3 9a3 3 0 013-3h12a3 3 0 013 3v6a3 3 0 01-3 3H6a3 3 0 01-3-3z" /><path d="M9 12h6" /></>,
  flow: <><rect x="9" y="3" width="6" height="5" rx="1.5" /><path d="M12 8v3.5M5 21v-3.5M12 11.5H5v2M12 11.5h7v2M19 21v-3.5" /><rect x="3" y="16" width="4" height="5" rx="1.5" /><rect x="17" y="16" width="4" height="5" rx="1.5" /></>,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M12 4v2.5M12 17.5V20M4 12h2.5M17.5 12H20M6.3 6.3l1.8 1.8M15.9 15.9l1.8 1.8M17.7 6.3l-1.8 1.8M8.1 15.9l-1.8 1.8" /></>,
  search: <><path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z" /><path d="M20 20l-4.2-4.2" /></>,
  scroll: <><path d="M5 4h11a2 2 0 012 2v12a2 2 0 002 2H8a2 2 0 01-2-2V6a2 2 0 00-2-2z" /><path d="M9 8h6" /><path d="M9 12h6" /></>,
  mail: <><path d="M4 5h16a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1z" /><path d="M3.5 6.5l8.5 6 8.5-6" /></>,
  reports: <><path d="M4 20h16" /><path d="M7 20v-6M12 20V7M17 20v-9" /></>,
  close: <><path d="m6 6 12 12M18 6 6 18" /></>,
  chevronDown: <><path d="m6 9 6 6 6-6" /></>,
  chevronUp: <><path d="m6 15 6-6 6 6" /></>,
  chevronLeft: <><path d="m15 6-6 6 6 6" /></>,
  chevronRight: <><path d="m9 6 6 6-6 6" /></>,
  // Neutral sort affordance: the same two chevrons stacked, so an unsorted
  // column shows the control exists without claiming a direction. Same 24
  // viewBox, same stroke, same <Icon> — no new icon library.
  sortNeutral: <><path d="m7 10 5-5 5 5" /><path d="m17 14-5 5-5-5" /></>,
  arrowUp: <><path d="M12 20V4m-6 6 6-6 6 6" /></>,
  arrowDown: <><path d="M12 4v16m-6-6 6 6 6-6" /></>,
  // Download: the arrow lands on a tray. Same 24 viewBox, same stroke, same
  // <Icon> as every other mark — no new icon library.
  // Review: an eye. Same 24 viewBox, same stroke, same <Icon>.
  eye: <><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" /><circle cx="12" cy="12" r="3" /></>,
  download: <><path d="M12 3v12m-5-5 5 5 5-5" /><path d="M4 20h16" /></>,
  back: <><path d="M20 12H4m6-6-6 6 6 6" /></>,
  filter: <><path d="M4 6h16M7 12h10M10 18h4" /></>,
  sidebar: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16m6-11-3 3 3 3" /></>,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  bell: <><path d="M6 9a6 6 0 0112 0v5l2 3H4l2-3z" /><path d="M10 20h4" /></>,
  alert: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5" /><path d="M12 16.2v.3" /></>,
};
function Icon({ name, size = 18, children }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }} aria-hidden="true">{children || ICON_MARKS[name]}</svg>;
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
// One date format product-wide: "1 Oct 2026, 10:00" and "1 Oct 2026". The
// browser's default locale string printed "10/1/2026, 10:00:00 AM" on some
// pages and "20 Oct 2026" on others, and month/day order depends on the
// machine (review X3).
function fmtDate(d) {
  if (!d) return '—'; const x = new Date(d); if (isNaN(x)) return '—';
  return x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    + ', ' + x.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
function fmtDateShort(d) { if (!d) return '—'; const x = new Date(d); return isNaN(x) ? '—' : x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }
// Interview type and mode as people say them ("Technical", "On site"), not
// the stored keys ("technical", "onsite") — review I2.
const IV_TYPE_LABEL = { phone: 'Phone screen', technical: 'Technical', client: 'Client', final: 'Final', hr: 'HR', reference: 'Reference' };
const IV_MODE_LABEL = { onsite: 'On site', video: 'Video', phone: 'Phone' };
const ivType = (t) => IV_TYPE_LABEL[t] || (t ? String(t).replace(/^./, (c) => c.toUpperCase()) : '—');
const ivMode = (m) => IV_MODE_LABEL[m] || (m ? String(m).replace(/^./, (c) => c.toUpperCase()) : '—');
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
  const primary = hasWhiteTextContrast(b.button_color) ? b.button_color : '#008064';
  if (primary) {
    // Keep the Control Center setting functional without letting it leak into
    // destructive/status colours. Only interactive action tokens are themed.
    r.setProperty('--button', primary);
    r.setProperty('--at-action', primary);
    r.setProperty('--at-action-hover', shadeColor(primary, -14));
    r.setProperty('--at-action-tint', colorWithAlpha(primary, .10));
    r.setProperty('--at-focus-ring', `0 0 0 3px ${colorWithAlpha(primary, .32)}`);
  }
  // Typography, geometry, neutrals and status colours belong to the design
  // system. Status colours especially: a configurable "success" that is not
  // green is not branding, it is a defect. Cleared rather than ignored, so a
  // value stored by an older build stops applying on the next load.
  for (const owned of ['--font', '--radius', '--card-radius', '--surface',
    '--text-dark', '--text-gray', '--border', '--success', '--warning', '--critical',
    '--primary', '--secondary', '--accent', '--brand', '--brand-dark',
    '--ticket-accent', '--ticket-accent-dark']) {
    r.removeProperty(owned);
  }
  // Page background (--bg) is OWNED BY THE STYLESHEET (warm off-white #f6f3ec).
  // We deliberately do NOT let branding's background_color drive it: legacy/stale
  // rows carry cool greys/whites (e.g. #f6f7f9) that made the page look grey.
  // Always clear any inline override so the stylesheet off-white wins.
  r.removeProperty('--bg');
  // Brand red, interactive green and semantic states are owned by the design
  // system. A saved tenant colour must never recolour destructive controls.
  document.title = (b.company_name || 'Arabtec Recruitment Hub');
}
function hasWhiteTextContrast(value) {
  const match = String(value || '').match(/^#([0-9a-f]{6})$/i);
  if (!match) return false;
  const channels = [0, 2, 4].map((i) => parseInt(match[1].slice(i, i + 2), 16) / 255)
    .map((v) => v <= .04045 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4));
  const luminance = .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
  return 1.05 / (luminance + .05) >= 4.5;
}
// Lighten/darken a hex color by percent (-100..100). Used to derive the action hover shade.
function shadeColor(hex, percent) {
  try {
    const h = hex.replace('#', '');
    const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    let r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16);
    const f = (v) => Math.max(0, Math.min(255, Math.round(v + (percent / 100) * 255)));
    return '#' + [f(r), f(g), f(b)].map((v) => v.toString(16).padStart(2, '0')).join('');
  } catch { return hex; }
}
function colorWithAlpha(hex, alpha) {
  try {
    const h = hex.replace('#', '');
    const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const values = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
    if (values.some(Number.isNaN)) throw new Error('Invalid color');
    return `rgba(${values.join(', ')}, ${alpha})`;
  } catch { return `rgba(0, 128, 100, ${alpha})`; }
}

/* ----------------------------- Auth context ----------------------------- */
const AppCtx = createContext(null);
const useApp = () => useContext(AppCtx);

function isSystemAdmin(user) { return !!user?.roles?.includes('system_admin'); }
function can(user, perm) {
  if (perm?.endsWith('.delete') && !isSystemAdmin(user)) return false;
  return user?.permissions?.includes(perm);
}

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
  // Location (25 Oct 2026): "Head Office", or "<site> · <area>". The API sends
  // `place` pre-built; the parts below are the fallback for older payloads.
  if (r.project?.isHeadOffice) return 'Head Office';
  if (r.place) return r.place;
  const parts = [r.project?.name, r.site?.name, r.location || r.project?.area]
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
    // A warning or error carries more to read than a confirmation.
    setToast({ msg, type }); setTimeout(() => setToast(null), type === 'success' ? 3200 : 6500);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {toast && (
        <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 200,
          background: toast.type === 'error' ? 'var(--critical)' : toast.type === 'warn' ? 'var(--warning-ink, #8a5a00)' : 'var(--success)',
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
  // "Active", "On hold": the stored key is not a label (review U2).
  const label = status ? String(status).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : '—';
  return <Badge variant={map[status] || 'soft'}>{label}</Badge>;
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

/* ONE overlay host for every dialog and drawer (2026-10-15).
   Dialogs used to render inside <main>, whose `isolation: isolate` traps any
   z-index — so the phone app bar (z 72, outside <main>) painted over a
   dialog's title and close button. Every overlay now portals into this single
   element. Its identity never changes (so React never remounts an open
   dialog), and <OverlaySlot/> moves it inside `.shell` once the shell is
   mounted, so `.shell-phone …` control sizing still reaches dialog content.
   Before sign-in it lives on <body>. */
const OVERLAY_HOST = (typeof document !== 'undefined' && document.body)
  ? (() => { const n = document.createElement('div'); n.className = 'overlay-host'; document.body.appendChild(n); return n; })()
  : null;
function toPageLevel(node) {
  return OVERLAY_HOST && typeof ReactDOM !== 'undefined' && ReactDOM.createPortal
    ? ReactDOM.createPortal(node, OVERLAY_HOST) : node;
}
function OverlaySlot() {
  const ref = useCallback((slot) => {
    if (!OVERLAY_HOST) return;
    if (slot) slot.appendChild(OVERLAY_HOST);
    else if (OVERLAY_HOST.parentNode !== document.body) document.body.appendChild(OVERLAY_HOST);
  }, []);
  return <div className="overlay-slot" ref={ref} />;
}

const DIALOG_FOCUS_SELECTOR = 'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
function dialogFocusables(dialog) {
  return dialog ? [...dialog.querySelectorAll(DIALOG_FOCUS_SELECTOR)].filter((node) => node.getClientRects().length > 0) : [];
}
function useDialogFocus(onClose) {
  const dialogRef = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    const frame = requestAnimationFrame(() => (dialogFocusables(dialog)[0] || dialog)?.focus());
    return () => {
      cancelAnimationFrame(frame);
      if (previous?.isConnected && typeof previous.focus === 'function') previous.focus();
    };
  }, []);

  const onDialogKeyDown = useCallback((e) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key !== 'Tab') return;
    const nodes = dialogFocusables(e.currentTarget);
    if (!nodes.length) { e.preventDefault(); return; }
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }, [onClose]);
  return { dialogRef, onDialogKeyDown };
}
function Modal({ title, children, onClose, footer, wide }) {
  const { dialogRef, onDialogKeyDown } = useDialogFocus(onClose);
  const titleId = useId();
  return toPageLevel(
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="modal" style={wide ? { maxWidth: 760 } : null}
        role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex="-1" onKeyDown={onDialogKeyDown}>
        <div className="modal-head"><h3 id={titleId}>{title}</h3><button type="button" className="icon-btn" aria-label="Close dialog" onClick={onClose}><Icon name="close" size={16} /></button></div>
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
/* Empty-state illustrations: 120px line drawings in the product's own
   language (a document, a search, a drawing set, a checklist), drawn on the
   faint blueprint grid that .empty paints. Neutral ink, one green accent,
   nothing cartoonish. Inline SVG, so the on-prem build depends on no image host. */
function EmptyArt({ name = 'none-yet' }) {
  const ink = '#4A4641', faint = '#C7C4BF', green = '#008064', red = '#D01827';
  const corners = <path d="M8 8h10M8 8v10M112 8h-10M112 8v10M8 112h10M8 112v-10M112 112h-10M112 112v-10" stroke={faint} strokeWidth="1.25" strokeLinecap="round" />;
  const marks = {
    'none-yet': <svg width="120" height="120" viewBox="0 0 120 120" fill="none" aria-hidden="true">
      {corners}
      <rect x="34" y="22" width="52" height="68" rx="3" stroke={ink} strokeWidth="1.5" />
      <path d="M48 22v-5h24v5" stroke={ink} strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M46 40h28M46 50h28M46 60h16" stroke={ink} strokeWidth="1.5" strokeLinecap="round" />
      <path d="M30 100h60" stroke={faint} strokeWidth="1.25" strokeDasharray="3 5" strokeLinecap="round" />
      <circle cx="86" cy="86" r="12" fill="#fff" stroke={green} strokeWidth="1.5" />
      <path d="M86 80v12M80 86h12" stroke={green} strokeWidth="1.5" strokeLinecap="round" />
    </svg>,
    'no-match': <svg width="120" height="120" viewBox="0 0 120 120" fill="none" aria-hidden="true">
      {corners}
      <path d="M24 34h72M24 50h72M24 66h72M24 82h72" stroke={faint} strokeWidth="1.25" strokeDasharray="3 5" strokeLinecap="round" />
      <circle cx="54" cy="54" r="22" fill="#fff" stroke={ink} strokeWidth="1.5" />
      <path d="M70 70l20 20" stroke={ink} strokeWidth="1.5" strokeLinecap="round" />
      <path d="M44 54h20" stroke={green} strokeWidth="1.5" strokeLinecap="round" />
    </svg>,
    'failed': <svg width="120" height="120" viewBox="0 0 120 120" fill="none" aria-hidden="true">
      <path d="M8 8h10M8 8v10M112 8h-10M112 8v10M8 112h10M8 112v-10M112 112h-10M112 112v-10" stroke="#E7B9BF" strokeWidth="1.25" strokeLinecap="round" />
      <rect x="22" y="40" width="32" height="40" rx="3" stroke={red} strokeWidth="1.5" />
      <rect x="66" y="40" width="32" height="40" rx="3" stroke={red} strokeWidth="1.5" />
      <path d="M54 60h4M62 60h4" stroke={red} strokeWidth="1.5" strokeLinecap="round" />
      <path d="M60 50v5M60 65v5" stroke={red} strokeWidth="1.5" strokeLinecap="round" />
      <path d="M30 52h12M30 62h12M74 52h12M74 62h12" stroke="#E7B9BF" strokeWidth="1.5" strokeLinecap="round" />
    </svg>,
    'all-clear': <svg width="120" height="120" viewBox="0 0 120 120" fill="none" aria-hidden="true">
      <path d="M8 8h10M8 8v10M112 8h-10M112 8v10M8 112h10M8 112v-10M112 112h-10M112 112v-10" stroke="#B7DCD3" strokeWidth="1.25" strokeLinecap="round" />
      <rect x="30" y="30" width="60" height="60" rx="3" stroke="#00664F" strokeWidth="1.5" />
      <path d="M44 60l11 11L78 48" stroke={green} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M30 100h60" stroke="#B7DCD3" strokeWidth="1.25" strokeDasharray="3 5" strokeLinecap="round" />
    </svg>,
    'drawing': <svg width="120" height="120" viewBox="0 0 120 120" fill="none" aria-hidden="true">
      {corners}
      <path d="M26 92V44l34-20 34 20v48" stroke={ink} strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M26 92h68M42 92V64h36v28" stroke={ink} strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M60 24v20M26 44h68" stroke={faint} strokeWidth="1.25" strokeDasharray="3 5" />
      <path d="M52 92V76h16v16" stroke={green} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>,
  };
  return marks[name] || marks['none-yet'];
}
/* The one word that says what kind of nothing this is, with its emoji — the
   secondary line the emoji policy allows. Shown only with a titled state. */
const EMPTY_KICKER = { 'none-yet': ['inbox', 'Nothing here yet'], 'no-match': ['search', 'No matches'], 'failed': ['attention', 'Needs attention'], 'all-clear': ['check', 'All clear'], 'drawing': ['build', 'Nothing planned yet'] };
function Empty({ art, text, title, action, tone = 'neutral' }) {
  const mark = tone === 'error' ? 'failed' : (art || 'none-yet');
  const kicker = EMPTY_KICKER[mark] || EMPTY_KICKER['none-yet'];
  return <div className={'empty empty-' + tone} role={tone === 'error' ? 'alert' : undefined}>
    <div className="ico" aria-hidden="true"><EmptyArt name={mark} /></div>
    {title && <div className="empty-kicker">{kicker[1]}</div>}
    {title && <h4 className="empty-title">{title}</h4>}<p>{text}</p>
    {action && <div className="empty-action">{action}</div>}
  </div>;
}
function ModulePreview({ title }) {
  return <section><PageHead title={title} sub="Work in progress" />
    <div className="card"><Empty title="This section is being prepared"
      text="The page is not available in this version yet. Please try again after the next update."
      action={<button className="btn" onClick={() => window.location.reload()}>Reload page</button>} /></div></section>;
}
function LoadError({ text, onRetry, title = 'Could not load this page' }) {
  return <div className="card"><Empty tone="error" title={title} text={text}
    action={<button className="btn" onClick={onRetry}>Retry</button>} /></div>;
}
// A refresh that failed while usable rows are still on screen. `LoadError`
// replaces the page, which is right on a first load and wrong on a refetch —
// it throws away content that is still perfectly readable, just not current.
// This reports the failure above that content and leaves it in place.
function RefetchError({ text, onRetry }) {
  return <div className="refetch-error" role="status">
    <Icon name="alert" size={16} />
    <span>{text || 'Could not refresh. Showing the last loaded results.'}</span>
    {onRetry && <button className="btn btn-ghost btn-sm" onClick={onRetry}>Retry</button>}
  </div>;
}
function Skeleton({ rows = 6, shape = 'detail' }) {
  if (shape === 'dashboard') return <DashboardSkeleton />;
  if (shape === 'list') return <div className="card flush list-skel" role="status" aria-label="Loading list" aria-busy="true">
    <div className="list-skel-head" />{Array.from({ length: rows }).map((_, i) => <div className="list-skel-row" key={i}>
      <div className="skeleton" style={{ width: 70 }} /><div className="skeleton" style={{ flex: 1, maxWidth: 260 }} />
      <div className="skeleton" style={{ width: 110 }} /><div className="skeleton" style={{ width: 76 }} />
    </div>)}</div>;
  return <div className="card-pad" role="status" aria-label="Loading details" aria-busy="true">{Array.from({ length: rows }).map((_, i) => <div key={i} className="skeleton" style={{ width: Math.max(25, 90 - i * 8) + '%' }} />)}</div>;
}
// Shared with the separately loaded modules; read at render time, after app.jsx ran.
window.ARABTEC_UI = { Empty, LoadError, Skeleton, Icon, CvFilePreview, useCvDocument };

/* One short, attributed line at the foot of every page — a fact or a piece of
   thinking from leadership, psychology, science or building, drawn from the
   curated list in knowledge-lines.js. Re-drawn on every route change, never
   inside the working area, never louder than the page. Renders nothing when
   the list is absent, so a missing script can never break a page. */
function pickKnowledgeLine(seed) {
  // The owner's list (Control Center → Knowledge lines) wins when it is saved
  // and non-empty; otherwise the bundled file.
  const own = window.ARABTEC_KNOWLEDGE_LINES_OWN;
  const lines = Array.isArray(own) && own.length ? own : window.ARABTEC_KNOWLEDGE_LINES;
  if (!Array.isArray(lines) || !lines.length) return null;
  const n = seed == null ? Math.floor(Math.random() * lines.length) : Math.abs(seed) % lines.length;
  return lines[n] || null;
}
/* Emoji policy (docs/audits/ui-rules.md, R10): emoji appear only through this
   map, and only in a Hint or the knowledge line — never in a button, a title,
   a badge, a table cell or a notification. One per element, leading it. */
const EMOJI = {
  hint: '💡', focus: '🎯', lock: '🔏', clock: '⏱️', check: '✅', calendar: '📅', people: '👥', chart: '📊', inbox: '📭', search: '🔍', attention: '📌', build: '🏗️',
  leadership: '🧭', teams: '🤝', psychology: '🧠', science: '🔬', engineering: '🏗️', wisdom: '🌿', history: '📜',
};
/* One fact the product can vouch for, beside or under the work: what a rule
   does, where a switch lives, what a number means. Never an opinion. */
function Hint({ emoji = 'hint', children, action }) {
  return <aside className="hint" role="note">
    <span className="hint-text">{children}</span>
    {action && <span className="hint-action">{action}</span>}
  </aside>;
}
/* `Quote — Author` per line, optional `— topic`. Mirrors
   backend/src/lib/knowledge-lines.js, which enforces the same rules on save. */
function parseKnowledgeText(text) {
  const lines = []; const errors = []; const seen = new Set();
  String(text || '').split(/\r?\n/).forEach((raw, i) => {
    const row = raw.trim();
    if (!row) return;
    const parts = row.split(/\s+[—–]\s+/);
    const q = (parts[0] || '').trim(), by = (parts[1] || '').trim(), t = (parts[2] || '').trim().toLowerCase();
    if (!by) { errors.push(`Line ${i + 1}: add the author after an em dash ( — ).`); return; }
    if (q.length < 3) { errors.push(`Line ${i + 1}: the quote is empty.`); return; }
    if (q.length > 160) { errors.push(`Line ${i + 1}: the quote is ${q.length} characters; keep it to 160.`); return; }
    if (seen.has(q.toLowerCase())) { errors.push(`Line ${i + 1}: this quote is already on the list.`); return; }
    seen.add(q.toLowerCase());
    lines.push(t ? { q, by, t } : { q, by });
  });
  return { lines, errors };
}
function applyOwnKnowledgeLines(text) {
  window.ARABTEC_KNOWLEDGE_LINES_OWN = parseKnowledgeText(text).lines;
}
function knowledgeLinesAsText(lines) {
  return (lines || []).map((l) => `${l.q} — ${l.by}${l.t ? ' — ' + l.t : ''}`).join('\n');
}
function KnowledgeLine({ seed }) {
  const line = useMemo(() => pickKnowledgeLine(seed), [seed]);
  if (!line) return null;
  return <footer className="knowledge-line" aria-label="A line worth keeping">
    <span className="kl-dash" aria-hidden="true" />
    <span className="kl-quote">{line.q}</span>
    <span className="kl-by">{line.by}</span>
  </footer>;
}

/* ----------------------------- Login ----------------------------- */
// Sign-in — calm and corporate, in the system's own colours: the light grey
// canvas used inside the app, one white bordered card for the form, and the
// Arabtec signature (red dash, heavy display heading with a red full stop, a
// faint logo watermark). Real markup throughout, so nothing is cropped at any
// width; the phone gets the same design stacked. Sign-in behaviour is unchanged.
function Login({ branding, onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(null);

  async function submit(e) {
    e.preventDefault(); setErr(null); setForgot(null); setBusy(true);
    try {
      const { token, user, mustChangePassword } = await api.post('/auth/login', { email, password, remember });
      // Keep the flag on the object the app renders from, so the forced-rotation
      // screen engages immediately rather than after the next /auth/me.
      api.setToken(token); onLogin({ ...user, mustChangePassword: !!mustChangePassword });
    } catch (e) { setErr(e.message || 'Sign-in failed. Please try again.'); } finally { setBusy(false); }
  }
  // Self-service reset is not available yet: the request is still recorded for
  // the administrator, and the user is told plainly who can help.
  async function doForgot() {
    setErr(null);
    try { await api.post('/auth/forgot-password', { email }); } catch { /* the message below stands either way */ }
    setForgot('Password resets are handled by your system administrator. Please contact them to reset your password.');
  }
  const trackCaps = (e) => { if (e.getModifierState) setCapsLock(e.getModifierState('CapsLock')); };
  // The admin-set company name (Branding) heads the panel; the product name is fixed.
  const company = branding?.company_name || 'Arabtec';
  const year = new Date().getFullYear();
  return (
    <div className="signin">
      <header className="signin-header"><Logo size={36} withText textColor="var(--ink)" /></header>

      <main className="signin-main" id="main-content">
        <section className="signin-intro" aria-labelledby="signin-title">
          <p className="signin-eyebrow"><span className="signin-dash" aria-hidden="true" />Human Resources</p>
          <h1 id="signin-title" className="signin-title">Recruitment Hub<span className="signin-stop" aria-hidden="true">.</span></h1>
          <p className="signin-lede">Hiring requests, candidates, interviews and offers for {company}, in one place.</p>
        </section>

        <form className="signin-card" onSubmit={submit} aria-labelledby="signin-heading">
          <h2 id="signin-heading" className="signin-heading">Sign in</h2>
          <p className="signin-sub">Use your {company} work account.</p>
          {err && <div className="error-banner" role="alert">{err}</div>}
          {forgot && <div className="signin-info" role="status">{forgot}</div>}

          <div className="field">
            <label htmlFor="signin-email">Work email</label>
            <input id="signin-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="name@arabtec.com" autoComplete="username" autoFocus required />
          </div>
          <div className="field">
            <label htmlFor="signin-password">Password</label>
            <div className="signin-password">
              <input id="signin-password" type={showPassword ? 'text' : 'password'} value={password}
                onChange={(e) => setPassword(e.target.value)} onKeyUp={trackCaps} onKeyDown={trackCaps}
                placeholder="Enter your password" autoComplete="current-password" required
                aria-describedby={capsLock ? 'signin-caps' : undefined} />
              <button type="button" className="signin-reveal" onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} aria-controls="signin-password">
                {showPassword
                  ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 3l18 18" /><path d="M10.6 6.1A10.9 10.9 0 0 1 12 6c6.5 0 10 6 10 6a17.6 17.6 0 0 1-3.2 3.9" /><path d="M6.6 6.6C3.8 8.4 2 12 2 12s3.5 6 10 6a10.6 10.6 0 0 0 5.4-1.4" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg>
                  : <Icon name="eye" size={16} />}
              </button>
            </div>
            {capsLock && <p id="signin-caps" className="signin-hint" role="status">Caps Lock is on.</p>}
          </div>

          <div className="signin-row">
            <label className="checkbox" htmlFor="signin-remember">
              <input id="signin-remember" type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Keep me signed in
            </label>
            <button type="button" className="signin-link" onClick={doForgot}>Forgot password?</button>
          </div>

          <button type="submit" className="btn btn-block signin-submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
      </main>

      <footer className="signin-footer">
        <span>© {year} Arabtec Construction. All rights reserved.</span>
        <span>Trouble signing in? Contact your system administrator.</span>
      </footer>
      {!HAS_CUSTOM_LOGO && <img className="signin-watermark" src="/arabtec-logo.svg" alt="" aria-hidden="true" />}
    </div>
  );
}

/* Who sees the whole Talent Pool and the CV review queue. Mirrors
   backend/src/lib/candidate-scope.js (AR-01); a courtesy so scoped roles are not
   offered a page the server refuses — the server is what enforces it. */
const BROAD_CANDIDATE_PERMS = ['request.view_all', 'interview.view_all', 'candidate.add'];
function hasBroadCandidateAccess(user) { return BROAD_CANDIDATE_PERMS.some((p) => can(user, p)); }
function hasFullPipelineAccess(user) {
  return (user?.roles || []).some((r) => ['system_admin', 'ceo', 'hr_director', 'recruitment_manager', 'recruiter'].includes(r));
}
const pipelineOrderFor = (user) => hasFullPipelineAccess(user) ? APP_ORDER : APP_ORDER.filter((s) => s !== 'sourced');

/* ----------------------------- Navigation config ----------------------------- */
const NAV = [
  /* Order follows the approved internal UI reference (§02): Workspace first,
     Administration second. Route keys and permissions are unchanged. */
  { section: 'Workspace' },
  { key: 'dashboard', label: 'Dashboard', icon: 'dashboard', perm: 'dashboard.view' },
  { key: 'requests', label: 'Hiring Requests', icon: 'ticket', anyPerm: ['request.view_all', 'request.view_own'] },
  { key: 'candidates', label: 'Talent Pool', icon: 'user', perm: 'candidate.view' },
  { key: 'candidateReview', label: 'Candidate Review', icon: 'shield', perm: 'candidate.view', broadCandidates: true },
  /* Hidden unless an administrator granted this user cv_intake.view. Hiding is
     a courtesy — routes/cv-intake.js enforces the same permission server-side,
     which is what a direct API call meets. */
  { key: 'cvIntake', label: 'CV Inbox', icon: 'mail', perm: 'cv_intake.view' },
  { key: 'interviews', label: 'Interviews', icon: 'calendar', anyPerm: ['interview.view_all', 'interview.view_assigned'] },
  { key: 'offers', label: 'Offers', icon: 'doc', perm: 'offer.view' },
  { key: 'orgStructure', label: 'Organization Structure', icon: 'building', perm: null },
  { key: 'reports', label: 'Reports', icon: 'scroll', perm: 'dashboard.view' },
  { section: 'Administration' },
  { key: 'locations', label: 'Locations', icon: 'pin', perm: 'location.manage' },
  { key: 'projects', label: 'Projects', icon: 'hardhat', perm: 'org.manage' },
  { key: 'sites', label: 'Sites', icon: 'pin', perm: 'org.manage' },
  { key: 'departments', label: 'Departments', icon: 'building', perm: 'org.manage' },
  { key: 'notifications', label: 'Notification Settings', icon: 'bell', perm: 'notification.manage' },
  { key: 'assessmentPolicy', label: 'Assessment Settings', icon: 'doc', perm: 'interview.assessment_policy' },
  { key: 'users', label: 'Users', icon: 'users', perm: 'user.manage' },
  { key: 'roles', label: 'Roles & Permissions', icon: 'shield', perm: 'role.manage' },
  { key: 'control', label: 'Control Center', icon: 'gear', perm: 'app.manage_ui' },
  { key: 'branding', label: 'Branding Settings', icon: 'palette', perm: 'branding.manage' },
  { key: 'buttons', label: 'Button Settings', icon: 'button', perm: 'button.manage' },
  { key: 'workflow', label: 'Workflow Settings', icon: 'flow', perm: 'workflow.manage' },
  { key: 'microsoft', label: 'Microsoft 365', icon: 'mail', perm: 'system.manage' },
  { key: 'email', label: 'Email & Mailbox', icon: 'mail', perm: 'system.manage' },
  { key: 'system', label: 'System Settings', icon: 'gear', perm: 'system.manage' },
  { key: 'audit', label: 'Audit Log', icon: 'scroll', perm: 'audit.view' },
];

function confirmPageExit() {
  return window.dispatchEvent(new Event('ats:before-navigate', { cancelable: true }));
}
const MOBILE_NAV = {
  interviewer: ['dashboard', 'interviews', 'requests', 'candidates'],
  executive: ['dashboard', 'reports', 'requests', 'offers'],
  director: ['dashboard', 'requests', 'offers', 'reports'],
  manager: ['dashboard', 'requests', 'candidates', 'interviews'],
  recruiter: ['dashboard', 'requests', 'candidates', 'interviews'],
};
function mobileNavItems(items, persona) {
  return (MOBILE_NAV[persona] || MOBILE_NAV.recruiter).map(key => items.find(n => n.key === key)).filter(Boolean);
}
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
      can(user, 'candidate.view') && hasBroadCandidateAccess(user) ? api.get('/candidates/intakes').catch(() => null) : Promise.resolve(null),
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
  if (key === 'interviews') return d.kpis?.upcomingInterviews || null;
  if (key === 'offers') {
    const n = (d.offersByStatus || []).filter((o) => o.status === 'pending_approval').reduce((s, o) => s + o.count, 0);
    return n || null;
  }
  if (key === 'requests') return d.kpis?.openRequests || null;
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

   ANYHELP — bounded conversation at POST /api/ai/chat. The server resolves the
     authenticated user's permissions and exposes read-only record tools.
     Messages and source labels render as text; conversation is held only in
     this component and resets on user change. Stop/unmount cancels the request.
   ========================================================================= */
const ANYHELP_TEAM_NOTE = 'Team chat is the hiring-request conversation. It is stored on the request, so what is said here stays on the record.';
const ANYHELP_AI_NOTE = 'Ask in English or Arabic about records you can access, or draft a message. anyhelp cannot change records, send messages, or approve actions.';

function anyhelpTime(iso) {
  const d = iso ? new Date(iso) : new Date();
  return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/* The assistant's single transport returns server text and retrieved sources. */
async function anyhelpAsk(text, { requestId, history, signal }) {
  const answer = await api.call('/ai/chat', {
    method: 'POST', signal,
    body: { message: text, history, contextRequestId: requestId || null },
  });
  return { role: 'Assistant', kind: 'ai', text: answer.text, sources: answer.sources || [] };
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
  const aiController = useRef(null);
  const aiEpoch = useRef(0);
  useEffect(() => {
    aiEpoch.current++;
    aiController.current?.abort();
    aiController.current = null;
    setAiLog([]); setDraft(''); setStatus('idle');
    return () => { aiEpoch.current++; aiController.current?.abort(); };
  }, [user.id]);
  // Team chat is per hiring request. When the page is not a request, the user
  // picks one from the requests they can already see — no new visibility.
  const [pickable, setPickable] = useState(null);
  const [pickedId, setPickedId] = useState(null);

  const threadRef = useRef(null);
  const dockRef = useRef(null);
  const fabRef = useRef(null);

  /* The launcher is fixed over the bottom-right 46px of the content column, so
     whatever scrolls under it loses part of its click area — measured at the
     desktop gate on Talent Pool, CV Intake, Users and Audit Log, and on the
     dashboard before its two lists got an explicit lane. Reserving a lane on
     every list that right-aligns an action does not generalise: any control
     can end up under a fixed element at some scroll offset.
     So the launcher yields instead. While the page is scrolling — which is
     exactly when you are travelling to the row you want — it fades and stops
     taking pointer events, then comes back shortly after you stop. Nothing
     moves, no page gives up width, and the control underneath is reachable
     during the gesture that brings it into view. */
  const [scrolling, setScrolling] = useState(false);
  useEffect(() => {
    let timer = null;
    const onScroll = () => {
      setScrolling(true);
      clearTimeout(timer);
      timer = setTimeout(() => setScrolling(false), 450);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('scroll', onScroll); clearTimeout(timer); };
  }, []);
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
    if (aiController.current) return;
    const controller = new AbortController();
    aiController.current = controller;
    const epoch = aiEpoch.current;
    let budget = 6000;
    const history = [];
    for (const entry of aiLog.filter(m => m.kind === 'mine' || m.kind === 'ai').slice(-8).reverse()) {
      const content = entry.text.slice(0, 2000);
      if (content.length > budget) break;
      history.unshift({ role: entry.kind === 'mine' ? 'user' : 'assistant', content });
      budget -= content.length;
    }
    setAiLog((l) => [...l.slice(-39), { who: user.fullName, role: 'You', time: anyhelpTime(), text, kind: 'mine' }]);
    setDraft('');
    setStatus('thinking');
    try {
      const answer = await anyhelpAsk(text, { requestId: contextRequestId, history, signal: controller.signal });
      if (epoch !== aiEpoch.current || controller.signal.aborted) return;
      setAiLog((l) => [...l.slice(-39), { who: 'anyhelp', time: anyhelpTime(), ...answer }]);
      setStatus('idle');
    } catch (e) {
      if (epoch !== aiEpoch.current || controller.signal.aborted) return;
      setAiLog((l) => [...l, { who: 'anyhelp', role: 'Failed', kind: 'failed', time: anyhelpTime(), text: serverReason(e) }]);
      setDraft(text);
      setStatus('failed');
    } finally {
      if (aiController.current === controller) aiController.current = null;
    }
  }

  function stopAnyhelp(clear = false) {
    aiEpoch.current++;
    aiController.current?.abort();
    aiController.current = null;
    setStatus('idle');
    if (clear) { setAiLog([]); setDraft(''); }
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
      <button ref={fabRef} type="button"
        className={'anyhelp-fab' + (open ? ' is-open' : '') + (scrolling && !open ? ' is-yielding' : '')}
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
          {tab === 'anyhelp' && <div className="btn-row" style={{ padding: '8px 14px' }}>
            <button type="button" className="btn btn-sm" disabled={!aiLog.length} onClick={() => stopAnyhelp(true)}>New conversation</button>
            {status === 'thinking' && <button type="button" className="btn btn-sm" onClick={() => stopAnyhelp()}>Stop</button>}
          </div>}

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
                  Ask in English or Arabic — search candidates, summarize a hiring request, or draft a message.
                  {contextRequestId ? ' The current hiring request provides context.' : ''}
                </div>
                : aiLog.map((m, i) => (
                  <article key={i} className={'anyhelp-msg ' + (m.kind === 'mine' ? 'mine' : m.kind === 'ai' ? 'ai' : m.kind)}>
                    <div className="anyhelp-who"><b>{m.who}</b><span>{m.role} · {m.time}</span></div>
                    <p>{m.text}</p>
                    {m.sources && m.sources.length > 0 && <ul className="anyhelp-results">
                      {m.sources.map((s) => <li key={s.type + ':' + s.id}><small>{s.label} [{s.type}:{s.id}]</small></li>)}
                    </ul>}
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
            {status === 'thinking' && <div className="anyhelp-status" aria-live="polite">anyhelp is preparing your answer…</div>}
            {status === 'sending' && <div className="anyhelp-status" aria-live="polite">Sending…</div>}
            {tab === 'team' && status === 'failed' && thread.error && (
              <div className="anyhelp-status failed" aria-live="assertive">Not sent — {thread.error}</div>
            )}
          </div>

          <form className="anyhelp-composer" onSubmit={submit}>
            <label className="sr-only" htmlFor="anyhelp-input">Message anyhelp</label>
            <textarea id="anyhelp-input" rows="2" value={draft} onChange={(e) => setDraft(e.target.value)}
              maxLength={tab === 'anyhelp' ? 4000 : undefined}
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

/* ============================ MOBILE TEMPLATE ============================
   A dedicated phone presentation, not a reflowed desktop one. It renders
   INSTEAD of the desktop shell — never alongside it — so there is exactly one
   set of interactive controls in the DOM: no duplicate focus targets, no
   duplicate ids, no second copy of a menu to keep in sync.

   Everything it shows comes from the same props the desktop shell already
   has: the same permission-filtered nav list, the same `go()`, the same work
   counts, the same user and branding. The phone chrome owns no data and issues
   no request of its own; see the note in `Shell` for what a live resize across
   the breakpoint does cost.

   Arabtec identity is unchanged: the same Logo, the same tokens, the same
   type. The composition is what is phone-specific.
   ====================================================================== */
function useIsPhone(query = '(max-width: 900px)') {
  const get = () => (typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false);
  const [isPhone, setIsPhone] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(query);
    const onChange = (e) => setIsPhone(e.matches);
    setIsPhone(mq.matches);
    // Safari < 14 only has the deprecated listener pair.
    if (mq.addEventListener) { mq.addEventListener('change', onChange); return () => mq.removeEventListener('change', onChange); }
    mq.addListener(onChange); return () => mq.removeListener(onChange);
  }, [query]);
  return isPhone;
}
// Modules loaded as separate scripts (org-structure.jsx) switch layout on the
// same breakpoint as the shell, so they read this hook rather than a copy.
window.ArabtecUseIsPhone = useIsPhone;

/* The drawer owns focus while it is open: Escape closes it, focus moves in on
   open and returns to the trigger on close, and nothing behind it is
   reachable. When closed it is not rendered at all, which is the strongest
   form of "the inactive presentation is not focusable". */
function MobileDrawer({ open, onClose, nav, route, counts, onGo, user, roleCode, branding, onLogout, onChangePassword }) {
  const panelRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const first = panelRef.current && panelRef.current.querySelector('button, a[href]');
    if (first) first.focus();
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const items = [...panelRef.current.querySelectorAll('button, a[href], input, select, textarea')]
        .filter((el) => !el.disabled && el.offsetParent !== null);
      if (!items.length) return;
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="mdrawer-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="mdrawer" ref={panelRef} role="dialog" aria-modal="true" aria-label="Navigation">
        <div className="mdrawer-head">
          <span className="side-mark"><Logo size={30} /></span>
          <span className="side-txt">
            <strong>{branding?.app_name || 'Arabtec'}</strong>
            <span>Recruitment Hub</span>
          </span>
          <button className="icon-btn mdrawer-close" onClick={onClose} aria-label="Close navigation">
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className="mdrawer-who">
          <span className="avatar">{initials(user.fullName)}</span>
          <span className="mdrawer-who-txt">
            <strong>{user.fullName}</strong>
            <span>{ROLE_NAMES[roleCode] || roleCode}</span>
          </span>
        </div>

        <nav className="mdrawer-nav" aria-label="Sections">
          {nav.map((n, i) => {
            if (n.section) return <div key={'s' + i} className="mdrawer-section">{n.section}</div>;
            const c = navCount(n.key, counts);
            return (
              <button key={n.key} className={'mdrawer-item' + (route === n.key ? ' active' : '')}
                onClick={() => onGo(n.key)} aria-current={route === n.key ? 'page' : undefined}>
                <span className="mdrawer-ico"><Icon name={n.icon} size={18} /></span>
                <span className="mdrawer-label">{n.label}</span>
                {c ? <span className="nav-count">{c}</span> : null}
              </button>
            );
          })}
        </nav>

        <div className="mdrawer-foot">
          <button className="mdrawer-foot-btn" onClick={onChangePassword}>
            <Icon name="shield" size={16} /> Change password
          </button>
          <button className="mdrawer-foot-btn" onClick={onLogout}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" /></svg>
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

/* Compact application bar: who/where, then the two things a recruiter reaches
   for on a phone (search and notifications). The page's own title lives in the
   page header below it, not here, so the bar stays one line at 360px. */
function MobileAppBar({ title, onMenu, onSearch, onGo }) {
  return (
    <header className="mtopbar">
      <button className="mtopbar-btn" onClick={onMenu} aria-label="Open navigation">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
      </button>
      <span className="mtopbar-title">{title}</span>
      <button className="mtopbar-btn" onClick={onSearch} aria-label="Search candidates">
        <Icon name="search" size={18} />
      </button>
      <NotificationBell onNavigate={onGo} />
    </header>
  );
}

/* Bottom tab bar: the sections this persona actually works in, one tap each.
   "More" opens the drawer rather than a second sheet, so there is one menu on
   a phone, not two lists of the same links that can disagree. */
function MobileTabBar({ items, route, counts, onGo, onMore, moreOpen }) {
  const SHORT = { dashboard: 'Home', candidates: 'Talent', requests: 'Requests', candidateReview: 'Review', interviews: 'Interviews', offers: 'Offers', cvIntake: 'CV Inbox' };
  return (
    <nav className="mtabbar" aria-label="Primary">
      {items.map((n) => {
        const c = navCount(n.key, counts);
        return (
          <button key={n.key} className={'mtab' + (route === n.key ? ' active' : '')}
            onClick={() => onGo(n.key)} aria-current={route === n.key ? 'page' : undefined}>
            <span className="mtab-ico">
              <Icon name={n.icon} size={20} />
              {c ? <span className="mtab-dot" aria-hidden="true" /> : null}
            </span>
            <span className="mtab-label">{SHORT[n.key] || n.label}</span>
          </button>
        );
      })}
      <button className={'mtab' + (moreOpen ? ' active' : '')} onClick={onMore} aria-expanded={moreOpen} aria-label="More sections">
        <span className="mtab-ico">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
        </span>
        <span className="mtab-label">More</span>
      </button>
    </nav>
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
  const [mobileNavOpen, setMobileNavOpen] = useState(false);   // the phone drawer
  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const density = branding?.table_density || 'comfortable';
  const [counts] = useWorkCounts(user);
  // Drives which presentation renders. One boolean, one source of truth.
  const isPhone = useIsPhone();
  const persona = personaFor(user);
  const roleCode = primaryRole(user);

  // Cross-module navigation. The CV Inbox ships as its own script and has no
  // access to `go`, so it asks for a route by event rather than reaching into
  // the shell — the same shape as `ats:open-request` and `ats:open-candidate`.
  useEffect(() => {
    const onNavigate = (e) => { const key = e.detail?.route; if (key) go(key); };
    window.addEventListener('ats:navigate', onNavigate);
    return () => window.removeEventListener('ats:navigate', onNavigate);
  });

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
    if (!confirmPageExit()) return false;
    setRoute(r); setRouteParams(params); setMobileNavOpen(false);
  }, []);

  // Accept OAuth deep links and in-app settings links through the same guarded
  // navigation path. Clear recognized hashes so a refresh cannot replay a banner.
  useEffect(() => {
    const followHash = () => {
      const raw = String(window.location.hash || '').replace(/^#/, '');
      const [path, query] = raw.split('?');
      // `#requests/12` opens one record (review R9). The id is handed over the
      // same way the Ctrl+K palette hands a candidate: a pending id for a page
      // that mounts fresh, an event for one already on screen.
      const [key, recId] = path.split('/');
      if (!key || !NAV.some((n) => n.key === key)) return;
      const params = Object.fromEntries(new URLSearchParams(query || ''));
      const id = /^\d+$/.test(recId || '') ? Number(recId) : null;
      if (id && key === 'interviews') params.openId = id;
      if (id && RECORD_OPENERS[key]) window[RECORD_OPENERS[key].pending] = id;
      go(key, Object.keys(params).length ? params : null);
      if (id && RECORD_OPENERS[key]) window.dispatchEvent(new CustomEvent(RECORD_OPENERS[key].event, { detail: { id } }));
      // Keep a record link in the address bar; the page rewrites it on close.
      if (!id) window.history.replaceState(null, '', window.location.pathname + window.location.search);
    };
    followHash();
    window.addEventListener('hashchange', followHash);
    return () => window.removeEventListener('hashchange', followHash);
  }, [go]);

  // Branding, buttons and notifications each had two homes: a Control Center
  // tab and a page of their own. Whoever can open the Control Center manages
  // them there, so the duplicate menu entries are hidden for them; the routes
  // stay, and a user without Control Center keeps their own entry (review C1).
  const IN_CONTROL_CENTER = ['branding', 'buttons', 'notifications'];
  const hasControl = can(user, 'app.manage_ui');
  const allowedNav = NAV.filter((n) => n.section || (
    !(hasControl && IN_CONTROL_CENTER.includes(n.key))
    && (!n.broadCandidates || hasBroadCandidateAccess(user))
    && (n.anyPerm ? n.anyPerm.some((p) => can(user, p)) : (!n.perm || can(user, n.perm)))));
  // A section header with nothing under it (a hiring manager's "Administration")
  // is dropped rather than drawn empty (walkthrough 25 Oct 2026).
  const visibleNav = allowedNav.filter((n, i) => !n.section || (allowedNav[i + 1] && !allowedNav[i + 1].section));
  const navItems = visibleNav.filter((n) => !n.section);
  // Five-item bottom bar: the four most-used sections this role can reach, plus More.
  const primaryMobile = mobileNavItems(navItems, persona);

  const OrgStructurePage = window.ArabtecOrgStructurePage;
  const CandidateReviewPage = window.ArabtecCandidateIntakeReviewPage;
  const EmailSettingsPage = window.ArabtecEmailSettingsPage;
  const CvIntakePage = window.ArabtecCvIntakePage;
  // One guard for every route, using the same rule as the menu. Typed or
  // bookmarked links (#control, #audit, #roles…) must not render a page the
  // menu hides; the server already refuses the data, this stops the empty
  // shell and its 403 errors.
  const routeDef = NAV.find((n) => n.key === route);
  const routeAllowed = !routeDef || (
    (!routeDef.broadCandidates || hasBroadCandidateAccess(user))
    && (routeDef.anyPerm ? routeDef.anyPerm.some((p) => can(user, p)) : (!routeDef.perm || can(user, routeDef.perm))));
  const RoutePage = {
    dashboard: <Dashboard user={user} onNavigate={go} dash={counts.dash} intakes={counts.intakes} />,
    reports: <ReportsPage user={user} />,
    requests: <RequestsPage user={user} initialFilters={route === 'requests' ? routeParams : null} />,
    candidates: <CandidatesPage user={user} onNavigate={go} initialFilters={route === 'candidates' ? routeParams : null} />,
    candidateReview: CandidateReviewPage ? <CandidateReviewPage user={user} /> : <LoadError text="Candidate Review module failed to load." onRetry={() => window.location.reload()} />,
    interviews: <InterviewsPage user={user} initialFilters={route === 'interviews' ? routeParams : null} />,
    cvIntake: can(user, 'cv_intake.view')
      ? (CvIntakePage
        ? <CvIntakePage user={user} PageHead={PageHead} Empty={Empty} Skeleton={Skeleton} Icon={Icon} Badge={Badge} />
        : <LoadError text="CV Intake module failed to load." onRetry={() => window.location.reload()} />)
      : <Forbidden what="CV Inbox" need="CV intake access, granted per user by a System Admin" />,
    orgStructure: OrgStructurePage ? <OrgStructurePage user={user} /> : <ModulePreview title="Organization Structure" />,
    offers: <OffersPage user={user} initialFilters={route === 'offers' ? routeParams : null} />,
    users: can(user, 'user.manage')
      ? <UsersPage user={user} />
      : <Forbidden what="User Management" need="System Admin" />,
    roles: <RolesPage user={user} />,
    locations: <LocationsPage user={user} />,
    projects: <ProjectsPage user={user} />,
    sites: <SitesPage user={user} />,
    departments: <DepartmentsPage user={user} />,
    control: <ControlCenterPage user={user} branding={branding} refreshBranding={refreshBranding} />,
    branding: <BrandingPage user={user} branding={branding} refreshBranding={refreshBranding} />,
    buttons: <ButtonsPage user={user} />,
    workflow: <WorkflowPage user={user} />,
    microsoft: can(user, 'system.manage')
      ? <MicrosoftPage user={user} params={route === 'microsoft' ? routeParams : null} />
      : <Forbidden what="Microsoft 365 Integration" need="System Admin" />,
    system: can(user, 'system.manage')
      ? <SystemPage user={user} />
      : <Forbidden what="System Settings" need="System Admin" />,
    email: can(user, 'system.manage')
      ? (EmailSettingsPage ? <EmailSettingsPage PageHead={PageHead} Empty={Empty} Skeleton={Skeleton} Icon={Icon} /> : <LoadError text="Email settings module failed to load." onRetry={() => window.location.reload()} />)
      : <Forbidden what="Email Settings" need="System Admin" />,
    notifications: can(user, 'notification.manage')
      ? <div><PageHead crumb="Administration / Notifications" title="Notification Settings"
          sub="Which events send an in-app alert or an email, and to whom." /><NotificationsPanel user={user} /></div>
      : <Forbidden what="Notification Settings" need="HR, Recruitment or System Admin" />,
    assessmentPolicy: can(user, 'interview.assessment_policy')
      ? <AssessmentPolicyPage user={user} />
      : <Forbidden what="Assessment Settings" need="System Admin" />,
    audit: <AuditPage user={user} />,
  }[route] || <Dashboard user={user} onNavigate={go} dash={counts.dash} intakes={counts.intakes} />;
  // Pages that already guard themselves keep their more specific message.
  const Page = routeAllowed || RoutePage?.type === Forbidden ? RoutePage : <Forbidden what={routeDef.label} />;

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

  /* Everything below is shared by both presentations and defined ONCE. These
     are singletons by contract: two CvReviewHosts would open two panels on one
     `ats:open-cv-review` event, and two CommandPalettes would answer one
     shortcut twice. Defining them here rather than in each branch is what makes
     "one of each" a property of the code, not of remembering to keep two
     branches in step. */
  const overlays = (
    <>
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

      {/* One CV review panel for the whole app; every entry point reaches it
          through the `ats:open-cv-review` event rather than owning its state. */}
      <CvReviewHost user={user} />
      <DocumentPanelHost />

      <AnyhelpDock user={user} route={route} context={anyhelpContext} onNavigate={go} />
    </>
  );

  /* ONE presentation at a time.

     Below the breakpoint the desktop sidebar, topbar and bottom nav are not
     rendered at all — not hidden with CSS. Hiding them would leave a second
     full set of buttons, menus and dialogs in the DOM: duplicate focus targets
     for a keyboard, duplicate ids, and two copies of a menu to keep in sync.

     Everything the phone shell shows comes from the state this component
     already holds: the same permission-filtered `visibleNav`, the same `go`,
     the same work counts, the same user. Nothing here fetches: the phone chrome
     reads what the shell already has, so it adds no request of its own.

     The page itself is never remounted by a presentation change; see the
     single tree below. */
  /* ONE tree for both presentations (2026-10-15). The phone and desktop
     chrome used to be two different element trees, so crossing 900px
     remounted <main> and the page inside it: an open dialog, a typed draft,
     filters, selection and focus were all lost when a window was resized or
     a tablet rotated. Now <main> always sits at shell > .main > main, and
     each chrome slot keeps its position (null when not shown), so React keeps
     the page mounted and only swaps the chrome around it. */
  return (
    <div className={'shell' + (isPhone ? ' shell-phone' : '')}
      style={isPhone ? undefined : { '--sidebar-w': collapsed ? '68px' : '264px' }}>
      {isPhone ? (
            <MobileAppBar
              title={(NAV.find((n) => n.key === route) || {}).label || 'Arabtec'}
              onMenu={() => setMobileNavOpen(true)}
              onSearch={() => setPaletteOpen(true)}
              onGo={go}
            />
      ) : null}
      {isPhone ? (
            <MobileDrawer
              open={mobileNavOpen}
              onClose={() => setMobileNavOpen(false)}
              nav={visibleNav}
              route={route}
              counts={counts}
              onGo={(key) => { setMobileNavOpen(false); go(key); }}
              user={user}
              roleCode={roleCode}
              branding={branding}
              onLogout={() => { if (confirmPageExit()) onLogout(); }}
              onChangePassword={() => { setMobileNavOpen(false); setPwdOpen(true); }}
            />
      ) : (
        <aside className={'sidebar' + (collapsed ? ' collapsed' : '')}>
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
      )}

      <div className="main">
        {isPhone ? null : (
          <header className="topbar">
            <button className="icon-btn menu-btn" onClick={() => setMobileNavOpen(true)} title="Open menu" aria-label="Open menu">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
            </button>
            <button className="icon-btn collapse-btn" onClick={() => setCollapsed((c) => !c)} title="Toggle sidebar" aria-label="Toggle sidebar">
              <Icon name="sidebar" size={18} />
            </button>
            {collapsed && <div className="tb-brand">
              <span className="bn">
                <strong>Recruitment Hub</strong>
                <span>{branding?.company_name || 'Arabtec Construction'}</span>
              </span>
            </div>}
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
                  <div className="menu-item" onClick={() => { if (confirmPageExit()) onLogout(); }} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" /></svg>
                    Logout
                  </div>
                </div>
              )}
            </div>
          </header>
        )}
        <main id="main-content" className={'content ' + (isPhone ? 'content-phone' : 'has-dock') + ' density-' + density} tabIndex="-1">
          <ErrorBoundary page resetKey={route}>{Page}</ErrorBoundary>
          <KnowledgeLine key={route} />
        </main>
      </div>

      {isPhone ? (
            <MobileTabBar
              items={primaryMobile}
              route={route}
              counts={counts}
              onGo={go}
              onMore={() => setMobileNavOpen(true)}
              moreOpen={mobileNavOpen}
            />
      ) : null}

      {overlays}
      <OverlaySlot />
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
  if (!items.length) return <Empty art="none-yet" text="No data yet." />;
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
  const order = FUNNEL_ORDER;
  const map = foldLegacyScreening(Object.fromEntries(data.map((d) => [d.status, d.count])));
  const rows = order.filter((s) => map[s]).map((s) => ({ status: s, count: map[s] }));
  if (!rows.length) return <Empty art="none-yet" text="No applications yet." />;
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
const FUNNEL_ORDER = ['sourced', 'shortlisted', 'interviewing', 'waiting_feedback', 'issuing_offer', 'offer_sent', 'joined'];
// The Screening stage was removed from the hiring pipeline (recruitment team,
// 25 Oct 2026): Shortlisted goes straight to Interview. Applications stored at
// the old Screening statuses are legacy rows; every chart counts them under
// Shortlisted so a historical candidate never disappears from a total.
const LEGACY_SCREENING = ['matched', 'unmatched', 'screened', 'cv_screening', 'screening'];
function foldLegacyScreening(counts) {
  const out = { ...(counts || {}) };
  let extra = 0;
  for (const k of LEGACY_SCREENING) { if (out[k]) { extra += Number(out[k]) || 0; delete out[k]; } }
  if (extra) out.shortlisted = (Number(out.shortlisted) || 0) + extra;
  return out;
}

// Compact, Workable-style pipeline funnel rendered on each request card.
// Shows total candidates + a proportional stacked bar across active stages.
function FunnelMini({ pipeline }) {
  const byStage = foldLegacyScreening((pipeline && pipeline.byStage) || {});
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
  sourced: '#8A867F', shortlisted: '#6B8F3D', interview_hr: '#008064',
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

function DashBars({ rows, empty, icon = EMOJI.chart }) {
  if (!rows || !rows.length) return <Empty art="none-yet" text={empty} />;
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
  const order = ['sourced', 'shortlisted', 'interview_hr', 'offer', 'hired'];
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
  if (!live && !closed) return <Empty art="none-yet" text="No candidates in the pipeline yet. Import CVs against a hiring request to get started." />;
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
const ROLE_RANK = ['system_admin', 'hr_director', 'recruitment_manager',
  'recruiter', 'project_manager', 'hiring_manager', 'interviewer', 'viewer'];
/* Data-quality labels a CV can carry into the Talent Pool. Kept in step with
   backend/src/lib/cv-intake/auto-ingest.js — a label is never a reason a
   candidate is hidden, only a reason a recruiter might look sooner. */
const QUALITY_FLAGS = [
  ['needs-review', 'Needs Review'],
  ['possible-duplicate', 'Possible Duplicate'],
  ['contact-missing', 'Contact Missing'],
  ['incomplete-profile', 'Incomplete Profile'],
  ['low-confidence', 'Low Confidence'],
  ['unclassified', 'Unclassified'],
];
const QUALITY_LABEL = Object.fromEntries(QUALITY_FLAGS);

const DISCIPLINE_CLASSES = [
  'Construction / Engineering Core',
  'Construction / Engineering Support',
  'Adjacent / Transferable',
  'Other Professional Background',
  'Unclassified',
];

/* What the parse could not establish, shown ON the candidate rather than used
   to withhold them. The full sentence is the tooltip: the badge is for
   scanning a grid, the sentence is for deciding what to do about it. */
/* Two tiers, on the canonical palette. Deliberately never `critical`: that red
   means Rejected or Failed everywhere else in the product, and a candidate with
   a missing phone number has not been turned down. Amber asks for a look; grey
   records something the parse could not establish. */
const QUALITY_VARIANT = {
  'needs-review': 'warning',
  'possible-duplicate': 'warning',
  'contact-missing': 'warning',
  'incomplete-profile': 'soft',
  'low-confidence': 'soft',
  'unclassified': 'soft',
};
function QualityBadges({ flags, note }) {
  if (!flags || flags.length === 0) return null;
  return (
    <div className="cc-flags" title={note || undefined}>
      {flags.map((code) => (
        <Badge key={code} variant={QUALITY_VARIANT[code] || 'soft'}>{QUALITY_LABEL[code] || code}</Badge>
      ))}
    </div>
  );
}

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
// `onClick` is optional. Present, this renders as a real button — keyboard-
// reachable, screen-reader-announced, with the same hover lift the ticket
// cards use. Absent, it renders exactly as before: a plain div, no pointer
// cursor. A card that looks clickable and isn't is worse than one that looks
// inert, so the two states are never allowed to look alike.
// `unavailable` names the source that did not load ("Hiring requests"). The
// tile then shows no number at all: a zero the page cannot vouch for reads as
// "nothing to do", which is the one thing a failed read must never say. The
// tile keeps its link — the full list has its own loader and retry.
function KpiCard({ label, value, meta, tone, onClick, unavailable }) {
  const cls = 'dash-kpi' + (tone && !unavailable ? ' ' + tone : '') + (onClick ? ' dash-kpi-link' : '') + (unavailable ? ' dash-kpi-unavailable' : '');
  const body = <>
    <span className="dash-kpi-label">{label}</span>
    <div className="dash-kpi-val">{unavailable ? '—' : value}</div>
    <div className="dash-kpi-hint">{unavailable ? `${unavailable} not loaded` : meta}</div>
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
  // A request still waiting for its decision has not started, so it is not
  // "Healthy" yet — it is waiting (review D4).
  const awaiting = r.status === 'pending_approval';
  const days = h.daysOpen == null ? null : h.daysOpen;
  // The whole row opens the request; the button is a quiet affordance, not a
  // primary — a list of five green "Open" buttons left the page with no
  // primary at all (review D1).
  return (
    <div className={'role-row' + (onOpen ? ' role-row-link' : '')}
      {...(onOpen ? { role: 'link', tabIndex: 0, onClick: () => onOpen(r), onKeyDown: (e) => { if (e.key === 'Enter') onOpen(r); } } : {})}>
      <div>
        <span className="cell-title">{r.title}</span>
        <span className="cell-meta">{shortReqCode(r.ticketNo)} · {(r.project || {}).name || 'No project'}</span>
      </div>
      <div>{awaiting
        ? <Badge variant="soft">Awaiting approval</Badge>
        : <Badge variant={tone === 'risk' ? 'critical' : tone === 'warn' ? 'warning' : 'success'}>{h.label || '—'}</Badge>}</div>
      <div>
        <span className="progress"><span style={{ width: filled + '%' }} /></span>
        <span className="cell-meta">{r.headcountFilled} of {r.headcount} seats · {(r.pipeline || {}).total || 0} in pipeline</span>
      </div>
      <div className="role-row-end">
        <span className="idle">{days == null ? '—' : awaiting ? `Waiting ${days} ${days === 1 ? 'day' : 'days'} for approval` : `Open ${days} ${days === 1 ? 'day' : 'days'}`}</span>
        {onOpen && <button className="btn btn-ghost btn-sm" tabIndex={-1} onClick={(e) => { e.stopPropagation(); onOpen(r); }}>Open</button>}
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
   compositions that show them.

   Each work list settles on its own. A list that fails is reported in
   `sectionErrors` and is never turned into an empty array: an empty list is a
   real answer ("nothing pending") and a failed read is not. On a reload, the
   lists that succeed replace their rows and the ones that fail keep whatever
   they last loaded (`loaded` says whether there is anything to keep), so a
   retry can never discard rows the recruiter is already looking at. A late
   response from a superseded reload is dropped. */
const DASH_SOURCES = ['requests', 'interviews'];
const DASH_SOURCE_LABEL = { requests: 'hiring requests', interviews: 'interviews' };
function useDashboardData(user, persona, sharedDash) {
  const [state, setState] = useState({
    loading: true, err: null, d: null, dashStale: false, requests: [], interviews: [],
    wanted: { requests: false, interviews: false },
    loaded: { requests: false, interviews: false },
    sectionErrors: { requests: null, interviews: null },
  });
  // Only the newest reload may write state; anything older resolves into nothing.
  const gen = useRef(0);
  // Exposed as `reload` so a persona composition that mutates something the
  // dashboard shows (Assign, Pause…) can pull the fresh numbers back in,
  // rather than leaving the KPIs and tables stale until the next full visit.
  const reload = useCallback(() => {
    const mine = ++gen.current;
    // `sharedDash` is the /dashboard payload the Shell already fetched for the
    // sidebar counts. Reusing it is the difference between one call and two.
    const wantsDashboard = !sharedDash && can(user, 'dashboard.view') && persona !== 'interviewer';
    const wantsRequests = persona !== 'interviewer'
      && (can(user, 'request.view_all') || can(user, 'request.view_own'));
    const wantsInterviews = (persona === 'recruiter' || persona === 'interviewer')
      && (can(user, 'interview.view_all') || can(user, 'interview.view_assigned'));
    const settle = (p) => p.then((value) => ({ ok: true, value }), (e) => ({ ok: false, error: e.message || 'Request failed' }));

    Promise.all([
      wantsDashboard ? settle(api.get('/dashboard')) : null,
      wantsRequests ? settle(api.get('/requests?pageSize=100')) : null,
      wantsInterviews ? settle(api.get('/interviews')) : null,
    ]).then(([d, rq, iv]) => {
      if (mine !== gen.current) return;
      setState((prev) => {
        // The shared payload is the page: without it there is nothing to
        // compose. A refresh that loses it keeps the last one instead.
        if (d && !d.ok && !prev.d) return { ...prev, loading: false, err: d.error };
        const list = (key, res) => {
          if (!res) return { rows: [], error: null, loaded: false };
          if (res.ok) return { rows: (res.value && res.value[key]) || [], error: null, loaded: true };
          return { rows: prev.loaded[key] ? prev[key] : [], error: res.error, loaded: prev.loaded[key] };
        };
        const requests = list('requests', rq), interviews = list('interviews', iv);
        return {
          loading: false, err: null,
          d: d ? (d.ok ? d.value : prev.d) : (sharedDash || null),
          dashStale: !!(d && !d.ok),
          requests: requests.rows, interviews: interviews.rows,
          wanted: { requests: !!rq, interviews: !!iv },
          loaded: { requests: requests.loaded, interviews: interviews.loaded },
          sectionErrors: { requests: requests.error, interviews: interviews.error },
        };
      });
    });
  }, [user.id, persona, !!sharedDash]);
  useEffect(() => { reload(); return () => { gen.current++; }; }, [reload]);
  // A list is unavailable when its latest read failed and nothing older can
  // stand in for it. A failed refresh over rows already loaded is "stale",
  // not unavailable: the rows stay and the page says they may not be current.
  const unavailable = {
    requests: !!(state.sectionErrors.requests && !state.loaded.requests),
    interviews: !!(state.sectionErrors.interviews && !state.loaded.interviews),
  };
  return { ...state, unavailable, reload };
}

// "Hiring requests", "Interviews" or "Hiring requests and interviews" — the
// label a KPI tile shows for the source(s) it could not count; null when all loaded.
function unavailableLabel(unavailable, keys) {
  const failed = keys.filter((k) => unavailable[k]).map((k) => DASH_SOURCE_LABEL[k]);
  if (!failed.length) return null;
  const s = failed.join(' and ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}
/* In-place state for a dashboard section whose source did not load. It sits
   inside the section's own card so the rest of the page stays usable, and it
   never resolves to the "all clear" empty state: "nothing is waiting on you"
   is a conclusion the page cannot draw from a failed read.

   Deliberately quiet. The page-level notice (see Dashboard) already carries
   the server's reason and the primary Retry, so a section only marks itself:
   a neutral "did not load" state with a light retry when it has nothing to
   show, or one muted line under rows that another source did fill
   (`partial`). Three red cards for one failed read would shout the same thing
   three times. Renders nothing when every source it is asked about loaded. */
function SectionUnavailable({ sources, data, partial }) {
  const failed = sources.filter((k) => data.unavailable[k]);
  if (!failed.length) return null;
  const what = failed.map((k) => DASH_SOURCE_LABEL[k]).join(' and ');
  if (partial) return <div className="section-caveat" role="status"><Icon name="alert" size={14} /><span>{`${what.charAt(0).toUpperCase() + what.slice(1)} did not load, so this list may be incomplete.`}</span></div>;
  return <Empty art="failed" title={`${what.charAt(0).toUpperCase() + what.slice(1)} did not load`} text="Nothing here can be counted until they do."
    action={<button className="btn btn-ghost btn-sm" onClick={data.reload}>Retry</button>} />;
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
function RecruiterDashboard({ user, data, onNavigate, notice }) {
  const { d, requests, interviews, unavailable } = data;
  const missing = (...keys) => keys.some((k) => unavailable[k]);
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
      <PageHead crumb={`${ROLE_NAMES[primaryRole(user)] || 'Recruiter'} workspace`} title="Your next actions"
        sub="Every item here links to a hiring request, a candidate, an interview or an offer."
        actions={<>
          <button className="btn btn-secondary" onClick={() => onNavigate('requests')}>Open my roles</button>
          {can(user, 'candidate.add') && <button className="btn" onClick={() => onNavigate('candidates')}>Add candidate</button>}
        </>} />
      {notice}

      <div className="dash-kpi-row kpi-4">
        <KpiCard label="Overdue actions" value={overdue} tone={overdue ? 'kpi-risk' : ''}
          meta={stalled.length ? `Oldest role open ${Math.max(...stalled.map((r) => (r.health || {}).daysOpen || 0))} days` : 'Nothing overdue'}
          unavailable={unavailableLabel(unavailable, ['requests', 'interviews'])}
          onClick={() => onNavigate('interviews', { status: 'completed' })} />
        <KpiCard label="Interviews this week" value={thisWeek.length}
          meta={thisWeek.length ? `Next: ${fmtWhen(thisWeek[0].scheduledAt)}` : 'None scheduled'}
          unavailable={unavailableLabel(unavailable, ['interviews'])}
          onClick={() => onNavigate('interviews', { thisWeek: true })} />
        <KpiCard label="Assigned open roles" value={owned.length}
          meta={`${owned.filter((r) => r.priority === 'critical').length} critical · ${attention.length} need attention`}
          unavailable={unavailableLabel(unavailable, ['requests'])}
          onClick={() => onNavigate('requests', { owner: String(user.id) })} />
        <KpiCard label="Offers to issue" value={offersToIssue}
          meta={d?.myWork.myPendingOfferApprovals ? `${d.myWork.myPendingOfferApprovals} more waiting on an approver` : 'None waiting on an approver'}
          onClick={() => onNavigate('offers', { toIssue: true })} />
      </div>

      <div className="dash-grid-2">
        <section className="card">
          <div className="card-head"><div><h3>Waiting on you</h3></div><span className="dash-headnote">Sorted by what blocks others first</span></div>
          {/* "All clear" is only claimed when both lists this queue is built
              from actually loaded; a queue that is empty because a read failed
              says so instead. */}
          {actions.length === 0
            ? (missing('requests', 'interviews')
              ? <SectionUnavailable sources={['requests', 'interviews']} data={data} />
              : <Empty art="all-clear" title="Nothing is waiting on you" text="No overdue feedback, no stalled roles, no unsourced requests in your scope." />)
            : <>
              <div className="action-list">
                {actions.slice(0, 6).map((a, i) => (
                  <ActionItem key={i} tone={a.tone} title={a.title} meta={a.meta} why={a.why}
                    cta={a.cta} onCta={a.onCta} />
                ))}
              </div>
              <SectionUnavailable sources={['requests', 'interviews']} data={data} partial />
              {healthy > 0 && <div className="reassurance">{healthy} of {owned.length} of your roles are progressing normally.</div>}
            </>}
        </section>

        <aside className="card">
          <div className="card-head"><div><h3>Today</h3></div><span className="dash-headnote">Owned appointments</span></div>
          <div className="event-list">
            {todays.length === 0 && stalled.length === 0
              ? (missing('requests', 'interviews')
                ? <SectionUnavailable sources={['requests', 'interviews']} data={data} />
                : <Empty art="none-yet" text="Nothing is scheduled for today." />)
              : <>
                {todays.map((i) => (
                  <EventCard key={i.id} tone="good"
                    title={`${timeOf(i.scheduledAt)} · ${ivType(i.interviewType)} interview`}
                    meta={`${(i.candidate || {}).fullName || 'Candidate'} · ${(i.request || {}).title || ''}`} />
                ))}
                {stalled.slice(0, 2).map((r) => (
                  <EventCard key={r.id} tone="risk"
                    title={`Overdue · ${shortReqCode(r.ticketNo)}`}
                    meta={`${r.title} · open ${(r.health || {}).daysOpen ?? '—'} days`} />
                ))}
              </>}
          </div>
          {(todays.length > 0 || stalled.length > 0) && <SectionUnavailable sources={['requests', 'interviews']} data={data} partial />}
        </aside>
      </div>

      <section className="card" style={{ marginTop: 16 }}>
        <div className="card-head"><div><h3>My roles</h3></div><span className="dash-headnote">Current status and how long each has been open</span></div>
        {unavailable.requests
          ? <SectionUnavailable sources={['requests']} data={data} />
          : mine.length === 0
            ? <Empty art="none-yet" text="No open hiring requests are assigned to you." />
            : <div className="role-health">{mine.slice(0, 8).map((r) => <RoleRow key={r.id} r={r} onOpen={(role) => openRequest(role.id, onNavigate)} />)}</div>}
      </section>
            <Hint>Select several cards on a pipeline board to move them together. Selections hidden by the current filter ask you to confirm first.</Hint>
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

function ManagerDashboard({ user, data, onNavigate, notice, figures }) {
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
      <PageHead crumb="Recruitment operations" title="Team command"
        sub="The blocker, who owns it, and how long it has been sitting there."
        actions={<>
          <button className="btn btn-secondary" onClick={() => onNavigate('requests')}>All hiring requests</button>
          <button className="btn" onClick={() => onNavigate('reports')}>Reports</button>
        </>} />
      {notice}

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

      <FiguresToggle figures={figures} />
      <div className="dash-grid-2 dash-figure">
        <section className="card">
          <div className="card-head"><div><h3>Recruiter workload</h3></div><span className="dash-headnote">Workload at a glance — no ranking.</span></div>
          <div className="card-pad">
            {!workloadRows.length
              ? <Empty art="none-yet" text="No open request is assigned to a recruiter yet." />
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
          ? <Empty art="all-clear" title="Nothing needs escalation" text="No stalled, unassigned or at-risk requests right now." />
          : <div className="table-wrap"><table className="table responsive-table">
            <thead><tr><th>Role</th><th>Owner</th><th>Stage / Idle</th><th>Blocker</th><th>Next action</th></tr></thead>
            <tbody>{attentionRows.map((r) => (
              <tr key={r.id} className="row-link" onClick={() => openRequest(r.id, onNavigate)}>
                <td data-label="Role">
                  <span className="cell-strong">{r.title}</span>
                  <div className="cell-sub">{shortReqCode(r.ticketNo)} · {placeLabel(r)} · <PriorityBadge p={r.priority} /></div>
                </td>
                <td data-label="Owner">
                  {r.owner ? r.owner.name : <span className="muted">Unassigned</span>}
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
            <Hint emoji="lock">A request can be assigned to a recruiter once the HR Director has approved it. Changing budget or headcount sends it back for approval.</Hint>
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
  if (!rows.length) return <Empty art="none-yet" text="No hiring requests to summarise yet." />;
  return (
    <div className="table-wrap">
      <table className="table responsive-table plan-table">
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
// Director: the full picture first, ordered by what needs her. 1) decisions and
// risks that need action now, 2) the whole hiring position in one row of
// figures, the pipeline funnel and the plan, 3) detail on demand. Every figure
// can be narrowed by project, department or recruiter (owner review, 4 Oct 2026).
const DASH_FILTER_KEY = 'arabtec_dash_filter';
const FUNNEL = [[1, 'Sourced'], [2, 'Shortlisted'], [3, 'Interview'], [4, '2nd interview'], [5, 'Offer'], [6, 'Hired']];
function readDashFilter() {
  try { const v = JSON.parse(localStorage.getItem(DASH_FILTER_KEY) || '{}'); return { projectId: v.projectId || '', departmentId: v.departmentId || '', ownerId: v.ownerId || '' }; }
  catch { return { projectId: '', departmentId: '', ownerId: '' }; }
}
function DirectorDashboard({ user, data, onNavigate, notice, figures, intakes }) {
  const { d: shared, requests: allRequests } = data;
  const [f, setF] = useState(readDashFilter);
  const [meta, setMeta] = useState(null);
  const [narrowed, setNarrowed] = useState(null);
  const [details, setDetails] = useState(false);
  const isNarrowed = !!(f.projectId || f.departmentId || f.ownerId);
  useEffect(() => { api.get('/requests/meta/form').then(setMeta).catch(() => setMeta({ projects: [], departments: [], recruiters: [] })); }, []);
  useEffect(() => {
    try { localStorage.setItem(DASH_FILTER_KEY, JSON.stringify(f)); } catch { /* per-device convenience */ }
    if (!isNarrowed) { setNarrowed(null); return undefined; }
    let live = true;
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
    api.get('/dashboard?' + qs).then((r) => { if (live) setNarrowed(r); }).catch(() => { if (live) setNarrowed(null); });
    return () => { live = false; };
  }, [f.projectId, f.departmentId, f.ownerId]);
  const d = isNarrowed ? narrowed : shared;
  const match = (r) => (!f.projectId || Number(r.projectId) === Number(f.projectId))
    && (!f.departmentId || Number(r.departmentId) === Number(f.departmentId))
    && (!f.ownerId || Number(r.ownerId) === Number(f.ownerId));
  const requests = (allRequests || []).filter(match);
  const k = (d && d.kpis) || {};

  // 1 — needs action now
  const awaiting = requests.filter((r) => ['pending_approval', 'draft', 'budget_validation'].includes(r.status))
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  const pendingOffers = d ? (d.offersByStatus || []).filter((o) => o.status === 'pending_approval').reduce((n, o) => n + o.count, 0) : 0;
  const running = requests.filter((r) => isOpenReq(r) && !awaiting.includes(r));
  const sev = (r) => (r.health || {}).level === 'red' ? 3 : r.priority === 'critical' ? 2 : (r.health || {}).level === 'amber' ? 1 : 0;
  const atRisk = running.filter((r) => sev(r) > 0).sort((a, b) => sev(b) - sev(a) || ((b.health || {}).daysOpen ?? 0) - ((a.health || {}).daysOpen ?? 0));
  const cvWaiting = !isNarrowed && intakes ? intakes : 0;
  const waitDays = (r) => { const t = new Date(r.createdAt).getTime(); return isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000); };
  const riskWhy = (r) => {
    const h = r.health || {};
    if (h.daysToTarget != null && h.daysToTarget < 0) return `Past target join date by ${Math.ceil(-h.daysToTarget)} days`;
    if (h.level === 'red') return `Open ${h.daysOpen} days — overdue`;
    if (r.priority === 'critical') return 'Critical priority, still open';
    return `Open ${h.daysOpen} days — needs attention`;
  };
  const decisionsCount = awaiting.length + pendingOffers;

  // 2 — the whole position
  const apps = (d && d.applicationsByStatus) || [];
  const byColumn = (col) => apps.filter((a) => (APP_STATUS[a.status] || {}).column === col).reduce((n, a) => n + a.count, 0);
  const inPipeline = [1, 2, 3, 4, 5].reduce((n, c) => n + byColumn(c), 0);
  const offersOut = d ? (d.offersByStatus || []).filter((o) => ['pending_approval', 'approved', 'sent'].includes(o.status)).reduce((n, o) => n + o.count, 0) : 0;
  const nameOf = (list, id) => ((list || []).find((x) => Number(x.id) === Number(id)) || {}).name || ((list || []).find((x) => Number(x.id) === Number(id)) || {}).title;
  const scopeText = isNarrowed
    ? [f.projectId && nameOf(meta?.projects, f.projectId), f.departmentId && nameOf(meta?.departments, f.departmentId), f.ownerId && nameOf(meta?.recruiters, f.ownerId)].filter(Boolean).join(' · ')
    : 'All projects, departments and recruiters';
  const planBy = f.projectId ? 'department' : 'project';
  const setFilter = (key) => (e) => setF((x) => ({ ...x, [key]: e.target.value }));

  return (
    <div>
      <PageHead crumb="Hiring plan and governance" title="Hiring plan and recruitment health"
        sub="What needs your decision, what is at risk, and where hiring stands against the plan."
        actions={<>
          <button className="btn btn-secondary" onClick={() => onNavigate('reports')}>Reports</button>
          {decisionsCount > 0 && (awaiting.length
            ? <button className="btn" onClick={() => onNavigate('requests', { status: 'pending_approval' })}>Review approvals ({decisionsCount})</button>
            : can(user, 'offer.approve') && <button className="btn" onClick={() => onNavigate('offers', { status: 'pending_approval' })}>Review offers ({pendingOffers})</button>)}
        </>} />
      {notice}

      <div className="dash-filter" role="group" aria-label="Narrow the dashboard">
        <label><span>Location</span>
          <SearchSelect value={f.projectId} ariaLabel="Location" placeholder="All locations" emptyLabel="All locations"
            options={(meta?.projects || []).map((p) => ({ value: String(p.id), label: p.isHeadOffice ? 'Head Office' : p.name, hint: p.isHeadOffice ? '' : (p.area || '') }))}
            onChange={(v) => setFilter('projectId')({ target: { value: v } })} /></label>
        <label><span>Department</span>
          <SearchSelect value={f.departmentId} ariaLabel="Department" placeholder="All departments" emptyLabel="All departments"
            options={optsOf(meta?.departments)} onChange={(v) => setFilter('departmentId')({ target: { value: v } })} /></label>
        <label><span>Recruiter</span>
          <SearchSelect value={f.ownerId} ariaLabel="Recruiter" placeholder="All recruiters" emptyLabel="All recruiters"
            options={optsOf(meta?.recruiters)} onChange={(v) => setFilter('ownerId')({ target: { value: v } })} /></label>
        <span className="dash-filter-scope">{isNarrowed ? <>Showing <strong>{scopeText}</strong></> : scopeText}</span>
        {isNarrowed && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setF({ projectId: '', departmentId: '', ownerId: '' })}>Clear</button>}
      </div>

      <section className="card dash-attention">
        <div className="card-head"><div><h3>Needs your attention</h3></div><span className="dash-headnote">Decisions first, then risks</span></div>
        {!decisionsCount && !atRisk.length && !cvWaiting
          ? <div className="dash-allclear">Nothing is waiting on you and no role is at risk.</div>
          : <div className="action-list">
            {awaiting.slice(0, 5).map((r) => (
              <ActionItem key={'a' + r.id} tone="warn" title={`Approve ${shortReqCode(r.ticketNo)} — ${r.title}`}
                meta={`${(r.project || {}).name || 'No project'} · ${r.headcount} seat${r.headcount === 1 ? '' : 's'}${waitDays(r) != null ? ` · waiting ${waitDays(r)} day${waitDays(r) === 1 ? '' : 's'}` : ''}`}
                why="Sourcing cannot start until this is approved" cta="Open request" onCta={() => openRequest(r.id, onNavigate)} />
            ))}
            {awaiting.length > 5 && <button type="button" className="btn btn-ghost btn-sm dash-more" onClick={() => onNavigate('requests', { status: 'pending_approval' })}>All {awaiting.length} requests awaiting approval</button>}
            {pendingOffers > 0 && (
              <ActionItem tone="warn" title={`${pendingOffers} offer${pendingOffers === 1 ? '' : 's'} awaiting approval`}
                meta="Offers held pending a decision" why="Candidates are waiting" cta="Open offers" onCta={() => onNavigate('offers', { status: 'pending_approval' })} />
            )}
            {atRisk.slice(0, 5).map((r) => (
              <ActionItem key={'r' + r.id} tone="risk" title={`${shortReqCode(r.ticketNo)} — ${r.title}`}
                meta={`${(r.project || {}).name || 'No project'} · ${r.headcountFilled} of ${r.headcount} filled · ${(r.pipeline || {}).total || 0} in pipeline`}
                why={riskWhy(r)} cta="Open request" onCta={() => openRequest(r.id, onNavigate)} />
            ))}
            {atRisk.length > 5 && <button type="button" className="btn btn-ghost btn-sm dash-more" onClick={() => setDetails(true)}>All {atRisk.length} roles at risk</button>}
            {cvWaiting > 0 && (
              <ActionItem tone="warn" title={`${cvWaiting} CV${cvWaiting === 1 ? '' : 's'} waiting in Candidate Review`}
                meta="Received CVs not yet accepted into the Talent Pool" why="Candidates are not in any pipeline until reviewed" cta="Open Candidate Review" onCta={() => onNavigate('candidateReview')} />
            )}
          </div>}
      </section>

      <div className="dash-kpi-row dash-kpi-6">
        <KpiCard label="Open roles" value={running.length} meta={awaiting.length ? `+ ${awaiting.length} awaiting approval` : 'Approved and recruiting'} onClick={() => onNavigate('requests')} />
        <KpiCard label="Seats filled" value={k.headcountFilled ?? '—'} meta={`${k.fillRate ?? 0}% of ${k.headcountTotal ?? 0} planned`} onClick={() => onNavigate('requests')} />
        <KpiCard label="In pipeline" value={d ? inPipeline : '—'} meta="Candidates on open roles" onClick={() => onNavigate('candidates')} />
        <KpiCard label="Interviews ahead" value={k.upcomingInterviews ?? '—'} meta="Scheduled from today" onClick={() => onNavigate('interviews')} />
        <KpiCard label="Offers out" value={d ? offersOut : '—'} meta={pendingOffers ? `${pendingOffers} awaiting approval` : 'Awaiting approval, approved or sent'} tone={pendingOffers ? 'kpi-attn' : ''} onClick={() => onNavigate('offers')} />
        <KpiCard label="Time to fill" value={k.timeToFillDays == null ? '—' : k.timeToFillDays + 'd'} meta={k.timeToFillDays == null ? 'No role filled yet' : 'Average, approval to filled'} />
      </div>

      <FiguresToggle figures={figures} />
      <div className="dash-grid-2 dash-figure">
        <section className="card">
          <div className="card-head"><div><h3>Hiring funnel</h3></div><span className="dash-headnote">Candidates by stage</span></div>
          <div className="card-pad">
            {!d ? <Empty art="none-yet" text="No data." /> : (
              <DashBars empty="No candidates in any pipeline yet." rows={FUNNEL.map(([col, label]) => ({ label, count: byColumn(col), color: col === 6 ? 'var(--green-700)' : col === 5 ? 'var(--warning)' : 'var(--green)' }))} />
            )}
          </div>
        </section>
        <section className="card">
          <div className="card-head"><div><h3>Hiring plan by {planBy}</h3></div><span className="dash-headnote">Planned versus filled</span></div>
          <div className="card-pad"><PlanTable rows={planBy === 'project' ? planRows(requests, 'project') : planRows(requests.map((r) => ({ ...r, department: { name: nameOf(meta?.departments, r.departmentId) || 'No department' } })), 'department')} unit={planBy === 'project' ? 'Project' : 'Department'} /></div>
        </section>
      </div>

      <button type="button" className="btn btn-secondary dash-details-toggle" aria-expanded={details} onClick={() => setDetails((v) => !v)}>
        {details ? 'Hide details' : 'Show details'} — roles by age, requests by status, recruiter workload, every open role
        <Icon name="chevronDown" size={16} />
      </button>
      {details && <>
        <div className="dash-grid-2">
          <section className="card">
            <div className="card-head"><div><h3>Open roles by age</h3></div><span className="dash-headnote">Days since approval</span></div>
            <div className="card-pad">
              {!d ? <Empty art="none-yet" text="No data." /> : (
                <DashBars empty="No approved role is open." rows={[
                  { label: 'On track · 0–30 days', count: d.aging['0-30'] || 0, color: 'var(--green)' },
                  { label: 'At risk · 31–60 days', count: d.aging['31-60'] || 0, color: 'var(--warning)' },
                  { label: 'Overdue · 61–90 days', count: d.aging['61-90'] || 0, color: 'var(--brand)' },
                  { label: 'Overdue · 90+ days', count: d.aging['90+'] || 0, color: 'var(--brand-dark)' },
                ]} />
              )}
              {d && d.awaitingApproval && d.awaitingApproval.count > 0 && <p className="dash-note">Not counted: {d.awaitingApproval.count} request{d.awaitingApproval.count === 1 ? '' : 's'} awaiting approval (oldest waiting {d.awaitingApproval.oldestDays} day{d.awaitingApproval.oldestDays === 1 ? '' : 's'}).</p>}
            </div>
          </section>
          <section className="card">
            <div className="card-head"><div><h3>Requests by status</h3></div><span className="dash-headnote">Every request in view</span></div>
            <div className="card-pad">
              <DashBars empty="No hiring requests yet." rows={((d && d.requestsByStatus) || []).filter((r) => r.count > 0).map((r) => ({ label: (REQ_STATUS[r.status] || {}).label || r.status.replace(/_/g, ' '), count: r.count, color: r.status === 'pending_approval' ? 'var(--warning)' : ['closed', 'cancelled', 'rejected'].includes(r.status) ? 'var(--muted)' : 'var(--green-700)' }))} />
            </div>
          </section>
        </div>
        {((d && d.recruiterLoad) || []).length > 0 && (
          <section className="card" style={{ marginTop: 12 }}>
            <div className="card-head"><div><h3>Recruiter workload</h3></div><span className="dash-headnote">Open requests per recruiter</span></div>
            <div className="card-pad"><DashBars rows={d.recruiterLoad.map((r) => ({ label: r.name, count: r.c ?? r.count ?? 0, color: 'var(--green-700)' }))} /></div>
          </section>
        )}
        <section className="card" style={{ marginTop: 12 }}>
          <div className="card-head"><div><h3>Every open role</h3></div><span className="dash-headnote">{running.length + awaiting.length} in view</span></div>
          {!(running.length + awaiting.length) ? <Empty art="none-yet" text="No open hiring requests." />
            : <div className="role-health">{[...atRisk, ...running.filter((r) => !atRisk.includes(r)), ...awaiting].map((r) => <RoleRow key={r.id} r={r} onOpen={(role) => openRequest(role.id, onNavigate)} />)}</div>}
        </section>
      </>}
    </div>
  );
}

/* ------------------------------ COO / EXECUTIVE --------------------------- */
/* Aggregate only. No candidate identity appears on this composition — the
   executive view answers "are we hiring to plan", not "who is in the pipeline". */
function ExecutiveDashboard({ user, data, onNavigate, notice, figures }) {
  const { d, requests } = data;
  const k = (d && d.kpis) || {};
  const remaining = Math.max((k.headcountTotal || 0) - (k.headcountFilled || 0), 0);
  const criticalOpen = requests.filter((r) => isOpenReq(r) && r.priority === 'critical');

  return (
    <div>
      <PageHead crumb="Executive workforce overview" title="Hiring progress against the approved plan"
        sub="Delivery against plan. Aggregate figures only — no candidate names in this view."
        actions={can(user, 'report.export') ? <button className="btn" onClick={() => onNavigate('reports')}>Reports</button> : null} />
      {notice}

      <div className="dash-kpi-row">
        <KpiCard label="Planned" value={k.headcountTotal ?? '—'} meta="Approved workforce plan" />
        <KpiCard label="Filled" value={k.headcountFilled ?? '—'} meta={`${k.fillRate ?? 0}% of plan`} />
        <KpiCard label="Remaining" value={remaining} tone={remaining ? 'kpi-attn' : ''}
          meta={`${requests.filter(isOpenReq).length} open request${requests.filter(isOpenReq).length === 1 ? '' : 's'}`} />
      </div>

      <FiguresToggle figures={figures} />
      <section className="card dash-figure">
        <div className="card-head"><div><h3>One hiring-progress view</h3></div><span className="dash-headnote">By project</span></div>
        <div className="card-pad"><PlanTable rows={planRows(requests, 'project')} unit="Project" /></div>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <div className="card-head"><div><h3>Critical vacancies</h3></div><span className="dash-headnote">Roles flagged critical and still open</span></div>
        {!criticalOpen.length
          ? <Empty art="all-clear" title="No critical vacancies" text="Nothing flagged critical is still open." />
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
                    <td data-label="Health"><ReqHealth health={r.health} status={r.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>}
      </section>

      <div className="dash-grid-2 dash-figure" style={{ marginTop: 16 }}>
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
            <Hint emoji="check">Every number here settles from its own list. A tile shows a dash, never a zero, when its source did not load.</Hint>
    </div>
  );
}

/* --------------------------- TECHNICAL INTERVIEWER ------------------------ */
function InterviewerDashboard({ user, data, onNavigate, notice }) {
  const { interviews } = data;
  const scheduled = interviews.filter((i) => i.status === 'scheduled');
  const upcoming = scheduled.filter((i) => { const n = daysUntil(i.scheduledAt); return n == null || n >= 0; })
    .sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)));
  const feedbackDue = interviews.filter((i) => i.status === 'completed' && !i.overallOutcome);
  const done = interviews.filter((i) => i.status === 'completed' && i.overallOutcome);

  return (
    <div>
      <PageHead crumb="Interview panel" title="Your interviews"
        sub="Only interviews you are on the panel for. Salary and offer terms are not part of this view."
        actions={<button className="btn" onClick={() => onNavigate('interviews')}>All my interviews</button>} />
      {notice}

      <div className="dash-kpi-row">
        <KpiCard label="Scheduled" value={upcoming.length} meta={upcoming.length ? `Next: ${fmtWhen(upcoming[0].scheduledAt)}` : 'Nothing scheduled'} />
        <KpiCard label="Feedback due" value={feedbackDue.length} tone={feedbackDue.length ? 'kpi-risk' : ''}
          meta={feedbackDue.length ? 'A hiring decision is waiting on these' : 'Nothing outstanding'} />
        <KpiCard label="Completed" value={done.length} meta="Interviews you have already assessed" />
      </div>

      <section className="card">
        <div className="card-head"><div><h3>Pending assessments</h3></div><span className="dash-headnote">Feedback the panel is waiting on</span></div>
        {!feedbackDue.length
          ? <Empty art="all-clear" title="No assessment is outstanding" text="Every interview you have run has feedback recorded." />
          : <div className="action-list">
            {feedbackDue.map((i) => (
              <ActionItem key={i.id} tone="risk" title={`Submit feedback — ${(i.candidate || {}).fullName || 'Candidate'}`}
                meta={`${(i.request || {}).title || 'Role'} · ${i.interviewNo} · ${fmtWhen(i.scheduledAt)}`}
                why="Blocks the hiring decision" cta="Open interview" onCta={() => onNavigate('interviews', { openId: i.id })} />
            ))}
          </div>}
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <div className="card-head"><div><h3>Upcoming</h3></div><span className="dash-headnote">Assigned to you</span></div>
        {!upcoming.length
          ? <Empty art="none-yet" text="No interviews are scheduled for you." />
          : <div className="event-list">
            {upcoming.slice(0, 8).map((i) => (
              <EventCard key={i.id} tone={isToday(i.scheduledAt) ? 'warn' : ''}
                title={`${fmtWhen(i.scheduledAt)} · ${ivType(i.interviewType)}`}
                meta={`${(i.candidate || {}).fullName || 'Candidate'} · ${(i.request || {}).title || ''} · ${i.mode || ''}`} />
            ))}
          </div>}
      </section>
            <Hint emoji="calendar">Every interview invite carries a calendar file. Open it to add the slot to Outlook; your scorecard opens from the interview itself.</Hint>
    </div>
  );
}

/* Dispatcher. The real authenticated role picks the composition. */
// The system administrator's dashboard: the director view (the big picture)
// by default, with a switch into every role's own composition so an admin can
// check what each role sees without borrowing an account. Every view is
// rendered with the admin's own scope.
const DASH_VIEWS = [['director', 'Director'], ['executive', 'Executive'], ['manager', 'Recruitment manager'], ['recruiter', 'Recruiter'], ['interviewer', 'Interviewer']];
const DASH_VIEW_KEY = 'arabtec_dash_view';
/* Phone only (hidden on desktop by CSS): folds the chart sections marked
   `.dash-figure` so a phone dashboard opens on the decisions, not on four
   screens of charts. */
function FiguresToggle({ figures }) {
  if (!figures) return null;
  return <button type="button" className="btn btn-secondary dash-figures-toggle" aria-expanded={figures.open} onClick={figures.toggle}>
    {figures.open ? 'Hide hiring figures' : 'Show hiring figures'}
    <Icon name="chevronDown" size={16} />
  </button>;
}
function Dashboard({ user, onNavigate, dash, intakes }) {
  const isAdmin = (user.roles || []).includes('system_admin');
  const [figuresOpen, setFiguresOpen] = useState(false);
  const [view, setView] = useState(() => { try { const v = localStorage.getItem(DASH_VIEW_KEY); return DASH_VIEWS.some(([k]) => k === v) ? v : 'director'; } catch { return 'director'; } });
  const persona = isAdmin ? view : personaFor(user);
  const data = useDashboardData(user, persona, dash);
  const choose = (k) => { setView(k); try { localStorage.setItem(DASH_VIEW_KEY, k); } catch { /* per-device convenience only */ } };
  const viewTabs = isAdmin ? <div className="dash-view-switch">
    <div className="control-tabs dash-view-tabs" role="tablist" aria-label="Preview the dashboard as">
      {DASH_VIEWS.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={persona === k} className={'control-tab' + (persona === k ? ' active' : '')} onClick={() => choose(k)}>{label}</button>)}
    </div>
    <p className="dash-view-note">Preview what each role sees on their dashboard. Figures use your own access as System Administrator.</p>
  </div> : null;

  if (!can(user, 'dashboard.view') && persona !== 'interviewer') {
    return <Forbidden what="Dashboard" need="dashboard.view" />;
  }
  if (data.loading) {
    return (<div>
      <PageHead crumb="Recruitment workspace" title="Dashboard" sub="Your scoped recruitment overview." />
      {viewTabs}
      <Skeleton shape="dashboard" />
    </div>);
  }
  // The page is taken over by an error only when there is nothing to compose:
  // the shared payload never arrived, or every work list this persona reads
  // failed with nothing older to fall back on. One list out of two failing is
  // handled inside the composition, section by section.
  const wantedLists = DASH_SOURCES.filter((k) => data.wanted[k]);
  const nothingUsable = wantedLists.length > 0 && wantedLists.every((k) => data.unavailable[k]);
  if (data.err || nothingUsable) return <div><PageHead crumb="Recruitment workspace" title="Dashboard" />
    {viewTabs}
    <LoadError title="Could not load the dashboard" text={data.err || data.sectionErrors[wantedLists[0]]} onRetry={data.reload} /></div>;

  // One notice under the page title carries the failure and the primary
  // Retry, the way every list page reports a failed refresh. A list that
  // never loaded is named with the server's reason; a refresh that failed
  // after a successful load keeps the last results on screen and says so.
  const join = (xs) => xs.length > 1 ? xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1] : xs[0];
  const missing = DASH_SOURCES.filter((k) => data.unavailable[k]);
  const stale = DASH_SOURCES.filter((k) => data.sectionErrors[k] && data.loaded[k]).map((k) => DASH_SOURCE_LABEL[k]);
  if (data.dashStale) stale.unshift('the dashboard figures');
  const notice = <>
    {viewTabs}
    {missing.length > 0 && <RefetchError onRetry={data.reload}
      text={`Could not load ${join(missing.map((k) => DASH_SOURCE_LABEL[k]))} (${data.sectionErrors[missing[0]]}). Figures and lists that depend on them are marked below.`} />}
    {stale.length > 0 && <RefetchError onRetry={data.reload} text={`Could not refresh ${join(stale)}. Showing the last loaded results.`} />}
  </>;

  // On a phone the charts fold behind one "Show hiring figures" button, so the
  // screen leads with what needs a decision (FiguresToggle, .dash-figure).
  const figures = { open: figuresOpen, toggle: () => setFiguresOpen((v) => !v) };
  const props = { user, data, onNavigate, notice, figures, intakes };
  const personaView = persona === 'manager' ? <ManagerDashboard {...props} />
    : persona === 'director' ? <DirectorDashboard {...props} />
    : persona === 'executive' ? <ExecutiveDashboard {...props} />
    : persona === 'interviewer' ? <InterviewerDashboard {...props} />
    : <RecruiterDashboard {...props} />;
  return <div className={'dash-root' + (figuresOpen ? ' figures-open' : '')}>{personaView}</div>;
}

/* ----------------------------- Reports / analytics ----------------------------- */
// A horizontal bar metric row (label · proportional fill · value).
function MetricBar({ rows, labeler = (s) => s, max }) {
  const items = (rows || []).filter((r) => r.count > 0);
  if (!items.length) return <Empty art="none-yet" text="No data yet." />;
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
  const rows = FUNNEL_ORDER.filter((s) => foldLegacyScreening(map)[s] != null).map((s) => ({ status: s, count: foldLegacyScreening(map)[s] }));
  if (!rows.length) return <Empty art="none-yet" text="No applications yet." />;
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
  const load = useCallback(() => {
    setErr(null);
    if (!can(user, 'dashboard.view')) { setErr('You do not have analytics access.'); return; }
    api.get('/dashboard').then(setD).catch((e) => setErr(e.message));
  }, [user]);
  useEffect(load, [load]);

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

  if (err) return <LoadError title="Could not load reports" text={err} onRetry={load} />;
  if (!d) return (
    <div>
      <PageHead crumb="Overview / Reports" title="Recruitment Reports" sub="Loading analytics…" />
      <div className="dash-kpi-row kpi-4">{[0, 1, 2, 3].map((i) => <div className="dash-kpi dash-kpi-skel" key={i}><div className="skeleton" style={{ width: '52%' }} /><div className="skeleton" style={{ width: '34%', height: 26, margin: '12px 0 8px' }} /><div className="skeleton" style={{ width: '66%' }} /></div>)}</div>
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

      <div className="dash-kpi-row kpi-4">
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
function PageHead({ crumb, title, sub, actions, back }) {
  return (
    <div className="page-head">
      <div className="page-head-main">
        {back && <div className="detail-back">{back}</div>}
        {crumb && <div className="breadcrumb">{crumb}</div>}
        <h1 className="page-title">{title}</h1>
        {sub && <p className="page-sub">{sub}</p>}
      </div>
      {actions && <div className="page-head-actions">{actions}</div>}
    </div>
  );
}

function FilterToolbar({ search, children, count, activeCount = 0 }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  return <div className="toolbar filter-toolbar">
    <div className="toolbar-search">{search}</div>
    <button className="btn btn-secondary filter-toggle" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(v => !v)}>
      <Icon name="filter" size={16} />Filters{activeCount > 0 ? ` (${activeCount})` : ''}
    </button>
    <div id={id} className={'toolbar-secondary' + (expanded ? ' expanded' : '')}>{children}</div>
    <div className="toolbar-count">{count}</div>
  </div>;
}

/* A dropdown you can type into (recruitment team, 25 Oct 2026). Every filter
   and form list that used to be a native <select> — departments, projects and
   sites, recruiters, hiring managers, requests — is one of these: type a few
   letters, the list narrows, Enter or a click picks, Escape closes, the × (or
   Backspace on an empty box) clears. Native <select> stays only for lists of a
   handful of fixed words (priority, Head Office / Projects).
   `options`: [{ value, label, hint? }]. `value` is compared as a string. */
function SearchSelect({ value, onChange, options, placeholder = 'Type to search…', emptyLabel = 'All', ariaLabel, disabled, title, style, className }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const ref = useRef(null);
  const listId = useId();
  const has = value !== '' && value != null;
  const current = (options || []).find((o) => String(o.value) === String(value));
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    const list = t ? (options || []).filter((o) => String(o.label).toLowerCase().includes(t) || String(o.hint || '').toLowerCase().includes(t)) : (options || []);
    return list.slice(0, 200);
  }, [options, q]);
  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!ref.current?.contains(e.target)) { setOpen(false); setQ(''); } };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  function pick(v) { onChange(v); setOpen(false); setQ(''); }
  function keys(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) setOpen(true); else setHi((h) => Math.min(h + 1, Math.max(shown.length - 1, 0))); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') { if (open) { e.preventDefault(); if (shown[hi]) pick(shown[hi].value); } }
    // Escape closes the list only; the dialog around it stays open (walkthrough 25 Oct 2026).
    else if (e.key === 'Escape') { if (open) { e.preventDefault(); e.stopPropagation(); setOpen(false); setQ(''); } }
    else if (e.key === 'Backspace' && !q && has) { onChange(''); }
  }
  return (
    <div ref={ref} className={'sselect' + (open ? ' open' : '') + (has ? ' has-value' : '') + (disabled ? ' disabled' : '') + (className ? ' ' + className : '')} style={style} title={title}>
      <input type="text" role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-label={ariaLabel}
        autoComplete="off" spellCheck="false" disabled={disabled}
        value={open ? q : (current ? current.label : '')}
        placeholder={current ? current.label : placeholder}
        onFocus={() => { setOpen(true); setHi(0); }}
        onClick={() => { if (!open) { setOpen(true); setHi(0); } }}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setHi(0); }}
        onKeyDown={keys} />
      {has && !disabled && <button type="button" className="sselect-clear" aria-label="Clear" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => { onChange(''); setQ(''); }}>×</button>}
      <span className="sselect-caret" aria-hidden="true">▾</span>
      {open && (
        <ul id={listId} role="listbox" className="sselect-list">
          {emptyLabel != null && !q && <li role="option" aria-selected={!has} className={'sselect-opt' + (!has ? ' selected' : '')} onMouseDown={(e) => { e.preventDefault(); pick(''); }}>{emptyLabel}</li>}
          {shown.length === 0
            ? <li className="sselect-empty">No matches{q ? ` for “${q}”` : ''}</li>
            : shown.map((o, i) => (
              <li key={String(o.value)} role="option" aria-selected={String(o.value) === String(value)}
                className={'sselect-opt' + (i === hi ? ' active' : '') + (String(o.value) === String(value) ? ' selected' : '')}
                onMouseEnter={() => setHi(i)} onMouseDown={(e) => { e.preventDefault(); pick(o.value); }}>
                <span>{o.label}</span>{o.hint ? <small>{o.hint}</small> : null}
              </li>
            ))}
          {(options || []).length > 200 && shown.length === 200 && <li className="sselect-empty">Type to narrow the list…</li>}
        </ul>
      )}
    </div>
  );
}
// Shorthands for the two shapes every list in this app comes in.
const optsOf = (list, label = (x) => x.name, value = (x) => x.id) => (list || []).map((x) => ({ value: String(value(x)), label: label(x) }));
const pairOpts = (pairs) => (pairs || []).map(([id, name]) => ({ value: String(id), label: name }));

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
function CountPill({ n, total, noun, suffix }) {
  if (n == null) return null;
  const label = total != null && total !== n ? `${n} of ${total}` : `${n}`;
  return <span className="count-pill">{label} <em>{n === 1 ? noun : noun + 's'}{suffix ? ' ' + suffix : ''}</em></span>;
}

// SLA / aging indicator for a hiring request. Reads the `health` object the
// requests API already returns ({ level, label, daysOpen }); renders nothing
// when the API did not supply it.
function ReqHealth({ health, compact, status }) {
  // Sourcing has not started on a request still waiting for its decision, so
  // its clock is not "Healthy" — say what it is waiting on (review D4/R8).
  if (status === 'pending_approval') {
    return <span className="sla sla-waiting" title="Waiting for approval; sourcing starts once approved"><i />{compact ? '' : 'Awaiting approval'}</span>;
  }
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
          <button className="btn btn-ghost btn-sm" onClick={() => { if (confirmPageExit()) onLogout(); }}>Sign out instead</button>
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
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const loadSeq = useRef(0);
  const canManage = can(user, 'user.manage');

  // Roles, departments, projects and sites do not depend on the search box, but
  // they used to sit in the same Promise.all as `/users` — so typing one letter
  // refetched all five, and `setUsers(null)` blanked the table to a skeleton
  // between every keystroke. The reference data loads once; only `/users`
  // follows `q`.
  useEffect(() => {
    Promise.all([api.get('/roles'), api.get('/org/departments'), api.get('/org/projects'), api.get('/org/sites')])
      .then(([r, d, p, s]) => { setRoles(r.roles); setDepts(d.departments); setProjects(p.projects); setSites(s.sites); })
      .catch(() => { /* the table still works; the edit dialog surfaces its own errors */ });
  }, []);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setBusy(true); setLoadError(null);
    try {
      const u = await api.get('/users' + (q ? '?q=' + encodeURIComponent(q) : ''));
      if (seq !== loadSeq.current) return;
      setUsers(u.users);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setLoadError(e.message || 'Could not load users.');
    } finally {
      if (seq === loadSeq.current) setBusy(false);
    }
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
      {loadError && users ? <RefetchError text={loadError} onRetry={load} /> : null}
      <div className={'card' + (busy && users ? ' table-busy' : '')} aria-busy={busy && !!users}>
        {loadError && !users ? <Empty tone="error" title="Could not load users" text={loadError}
          action={<button className="btn" onClick={load}>Retry</button>} />
          : !users ? <Skeleton /> : users.length === 0 ? <Empty text="No users found." /> : (
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Job Title</th><th>Role(s)</th><th>Status</th><th>Last Login</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td><strong>{u.fullName}</strong><div className="muted">{u.employeeNo || '—'}</div></td>
                  <td>{u.email}</td>
                  <td>{u.jobTitle || '—'}</td>
                  <td>{u.roles.map((r) => <span className="chip" key={r.code}>{r.name}</span>)}</td>
                  <td><StatusBadge status={u.status} /></td>
                  <td className="muted">{fmtDate(u.lastLoginAt)}</td>
                  {/* Four full-width text buttons behind `white-space: nowrap`
                      gave this cell a 359px intrinsic minimum, which pushed the
                      table to 1107px inside a 1095px card — a 12px horizontal
                      scroll at 1440, the widest width we support. A wrapping
                      row drops that floor without hiding any action. */}
                  {/* One visible action and a menu for the rest: four buttons in
                      this cell wrapped, and "Deactivate" landed on the next row's
                      border (docs/audits/heuristic-2026-09-30.md, U1). */}
                  <td className="user-actions">
                    {canManage && <>
                      <button className="btn btn-secondary btn-sm" onClick={() => setEditing(u)}>Edit</button>
                      <RowMenu ariaLabel={`More actions for ${u.fullName}`} items={[
                        { label: 'Activity', onClick: () => showActivity(u) },
                        { label: 'Reset password', onClick: () => resetPwd(u) },
                        { label: u.status === 'active' ? 'Deactivate' : 'Activate', danger: u.status === 'active',
                          disabled: u.id === user.id, reason: 'You cannot deactivate your own account', onClick: () => toggleStatus(u) },
                      ]} />
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
      {/* Every section sits on the same two-column form grid as the fields
          above: one label style, one column edge, spacing from the scale (R16). */}
      <div className="form-grid user-form-rest">
        <div className="field full"><label>Roles</label>
          <div className="tag-row">{roles.map((r) => <span key={r.code} className={'tag-toggle' + (f.roleCodes.includes(r.code) ? ' on' : '')} title={r.name} onClick={() => toggleArr('roleCodes', r.code)}>{r.name}</span>)}</div></div>
        <div className="full user-form-switch">
          <label className="switch"><input type="checkbox" checked={f.globalScope} onChange={(e) => set('globalScope', e.target.checked)} /> Global access (all projects &amp; sites)</label></div>
        {!f.globalScope && <>
          <div className="field full"><label>Projects</label>
            <div className="tag-row">{projects.map((p) => <span key={p.id} className={'tag-toggle' + (f.projectIds.includes(p.id) ? ' on' : '')} title={p.name} onClick={() => toggleArr('projectIds', p.id)}>{p.name}</span>)}</div></div>
          <div className="field full"><label>Sites</label>
            <div className="tag-row">{sites.map((s) => <span key={s.id} className={'tag-toggle' + (f.siteIds.includes(s.id) ? ' on' : '')} title={s.name} onClick={() => toggleArr('siteIds', s.id)}>{s.name}</span>)}</div></div>
        </>}
        {isNew && <div className="field">
          <label>Initial password</label>
          <div className="pw-input">
            <input type={showPwd ? 'text' : 'password'} value={initialPassword} autoComplete="new-password"
              onChange={(e) => setInitialPassword(e.target.value)} placeholder="Leave blank to generate one" />
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowPwd((v) => !v)}>{showPwd ? 'Hide' : 'Show'}</button>
          </div>
          <p className="field-hint">Optional. Leave blank to generate a temporary password — it is shown once, immediately after the user is created. Either way the user must set their own password at first login.</p>
        </div>}
      </div>
    </Modal>
  );
}

/* ----------------------------- Roles & Permissions ----------------------------- */
// Roles page areas: each raw permission resource belongs to one. Anything the
// server adds later without an entry here lands in the last area.
const PERMISSION_AREAS = [
  { label: 'Hiring requests', resources: ['request'] },
  { label: 'Candidates', resources: ['candidate', 'application'] },
  { label: 'CV Inbox', resources: ['cv_intake'] },
  { label: 'Interviews', resources: ['interview'] },
  { label: 'Offers & salary', resources: ['offer', 'salary'] },
  { label: 'Dashboard & reports', resources: ['dashboard', 'report'] },
  { label: 'Administration', resources: ['user', 'role', 'org', 'org_chart', 'workflow', 'notification', 'audit', 'system', 'app', 'branding', 'button'] },
];

function RolesPage({ user }) {
  const toast = useToast();
  const [loadError, setLoadError] = useState(null);
  const [roles, setRoles] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [selected, setSelected] = useState(null);
  const [draft, setDraft] = useState([]);
  const canManage = can(user, 'role.manage');

  // P0-4: switching roles (or leaving the page) must not silently drop unsaved
  // toggles. `dirty` compares the working draft to the selected role's stored
  // permissions as sets, so order does not matter.
  const dirty = useMemo(() => {
    const a = new Set(draft), b = new Set(selected?.permissions || []);
    return a.size !== b.size || [...a].some((x) => !b.has(x));
  }, [draft, selected]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    const navigate = (e) => { if (!window.confirm('Discard unsaved permission changes?')) e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    window.addEventListener('ats:before-navigate', navigate);
    return () => { window.removeEventListener('beforeunload', warn); window.removeEventListener('ats:before-navigate', navigate); };
  }, [dirty]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
    const [r, p] = await Promise.all([api.get('/roles'), api.get('/roles/permissions')]);
    setRoles(r.roles); setCatalog(p.permissions);
    if (!selected && r.roles[0]) { setSelected(r.roles[0]); setDraft(r.roles[0].permissions); }
    } catch (e) { setLoadError(e.message); }
  }, [selected]);
  useEffect(() => { load(); }, []);

  function pick(role) {
    if (role.id === selected?.id) return;
    if (dirty && !window.confirm(`Discard unsaved permission changes for ${selected.name}?`)) return;
    setSelected(role); setDraft(role.permissions);
  }
  function toggle(code) { setDraft((d) => d.includes(code) ? d.filter((x) => x !== code) : [...d, code]); }
  async function save() {
    try { await api.put(`/roles/${selected.id}/permissions`, { permissionCodes: draft }); setSelected((role) => ({ ...role, permissions: [...draft] })); setRoles((all) => all.map(role => role.id === selected.id ? { ...role, permissions: [...draft] } : role)); toast('Permissions updated'); }
    catch (e) { toast(e.message, 'error'); }
  }
  // Areas people recognise, in the order the work happens, instead of one
  // heading per raw resource (20 of them, most holding a single switch).
  const [query, setQuery] = useState('');
  const groups = useMemo(() => {
    const byArea = new Map(PERMISSION_AREAS.map((a) => [a.label, []]));
    for (const p of catalog) {
      const area = PERMISSION_AREAS.find((a) => a.resources.includes(p.resource)) || PERMISSION_AREAS[PERMISSION_AREAS.length - 1];
      byArea.get(area.label).push(p);
    }
    return [...byArea].filter(([, perms]) => perms.length);
  }, [catalog]);
  const q = query.trim().toLowerCase();
  const shown = q ? groups.map(([area, perms]) => [area, perms.filter((p) => (p.description + ' ' + p.code).toLowerCase().includes(q))]).filter(([, perms]) => perms.length) : groups;
  function setArea(perms, on) {
    const codes = perms.map((p) => p.code);
    setDraft((d) => on ? [...new Set([...d, ...codes])] : d.filter((c) => !codes.includes(c)));
  }

  if (loadError) return <LoadError text={loadError} onRetry={load} />;
  if (!roles) return <Skeleton rows={8} />;
  return (
    <div>
      <PageHead crumb="Administration / Roles" title="Roles & Permissions" sub="Pick a role, then switch on what it is allowed to do. Every change is recorded in the audit log." />
      <div className="roles-layout">
        <div className="card roles-list"><div className="card-pad">
          {roles.map((r) => (
            <button key={r.id} className={'role-choice' + (selected?.id === r.id ? ' active' : '')} onClick={() => pick(r)} aria-current={selected?.id === r.id ? 'true' : undefined}>
              <span>{r.name}</span>
            </button>
          ))}
        </div></div>
        <div className="card">
          <div className="card-head permissions-save"><h3>{selected?.name} — {draft.length} permissions{dirty && <span className="muted" style={{ fontWeight: 400 }}> · unsaved</span>}</h3>
            {canManage && <button className="btn btn-sm" disabled={!dirty} onClick={save}>Save Changes</button>}</div>
          <div className="card-pad permissions-panel">
            <div className="perm-search">
              <input className="input" type="search" placeholder="Search permissions" aria-label="Search permissions" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            {shown.length === 0 && <p className="muted">No permission matches “{query}”.</p>}
            {shown.map(([area, perms]) => {
              const on = perms.filter((p) => draft.includes(p.code)).length;
              const all = on === perms.length;
              return (
                <section key={area} className="perm-area">
                  <div className="perm-area-head">
                    <h4>{area}</h4>
                    <span className="muted perm-area-count">{on} of {perms.length} on</span>
                    {canManage && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setArea(perms, !all)}>{all ? 'Clear all' : 'Select all'}</button>}
                  </div>
                  <div className="perm-area-grid">
                    {perms.map((p) => (
                      <label key={p.code} className="switch permission-toggle">
                        <input type="checkbox" disabled={!canManage} checked={draft.includes(p.code)} onChange={() => toggle(p.code)} /> <span>{p.description}<code className="permission-code">{p.code}</code></span>
                      </label>
                    ))}
                  </div>
                </section>
              );
            })}
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
        {!rows ? <Skeleton /> : rows.length === 0 ? <Empty art="none-yet" text="No projects yet." /> : (
          <div className="table-wrap"><table className="responsive-table"><thead><tr><th>Code</th><th>Name</th><th>Client</th><th>Location</th><th>Status</th><th>Sites</th><th>PM</th>{canManage && <th><span className="sr-only">Actions</span></th>}</tr></thead>
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

/* Hiring locations (recruitment team, 25 Oct 2026). Head Office + the sites a
   request can be for, each with the area it is in; the area list itself is
   editable. Sites are the same rows as Administration → Projects — this page
   is the recruitment team's own, lighter door to them (location.manage). */
function LocationsPage({ user }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const canManage = can(user, 'location.manage');
  const load = useCallback(async () => { try { setData(await api.get('/org/locations')); setError(''); } catch (e) { setError(e.message || 'Could not load locations.'); } }, []);
  useEffect(() => { load(); }, [load]);
  const [newArea, setNewArea] = useState('');
  const [newSite, setNewSite] = useState({ name: '', area: '' });
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(null); // { id, name }
  async function run(label, fn) {
    if (busy) return;
    setBusy(true);
    try { setData(await fn()); if (label) toast(label); }
    catch (e) { toast(e.message || 'Could not save.', 'error'); }
    finally { setBusy(false); }
  }
  const saveAreas = (areas) => run('Areas saved', () => api.put('/org/locations/areas', { areas }));
  const updateSite = (id, patch, label) => run(label, () => api.put('/org/locations/sites/' + id, patch));
  async function addSite() {
    const name = newSite.name.trim(), area = newSite.area || (data?.areas || [])[0] || '';
    if (!name) { toast('Type the site name.', 'error'); return; }
    await run(`Added ${name}`, () => api.post('/org/locations/sites', { name, area }));
    setNewSite({ name: '', area: '' });
  }
  const areas = data?.areas || [];
  const areaSelect = (value, onChange, label) => (
    <select value={areas.includes(value) ? value : ''} aria-label={label} disabled={!canManage || busy} onChange={(e) => onChange(e.target.value)}>
      {!areas.includes(value) && <option value="">{value ? `${value} (not in the area list)` : '— Area —'}</option>}
      {areas.map((a) => <option key={a} value={a}>{a}</option>)}
    </select>
  );
  return (
    <div>
      <PageHead crumb="Administration / Locations" title="Locations"
        sub="Where a hiring request is for: the Head Office, or one of the company's sites and the area it is in. The hiring request form reads this list." />
      {error ? <LoadError text={error} onRetry={load} /> : !data ? <Skeleton rows={6} /> : (
        <div style={{ display: 'grid', gap: 16 }}>
          <div className="card card-pad">
            <div className="section-title" style={{ marginTop: 0 }}>Areas</div>
            <p className="muted" style={{ marginTop: 0 }}>The area each site is in, shown beside its name in the request form.</p>
            <div className="tag-row" style={{ marginBottom: 10 }}>
              {areas.map((a) => (
                <span key={a} className="tag-toggle on" title={a}>{a}
                  {canManage && areas.length > 1 && <button type="button" className="icon-btn" aria-label={`Remove area ${a}`} disabled={busy} style={{ marginInlineStart: 4 }}
                    onClick={() => saveAreas(areas.filter((x) => x !== a))}><Icon name="close" size={12} /></button>}
                </span>
              ))}
            </div>
            {canManage && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <input placeholder="New area, e.g. Upper Egypt Area" value={newArea} onChange={(e) => setNewArea(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && newArea.trim()) { saveAreas([...areas, newArea.trim()]); setNewArea(''); } }} />
                <button className="btn btn-secondary" disabled={busy || !newArea.trim()} onClick={() => { saveAreas([...areas, newArea.trim()]); setNewArea(''); }}>Add area</button>
              </div>
            )}
          </div>
          <div className="card card-pad">
            <div className="section-title" style={{ marginTop: 0 }}>Head Office</div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <strong>{data.headOffice.name}</strong>
              {areaSelect(data.headOffice.area || '', (v) => updateSite(data.headOffice.id, { area: v }, 'Head Office area saved'), 'Head Office area')}
            </div>
          </div>
          <div className="card">
            <div className="card-head"><div><h3>Sites</h3></div><span className="dash-headnote">{data.sites.length} site{data.sites.length === 1 ? '' : 's'}</span></div>
            {data.sites.length === 0 ? <Empty art="none-yet" text="No sites yet. Add the first one below." /> : (
              <div className="table-wrap"><table className="responsive-table">
                <thead><tr><th>Site</th><th>Area</th><th>Status</th>{canManage && <th><span className="sr-only">Actions</span></th>}</tr></thead>
                <tbody>{data.sites.map((p) => (
                  <tr key={p.id}>
                    <td data-label="Site">
                      {renaming && renaming.id === p.id
                        ? <input autoFocus value={renaming.name} aria-label={`Rename ${p.name}`} onChange={(e) => setRenaming({ id: p.id, name: e.target.value })}
                            onKeyDown={(e) => { if (e.key === 'Enter') { updateSite(p.id, { name: renaming.name }, 'Site renamed'); setRenaming(null); } if (e.key === 'Escape') setRenaming(null); }}
                            onBlur={() => { if (renaming.name.trim() && renaming.name.trim() !== p.name) updateSite(p.id, { name: renaming.name }, 'Site renamed'); setRenaming(null); }} />
                        : <strong>{p.name}</strong>}
                      <div className="muted" style={{ fontSize: 11.5 }}>{p.code}</div>
                    </td>
                    <td data-label="Area">{areaSelect(p.area || '', (v) => updateSite(p.id, { area: v }, `${p.name}: area saved`), `Area of ${p.name}`)}</td>
                    <td data-label="Status">
                      {canManage
                        ? <select value={p.status} aria-label={`Status of ${p.name}`} disabled={busy} onChange={(e) => updateSite(p.id, { status: e.target.value }, `${p.name}: ${e.target.value.replace('_', ' ')}`)}>
                            <option value="active">Active</option><option value="on_hold">On hold</option><option value="closed">Closed</option>
                          </select>
                        : <StatusBadge status={p.status} />}
                    </td>
                    {canManage && <td className="cell-actions"><button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setRenaming({ id: p.id, name: p.name })}>Rename</button></td>}
                  </tr>
                ))}</tbody>
              </table></div>
            )}
            {canManage && (
              <div className="card-pad" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', borderTop: '1px solid var(--border)' }}>
                <input placeholder="New site name" value={newSite.name} onChange={(e) => setNewSite((x) => ({ ...x, name: e.target.value }))} onKeyDown={(e) => { if (e.key === 'Enter') addSite(); }} />
                {areaSelect(newSite.area || areas[0] || '', (v) => setNewSite((x) => ({ ...x, area: v })), 'Area of the new site')}
                <button className="btn" disabled={busy || !newSite.name.trim()} onClick={addSite}>Add site</button>
              </div>
            )}
          </div>
        </div>
      )}
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
        {!rows ? <Skeleton /> : rows.length === 0 ? <Empty art="none-yet" text="No sites yet." /> : (
          <div className="table-wrap"><table className="responsive-table"><thead><tr><th>Code</th><th>Name</th><th>Project</th><th>Location</th><th>Status</th><th>Site Manager</th>{canManage && <th><span className="sr-only">Actions</span></th>}</tr></thead>
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
        {!rows ? <Skeleton /> : rows.length === 0 ? <Empty art="none-yet" text="No departments yet." /> : (
          <div className="table-wrap"><table className="responsive-table"><thead><tr><th>Code</th><th>Name</th><th>Head</th><th>Status</th>{canManage && <th><span className="sr-only">Actions</span></th>}</tr></thead>
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
  const TABS = [['buttons', 'Buttons'], ['notifications', 'Notifications'], ['features', 'Features'], ['branding', 'Branding & Logo'],
    ['fields', 'Built-in Fields'], ['custom', 'Custom Fields'], ...(isSystemAdmin(user) ? [['request-deletion', 'Delete request']] : []), ...(isSystemAdmin(user) && can(user, 'system.manage') ? [['knowledge', 'Footer quotes']] : [])];
  return (
    <div>
      <PageHead crumb="Configuration / Control Center" title="Control Center"
        sub="Super-admin control of the whole app: turn buttons on/off, choose which notifications and emails go out and to whom, upload the logo, show or hide any built-in field, and add your own custom fields." />
      <div className="control-tabs" role="tablist" aria-label="Control Center sections">
        {TABS.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={'control-tab' + (tab === k ? ' active' : '')}>{label}</button>
        ))}
      </div>
      {tab === 'buttons' && <ButtonsPanel user={user} />}
      {tab === 'notifications' && <NotificationsPanel user={user} />}
      {tab === 'features' && <FeaturesPanel user={user} />}
      {tab === 'branding' && <BrandingLogoPanel user={user} branding={branding} refreshBranding={refreshBranding} />}
      {tab === 'fields' && <BuiltinFieldsPanel user={user} />}
      {tab === 'custom' && <CustomFieldsPanel user={user} />}
      {tab === 'knowledge' && <KnowledgeLinesPanel />}
      {tab === 'request-deletion' && isSystemAdmin(user) && <RequestDeletionPanel user={user} />}
    </div>
  );
}

// Request-only deletion is deliberately kept in the System Admin control surface.
function RequestDeletionPanel({ user }) {
  const [rows, setRows] = useState([]);
  const [selected, setSelected] = useState(null);
  const [impact, setImpact] = useState(null);
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();
  const load = useCallback(() => api.get('/requests').then(r => setRows(r.requests || [])).catch(e => setError(e.message)), []);
  useEffect(() => { if (isSystemAdmin(user)) load(); }, [user, load]);
  if (!isSystemAdmin(user)) return null;
  async function review(row) {
    setSelected(null); setImpact(null); setReason(''); setConfirmation(''); setError(''); setBusy(true);
    try { const result = await api.get(`/requests/${row.id}/delete-impact`); setSelected(row); setImpact(result); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function removeRequest() {
    if (!selected || !impact || !reason.trim() || confirmation !== selected.ticketNo) return;
    setBusy(true); setError('');
    try {
      await api.call(`/requests/${selected.id}`, { method: 'DELETE', body: { reason: reason.trim() } });
      setSelected(null); setImpact(null); toast('Request deleted. Linked records preserved.'); await load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <div className="card card-pad">
    <h3>Delete request permanently</h3>
    <p>The request is permanently erased. Candidates, applications, interviews, offers, documents and history are preserved; their request link is removed.</p>
    {error && <div role="alert" className="form-error">{error}</div>}
    <div className="field"><label htmlFor="delete-request-choice">Request</label>
      <select id="delete-request-choice" disabled={busy} value={selected?.id || ''} onChange={e => { const row = rows.find(r => r.id === Number(e.target.value)); if (row) review(row); else { setSelected(null); setImpact(null); } }}>
        <option value="">Choose a request to review</option>
        {rows.map(r => <option key={r.id} value={r.id}>{r.ticketNo} — {r.title} ({r.status})</option>)}
      </select>
    </div>
    {selected && impact && <>
      {/* Only what is actually linked; zero counts are noise. */}
      <p>{(() => { const kept = Object.entries(impact.detached || {}).filter(([, v]) => v > 0);
        return kept.length ? `${kept.map(([k, v]) => `${v} ${k}`).join(' · ')} will be preserved.` : 'No linked records. Only the request itself will be erased.'; })()}</p>
      <div className="field"><label htmlFor="delete-request-reason">Reason</label><textarea id="delete-request-reason" value={reason} onChange={e => setReason(e.target.value)} disabled={busy} /></div>
      <div className="field"><label htmlFor="delete-request-confirm">Type {selected.ticketNo} to confirm permanent deletion</label><input id="delete-request-confirm" autoComplete="off" value={confirmation} onChange={e => setConfirmation(e.target.value)} disabled={busy} /></div>
      <button className="btn btn-danger" disabled={busy || !reason.trim() || confirmation !== selected.ticketNo} onClick={removeRequest}>{busy ? 'Deleting…' : 'Permanently delete request only'}</button>
    </>}
  </div>;
}

// --- Knowledge lines panel ---
// The owner's own list for the line at the foot of every page. Saved as the
// `knowledge_lines` system setting; empty means the bundled list is used.
const KL_TOPICS = ['leadership', 'teams', 'psychology', 'science', 'engineering', 'wisdom', 'history'];
// The same rules the server applies on save (lib/knowledge-lines.js), per row.
function klRowError(row, rows, skip) {
  const q = (row.q || '').trim(); const by = (row.by || '').trim();
  if (q.length < 3) return 'Write the quote.';
  if (q.length > 160) return `The quote is ${q.length} characters; keep it to 160.`;
  if (/\s[—–]\s/.test(q)) return 'Take out the spaced dash ( — ) from the quote; it separates the author.';
  if (!by) return 'Add the author.';
  if (/\s[—–]\s/.test(by)) return 'Take out the spaced dash ( — ) from the author.';
  if (rows.some((r, i) => i !== skip && r.q.trim().toLowerCase() === q.toLowerCase())) return 'This quote is already on the list.';
  return null;
}
function KlRowForm({ value, onChange, error, onSave, onCancel, saveLabel }) {
  const set = (k) => (e) => onChange({ ...value, [k]: e.target.value });
  return (
    <div className="kl-form">
      <div className="field kl-form-quote">
        <label htmlFor="kl-q">Quote</label>
        <textarea id="kl-q" rows="2" value={value.q} onChange={set('q')} autoFocus />
        <span className={'kl-count' + (value.q.trim().length > 160 ? ' error' : '')}>{value.q.trim().length} / 160</span>
      </div>
      <div className="field"><label htmlFor="kl-by">Author</label><input id="kl-by" value={value.by} onChange={set('by')} /></div>
      <div className="field"><label htmlFor="kl-t">Topic</label>
        <select id="kl-t" value={value.t || ''} onChange={set('t')}>
          <option value="">No topic</option>
          {KL_TOPICS.map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
        </select>
      </div>
      {error && value.q.trim() && <div className="kl-form-error" role="alert">{error}</div>}
      <div className="kl-form-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-secondary" disabled={!!error} onClick={onSave}>{saveLabel}</button>
      </div>
    </div>
  );
}
// The owner's footer quotes: add, edit, remove or replace any line, then save.
// Saved as the `knowledge_lines` system setting; empty means the built-in list.
function KnowledgeLinesPanel() {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [savedText, setSavedText] = useState('');
  const [baseline, setBaseline] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [filter, setFilter] = useState('');
  const [edit, setEdit] = useState(null); // { index: number | 'new', row }
  const [bulk, setBulk] = useState(null); // text while "Paste a list" is open
  const builtIn = () => (window.ARABTEC_KNOWLEDGE_LINES || []).map((l) => ({ q: l.q, by: l.by, ...(l.t ? { t: l.t } : {}) }));
  const load = useCallback(() => {
    setLoadError(null);
    api.get('/settings/system').then((r) => {
      const own = r.settings?.knowledge_lines || '';
      const list = own ? parseKnowledgeText(own).lines : builtIn();
      setSavedText(own); setRows(list); setBaseline(knowledgeLinesAsText(list));
    }).catch((e) => setLoadError(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);
  const dirty = !!rows && knowledgeLinesAsText(rows) !== baseline;
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  if (loadError) return <LoadError title="Could not load footer quotes" text={loadError} onRetry={load} />;
  if (!rows) return <Skeleton rows={5} />;
  const usingOwn = !!savedText.trim();
  async function persist(value, message) {
    setBusy(true);
    try {
      await api.put('/settings/system', { settings: { knowledge_lines: value } });
      const list = value ? parseKnowledgeText(value).lines : builtIn();
      setSavedText(value); applyOwnKnowledgeLines(value); setRows(list); setBaseline(knowledgeLinesAsText(list)); setEdit(null);
      toast(message);
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }
  const commitEdit = () => {
    const r = edit.row; const clean = { q: r.q.trim(), by: r.by.trim(), ...(r.t ? { t: r.t } : {}) };
    setRows(edit.index === 'new' ? [clean, ...rows] : rows.map((x, i) => (i === edit.index ? clean : x)));
    setEdit(null);
  };
  const remove = (i) => { if (window.confirm(`Remove this quote?\n\n“${rows[i].q}” — ${rows[i].by}\n\nIt leaves the footer when you save.`)) { setRows(rows.filter((_, j) => j !== i)); if (edit && edit.index === i) setEdit(null); } };
  const term = filter.trim().toLowerCase();
  const visible = rows.map((r, i) => ({ r, i })).filter(({ r }) => !term || `${r.q} ${r.by} ${r.t || ''}`.toLowerCase().includes(term));
  const bulkParsed = bulk != null ? parseKnowledgeText(bulk) : null;
  const editError = edit ? klRowError(edit.row, rows, edit.index === 'new' ? -1 : edit.index) : null;
  return (
    <div className="card kl-editor">
      <div className="card-head">
        <div><h3>Footer quotes</h3><div className="muted">One quote is shown at the foot of every page. Add, edit or remove quotes, then save. Each quote needs an author; up to 160 characters.</div></div>
        <span className="dash-headnote">{usingOwn ? 'Your list is in use' : 'Built-in list in use'} · {rows.length} {rows.length === 1 ? 'quote' : 'quotes'}</span>
      </div>
      <div className="card-pad">
        <div className="kl-toolbar">
          <input type="search" aria-label="Search quotes" placeholder="Search quote, author or topic…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button type="button" className="btn btn-secondary" disabled={!!edit || bulk != null} onClick={() => setEdit({ index: 'new', row: { q: '', by: '', t: '' } })}>Add quote</button>
          <button type="button" className="btn btn-ghost" disabled={!!edit} onClick={() => setBulk(bulk == null ? knowledgeLinesAsText(rows) : null)}>{bulk == null ? 'Paste a list' : 'Close paste'}</button>
        </div>
        {bulk != null && (
          <div className="kl-bulk">
            <label htmlFor="kl-bulk">Paste or edit the whole list — one per line: <code>Quote — Author — topic</code> (topic optional). Applying replaces the list below; nothing is saved until you press Save changes.</label>
            <textarea id="kl-bulk" rows="12" value={bulk} onChange={(e) => setBulk(e.target.value)} spellCheck="true" />
            <div className="kl-editor-foot">
              <span className={bulkParsed.errors.length ? 'kl-editor-count error' : 'kl-editor-count'} role="status">
                {bulkParsed.lines.length} {bulkParsed.lines.length === 1 ? 'line' : 'lines'}{bulkParsed.errors.length ? ` · ${bulkParsed.errors[0]}${bulkParsed.errors.length > 1 ? ` (+${bulkParsed.errors.length - 1} more)` : ''}` : ''}
              </span>
              <span className="kl-editor-actions">
                <button type="button" className="btn btn-ghost" onClick={() => setBulk(null)}>Cancel</button>
                <button type="button" className="btn btn-secondary" disabled={bulkParsed.errors.length > 0 || !bulkParsed.lines.length} onClick={() => { setRows(bulkParsed.lines); setBulk(null); }}>Apply to the list</button>
              </span>
            </div>
          </div>
        )}
        {edit && edit.index === 'new' && <KlRowForm value={edit.row} onChange={(row) => setEdit({ ...edit, row })} error={editError} onSave={commitEdit} onCancel={() => setEdit(null)} saveLabel="Add to the list" />}
        <table className="kl-table">
          <thead><tr><th scope="col">Quote</th><th scope="col">Author</th><th scope="col">Topic</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {visible.map(({ r, i }) => (edit && edit.index === i ? (
              <tr key={'e' + i}><td colSpan="4"><KlRowForm value={edit.row} onChange={(row) => setEdit({ ...edit, row })} error={editError} onSave={commitEdit} onCancel={() => setEdit(null)} saveLabel="Update quote" /></td></tr>
            ) : (
              <tr key={i}>
                <td className="kl-q">{r.q}</td>
                <td className="kl-by">{r.by}</td>
                <td className="kl-t">{r.t || <span className="muted">—</span>}</td>
                <td className="kl-actions">
                  <button type="button" className="btn btn-ghost btn-sm" disabled={!!edit || bulk != null} aria-label={`Edit: ${r.q}`} onClick={() => setEdit({ index: i, row: { q: r.q, by: r.by, t: r.t || '' } })}>Edit</button>
                  <button type="button" className="btn btn-ghost btn-sm kl-remove" disabled={!!edit || bulk != null} aria-label={`Remove: ${r.q}`} onClick={() => remove(i)}>Remove</button>
                </td>
              </tr>
            )))}
            {visible.length === 0 && <tr><td colSpan="4" className="muted">{term ? 'No quote matches that search.' : 'The list is empty — add a quote, or reset to the built-in list.'}</td></tr>}
          </tbody>
        </table>
        <div className="kl-editor-foot kl-savebar">
          <span className="kl-editor-count" role="status">{dirty ? 'Unsaved changes' : (usingOwn ? 'Saved' : 'Showing the built-in list')}</span>
          <span className="kl-editor-actions">
            <button type="button" className="btn btn-ghost" disabled={busy || !dirty} onClick={() => { setRows(parseKnowledgeText(baseline).lines); setEdit(null); }}>Discard changes</button>
            <button type="button" className="btn btn-ghost" disabled={busy || !usingOwn} onClick={() => { if (window.confirm('Reset to the built-in list? Your saved list will be replaced.')) persist('', 'Built-in list restored'); }}>Reset to the built-in list</button>
            <button type="button" className="btn" disabled={busy || !dirty || !rows.length || !!edit || bulk != null} onClick={() => persist(knowledgeLinesAsText(rows), 'Footer quotes saved')}>{busy ? 'Saving…' : 'Save changes'}</button>
          </span>
        </div>
      </div>
    </div>
  );
}

// --- Features panel ---
// Only a switch the server actually consults is offered as a control. The
// rest are shown as reserved, so an administrator is never handed a toggle
// that does nothing and left to wonder why.
function FeaturesPanel({ user }) {
  const toast = useToast();
  const [flags, setFlags] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [busyKey, setBusyKey] = useState(null);
  const load = useCallback(() => { setLoadError(null); api.get('/settings/features').then((r) => setFlags(r.features)).catch((e) => setLoadError(e.message)); }, []);
  useEffect(() => { load(); }, [load]);
  const canManage = can(user, 'system.manage');
  async function toggle(flag) {
    setBusyKey(flag.key);
    try {
      const r = await api.put(`/settings/features/${flag.key}`, { enabled: !flag.enabled });
      setFlags((fs) => fs.map((f) => (f.key === flag.key ? { ...f, enabled: r.enabled } : f)));
      toast(`${flag.label} ${r.enabled ? 'switched on' : 'switched off'}`);
    } catch (e) { toast(e.message, 'error'); } finally { setBusyKey(null); }
  }
  if (loadError) return <LoadError title="Could not load features" text={loadError} onRetry={load} />;
  if (!flags) return <Skeleton rows={5} />;
  const live = flags.filter((f) => f.enforced), reserved = flags.filter((f) => !f.enforced);
  return (
    <div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head"><div><h3>Switches in effect</h3></div><span className="dash-headnote">Changes are audited</span></div>
        {live.length === 0 ? <Empty text="No switchable feature in this version." /> : live.map((f) => (
          <div key={f.key} className="card-pad" style={{ display: 'flex', gap: 16, alignItems: 'flex-start', borderTop: '1px solid var(--border)' }}>
            <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600 }}>{f.label}</div><div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{f.description}</div></div>
            <label className="switch" style={{ flexShrink: 0 }}>
              <input type="checkbox" checked={f.enabled} disabled={!canManage || busyKey === f.key} onChange={() => toggle(f)} />
              {f.enabled ? 'On' : 'Off'}
            </label>
          </div>
        ))}
      </div>
      {reserved.length > 0 && (
        <div className="card">
          <div className="card-head"><div><h3>Reserved</h3></div><span className="dash-headnote">Listed for transparency; no switch has an effect yet</span></div>
          {reserved.map((f) => (
            <div key={f.key} className="card-pad" style={{ borderTop: '1px solid var(--border)' }}>
              <div style={{ fontWeight: 600, color: 'var(--muted)' }}>{f.label}</div><div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{f.description}</div>
            </div>
          ))}
        </div>
      )}
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
            <td><strong>{b.label}</strong><div className="muted fine-key">{b.buttonKey}</div></td>
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
// Column headings for the notification grid: short, with the full sentence
// on hover (title) and on the phone's stacked label.
const NOTIF_WHO_SHORT = {
  requester: 'Requester', owner: 'Recruiter', hiring_manager: 'Hiring manager',
  approvers: 'Approvers', panel: 'Panel', candidate: 'Candidate', actor: 'Who acted',
};
function NotificationsPanel({ user }) {
  const [ivTemplates, setIvTemplates] = useState(false);
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
      {/* The words of interview invitations live with the interviews; this is the second way in. */}
      <div className="iv-tpl-link">
        <span className="muted">Interview working days and hours, the Head Office address, and the wording of invitations, updates and cancellations live in Scheduling Setup.</span>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setIvTemplates(true)}>Scheduling Setup</button>
      </div>
      {ivTemplates && <InterviewTemplatesModal onClose={() => setIvTemplates(false)} />}
      {!data.emailConfigured && (
        <div className="notice notice-warn card-pad" style={{ marginBottom: 14 }}>
          <strong>No mailbox is configured.</strong> In-app alerts still work; anything ticked
          for email is recorded but will not send until a mailbox is connected in <a href="#email">Email &amp; Mailbox</a>.
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
            <table className="table notif-grid">
              {/* One grid: events down the side, who is told across the top,
                  one tick where they meet. It replaced a block of seven
                  labelled checkboxes repeated under every event (review C2). */}
              <thead><tr>
                <th className="notif-event">Event</th>
                <th className="notif-tick">On</th>
                <th className="notif-tick">In-app</th>
                <th className="notif-tick">Email</th>
                {Object.entries(data.recipients).map(([token, label]) => (
                  <th key={token} className={'notif-tick notif-who' + (external.has(token) ? ' recip-external' : '')} title={label}>
                    {NOTIF_WHO_SHORT[token] || label.split(' — ')[0]}
                  </th>
                ))}
              </tr></thead>
              <tbody>
                {data.notifications.filter((n) => n.category === cat).map((n) => {
                  const busy = saving.has(n.eventKey);
                  const off = !n.enabled;
                  return (
                    <tr key={n.eventKey} style={busy ? { opacity: .55 } : null}>
                      <td data-label="Event">
                        {/* Two fixed lines: label, then one clamped line (full text on hover).
                            The candidate-facing warning stays visible as words, inline. */}
                        <span className="cell-strong">{n.label}</span>
                        <span className="cell-sub notif-desc" title={n.description}>
                          {n.externalRecipients.length > 0 && n.enabled && n.email && <span className="notif-ext">Reaches candidates · </span>}
                          {n.description}
                        </span>
                      </td>
                      <td data-label="On" className="notif-tick">
                        <input type="checkbox" checked={n.enabled} disabled={!canEdit || busy}
                          aria-label={`Enable ${n.label}`}
                          onChange={(e) => patch(n.eventKey, { enabled: e.target.checked })} />
                      </td>
                      <td data-label="In-app" className="notif-tick">
                        <input type="checkbox" checked={n.inApp} disabled={!canEdit || busy || off}
                          aria-label={`In-app alert for ${n.label}`}
                          onChange={(e) => patch(n.eventKey, { inApp: e.target.checked })} />
                      </td>
                      <td data-label="Email" className="notif-tick">
                        <input type="checkbox" checked={n.email} disabled={!canEdit || busy || off}
                          aria-label={`Email for ${n.label}`}
                          onChange={(e) => patch(n.eventKey, { email: e.target.checked })} />
                      </td>
                      {Object.entries(data.recipients).map(([token, label]) => (
                        <td key={token} data-label={label.split(' — ')[0]} className={'notif-tick' + (external.has(token) ? ' recip-external' : '')}>
                          <input type="checkbox" checked={n.recipients.includes(token)}
                            aria-label={`${label.split(' — ')[0]} — ${n.label}`}
                            disabled={!canEdit || busy || off}
                            onChange={() => toggleRecipient(n, token)} />
                        </td>
                      ))}
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
  const [f, setF] = useState({ app_name: branding?.app_name || 'Arabtec', button_color: branding?.button_color || '#008064' });
  const actionColorOk = hasWhiteTextContrast(f.button_color);
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
    <div className="detail-grid">
      <div className="card card-pad">
        <div className="section-title" style={{ marginTop: 0 }}>Logo</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 12 }}>
          <div style={{ width: 96, height: 72, border: '1px solid var(--border)', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fff', overflow: 'hidden' }}>
            {hasLogo ? <img src={`/api/admin-ui/logo?v=${logoVersion}`} alt="Logo" style={{ maxWidth: '100%', maxHeight: '100%' }} /> : <Logo size={40} withText />}
          </div>
          <div>
            <label className="btn btn-sm" style={{ cursor: 'pointer' }}>{busy ? 'Uploading…' : (hasLogo ? 'Replace Logo' : '+ Upload Logo')}
              <input type="file" style={{ display: 'none' }} accept=".png,.jpg,.jpeg,.svg" onChange={uploadLogo} disabled={busy} /></label>
            {hasLogo && isSystemAdmin(user) && <button className="btn btn-sm btn-ghost" style={{ marginLeft: 8 }} onClick={removeLogo} disabled={busy}>Remove</button>}
            <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>PNG, JPG or SVG. Shown app-wide and on the login screen.</div>
          </div>
        </div>
      </div>
      <div className="card card-pad">
        <div className="section-title" style={{ marginTop: 0 }}>Identity</div>
        <div className="field"><label>App Name</label><input value={f.app_name} onChange={(e) => setF((s) => ({ ...s, app_name: e.target.value }))} /></div>
        <div className="field"><label>Primary Action Color</label><input type="color" value={f.button_color} onChange={(e) => setF((s) => ({ ...s, button_color: e.target.value }))} style={{ width: 60, height: 32, padding: 2 }} />
          {!actionColorOk && <div className="field-hint" role="alert">Choose a darker color so white button text remains readable.</div>}
        </div>
        <button className="btn" onClick={saveBranding} disabled={busy || !actionColorOk} style={{ marginTop: 10 }}>{busy ? 'Saving…' : 'Save'}</button>
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
              <td><strong>{fl.defaultLabel}</strong><div className="muted fine-key">{fl.fieldKey}</div></td>
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
      {!fields ? <Skeleton rows={4} /> : fields.length === 0 ? <Empty art="none-yet" text="No custom fields yet. Add one above." /> : (
        <table><thead><tr><th>Label</th><th>Key</th><th>Type</th><th>Required</th><th>Visible</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{fields.map((cf) => (
            <tr key={cf.fieldKey}>
              <td><strong>{cf.label}</strong></td>
              <td className="muted fine-key">{cf.fieldKey}</td>
              <td><span className="chip">{cf.fieldType}</span></td>
              <td><input type="checkbox" checked={cf.required} onChange={(e) => toggle(cf.fieldKey, { required: e.target.checked })} /></td>
              <td><input type="checkbox" checked={cf.visible} onChange={(e) => toggle(cf.fieldKey, { visible: e.target.checked })} /></td>
              <td>{isSystemAdmin(user) && <button className="btn btn-sm btn-ghost" onClick={() => remove(cf.fieldKey)}>Delete</button>}</td>
            </tr>
          ))}</tbody></table>
      )}
      <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>Custom fields appear on the {entity === 'candidate' ? 'Add/Edit Candidate' : 'Create/Edit Request'} form and save with the record.</div>
    </div>
  );
}

function BrandingPage({ user, branding, refreshBranding }) {
  const toast = useToast();
  const [f, setF] = useState({ button_color: '#008064', ...(branding || {}) });
  const [busy, setBusy] = useState(false);
  const canManage = can(user, 'branding.manage');
  const actionColorOk = hasWhiteTextContrast(f.button_color);
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
        actions={canManage && <><button className="btn btn-ghost" onClick={reset}>Revert</button><button className="btn" onClick={save} disabled={busy || !actionColorOk}>{busy ? 'Saving…' : 'Save Branding'}</button></>} />
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
        {!actionColorOk && <div className="error-banner" role="alert">Primary action color needs stronger contrast with white text before it can be saved.</div>}
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
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [offerRequired, setOfferRequired] = useState(true);
  const [confirmOfferOff, setConfirmOfferOff] = useState(false);
  const load = useCallback(() => {
    setLoadError(null);
    Promise.all([api.get('/settings/workflows'), api.get('/settings/system')])
      .then(([w, sys]) => { setRows(w.workflows); setOfferRequired((sys.settings || {}).offer_approval_required !== 'false'); })
      .catch((e) => setLoadError(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);
  const canManage = can(user, 'workflow.manage');
  const canManageOffers = can(user, 'system.manage');
  async function setOfferApproval(required) {
    setBusy(true);
    try {
      const r = await api.put('/settings/system', { settings: { offer_approval_required: required ? 'true' : 'false' } });
      setOfferRequired((r.settings || {}).offer_approval_required !== 'false');
      toast(required ? 'HR Director approval of offers is required again' : 'Offer approval step switched off');
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); setConfirmOfferOff(false); }
  }
  // The approval step is the `approval_chain` row's active flag. Switching it
  // off is confirmed first, because from then on every submitted request goes
  // straight to sourcing; the server audits the change and marks each request
  // that skipped the step.
  async function setApproval(isActive) {
    setBusy(true);
    try {
      const r = await api.put('/settings/workflows/approval_chain', { isActive });
      setRows((rs) => rs.map((w) => (w.key === 'approval_chain' ? r.workflow : w)));
      toast(isActive ? 'HR Director approval is required again' : 'Approval step switched off');
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); setConfirmOff(false); }
  }
  const head = <PageHead crumb="Configuration / Workflow" title="Workflow Settings" sub="The one approval step that gates sourcing, and the state machines that drive requests and applications." />;
  if (loadError) return <div>{head}<LoadError title="Could not load workflow settings" text={loadError} onRetry={load} /></div>;
  if (!rows) return <div>{head}<Skeleton rows={6} /></div>;
  const approval = rows.find((w) => w.key === 'approval_chain');
  return (
    <div>
      {head}
      {approval && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head"><div><h3>Hiring request approval</h3></div><Badge variant={approval.isActive ? 'success' : 'warning'}>{approval.isActive ? 'Required' : 'Off'}</Badge></div>
          <div className="card-pad">
            <p style={{ margin: '0 0 14px', maxWidth: 640 }}>{approval.isActive
              ? 'A submitted request waits for the HR Director\u2019s decision before sourcing can begin. One step, one approver.'
              : 'A submitted request is approved at once and sourcing can begin. Each request that skips the step is marked as auto-approved in its activity and in the audit log.'}</p>
            {canManage
              ? (approval.isActive
                ? <button className="btn btn-secondary" disabled={busy} onClick={() => setConfirmOff(true)}>Switch approval off</button>
                : <button className="btn" disabled={busy} onClick={() => setApproval(true)}>Require HR Director approval</button>)
              : <p className="muted" style={{ margin: 0 }}>Only a user with workflow management rights can change this.</p>}
          </div>
        </div>
      )}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head"><div><h3>Offer approval</h3></div><Badge variant={offerRequired ? 'success' : 'warning'}>{offerRequired ? 'Required' : 'Off'}</Badge></div>
        <div className="card-pad">
          <p style={{ margin: '0 0 14px', maxWidth: 640 }}>{offerRequired
            ? 'A submitted offer waits for the HR Director\u2019s decision before it can be sent. One step, one approver, whatever the salary.'
            : 'A submitted offer is approved at once and can be sent. Each offer that skips the step is marked as auto-approved in its activity and in the audit log.'}</p>
          {canManageOffers
            ? (offerRequired
              ? <button className="btn btn-secondary" disabled={busy} onClick={() => setConfirmOfferOff(true)}>Switch offer approval off</button>
              : <button className="btn" disabled={busy} onClick={() => setOfferApproval(true)}>Require HR Director approval</button>)
            : <p className="muted" style={{ margin: 0 }}>Only a system administrator can change this.</p>}
        </div>
      </div>
      {confirmOfferOff && <Confirm title="Switch offer approval off?" confirmLabel="Switch off" danger
        message="From now on, every submitted offer is approved at once and can be sent without the HR Director's decision. Offers already waiting for approval are not changed. This change is recorded in the audit log."
        onConfirm={() => setOfferApproval(false)} onClose={() => setConfirmOfferOff(false)} />}
      {confirmOff && <Confirm title="Switch approval off?" confirmLabel="Switch off" danger
        message="From now on, every submitted or resubmitted hiring request goes straight to sourcing without the HR Director's decision. Requests already waiting for approval are not changed. This change is recorded in the audit log."
        onConfirm={() => setApproval(false)} onClose={() => setConfirmOff(false)} />}
      {rows.filter((w) => w.key !== 'approval_chain').map((w) => (
        <div className="card" key={w.key} style={{ marginBottom: 16 }}>
          <div className="card-head"><h3>{w.name}</h3><Badge variant={w.isActive ? 'success' : 'soft'}>{w.isActive ? 'active' : 'inactive'}</Badge></div>
          <div className="card-pad">
            {Object.entries(w.value).map(([group, items]) => (
              <div key={group} style={{ marginBottom: 10 }}>
                <div className="muted" style={{ textTransform: 'capitalize', marginBottom: 6 }}>{group}</div>
                <div>{(items || []).map((s, i) => <span key={i} className="chip" title={s}>{s}</span>)}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
      <p className="muted">Visual editing of states &amp; transitions ships with the Admin Workflow Designer in a later phase.</p>
    </div>
  );
}

/* ----------------------------- Microsoft 365 ----------------------------- */
/*
   The delegated mailbox connection for career@arabtecegy.com.

   One button does the whole setup: Connect sends the administrator to
   Microsoft, they sign in as the careers mailbox, and the ATS keeps a
   refreshable delegated grant. There is nothing here to paste — no tenant id,
   no client secret, no password. Those live in the server environment and this
   screen never sees them; it is told only WHICH variable names are still
   missing, never a value.
*/
const MS_STATE = {
  CONNECTED: { label: 'Connected', variant: 'success' },
  RECONNECT_REQUIRED: { label: 'Reconnect required', variant: 'warning' },
  DISCONNECTED: { label: 'Disconnected', variant: 'soft' },
  ERROR: { label: 'Error', variant: 'critical' },
};

// The callback comes back with a code, not a sentence. One place turns each
// distinguishable failure into something an administrator can act on.
const MS_CALLBACK_MESSAGE = {
  'wrong-account': (p) => `That Microsoft account is not the careers mailbox. Sign in as ${p.expected || 'the configured mailbox'} and try again.`,
  'wrong-tenant': () => 'That Microsoft account belongs to a different tenant. Sign in with the Arabtec account.',
  'consent-denied': () => 'Consent was not granted, so nothing was connected. Run Connect again and accept the requested permissions.',
  'invalid-state': () => 'That sign-in link had expired or had already been used. Start again from Connect Microsoft 365.',
  'missing-code': () => 'Microsoft did not return an authorization code. Start again from Connect Microsoft 365.',
  'token-cache-missing': () => 'Microsoft returned no refresh token. Check that offline_access is granted on the app registration, then try again.',
  'reconnect-required': () => 'Microsoft 365 connection requires sign-in again.',
  'graph-unavailable': () => 'Microsoft could not be reached. Check the server’s outbound HTTPS access and try again.',
  'graph-throttled': () => 'Microsoft is throttling requests. Wait a moment and try again.',
  'not-configured': () => 'The integration is not configured on this server yet.',
};

function MicrosoftPage({ user, params }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);          // 'connect' | 'test' | 'sync' | 'disconnect'
  const [result, setResult] = useState(null);      // last test / scan outcome, shown inline
  const [deviceCode, setDeviceCode] = useState(null);
  const canManage = can(user, 'system.manage');

  const load = useCallback(async () => {
    try {
      const r = await api.get('/integrations/microsoft/status');
      setData(r); setErr(null);
      // The server owns the flow; mirror whatever it reports so a code survives
      // a page reload and a completed sign-in clears itself.
      if (r.deviceCode) setDeviceCode(r.deviceCode);
      else setDeviceCode(null);
    } catch (e) { setErr(e.message || 'Could not read the Microsoft 365 connection.'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // While a device sign-in is outstanding, poll for its outcome. Stops as soon
  // as it resolves, so an idle admin page is not polling in the background.
  const devicePending = deviceCode && (deviceCode.state === 'pending' || deviceCode.state === 'starting');
  useEffect(() => {
    if (!devicePending) return undefined;
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, [devicePending, load]);

  // Announce the result of a device sign-in once.
  const deviceState = deviceCode && deviceCode.state;
  const announced = useRef(null);
  useEffect(() => {
    if (!deviceState || announced.current === deviceState) return;
    if (deviceState === 'connected') { announced.current = deviceState; toast('Microsoft 365 connected.'); }
    if (deviceState === 'failed') {
      announced.current = deviceState;
      const build = MS_CALLBACK_MESSAGE[deviceCode.error];
      toast(build ? build({ expected: data?.mailbox }) : 'The Microsoft 365 sign-in did not complete.', 'error');
    }
  }, [deviceState, deviceCode, data, toast]);

  // The outcome of an OAuth round trip, handed over in the redirect the callback
  // issued. Shown once, then the shell has already cleared it from the URL.
  useEffect(() => {
    if (!params || !params.microsoft) return;
    if (params.microsoft === 'connected') toast('Microsoft 365 connected.');
    else {
      const build = MS_CALLBACK_MESSAGE[params.code];
      toast(build ? build(params) : 'The Microsoft 365 sign-in did not complete.', 'error');
    }
  }, [params, toast]);

  async function connect() {
    setBusy('connect');
    try {
      // The server builds the authorize URL (it holds the client id and the
      // redirect URI); the browser makes the top-level navigation, which is what
      // Microsoft requires. The API client sends a bearer token, so a plain link
      // would arrive unauthenticated.
      const r = await api.get('/integrations/microsoft/connect');
      // Device code has no redirect to navigate to: Microsoft issues a short
      // code, the administrator types it on microsoft.com, and the server polls
      // until they finish. Show the code and let /status report the outcome.
      if (r.mode === 'device-code') {
        setDeviceCode(r.deviceCode || null);
        setBusy(null);
        return;
      }
      window.location.assign(r.authUrl);
    } catch (e) {
      setBusy(null);
      toast(e.message || 'Could not start the Microsoft sign-in.', 'error');
    }
  }

  async function act(kind, path, okMessage) {
    setBusy(kind); setResult(null);
    try {
      const r = await api.post(path, {});
      setResult({ kind, ok: true, body: r });
      toast(typeof okMessage === 'function' ? okMessage(r) : okMessage);
    } catch (e) {
      setResult({ kind, ok: false, body: e.data || { error: e.message } });
      toast(e.message || 'The request failed.', 'error');
    } finally {
      setBusy(null);
      load();
    }
  }

  if (err) return <div className="error-banner">{err}</div>;
  if (!data) return <div className="card"><Skeleton rows={7} /></div>;

  const state = MS_STATE[data.status] || MS_STATE.DISCONNECTED;
  const connected = data.connected === true;
  // ERROR describes the last SCAN, not the grant. The backend accepts Test and
  // Scan in that state and tries to recover, so disabling them here pushed an
  // administrator toward an unnecessary OAuth reconnect — or a day's wait for
  // the next timer — for what may have been a moment's throttling. Only the two
  // states that genuinely need a new sign-in disable the recovery actions.
  const canAttempt = data.hasTokenCache === true
    && data.status !== 'DISCONNECTED' && data.status !== 'RECONNECT_REQUIRED';

  return (
    <div>
      <PageHead
        crumb="Configuration / Microsoft 365"
        title="Microsoft 365"
        sub="Delegated mailbox connection for the careers inbox. CVs arriving by email enter the same reviewed intake queue as uploaded CVs."
        actions={canManage && (
          <button className="btn btn-ghost" onClick={load} disabled={busy !== null}>Refresh</button>
        )}
      />

      {!data.configured && (
        <div className="notice notice-warn card-pad" style={{ marginBottom: 14 }}>
          <strong>Not configured on this server.</strong> The following environment
          variables still need to be set before anyone can connect:{' '}
          {(data.missing || []).length === 0 ? '—' : data.missing.map((name, i) => (
            <React.Fragment key={name}>{i > 0 && ', '}<code>{name}</code></React.Fragment>
          ))}.
          They are set by an administrator on the server, never in this screen.
        </div>
      )}

      {data.reconnectRequired && (
        <div className="notice notice-warn card-pad" style={{ marginBottom: 14 }}>
          <strong>Microsoft 365 connection requires sign-in again.</strong>{' '}
          Scheduled inbox scans are paused until an administrator reconnects.
        </div>
      )}

      <section className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <h3>Connection</h3>
          <Badge variant={state.variant}>{state.label}</Badge>
        </div>
        <div className="card-pad">
          <div className="form-grid">
            <Info label="Mailbox">
              {connected ? `Connected as ${data.mailbox}` : (data.mailbox || '—')}
            </Info>
            <Info label="Connected">{data.connectedAt ? fmtDate(data.connectedAt) : '—'}</Info>
            <Info label="Last inbox sync">{data.lastSuccessfulSyncAt ? fmtDate(data.lastSuccessfulSyncAt) : 'Never'}</Info>
            <Info label="Last attempt">{data.lastAttemptAt ? fmtDate(data.lastAttemptAt) : '—'}</Info>
            <Info label="Last sync result">
              {data.lastResult
                ? `${data.lastResult.imported ?? 0} imported, ${data.lastResult.skipped ?? 0} skipped, ${data.lastResult.failed ?? 0} failed`
                : '—'}
            </Info>
            <Info label="Reads from">Inbox only, since {data.baselineAt ? fmtDate(data.baselineAt) : 'the connection date'}</Info>
          </div>

          {data.lastError && (
            <div className="notice notice-warn card-pad" style={{ marginTop: 4 }}>
              <strong>Last error:</strong> {data.lastError}
            </div>
          )}

          <div className="muted" style={{ marginTop: 12, fontSize: 12 }}>
            Permissions requested: {(data.scopes || []).join(', ')}. The ATS never
            marks mail read, moves it, or deletes it — duplicates are prevented in
            the ATS database instead.
          </div>
        </div>
      </section>

      {/* A device sign-in in progress. Not an OAuth internal — it is the one
          thing the administrator has to act on, so it sits above the actions. */}
      {canManage && devicePending && deviceCode.userCode && (
        <section className="card notice notice-info" style={{ marginBottom: 16 }}>
          <div className="card-head"><h3>Finish signing in to Microsoft 365</h3></div>
          <div className="card-pad">
            <p style={{ marginTop: 0 }}>
              Open <a href={deviceCode.verificationUri || 'https://login.microsoft.com/device'}
                target="_blank" rel="noopener noreferrer">{deviceCode.verificationUri || 'login.microsoft.com/device'}</a>
              {' '}and enter this code, signing in as <strong>{data.mailbox}</strong>:
            </p>
            <p className="device-code" style={{
              fontSize: 30, fontWeight: 700, letterSpacing: '.16em',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', margin: '12px 0',
            }}>{deviceCode.userCode}</p>
            <p className="muted" style={{ marginBottom: 0 }}>
              Waiting for you to finish… this page updates itself. The code expires
              {deviceCode.expiresAt ? ' at ' + new Date(deviceCode.expiresAt).toLocaleTimeString() : ' in about 15 minutes'}.
            </p>
          </div>
        </section>
      )}

      {canManage && (
        <section className="card" style={{ marginBottom: 16 }}>
          <div className="card-head"><h3>Actions</h3></div>
          <div className="card-pad" style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn" onClick={connect} disabled={!data.configured || busy !== null}>
              {busy === 'connect' ? 'Starting…'
                : devicePending ? 'Waiting for sign-in…'
                  : connected ? 'Reconnect' : 'Connect Microsoft 365'}
            </button>
            <button className="btn btn-ghost" disabled={!canAttempt || busy !== null}
              onClick={() => act('test', '/integrations/microsoft/test', (r) => r.message || 'Connection is healthy.')}>
              {busy === 'test' ? 'Testing…' : 'Test connection'}
            </button>
            <button className="btn btn-ghost" disabled={!canAttempt || busy !== null}
              onClick={() => act('sync', '/integrations/microsoft/sync',
                (r) => `Scan complete: ${r.imported} imported, ${r.skipped} skipped, ${r.failed} failed.`)}>
              {busy === 'sync' ? 'Scanning…' : 'Scan inbox now'}
            </button>
            <div className="spacer" style={{ flex: 1 }} />
            <button className="btn btn-danger" disabled={!data.hasTokenCache || busy !== null}
              onClick={() => act('disconnect', '/integrations/microsoft/disconnect', 'Microsoft 365 disconnected.')}>
              {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </div>
          <div className="card-pad" style={{ paddingTop: 0 }}>
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>
              Connect opens a Microsoft sign-in page. Sign in there as{' '}
              <strong>{data.mailbox}</strong> — any other account is refused. The
              password is entered at Microsoft and is never seen by the ATS.
              Imported CVs appear in <strong>Candidate Review</strong> as pending
              intakes; no candidate is created until a person approves one.
            </p>
          </div>
        </section>
      )}

      {result && (
        <div className={'notice card-pad ' + (result.ok ? 'notice-info' : 'notice-warn')} style={{ marginBottom: 16 }}>
          <strong>{result.kind === 'sync' ? 'Scan' : result.kind === 'test' ? 'Test' : 'Result'}:</strong>{' '}
          {result.ok
            ? (result.body.message
              || `${result.body.imported ?? 0} imported, ${result.body.skipped ?? 0} skipped, ${result.body.failed ?? 0} failed.`)
            : (result.body.error || 'The request failed.')}
        </div>
      )}

      {(data.recentIngestions || []).length > 0 && (
        <section className="card">
          <div className="card-head"><h3>Recent mailbox attachments</h3>
            <span className="dash-headnote">{data.recentIngestions.length} most recent</span></div>
          <div className="table-wrap">
            <table className="table responsive-table">
              <thead><tr><th>Attachment</th><th>Received</th><th>Outcome</th><th>Detail</th></tr></thead>
              <tbody>
                {data.recentIngestions.map((r) => (
                  <tr key={r.dedup_key}>
                    <td data-label="Attachment">{r.attachment_name || '—'}</td>
                    <td data-label="Received"><DateCell value={r.received_at || r.created_at} /></td>
                    <td data-label="Outcome">
                      <Badge variant={r.status === 'IMPORTED' ? 'success' : r.status === 'FAILED' ? 'critical' : 'soft'}>
                        {r.status}
                      </Badge>
                    </td>
                    <td data-label="Detail" className="muted">
                      {r.intake_id ? `Intake #${r.intake_id}` : (r.reason || '—')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
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
      <section className="card card-pad" aria-labelledby="developer-credit-heading" style={{ marginBottom: 16 }}>
        <h2 id="developer-credit-heading">About this system</h2>
        <p>Developed by Moutaz Adly</p>
      </section>
      <div className="card card-pad"><div className="form-grid">
        {Object.entries(s).map(([k, v]) => (
          <div className="field" key={k}><label>{k.replace(/_/g, ' ')}</label>
            <input type={/pass|secret|token|credential|pwd|api[_-]?key|_key$/i.test(k) ? 'password' : 'text'}
              autoComplete="off" value={v} disabled={!canManage} onChange={(e) => set(k, e.target.value)} /></div>
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
        {!data ? <Skeleton /> : data.logs.length === 0 ? <Empty art="none-yet" text="No audit entries match." /> : (
          <table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Comments</th><th><span className="sr-only">Actions</span></th></tr></thead>
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
// Priority is a level, not a state, so it is not a coloured pill: pills carry
// status, and a green "Medium" read exactly like a green "Sourcing" beside it
// (review R1). Bars show the level; only Critical takes a colour.
function PriorityBadge({ p }) {
  const x = PRIORITY[p] || { label: p };
  const level = { low: 1, medium: 2, high: 3, critical: 3 }[p] || 0;
  return <span className={'prio prio-' + (p || 'none')} title={`${x.label} priority`}>
    <span className="prio-bars" aria-hidden="true">{[1, 2, 3].map((i) => <i key={i} className={i <= level ? 'on' : ''} />)}</span>{x.label}
  </span>;
}
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
function ListSkeleton() { return <Skeleton shape="list" />; }

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
          <div><dt>Location</dt><dd title={place}>{place}</dd></div>
          {r.headcount != null && <div><dt>Headcount</dt><dd>{r.headcountFilled ?? 0} of {r.headcount}</dd></div>}
        </dl>

        <div className="rq-pipe">{r.pipeline ? <FunnelMini pipeline={r.pipeline} /> : null}</div>

        <div className="rq-foot">
          <ReqStatusBadge status={r.status} displayStatus={r.displayStatus} />
          {r.health && <ReqHealth health={r.health} status={r.status} />}
        </div>
      </div>
    </div>
  );
}

// A request "needs action" the same way ManagerDashboard already judges it:
// overdue on health, or the SLA clock itself has tripped. One definition,
// reused by the dashboard card, this toggle, and the filter chip's label.
function needsAction(r) { return (r.health || {}).level === 'red' || (r.health || {}).level === 'amber' || !!r.slaBreached; }

// Focus filters for the hiring-process strip (client-side over the list).
const REQ_FOCUS = [['awaiting', 'Awaiting approval'], ['unassigned', 'Needs a recruiter'], ['nocands', 'No candidates yet'], ['interview', 'Interviewing'], ['offer', 'Offer stage'], ['filled', 'Filled']];
const RF_INTERVIEW = ['interviewing', 'interview_hr', 'interview_technical', 'interview_1', 'interview_2', 'waiting_feedback'];
const RF_OFFER = ['issuing_offer', 'offer', 'offer_sent'];
function reqStageCount(r, list) { const b = (r.pipeline || {}).byStage || {}; return list.reduce((n, k) => n + (b[k] || 0), 0); }
function inFocus(r, focus) {
  const running = isOpenReq(r) && r.status !== 'pending_approval';
  switch (focus) {
    case 'awaiting': return r.status === 'pending_approval';
    case 'unassigned': return running && !r.owner;
    case 'nocands': return running && !!r.owner && !((r.pipeline || {}).total);
    case 'interview': return running && reqStageCount(r, RF_INTERVIEW) > 0;
    case 'offer': return running && reqStageCount(r, RF_OFFER) > 0;
    case 'filled': return r.status === 'filled';
    default: return true;
  }
}
function atRiskReq(r) { const h = r.health || {}; return isOpenReq(r) && r.status !== 'pending_approval' && (h.level === 'red' || h.level === 'amber' || (h.daysToTarget != null && h.daysToTarget < 0)); }
// Director / Executive: the eagle-eye view, then every number per project.
function RequestsOverview({ all, meta, onPick }) {
  const [open, setOpen] = useState(false);
  if (!all) return <div className="req-overview"><Skeleton rows={2} /></div>;
  const running = all.filter((r) => isOpenReq(r) && r.status !== 'pending_approval');
  const awaiting = all.filter((r) => r.status === 'pending_approval');
  const planned = all.filter(isOpenReq).reduce((n, r) => n + (r.headcount || 0), 0);
  const filled = all.filter(isOpenReq).reduce((n, r) => n + (r.headcountFilled || 0), 0);
  const risk = all.filter(atRiskReq);
  const critical = running.filter((r) => r.priority === 'critical');
  const pipeline = running.reduce((n, r) => n + ((r.pipeline || {}).total || 0), 0);
  const byProject = new Map();
  for (const r of all) {
    const key = r.projectId || 0;
    const row = byProject.get(key) || { id: r.projectId, name: (r.project || {}).name || 'No project', requests: 0, open: 0, awaiting: 0, planned: 0, filled: 0, pipeline: 0, risk: 0 };
    row.requests++; if (isOpenReq(r) && r.status !== 'pending_approval') row.open++; if (r.status === 'pending_approval') row.awaiting++;
    if (isOpenReq(r)) { row.planned += r.headcount || 0; row.filled += r.headcountFilled || 0; row.pipeline += (r.pipeline || {}).total || 0; }
    if (atRiskReq(r)) row.risk++;
    byProject.set(key, row);
  }
  const projects = [...byProject.values()].sort((a, b) => b.planned - a.planned || a.name.localeCompare(b.name));
  return (
    <section className="req-overview" aria-label="Hiring requests at a glance">
      <div className="dash-kpi-row dash-kpi-6">
        <KpiCard label="Open roles" value={running.length} meta="Approved and recruiting" onClick={() => onPick({ openOnly: true })} />
        <KpiCard label="Awaiting approval" value={awaiting.length} tone={awaiting.length ? 'kpi-attn' : ''} meta="Sourcing starts at approval" onClick={() => onPick({ focus: 'awaiting' })} />
        <KpiCard label="Seats" value={`${filled} / ${planned}`} meta={planned ? `${Math.round(filled / planned * 100)}% filled` : 'No open seats'} />
        <KpiCard label="At risk" value={risk.length} tone={risk.length ? 'kpi-risk' : ''} meta="Overdue or past target date" onClick={() => onPick({ attention: true })} />
        <KpiCard label="Critical open" value={critical.length} meta="Flagged critical" onClick={() => onPick({ priority: 'critical' })} />
        <KpiCard label="In pipeline" value={pipeline} meta="Candidates on open roles" />
      </div>
      <button type="button" className="btn btn-secondary dash-details-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide' : 'Show'} the numbers for each project ({projects.length}) <Icon name="chevronDown" size={16} />
      </button>
      {open && (
        <div className="card flush"><div className="table-wrap"><table className="table responsive-table req-projects">
          <thead><tr><th>Project</th><th>Requests</th><th>Open</th><th>Awaiting approval</th><th>Seats filled</th><th>In pipeline</th><th>At risk</th><th><span className="sr-only">Show</span></th></tr></thead>
          <tbody>{projects.map((p) => (
            <tr key={p.id || 'none'}>
              <td data-label="Project"><span className="cell-strong">{p.name}</span></td>
              <td data-label="Requests">{p.requests}</td>
              <td data-label="Open">{p.open}</td>
              <td data-label="Awaiting approval">{p.awaiting || '—'}</td>
              <td data-label="Seats filled">{p.filled} / {p.planned}</td>
              <td data-label="In pipeline">{p.pipeline}</td>
              <td data-label="At risk">{p.risk ? <span className="text-risk">{p.risk}</span> : '—'}</td>
              <td>{p.id ? <button className="btn btn-ghost btn-sm" onClick={() => onPick({ projectId: String(p.id) })}>Show requests</button> : null}</td>
            </tr>
          ))}</tbody>
        </table></div></div>
      )}
    </section>
  );
}
// Recruitment Manager / System Administrator: the hiring process, what needs
// doing, and how each recruiter stands.
function RequestsControlPanel({ all, rstat, onPick, onAssign }) {
  if (!all) return <div className="req-control"><Skeleton rows={3} /></div>;
  const count = (f) => all.filter((r) => inFocus(r, f)).length;
  const unassigned = all.filter((r) => inFocus(r, 'unassigned'));
  const noCands = all.filter((r) => inFocus(r, 'nocands'));
  const overdue = all.filter((r) => isOpenReq(r) && r.status !== 'pending_approval' && (r.health || {}).level === 'red');
  return (
    <section className="req-control" aria-label="Hiring process and recruiters">
      <div className="req-process" role="group" aria-label="Hiring process — filter requests by stage">
        {REQ_FOCUS.map(([k, label], i) => (
          <button key={k} type="button" className="req-step" onClick={() => onPick({ focus: k })}>
            <span className="req-step-n">{count(k)}</span><span className="req-step-l">{label}</span>{i < REQ_FOCUS.length - 1 && <span className="req-step-arrow" aria-hidden="true">›</span>}
          </button>
        ))}
      </div>
      <div className="req-control-stack">
        <section className="card">
          <div className="card-head"><div><h3>Actions needed</h3></div><span className="dash-headnote">Assign, start sourcing, recover overdue roles</span></div>
          {!unassigned.length && !noCands.length && !overdue.length
            ? <div className="dash-allclear">Every approved request has a recruiter and candidates, and none is overdue.</div>
            : <div className="action-list">
              {unassigned.slice(0, 5).map((r) => <ActionItem key={'u' + r.id} tone="warn" title={`Assign a recruiter — ${shortReqCode(r.ticketNo)} ${r.title}`} meta={`${(r.project || {}).name || 'No project'} · ${r.headcount} seat${r.headcount === 1 ? '' : 's'}`} why="Approved but nobody is sourcing" cta="Assign" onCta={() => onAssign(r)} />)}
              {overdue.slice(0, 5).map((r) => <ActionItem key={'o' + r.id} tone="risk" title={`Overdue — ${shortReqCode(r.ticketNo)} ${r.title}`} meta={`${r.owner ? r.owner.name : 'No recruiter'} · open ${(r.health || {}).daysOpen} days · ${(r.pipeline || {}).total || 0} in pipeline`} why="Past the health threshold" cta="Re-assign" onCta={() => onAssign(r)} />)}
              {noCands.slice(0, 5).map((r) => <ActionItem key={'n' + r.id} tone="warn" title={`No candidates yet — ${shortReqCode(r.ticketNo)} ${r.title}`} meta={`${r.owner.name} · open ${(r.health || {}).daysOpen ?? 0} days`} why="Sourcing has not produced a candidate" cta="Show" onCta={() => onPick({ focus: 'nocands' })} />)}
            </div>}
        </section>
        <section className="card">
          <div className="card-head"><div><h3>Recruiters</h3></div><span className="dash-headnote">{rstat ? `${rstat.unassigned} request${rstat.unassigned === 1 ? '' : 's'} without a recruiter` : 'Workload and progress'}</span></div>
          {!rstat ? <div className="card-pad"><Skeleton rows={3} /></div> : !rstat.recruiters.length ? <div className="dash-allclear">No recruiter is set up yet.</div> : (
            <div className="table-wrap"><table className="table responsive-table req-recruiters">
              <thead><tr><th>Recruiter</th><th>Open</th><th>No candidates</th><th>In pipeline</th><th>Interviews</th><th>Offers</th><th>Overdue</th><th><span className="sr-only">Show</span></th></tr></thead>
              <tbody>{rstat.recruiters.map((x) => (
                <tr key={x.id}>
                  <td data-label="Recruiter"><span className="cell-strong">{x.name}</span></td>
                  <td data-label="Open">{x.openRequests}</td>
                  <td data-label="No candidates">{x.withoutCandidates || '—'}</td>
                  <td data-label="In pipeline">{x.inPipeline}</td>
                  <td data-label="Interviews">{x.interviewsAhead || '—'}</td>
                  <td data-label="Offers">{x.offersOut || '—'}</td>
                  <td data-label="Overdue">{x.overdue ? <span className="text-risk">{x.overdue}</span> : '—'}</td>
                  <td><button className="btn btn-ghost btn-sm" onClick={() => onPick({ owner: String(x.id) })}>Requests</button></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </section>
      </div>
    </section>
  );
}

function RequestsPage({ user, initialFilters }) {
  const isPhone = useIsPhone();
  const toast = useToast();
  const [loadError, setLoadError] = useState(null);
  const [data, setData] = useState(null);
  // Approved layout is the table: it is what a recruiter scans down. Cards stay
  // one click away for people who prefer them.
  //
  // On a phone that ordering inverts. A stacked table row is a 390px-tall
  // column of LABEL/value pairs — three rows to a screen — while a card is the
  // same record in a shape built for the width. The toggle is unchanged and the
  // choice still sticks; only the first view a phone lands on differs, and only
  // at mount, so nobody's chosen view is yanked away by a rotate.
  const [view, setView] = useState(() => (isPhone ? 'cards' : 'table')); // table | cards
  // `owner`, `attention` and `openOnly` are NOT sent to the API — `owner` maps
  // onto the server's `ownerId` param (see the outgoing params below); `attention`
  // and `openOnly` are judged from fields every row already carries, the same way
  // the dashboards derive them, so a client-side filter keeps the server's query
  // surface from growing for something that isn't a real column.
  const [filters, setFilters] = useState(() => ({
    q: '', status: '', priority: '', sort: 'created', dir: 'desc',
    owner: '', attention: false, openOnly: false, projectId: '', departmentId: '', focus: '',
    ...(initialFilters || {}),
  }));
  const [selectedId, setSelectedId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [assigning, setAssigning] = useState(null); // request row being assigned/reassigned
  useRecordUrl('requests', selectedId);
  const [recruiters, setRecruiters] = useState([]);
  const [busy, setBusy] = useState(false);
  const loadSeq = useRef(0);
  const btns = useResolvedButtons();

  // Arriving from a dashboard card hands a fresh `initialFilters` object each
  // time — apply it whenever its identity changes, not just on first mount, so
  // a second card click while this page happens to already be current still lands.
  useEffect(() => {
    if (!initialFilters) return;
    setFilters((f) => ({ ...f, ...initialFilters }));
  }, [initialFilters]);

  const [meta, setMeta] = useState({ projects: [], departments: [] });
  useEffect(() => {
    api.get('/requests/meta/form').then((m) => { setRecruiters(m.assignableRecruiters || []); setMeta({ projects: m.projects || [], departments: m.departments || [] }); }).catch(() => {});
  }, []);
  // Role panels above the list (owner review, 4 Oct 2026): the eagle-eye view
  // for the Director and Executive, the hiring process and recruiter status for
  // whoever controls requests (Recruitment Manager, System Administrator).
  const persona = personaFor(user);
  const isAdmin = (user.roles || []).includes('system_admin');
  const showOverview = isAdmin || persona === 'director' || persona === 'executive';
  const showControl = can(user, 'request.assign_recruiter');
  const [allReqs, setAllReqs] = useState(null);
  const [rstat, setRstat] = useState(null);
  const loadPanels = useCallback(() => {
    if (!showOverview && !showControl) return;
    api.get('/requests?pageSize=200').then((r) => setAllReqs(r.requests || [])).catch(() => setAllReqs([]));
    if (showControl) api.get('/requests/recruiter-status').then(setRstat).catch(() => setRstat(null));
  }, [showOverview, showControl]);
  useEffect(() => { loadPanels(); }, [loadPanels]);

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

  // Refetch keeps the rows that are already on screen. `setData(null)` used to
  // run first, which sent the render branch below back to <Skeleton>: every
  // filter change and every search keystroke unmounted the whole table and
  // remounted it a moment later. `seq` is the same stale-response guard
  // CandidatesPage uses — the last request to be STARTED is the only one
  // allowed to write, so a slow early response cannot overwrite a newer one.
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setBusy(true); setLoadError(null);
    const params = new URLSearchParams();
    // Only the outgoing `q` is normalized (RQ-26-001 → REQ-2026-00001) so the stored
    // ticket_no can be matched; the text the user typed is left as-is in the input.
    // `attention`/`openOnly` are deliberately excluded — they filter client-side, below.
    Object.entries(filters).forEach(([k, v]) => {
      if (k === 'attention' || k === 'openOnly' || k === 'focus' || !v) return;
      params.set(k === 'owner' ? 'ownerId' : k, k === 'q' ? expandReqCode(v) : v);
    });
    try {
      const r = await api.get('/requests?' + params.toString());
      if (seq !== loadSeq.current) return;
      setData(r);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setLoadError(e.message);
    } finally {
      if (seq === loadSeq.current) setBusy(false);
    }
  }, [filters]);
  useEffect(() => { load(); }, [load]);

  // A chip/KPI/“Show” sets a filter on the list below the fold; bring the list
  // into view so the click visibly does something (owner audit 2026-10-15).
  // Declared before the early return: hooks must run in the same order on every render.
  const listTopRef = useRef(null);
  if (selectedId) return <RequestDetail id={selectedId} user={user} btns={btns} onBack={() => { setSelectedId(null); load(); }} />;

  const canCreate = btns.create_request?.visible;
  const canAssign = btns.assign_recruiter?.visible;

  // Client-side pass over the server-filtered rows for the two toggles that
  // aren't real columns — see the `filters` state comment above.
  const shown = (data ? data.requests : []).filter((r) => {
    if (filters.openOnly && !isOpenReq(r)) return false;
    if (filters.attention && !needsAction(r)) return false;
    if (filters.focus && !inFocus(r, filters.focus)) return false;
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
    filters.projectId && ['projectId', `Project: ${(meta.projects.find((x) => String(x.id) === String(filters.projectId)) || {}).name || filters.projectId}`, () => setFilters((f) => ({ ...f, projectId: '' }))],
    filters.departmentId && ['departmentId', `Department: ${(meta.departments.find((x) => String(x.id) === String(filters.departmentId)) || {}).name || filters.departmentId}`, () => setFilters((f) => ({ ...f, departmentId: '' }))],
    filters.focus && ['focus', `Stage: ${(REQ_FOCUS.find(([k]) => k === filters.focus) || [])[1] || filters.focus}`, () => setFilters((f) => ({ ...f, focus: '' }))],
  ].filter(Boolean);
  const pick = (patch) => {
    setFilters((f) => ({ ...f, status: '', owner: '', focus: '', projectId: '', departmentId: '', attention: false, ...patch }));
    setTimeout(() => listTopRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }), 60);
  };
  const unassign = async (r) => {
    if (!window.confirm(`Remove ${r.owner?.name || 'the recruiter'} from ${shortReqCode(r.ticketNo)}? The request stays open with no recruiter until someone is assigned.`)) return;
    try { await api.post(`/requests/${r.id}/unassign`, {}); toast(`Recruiter removed from ${shortReqCode(r.ticketNo)}`); load(); loadPanels(); }
    catch (e) { toast(e.message, 'error'); }
  };
  const isMine = String(filters.owner) === String(user.id);

  return (
    <div>
      <PageHead crumb="Recruitment / Requests" title="Hiring Requests"
        sub="Every hiring request — its approval, recruiter, candidates and progress."
        actions={<>
          <ViewToggle value={view} onChange={setView} options={[['cards', 'Cards'], ['table', 'Table']]} />
          {canCreate && <button className="btn" onClick={() => setCreating(true)}>{btns.create_request.label}</button>}
        </>} />

      {showOverview && <RequestsOverview all={allReqs} meta={meta} onPick={pick} />}
      {showControl && <RequestsControlPanel all={allReqs} rstat={rstat} onPick={pick} onAssign={(r) => setAssigning(r)} />}
      {persona === 'recruiter' && !isAdmin && (
        <div className="req-mine" role="group" aria-label="Whose requests">
          <button type="button" className={'seg-tab' + (!isMine ? ' active' : '')} aria-pressed={!isMine} onClick={() => setFilters((f) => ({ ...f, owner: '' }))}>All requests</button>
          <button type="button" className={'seg-tab' + (isMine ? ' active' : '')} aria-pressed={isMine} onClick={() => setFilters((f) => ({ ...f, owner: String(user.id) }))}>Assigned to me</button>
        </div>
      )}

      <div ref={listTopRef} className="scroll-anchor" aria-hidden="true" />
      <FilterToolbar activeCount={activeChips.length} search={<input placeholder="Search title / ticket / discipline…" value={filters.q} onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} />} count={<CountPill n={data ? shown.length : null} total={data ? data.requests.length : null} noun="request" />}>
        <SearchSelect value={filters.status} ariaLabel="Status" placeholder="Status" emptyLabel="All statuses"
          options={Object.entries(REQ_STATUS).filter(([, v], i, arr) => arr.findIndex(([, w]) => w.label === v.label) === i).map(([k, v]) => ({ value: k, label: v.label }))}
          onChange={(v) => setFilters((f) => ({ ...f, status: v }))} />
        <SearchSelect value={filters.projectId} ariaLabel="Location" placeholder="Location / site" emptyLabel="All locations"
          options={meta.projects.map((x) => ({ value: String(x.id), label: x.isHeadOffice ? 'Head Office' : x.name, hint: x.isHeadOffice ? '' : (x.area || '') }))}
          onChange={(v) => setFilters((f) => ({ ...f, projectId: v }))} />
        <SearchSelect value={filters.departmentId} ariaLabel="Department" placeholder="Department" emptyLabel="All departments"
          options={optsOf(meta.departments)}
          onChange={(v) => setFilters((f) => ({ ...f, departmentId: v }))} />
        <select value={filters.priority} onChange={(e) => setFilters((f) => ({ ...f, priority: e.target.value }))}>
          <option value="">All priorities</option>{Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
        <SearchSelect value={filters.owner} ariaLabel="Owner" placeholder="Owner" emptyLabel="All owners"
          options={[{ value: 'unassigned', label: 'Unassigned' }, ...optsOf(recruiters)]}
          onChange={(v) => setFilters((f) => ({ ...f, owner: v }))} />
        <label className="switch" title="Requests past their health threshold or SLA">
          <input type="checkbox" checked={filters.attention} onChange={(e) => setFilters((f) => ({ ...f, attention: e.target.checked }))} />
          Needs action
        </label>
        <label className="switch" title="Hide closed, filled, cancelled and rejected requests">
          <input type="checkbox" checked={filters.openOnly} onChange={(e) => setFilters((f) => ({ ...f, openOnly: e.target.checked }))} />
          Open only
        </label>
        <select className="sort-select" value={filters.sort} onChange={(e) => setFilters((f) => ({ ...f, sort: e.target.value }))}>
          <option value="created">Sort: Created</option><option value="priority">Priority</option><option value="title">Title</option><option value="status">Status</option><option value="ticket">Ticket No</option></select>
        <button className="btn btn-ghost" onClick={() => setFilters((f) => ({ ...f, dir: f.dir === 'desc' ? 'asc' : 'desc' }))}><Icon name={filters.dir === 'desc' ? 'arrowDown' : 'arrowUp'} size={16} />{filters.dir === 'desc' ? 'Desc' : 'Asc'}</button>
        </FilterToolbar>

      {activeChips.length > 0 && (
        <div className="filter-chips">
          {activeChips.map(([k, label, clear]) => (
            <span key={k} className="chip-filter" title={label}>
              <span className="chip-filter-label">{label}</span>
              <button aria-label={`Remove ${label} filter`} onClick={clear}><Icon name="close" size={16} /></button>
            </span>
          ))}
          <button className="btn btn-ghost btn-sm" onClick={() => setFilters((f) => ({ ...f, status: '', priority: '', owner: '', attention: false, openOnly: false, projectId: '', departmentId: '', focus: '' }))}>Clear all</button>
        </div>
      )}

      {/* A refetch that fails keeps the rows already on screen and reports it
          above them; only a failure with nothing to fall back on takes the page. */}
      {loadError && data ? <RefetchError text={loadError} onRetry={load} /> : null}
      {loadError && !data ? <LoadError text={loadError} onRetry={load} /> : !data ? <ListSkeleton rows={6} /> : shown.length === 0 ? (
        <div className="card"><Empty art="none-yet"
          title={activeChips.length || filters.q ? 'No requests match these filters' : 'No hiring requests yet'}
          text={activeChips.length || filters.q
            ? 'Try clearing the search box or widening the filters above.'
            : 'Raise the first hiring request to start tracking approvals, candidates and SLA.'} /></div>
      ) : view === 'table' ? (
        <div className={'card flush' + (busy ? ' table-busy' : '')} aria-busy={busy}><div className="table-wrap"><table className="table responsive-table">
          <thead><tr><th>Request</th><th>Position</th><th data-priority="secondary">Location</th><th>Owner</th><th data-priority="secondary">Pipeline</th><th>Priority</th><th>Status</th><th data-priority="secondary">Idle</th><th>SLA</th></tr></thead>
          <tbody>{shown.map((r) => (
            <tr key={r.id} className="row-link" onClick={() => setSelectedId(r.id)}>
              <td data-label="Request"><span className="code-pill" title={r.ticketNo}>{shortReqCode(r.ticketNo)}</span></td>
              <td data-label="Position"><span className="cell-strong clamp-2" title={r.title}>{r.title}</span><div className="cell-sub">{r.department?.name || '—'}</div></td>
              <td data-priority="secondary" data-label="Location" className="cell-sub-only">
                <span className="clamp-2" title={placeLabel(r)}>{placeLabel(r)}</span>
              </td>
              <td data-label="Owner" onClick={(e) => e.stopPropagation()}>
                {r.owner ? (canAssign
                  ? <span className="owner-cell"><span className="cell-sub-only">{r.owner.name}</span>
                    <span className="owner-actions"><button className="btn btn-ghost btn-sm" onClick={() => setAssigning(r)}>Change</button><button className="btn btn-ghost btn-sm" onClick={() => unassign(r)}>Remove</button></span></span>
                  : <span className="cell-sub-only">{r.owner.name}</span>)
                  : !canAssign ? <span className="muted">Unassigned</span>
                  : canAssignStatus(r.status) ? <button className="btn btn-ghost btn-sm" onClick={() => setAssigning(r)}>Assign</button>
                  : <span className="muted" title={ASSIGN_BLOCKED_TITLE}>After approval</span>}
              </td>
              <td data-priority="secondary" data-label="Pipeline">{r.pipeline ? <span className="pipe-count">{r.pipeline.total}<em>cand.</em></span> : <span className="muted">—</span>}</td>
              <td data-label="Priority"><PriorityBadge p={r.priority} /></td>
              <td data-label="Status"><ReqStatusBadge status={r.status} displayStatus={r.displayStatus} /></td>
              <td data-priority="secondary" data-label="Idle" className="cell-sub-only" title="Days since the last change on this request">{r.status === 'pending_approval' || r.lifecycle?.stageIdleDays == null ? '—' : r.lifecycle.stageIdleDays + 'd'}</td>
              <td data-label="SLA">{r.status === 'pending_approval' ? <span className="muted" title="The SLA clock starts at approval">—</span> : <ReqHealth health={r.health} status={r.status} />}</td>
            </tr>
          ))}</tbody>
        </table></div>
        <div className="reassurance">Rows without a warning are on track. The SLA clock starts when a request is approved.</div></div>
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
              setAssigning(null); load(); loadPanels();
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
  // Location (recruitment team, 25 Oct 2026): first "Head Office" or
  // "Projects"; for Projects, the Site list names every site with the area it
  // is in (kept current under Administration → Locations). Both map onto the
  // one field the API requires, `projectId`: the Head Office is a project row.
  const [locKind, setLocKind] = useState(null); // null = derive from projectId once meta loads
  useEffect(() => { api.get('/requests/meta/form').then(setMeta); }, []);
  const headOfficeId = meta ? meta.headOfficeProjectId : null;
  const kind = locKind !== null ? locKind
    : f.projectId === '' || f.projectId == null ? '' : Number(f.projectId) === headOfficeId ? 'head_office' : 'projects';
  const siteOptions = meta ? meta.projects
    .filter((p) => !p.isHeadOffice && (p.status === 'active' || Number(p.id) === Number(f.projectId)))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })) : [];
  const siteLabel = (p) => (p.area ? `${p.name} — ${p.area}` : p.name);
  function chooseLocation(v) {
    setLocKind(v);
    if (v === 'head_office') set('projectId', headOfficeId == null ? '' : String(headOfficeId));
    else set('projectId', '');            // Projects: the site is chosen next; blank until then
  }

  async function save() {
    if (!kind) { toast('Choose the location: Head Office or Projects.', 'error'); return; }
    if (kind === 'projects' && !f.projectId) { toast('Choose the site this request is for.', 'error'); return; }
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
        {!editing && <div className="field"><label>Hiring Manager</label>
          <SearchSelect value={f.hiringManagerId} ariaLabel="Hiring Manager" placeholder="Type a name…" emptyLabel="— None —"
            options={optsOf(meta.hiringManagers)} onChange={(v) => set('hiringManagerId', v)} /></div>}
        <div className="field"><label>Department *</label>
          <SearchSelect value={f.departmentId} ariaLabel="Department" placeholder="Type to find a department…" emptyLabel="— Select —"
            options={optsOf(meta.departments)} onChange={(v) => set('departmentId', v)} /></div>
        {/* Location → Site. The API still validates one field, projectId: the
            Head Office is a project row, every site is a project row, and the
            area printed beside a site comes from Administration → Locations. */}
        <div className="field"><label>Location *</label>
          <select value={kind} aria-label="Location" onChange={(e) => chooseLocation(e.target.value)}>
            <option value="">— Select —</option>
            <option value="head_office">Head Office</option>
            <option value="projects">Projects</option>
          </select>
        </div>
        {kind === 'projects' && (
          <div className="field"><label>Site *</label>
            <SearchSelect value={f.projectId} ariaLabel="Site" placeholder="Type to find a site…" emptyLabel="— Select a site —"
              options={siteOptions.map((p) => ({ value: String(p.id), label: p.name, hint: p.area || '' }))}
              onChange={(v) => set('projectId', v)} />
            {siteOptions.length === 0 && <small className="muted">No sites yet — the recruitment team adds them under Administration → Locations.</small>}
          </div>
        )}
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
        <Empty art="none-yet" title="Find candidates for this request"
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
        <Empty art="none-yet" tone="error" title="No shortlist" text={error}
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
          <Empty art="no-match" title="Nobody in the pool fits this request yet"
            text="An empty shortlist is a real answer — it means no current candidate evidences what this role asks for. Import CVs or widen the requirements." />
        </div>
      ) : (
        <div className={'card flush' + (busy ? ' table-busy' : '')} aria-busy={busy}>
          <table className="table">
            <thead><tr>
              <th style={{ width: 56 }}>Match</th>
              <th>Candidate</th>
              <th>Why</th>
              <th>Not evidenced</th>
              <th style={{ width: 96 }}><span className="sr-only">Actions</span></th>
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
  const [loadError, setLoadError] = useState(null);
  const [tab, setTab] = useState('thread');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [action, setAction] = useState(null);
  const [editing, setEditing] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [recruiters, setRecruiters] = useState([]);

  const load = useCallback(async () => { setLoadError(null); try { setReq((await api.get('/requests/' + id)).request); } catch (e) { setLoadError(e.message); } }, [id]);
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

  if (loadError) return <LoadError text={loadError} onRetry={load} />;
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
  // The one approver: the server accepts a decision only from the HR Director
  // (or the system administrator), so nobody else is offered the buttons.
  const isRequestApprover = (user.roles || []).some((r) => r === 'hr_director' || r === 'system_admin');

  return (
    <div>
      <TicketHeader req={req} onBack={onBack}>
        <div className="page-head-actions">
          {/* The approval step, surfaced: a draft is submitted here, and the
              one approver decides here. With the step switched off in Workflow
              Settings the same button reads "Submit" and sourcing begins at
              once — the server decides, the label only tells the truth. */}
          {btns.submit_request?.visible && ((s === 'pending_approval' && !(req.approvals || []).length) || s === 'reopened') && (
            <button className="btn" onClick={() => doAction('submit', {}, req.approvalRequired === false ? 'Submitted — sourcing can begin' : 'Submitted for HR Director approval')}>
              {req.approvalRequired === false ? 'Submit' : 'Submit for approval'}</button>)}
          {btns.approve_request?.visible && isRequestApprover && s === 'pending_approval' && <button className="btn" onClick={() => doAction('approve', {}, 'Request approved — sourcing can begin')}>Approve</button>}
          {btns.reject_request?.visible && isRequestApprover && s === 'pending_approval' && <button className="btn btn-danger" onClick={() => reasonAction('reject', 'Reject Request', 'Request rejected', true)}>Reject</button>}
          {btns.assign_recruiter?.visible && !TERMINAL_STATUSES.includes(s) && (
            canAssignNow
              ? <button className="btn btn-secondary" onClick={() => setAssigning(true)}>{assignLabel}</button>
              : <button className="btn btn-secondary" disabled title={ASSIGN_BLOCKED_TITLE}>{assignLabel}</button>
          )}
          {btns.assign_recruiter?.visible && req.owner && !TERMINAL_STATUSES.includes(s) && (
            <button className="btn btn-ghost" onClick={() => { if (window.confirm(`Remove ${req.owner.name} from this request? It stays open with no recruiter until someone is assigned.`)) doAction('unassign', {}, 'Recruiter removed'); }}>Remove recruiter</button>
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
          <span className="disclosure-caret">{detailsOpen ? 'Hide' : 'Show'}<Icon name={detailsOpen ? 'chevronUp' : 'chevronDown'} size={16} /></span>
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
  // Opens in the side panel (was a blob URL in a new tab, which is how thread CVs left the ATS).
  function viewPostFile(postId) {
    const p = (posts || []).find((x) => x.id === postId);
    openDocumentPanel('/thread/post/' + postId + '/file', p?.fileName, p?.type === 'cv' && p?.payload?.candidateName ? p.payload.candidateName + ' — CV' : null);
  }

  if (!posts) return <Skeleton rows={5} />;

  return (
    <div style={{ maxWidth: 860 }}>
      {posts.length === 0
        ? <div className="card"><Empty art="none-yet" text="No messages yet. Start the conversation, attach files, or post a CV below." /></div>
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
    message: { rail: 'var(--green-border)', tint: 'transparent', label: null },
    file: { rail: '#6b7480', tint: 'var(--surface-2, #fbfcfd)', label: 'Attachment' },
    cv: { rail: 'var(--green)', tint: 'var(--ticket-chip-bg)', label: 'CV' },
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
          {/* A system post made by a person (e.g. "Request submitted") shows
              that person's initials; the dot is for posts with no author (R6). */}
          {!isSystem || post.author?.name
            ? <span className="avatar" style={{ width: 26, height: 26, fontSize: 11 }}>{initials(post.author?.name)}</span>
            : <span style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--surface-2,#f1f3f5)', border: '1px solid var(--border)', display: 'grid', placeItems: 'center', fontSize: 11, color: 'var(--muted)', flex: '0 0 auto' }}>•</span>}
          <strong style={{ fontSize: 13 }}>{post.author?.name || 'System'}</strong>
          {post.author?.role && <span className="muted fine-key">{ROLE_NAMES[post.author.role] || post.author.role}</span>}
          {m.label && <span className="chip fine-key">{m.label}</span>}
          <span className="muted fine-key" style={{ marginLeft: 'auto' }} title={fmtDate(post.createdAt)}>{timeAgo(post.createdAt)}{post.edited ? ' · edited' : ''}</span>
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
                  <span className="muted fine-key" style={{ marginLeft: 'auto' }} title={fmtDate(r.createdAt)}>{timeAgo(r.createdAt)}</span>
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

function Info({ label, children }) { return <div style={{ marginBottom: 14 }}><div className="muted fine-label">{label}</div><div style={{ fontWeight: 500 }}>{children ?? '—'}</div></div>; }

// Arabtec ticket-styled field "chip": a soft pink-tinted label/value cell (per mockup).
function FieldChip({ label, children, full }) {
  return (
    <div style={{ gridColumn: full ? '1 / -1' : 'auto', background: 'var(--ticket-chip-bg, #fbeef0)', border: '1px solid var(--ticket-chip-border, #f3d6db)', borderRadius: 8, padding: '9px 12px' }}>
      <div className="fine-label" style={{ color: 'var(--green-700)', fontWeight: 700 }}>{label}</div>
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

function TicketHeader({ req, children, onBack }) {
  return <div className="ticket-header-card"><PageHead
    back={onBack && <button className="back-link" onClick={onBack}><Icon name="back" size={16} />Hiring Requests</button>}
    crumb="Hiring Request" title={req.title} actions={children}
    sub={<><span className="th-meta"><span className="code-pill" title={req.ticketNo}>{shortReqCode(req.ticketNo)}</span>
      <ReqStatusBadge status={req.status} displayStatus={req.displayStatus} />
      {req.priority && <PriorityBadge p={req.priority} />}{req.health && <ReqHealth health={req.health} status={req.status} />}</span>
      <span className="th-sub"><span><em>Department</em>{req.department?.name || '—'}</span>
      <span><em>Location</em>{placeLabel(req)}</span>
      {req.headcount != null && <span><em>Headcount</em>{req.headcountFilled ?? 0} of {req.headcount}</span>}</span></>} />
  </div>;
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
          <span className="chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} title={req.attachmentName || 'Attachment'}><FileGlyph /> {req.attachmentName || 'Attachment'}</span>
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
            <div className="muted fine-label">{label}</div>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: val ? 'var(--text-dark)' : 'var(--text-gray)' }}>{val ? fmtDateShort(val) : '—'}</div>
          </div>
        ))}
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 16 }}>
          <div style={{ textAlign: 'right' }}><div className="muted fine-label">Days open</div><div style={{ fontWeight: 700, fontSize: 16, color: 'var(--primary)' }}>{lc.daysOpen ?? '—'}</div></div>
          <div style={{ textAlign: 'right' }}><div className="muted fine-label">Since approval</div><div style={{ fontWeight: 700, fontSize: 16, color: 'var(--primary)' }}>{lc.daysSinceApproval ?? '—'}</div></div>
          <div style={{ textAlign: 'right' }}><div className="muted fine-label">To target join</div><div style={{ fontWeight: 700, fontSize: 16, color: dToTarget != null && dToTarget < 0 ? 'var(--critical)' : 'var(--primary)' }}>{dToTarget == null ? '—' : (dToTarget < 0 ? `${dToTarget}d` : `${dToTarget}d`)}</div></div>
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
          <FieldChip label="Location">{placeLabel(req)}</FieldChip>
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
            <div>{req.requiredSkills.map((s, i) => <span key={i} className="chip" title={s}>{s}</span>)}</div>
          </>
        )}
      </div>
    </div>
  );
}
function TimelineTab({ req }) {
  const acts = (req.activity || []).filter((a) => a.type !== 'hold_meta');
  if (!acts.length) return <div className="card"><Empty art="none-yet" text="No activity yet." /></div>;
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
  // 'screening' is kept only so an old bookmark or filter value does not crash
  // the board; nothing writes it any more (stage removed 25 Oct 2026).
  screening:          { label: 'Shortlisted', variant: 'info', column: 2 },
  interview_hr:       { label: 'Interview', variant: 'info', column: 3 },
  interview_technical:{ label: '2nd Interview (Technical)', variant: 'info', column: 4 },
  offer:              { label: 'Offer', variant: 'warning', column: 5 },
  hired:              { label: 'Hired', variant: 'success', column: 6 },
  rejected:           { label: 'Rejected', variant: 'critical', column: 99 },
  offer_declined:     { label: 'Offer Declined', variant: 'critical', column: 99 },
  on_hold:            { label: 'On Hold', variant: 'warning', column: 99 },
  new:         { label: 'Sourced', variant: 'soft', column: 1 },
  applied:     { label: 'Sourced', variant: 'soft', column: 1 },
  // Legacy Screening statuses (the API still stores them for historical rows):
  // shown and counted under Shortlisted, the stage that replaced Screening.
  matched:     { label: 'Shortlisted', variant: 'info', column: 2 },
  screened:    { label: 'Shortlisted', variant: 'info', column: 2 },
  cv_screening:{ label: 'Shortlisted', variant: 'info', column: 2 },
  unmatched:   { label: 'Shortlisted', variant: 'info', column: 2 },
  shortlisted: { label: 'Shortlisted', variant: 'info', column: 2 },
  interviewing:{ label: 'Interview', variant: 'info', column: 3 },
  interview_1: { label: 'Interview', variant: 'info', column: 3 },
  interview_2: { label: '2nd Interview (Technical)', variant: 'info', column: 4 },
  technical_interview: { label: '2nd Interview (Technical)', variant: 'info', column: 4 },
  waiting_feedback: { label: 'Interview', variant: 'info', column: 3 },
  issuing_offer: { label: 'Offer', variant: 'warning', column: 5 },
  offer_sent:  { label: 'Offer', variant: 'warning', column: 5 },
  offer_preparation: { label: 'Offer', variant: 'warning', column: 5 },
  joined:      { label: 'Hired', variant: 'success', column: 6 },
};
// Ordered stage columns for the pipeline (canonical list only).
// Board columns. `interview_technical` was removed: the API models a single
// `interviewing` stage, so that column could never be reached and any move to it
// was rejected with 400.
// Screening removed (recruitment team, 25 Oct 2026): Sourced → Shortlisted →
// Interview → Offer → Hired. Shortlisted is where hiring managers first see a
// candidate, and from there the next hop is the interview.
const APP_ORDER = ['sourced', 'shortlisted', 'interview_hr', 'offer', 'hired'];

// WRITE-DIRECTION map: board column -> the status the API actually accepts.
// APP_STATUS above is the read direction (API status -> display column); this is
// its mirror. Without it the board posted display keys such as 'screening', which
// the API rejects as Invalid status — five of six moves silently failed.
// Targets verified against the API's own transition table:
//   sourced -> shortlisted -> interviewing -> issuing_offer -> offer_sent -> joined
const APP_WRITE = {
  sourced: 'sourced',
  shortlisted: 'shortlisted',
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
  const current = (list || []).find(a => a.id === appId);
  if (pending.has(appId) || !current || !canPipelineMove(current.status, status)) return;
  setPending((p) => new Set(p).add(appId));
  setList((xs) => (xs || []).map((a) => (a.id === appId ? { ...a, status: toApiStatus(status) } : a)));
  try {
    const r = await api.post(`/applications/${appId}/move`, { status: toApiStatus(status), reason });
    if (r && r.application) {
      setList((xs) => (xs || []).map((a) => (a.id === appId ? { ...a, ...r.application } : a)));
    }
    toast(`Moved to ${(APP_STATUS[status] || {}).label || status}`);
  } catch (e) {
    // Revert only this card: another candidate may have moved successfully
    // while this request was in flight.
    setList((xs) => (xs || []).map((a) => a.id === appId ? current : a));
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
  if (s.column === 1.5 || s.column === 2) return 'shortlisted';
  // Columns 3 and 4 both fold into the single interview column: the API has one
  // `interviewing` stage, so a card must never land in a column that no longer
  // exists in APP_ORDER (it would vanish from the board).
  if (s.column === 3 || s.column === 4) return 'interview_hr';
  if (s.column === 5) return 'offer';
  if (s.column === 6) return 'hired';
  return status;
}
// Mirror of backend/src/lib/stages.js APP_TRANSITIONS. The board used to offer
// any forward jump (Sourced → Offer / Hired) and the server refused most of
// them, so menu actions "did nothing". Keep the two tables identical.
const APP_TRANSITIONS_API = {
  sourced: ['shortlisted', 'rejected', 'on_hold'],
  matched: ['shortlisted', 'interviewing', 'unmatched', 'rejected', 'on_hold'],
  shortlisted: ['interviewing', 'matched', 'rejected', 'on_hold'],
  unmatched: ['matched', 'shortlisted', 'rejected', 'on_hold'],
  interviewing: ['waiting_feedback', 'issuing_offer', 'rejected', 'on_hold', 'shortlisted'],
  waiting_feedback: ['issuing_offer', 'interviewing', 'rejected', 'on_hold', 'shortlisted'],
  issuing_offer: ['offer_sent', 'rejected', 'offer_declined', 'on_hold'],
  offer_sent: ['joined', 'offer_declined', 'rejected', 'on_hold'],
  on_hold: ['sourced', 'matched', 'shortlisted', 'interviewing', 'waiting_feedback', 'issuing_offer', 'rejected'],
};
const LINK_ENTRY_STAGES = ['sourced', 'shortlisted'];
function canPipelineMove(status, target) {
  if (!APP_STATUS[status] || TERMINAL_APP.includes(status)) return false;
  const from = APP_TRANSITIONS_API[status] ? status : toApiStatus(pipelineStage(status));
  const to = toApiStatus(target);
  return from !== to && (APP_TRANSITIONS_API[from] || []).includes(to);
}
function pipelineResidualLabel(status) {
  const column = pipelineStage(status);
  // The column already names the stage; its own default status ('interviewing'
  // under Interview, 'issuing_offer' under
  // Offer) adds nothing, and printing it read as a second, competing stage.
  if (status === column || status === APP_WRITE[column]) return '';
  // A legacy Screening row sits under Shortlisted and is Shortlisted; naming
  // its stored status would resurrect the removed stage on the card.
  if (LEGACY_SCREENING.includes(status)) return '';
  const label = APP_STATUS[status]?.label;
  return label && label !== APP_STATUS[column]?.label ? label : String(status).replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
}
function PipelineColumn({ stage, apps, pending, canMove, onMove, children }) {
  const [over, setOver] = useState(false);
  function dragged(e) {
    try { const id = e.dataTransfer.getData('application/x-ats-application'); return apps.find(a => String(a.id) === id); } catch { return null; }
  }
  return <div className={'kan-col' + (over ? ' kan-drop-active' : '')} data-stage={stage}
    onDragOver={(e) => { if (canMove && e.dataTransfer.types.includes('application/x-ats-application')) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(true); } }}
    onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false); }}
    onDrop={(e) => { e.preventDefault(); setOver(false); const app = dragged(e); if (canMove && app && !pending.has(app.id) && canPipelineMove(app.status, stage)) onMove(app.id, stage); }}>
    {children}
  </div>;
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
/* What a bulk move can honestly claim for the current selection. Pure, so the
   bar can state its scope before anything is sent: which selected rows are
   hidden by the filters, which forward stages at least one of them can reach,
   and exactly which rows would move to the chosen one. The server remains
   authoritative; this only stops the UI from promising more or less. */
function bulkSelectionSummary({ selected, apps, visibleApps, pending, target }) {
  const byId = new Map((apps || []).map((a) => [a.id, a]));
  const chosen = [...selected].map((id) => byId.get(id)).filter(Boolean);
  const visible = new Set((visibleApps || []).map((a) => a.id));
  const hidden = chosen.filter((a) => !visible.has(a.id));
  const movable = (a, s) => !pending.has(a.id) && canPipelineMove(a.status, s);
  const targets = APP_ORDER.filter((s) => chosen.some((a) => movable(a, s)));
  const to = targets.includes(target) ? target : (targets[0] || '');
  const eligible = to ? chosen.filter((a) => movable(a, to)) : [];
  return { chosen, hidden, targets, target: to, eligible };
}
function MatchScore({ score }) {
  if (score == null) return <span className="muted">—</span>;
  const color = score >= 80 ? 'var(--success)' : score >= 50 ? 'var(--warning)' : 'var(--critical)';
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
    <span style={{ width: 36, height: 6, background: '#eef1f4', borderRadius: 3, overflow: 'hidden', display: 'inline-block' }}>
      <span style={{ display: 'block', height: '100%', width: score + '%', background: color }} /></span>
    <span style={{ fontWeight: 600, fontSize: 12 }}>{score}</span></span>;
}

function RequestPipeline({ request, user, btns }) {
  const isPhone = useIsPhone();
  const toast = useToast();
  const [apps, setApps] = useState(null);
  const [loadError, setLoadError] = useState(null);
  // Same reason as the Talent Pool: a board does not fit a phone, a list does.
  const [view, setView] = useState(() => (isPhone ? 'list' : 'kanban')); // kanban | list | compact
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
  const [bulkTarget, setBulkTarget] = useState(''); // controlled destination; validated against the selection each render
  const [bulkConfirm, setBulkConfirm] = useState(null); // { go, sum } when hidden rows are part of the move

  const [canRecommend, setCanRecommend] = useState(false);
  const [recommendOpen, setRecommendOpen] = useState(false);
  const load = useCallback(async () => { setLoadError(null); try { const r = await api.get('/applications/request/' + request.id); setApps(r.applications); setCanRecommend(!!r.canRecommend); } catch (e) { setLoadError(e.message); } }, [request.id]);
  const [askUnlink, unlinkModal] = useUnlinkFlow(user, load);
  useEffect(() => { load(); }, [load]);

  // Apply candidate search/filter/sort to the loaded applications.
  const visibleApps = useMemo(() => {
    let list = apps || [];
    const q = pf.q.trim().toLowerCase();
    if (q) list = list.filter((a) => (a.candidate?.fullName || '').toLowerCase().includes(q) || (a.candidate?.employer || a.candidate?.currentCompany || '').toLowerCase().includes(q));
    if (pf.stage) list = list.filter((a) => pipelineStage(a.status) === pf.stage);
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
  // A hiring manager's / interviewer's decision on a Shortlisted candidate:
  // the server listed what this reader may do in `app.decisions`, so no
  // move_stage button is needed; reasons are still collected the same way.
  function decide(appId, status) {
    const app = (apps || []).find(a => a.id === appId);
    if (!app || pending.has(appId) || !(app.decisions || []).includes(toApiStatus(status))) return;
    if (REASON_STATUSES.includes(status)) setMoveModal({ appIds: [appId], toStatus: status, reason: true });
    else move(appId, status);
  }
  function requestMove(appId, status) {
    const app = (apps || []).find(a => a.id === appId);
    if (!canMove || pending.has(appId) || !app) return;
    if (!canPipelineMove(app.status, status)) {   // say why instead of silently snapping back
      const from = (APP_STATUS[pipelineStage(app.status)] || {}).label || app.status, to = (APP_STATUS[status] || {}).label || status;
      toast(`${from} → ${to} is not an allowed move.${pipelineStage(app.status) === 'sourced' ? ' Shortlist the candidate first.' : ''}`, 'error');
      return;
    }
    if (REASON_STATUSES.includes(status)) setMoveModal({ appIds: [appId], toStatus: status, reason: true });
    else move(appId, status);
  }
  async function bulkMove(status, reason) {
    if (bulkBusy) return;
    const ids = [...selected].filter(id => { const app = (apps || []).find(a => a.id === id); return !pending.has(id) && app && canPipelineMove(app.status, status); });
    if (!canMove || !ids.length) { toast('Select candidates that can move forward to this stage.', 'error'); return; }
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

  if (loadError) return <LoadError text={loadError} onRetry={load} />;
  if (!apps) return <Skeleton rows={6} />;

  const cols = pipelineOrderFor(user);
  const bulk = canBulk && selected.size > 0 ? bulkSelectionSummary({ selected, apps, visibleApps, pending, target: bulkTarget }) : null;
  const startBulk = () => {
    if (!bulk || !bulk.eligible.length) return;
    const go = () => {
      if (REASON_STATUSES.includes(bulk.target)) setMoveModal({ appIds: bulk.eligible.map((a) => a.id), toStatus: bulk.target, reason: true, bulk: true });
      else bulkMove(bulk.target);
    };
    // Rows the filters hide are still selected. Never move them silently.
    if (bulk.hidden.length) setBulkConfirm({ go, sum: bulk }); else go();
  };
  const activeApps = visibleApps.filter((a) => !isDisqualified(a.status));
  const disqualifiedCount = visibleApps.filter((a) => isDisqualified(a.status)).length;
  return (
    <div>
      {apps.length > 0 && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
          <Badge variant="success">Active {activeApps.length}</Badge>
          {disqualifiedCount > 0 && <Badge variant="critical">Disqualified {disqualifiedCount}</Badge>}
          <Badge variant="soft">Total {apps.length}</Badge>
        </div>
      )}
      <div className="toolbar">
        <ViewToggle value={view} onChange={setView} options={[['kanban', 'Board'], ['list', 'List'], ['compact', 'Table']]} />
        <input placeholder="Search name / employer…" value={pf.q} onChange={(e) => setPf((f) => ({ ...f, q: e.target.value }))} style={{ minWidth: 180 }} />
        <select value={pf.stage} onChange={(e) => setPf((f) => ({ ...f, stage: e.target.value }))}>
          <option value="">All stages</option>{cols.map((s) => <option key={s} value={s}>{APP_STATUS[s].label}</option>)}</select>
        <SearchSelect value={pf.recruiter} ariaLabel="Recruiter" placeholder="Recruiter" emptyLabel="All recruiters" style={{ minWidth: 160 }}
          options={pairOpts(recruiterOptions)} onChange={(v) => setPf((f) => ({ ...f, recruiter: v }))} />
        <select value={pf.sort} onChange={(e) => setPf((f) => ({ ...f, sort: e.target.value }))}>
          <option value="last">Sort: Last updated</option><option value="name">Name</option><option value="match">Match score</option></select>
        <div className="spacer" />
        <CountPill n={apps ? visibleApps.length : null} total={apps ? apps.length : null} noun="candidate" />
        {canRecommend && <button className={'btn btn-sm' + (canLink ? ' btn-secondary' : '')} onClick={() => setRecommendOpen(true)} title="Add a candidate you recommend, with their CV, straight into Shortlisted">Recommend a candidate</button>}
        {canImport && <button className="btn btn-secondary btn-sm" onClick={() => setImportOpen(true)}>Import CVs</button>}
        {canLink && <button className="btn btn-sm" onClick={() => setLinkOpen(true)}>{btns.link_candidate.label === 'Link to Request' ? 'Add Candidate' : btns.link_candidate.label}</button>}
      </div>

      {bulk && (
        <div className="bulk-bar" role="region" aria-label="Bulk move">
          <div className="bulk-scope">
            <strong>{bulk.chosen.length} selected</strong>
            {bulk.hidden.length > 0 && <span className="muted">· {bulk.hidden.length} hidden by the current filters</span>}
            {bulk.target
              ? <span className="muted">· {bulk.eligible.length} of {bulk.chosen.length} can move to {APP_STATUS[bulk.target].label}</span>
              : <span className="muted">· none of the selected candidates can move forward</span>}
          </div>
          <div className="bulk-actions">
            <select aria-label="Move to stage" value={bulk.target} disabled={!bulk.targets.length} onChange={(e) => setBulkTarget(e.target.value)}>
              {bulk.targets.length
                ? bulk.targets.map((s) => <option key={s} value={s}>{APP_STATUS[s].label}</option>)
                : <option value="">No forward stage</option>}
            </select>
            <button className="btn btn-sm" disabled={bulkBusy || !bulk.eligible.length} onClick={startBulk}>{bulkBusy ? 'Moving…' : bulk.eligible.length ? `Move ${bulk.eligible.length}` : 'Move'}</button>
            <button className="btn btn-ghost btn-sm" disabled={bulkBusy} onClick={() => setSelected(new Set())}>Clear</button>
          </div>
        </div>
      )}
      {bulkConfirm && <Confirm title="Include hidden candidates?" confirmLabel={`Move ${bulkConfirm.sum.eligible.length}`}
        message={`${bulkConfirm.sum.chosen.length} candidates are selected and ${bulkConfirm.sum.hidden.length} of them are hidden by the current filters. ${bulkConfirm.sum.eligible.length} eligible will move to ${APP_STATUS[bulkConfirm.sum.target].label}; the rest stay where they are.`}
        onConfirm={() => { const c = bulkConfirm; setBulkConfirm(null); c.go(); }} onClose={() => setBulkConfirm(null)} />}

      {apps.length === 0 ? <div className="card"><Empty art="none-yet" text={canLink ? "No candidates linked yet. Use 'Add Candidate' to add candidates." : canRecommend ? 'No shortlisted candidates yet. You can recommend one with their CV.' : 'No shortlisted candidates yet.'} />
          {(canImport || canRecommend) && <div style={{ textAlign: 'center', paddingBottom: 18, display: 'flex', gap: 8, justifyContent: 'center' }}>
            {canRecommend && <button className="btn btn-sm" onClick={() => setRecommendOpen(true)}>Recommend a candidate</button>}
            {canImport && <button className="btn btn-secondary btn-sm" onClick={() => setImportOpen(true)}>Import CVs</button>}
          </div>}</div>
        : visibleApps.length === 0 ? <div className="card"><Empty art="no-match" text="No candidates match the current filters." /></div>
        : view === 'kanban' ? (
          <div className="kanban">
            {cols.map((st) => {
              const items = visibleApps.filter((a) => {
                const canonical = pipelineStage(a.status);
                return canonical === st && !isDisqualified(a.status);
              });
              return (
                <PipelineColumn key={st} stage={st} apps={apps} pending={pending} canMove={canMove} onMove={requestMove}>
                  <div className="kan-head">
                    <span className="kan-dot" style={{ background: APP_STAGE_COLORS[st] || 'var(--muted)' }} />
                    <span className="kan-title">{APP_STATUS[st].label}</span>
                    <span className="kan-count">{items.length}</span>
                  </div>
                  <div className="kan-body">
                    {items.length === 0
                      ? <div className="kan-empty">No candidates at this stage</div>
                      : items.map((a) => <PipelineCard key={a.id} app={a} pending={pending.has(a.id)} canMove={canMove} canBulk={canBulk} selected={selected.has(a.id)} onSelect={() => toggleSel(a.id)} onView={() => setQuickView(a)} onMove={(s) => requestMove(a.id, s)} onDecide={(s) => decide(a.id, s)} onSchedule={() => setScheduleApp(a)} onOffer={() => setOfferApp(a)} onNote={() => setNoteApp(a)} onReviewCv={cvReviewOpener(user, a)} onUnlink={askUnlink ? () => askUnlink(a) : null} btns={btns} />)}
                  </div>
                </PipelineColumn>
              );
            })}
          </div>
        ) : view === 'list' ? (
          <div className="pipe-list">
            {visibleApps.map((a) => <PipelineCard key={a.id} app={a} wide pending={pending.has(a.id)} canMove={canMove} canBulk={canBulk} selected={selected.has(a.id)} onSelect={() => toggleSel(a.id)} onView={() => setQuickView(a)} onMove={(s) => requestMove(a.id, s)} onDecide={(s) => decide(a.id, s)} onSchedule={() => setScheduleApp(a)} onOffer={() => setOfferApp(a)} onNote={() => setNoteApp(a)} onReviewCv={cvReviewOpener(user, a)} onUnlink={askUnlink ? () => askUnlink(a) : null} btns={btns} />)}
          </div>
        ) : (
          <div className="card" style={{ overflowX: 'auto' }}><table>
            <thead><tr>{canBulk && <th><span className="sr-only">Select</span></th>}<th>Candidate</th><th>Employer / Project</th><th>Exp</th><th>Education</th><th>Match</th><th>Stage</th><th>Recruiter</th><th>Next Action</th><th>Last Update</th><th><span className="sr-only">Actions</span></th></tr></thead>
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
                  {decisionButtons({ app: a, pending: pending.has(a.id), onDecide: (s) => decide(a.id, s), compact: true })}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}

      {quickView && <CandidateQuickView app={quickView} user={user} onClose={() => setQuickView(null)} onChanged={load} />}
      {noteApp && <NextActionModal app={noteApp} onClose={() => setNoteApp(null)} onSaved={() => { setNoteApp(null); load(); }} />}
      {moveModal && <Confirm title="Provide a reason" message={`Set status to "${APP_STATUS[moveModal.toStatus].label}". This is recorded in the audit trail.`} requireReason danger
        onConfirm={(reason) => { const m = moveModal; setMoveModal(null); m.bulk ? bulkMove(m.toStatus, reason) : move(m.appIds[0], m.toStatus, reason); }} onClose={() => setMoveModal(null)} />}
      {unlinkModal}
      {linkOpen && <LinkCandidateModal requestId={request.id} user={user} onClose={() => setLinkOpen(false)} onLinked={() => { setLinkOpen(false); load(); }} />}
      {importOpen && <ImportCvsModal request={request} onClose={() => setImportOpen(false)} onDone={load} />}
      {recommendOpen && <RecommendCandidateModal request={request} onClose={() => setRecommendOpen(false)} onDone={() => { setRecommendOpen(false); load(); }} />}
      {scheduleApp && <ScheduleInterviewModal application={scheduleApp} onClose={() => setScheduleApp(null)} onScheduled={() => { setScheduleApp(null); load(); }} />}
      {offerApp && <CreateOfferModal application={offerApp} onClose={() => setOfferApp(null)} onCreated={() => { setOfferApp(null); load(); }} />}
    </div>
  );
}

// Shows the candidate's real stage and offers only the moves the server accepts
// (it used to show "Sourced" for a Shortlisted candidate and offer every stage,
// silently ignoring the ones that were not allowed).
function StageSelect({ value, onChange, disabled }) {
  const current = pipelineStage(value);
  const options = [current, ...APP_ORDER.filter((s) => s !== current && canPipelineMove(value, s))];
  return <select value={current} disabled={disabled || options.length < 2} aria-label="Move to stage"
    onChange={(e) => { if (e.target.value !== current) onChange(e.target.value); }}
    style={{ padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}>
    {options.map((s) => <option key={s} value={s}>{(APP_STATUS[s] || {}).label || s}</option>)}</select>;
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

/**
 * The pipeline card's "Review CV" handler, or null when the viewer cannot read
 * candidates at all. The applications serializer does not send `hasResume`, so
 * whether a file exists is decided by the panel — which already has a clear
 * "no CV stored" state — rather than guessed here.
 */
function cvReviewOpener(user, app) {
  const id = app.candidate?.id || app.candidateId;
  if (!id || !can(user, 'candidate.view')) return null;
  return () => openCvReview(id, app.candidate || null);
}
// Unlink = undo a link (owner request 2026-10-15). Recruitment only; the server
// refuses once interviews/offers exist and says to use Disqualify instead.
function useUnlinkFlow(user, reload) {
  const toast = useToast();
  const [target, setTarget] = useState(null);
  const allowed = hasFullPipelineAccess(user) && can(user, 'candidate.link');
  const ask = allowed ? (app) => setTarget(app) : null;
  const modal = target && <Confirm title="Unlink from request"
    message={`Remove ${target.candidate?.fullName || 'this candidate'} from ${shortReqCode(target.request?.ticketNo || target.ticketNo) || 'this request'}? They go back to the Talent Pool. No rejection is recorded and nothing is sent to the candidate.`}
    confirmLabel="Unlink"
    onConfirm={async (reason) => {
      const a = target; setTarget(null);
      try { await api.post(`/applications/${a.id}/unlink`, { reason }); toast('Unlinked — the candidate is back in the Talent Pool.'); await reload(); }
      catch (e) { toast(moveErrorText(e), 'error'); }
    }}
    onClose={() => setTarget(null)} />;
  return [ask, modal];
}
// The three decisions a hiring manager or panel interviewer takes on a
// Shortlisted candidate (recruitment team, 25 Oct 2026). The server names them
// per reader in `app.decisions`; a reader with the whole board gets none.
const DECISION_BUTTONS = [
  ['interviewing', 'Move to Interview', 'btn btn-sm', 'interview_hr'],
  ['on_hold', 'On Hold', 'btn btn-secondary btn-sm', 'on_hold'],
  ['rejected', 'Disqualify', 'btn btn-ghost btn-sm btn-danger-text', 'rejected'],
];
// A plain render helper (not a component) so the buttons sit in the card's own
// element tree — the board's tests and the drag handler both read that tree.
function decisionButtons({ app, pending, onDecide, compact }) {
  const allowed = Array.isArray(app.decisions) ? app.decisions : [];
  if (!allowed.length || !onDecide) return null;
  return (
    <div className={'pcard-decide' + (compact ? ' compact' : '')} role="group" aria-label={`Your decision on ${app.candidate?.fullName || 'this candidate'}`} onClick={(e) => e.stopPropagation()}>
      {DECISION_BUTTONS.filter(([api]) => allowed.includes(api)).map(([api, label, cls, boardKey]) => (
        <button key={api} type="button" className={cls} disabled={pending} onClick={() => onDecide(boardKey)}>{label}</button>
      ))}
    </div>
  );
}
function PipelineCard({ app, wide, pending, canMove, canBulk, selected, onSelect, onView, onMove, onDecide, onSchedule, onOffer, onNote, onReviewCv, onUnlink, btns = {}, showRequest }) {
  const cand = app.candidate || {};
  const [menu, setMenu] = useState(false);
  const menuRef = useRef(null), triggerRef = useRef(null);
  const menuId = useId();
  const targets = canMove ? APP_ORDER.filter(s => canPipelineMove(app.status, s)) : [];
  const movable = canMove && canPipelineMove(app.status, 'rejected');
  const residual = pipelineResidualLabel(app.status);
  useEffect(() => { if (pending) setMenu(false); }, [pending]);
  useEffect(() => {
    if (!menu) return;
    const close = e => { if (!menuRef.current?.contains(e.target) && !triggerRef.current?.contains(e.target)) setMenu(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menu]);
  // The menu renders at page level (portal) so the scrolling board can never
  // crop it (owner report 2026-10-15: Disqualify was cut off). It opens below
  // the trigger, flips above when there is more room there, stays clear of the
  // phone tab bar, and scrolls inside itself if it is still taller than the space.
  const [menuPos, setMenuPos] = useState(null);
  useEffect(() => {
    if (!menu) { setMenuPos(null); return; }
    const place = () => {
      const t = triggerRef.current; if (!t) return;
      const r = t.getBoundingClientRect();
      const vh = window.innerHeight, vw = window.innerWidth, w = Math.min(220, vw - 16);
      const bar = document.querySelector('.mtab')?.parentElement?.getBoundingClientRect();
      const floor = bar && bar.top > vh / 2 ? bar.top - 8 : vh - 8;
      const h = menuRef.current ? menuRef.current.scrollHeight : 0;
      const below = floor - r.bottom - 6, above = r.top - 8 - 6;
      let top, maxHeight;
      if (h <= below) { top = r.bottom + 6; maxHeight = below; }            // fits below the trigger
      else if (h <= above) { top = r.top - 6 - h; maxHeight = above; }      // fits above it
      else {                                                                 // fits neither (phone): use the full height
        maxHeight = floor - 16; top = Math.max(8, floor - 8 - Math.min(h, maxHeight));
      }
      setMenuPos({ left: Math.min(Math.max(8, r.right - w), vw - w - 8), top, width: w, maxHeight: Math.max(120, maxHeight) });
    };
    place();
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(place) : null;
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { if (raf != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [menu]);
  // Focus moves into the menu once it is placed (it is invisible until then,
  // and an invisible element cannot take focus — Escape would not reach it).
  useEffect(() => {
    if (menu && menuPos && menuRef.current && !menuRef.current.contains(document.activeElement)) menuRef.current.querySelector('button')?.focus();
  }, [menu, menuPos]);
  const unlinkable = !!onUnlink && ['sourced', 'shortlisted', 'matched', 'unmatched', 'on_hold'].includes(app.status);
  function action(run) { setMenu(false); triggerRef.current?.focus(); run(); }
  function menuKeys(e) {
    const items = [...menuRef.current.querySelectorAll('button')];
    const at = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setMenu(false); triggerRef.current?.focus(); }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault(); const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }
  }
  return <div className={'pcard' + (wide ? ' pcard-wide' : '') + (selected ? ' selected' : '') + (pending ? ' pcard-pending' : '')}
    aria-busy={pending || undefined} draggable={!!(movable && !pending)}
    onDragStart={e => { if (!movable || pending) { e.preventDefault(); return; } e.dataTransfer.setData('application/x-ats-application', String(app.id)); e.dataTransfer.effectAllowed = 'move'; }}
    onClick={e => { if (!pending && !e.target.closest('button,input,.pipeline-menu')) onView(); }}>
    {pending && <span className="pcard-busy" role="status"><i className="spin" />Moving…</span>}
    <div className="pcard-top">
      {canBulk && <input className="pcard-check" type="checkbox" aria-label={`Select ${cand.fullName || 'candidate'}`} checked={selected} disabled={pending} onChange={onSelect} />}
      <div className="pcard-id">
        <button className="pcard-name" disabled={pending} onClick={onView} title={cand.fullName || cand.name}>{cand.fullName || cand.name || '—'}</button>
        <span className="pcard-role" title={[cand.currentPosition, cand.currentCompany].filter(Boolean).join(' · ')}>{[cand.currentPosition, cand.currentCompany].filter(Boolean).join(' · ') || '—'}</span>
      </div>
      <div className="pcard-actions">
        <button ref={triggerRef} className="icon-btn pcard-menu-trigger" disabled={pending} aria-label={`Actions for ${cand.fullName || 'candidate'}`} aria-expanded={menu} aria-controls={menuId} aria-haspopup="menu" onClick={() => setMenu(v => !v)} onKeyDown={e => { if (e.key === 'Escape' && menu) { e.preventDefault(); e.stopPropagation(); setMenu(false); } }}><Icon name="more" size={18} /></button>
        {menu && toPageLevel(<div ref={menuRef} id={menuId} className="menu pipeline-menu pipeline-menu-floating" role="menu" onKeyDown={menuKeys}
          style={menuPos ? { position: 'fixed', left: menuPos.left, top: menuPos.top, width: menuPos.width, maxHeight: menuPos.maxHeight, right: 'auto', marginTop: 0 } : { position: 'fixed', visibility: 'hidden', top: 0, left: 0 }}
          onClick={e => e.stopPropagation()}
          onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget) && e.relatedTarget !== triggerRef.current) setMenu(false); }}>
          <button className="menu-item" role="menuitem" onClick={() => action(onView)}>View candidate</button>
          {onReviewCv && <button className="menu-item" role="menuitem" onClick={() => action(onReviewCv)}>Review CV</button>}
          {targets.map(stage => <button key={stage} className="menu-item" role="menuitem" onClick={() => action(() => onMove(stage))}>Move to {APP_STATUS[stage].label}</button>)}
          {movable && onNote && <button className="menu-item" role="menuitem" onClick={() => action(onNote)}>Set Next Action</button>}
          {movable && <button className="menu-item" role="menuitem" onClick={() => action(() => onMove('on_hold'))}>Put On Hold</button>}
          {movable && onSchedule && btns.schedule_interview?.visible && <button className="menu-item" role="menuitem" onClick={() => action(onSchedule)}>Schedule Interview</button>}
          {movable && onOffer && btns.generate_offer?.visible && <button className="menu-item" role="menuitem" onClick={() => action(onOffer)}>Generate Offer</button>}
          {unlinkable && <button className="menu-item" role="menuitem" onClick={() => action(onUnlink)}>Unlink from request</button>}
          {movable && <button className="menu-item menu-danger" role="menuitem" onClick={() => action(() => onMove('rejected'))}>Disqualify</button>}
        </div>)}
      </div>
    </div>
    {showRequest && (app.request?.ticketNo || app.ticketNo) && <span className="pcard-request" title={app.request?.ticketNo || app.ticketNo}>{shortReqCode(app.request?.ticketNo || app.ticketNo)}</span>}
    {wide && <span className="pcard-status"><AppStatusBadge status={app.status} /></span>}
    {residual && <span className="pcard-residual" title={`Underlying status: ${app.status}`}>{residual}</span>}
    {app.recommendation && <span className="pcard-recommended" title={`Recommended by ${app.recommendation.byName || 'a stakeholder'}`}><Badge variant="success">Recommended{app.recommendation.byName ? ` by ${app.recommendation.byName}` : ''}</Badge></span>}
    {decisionButtons({ app, pending, onDecide })}
    <div className="pcard-footer"><span className="pcard-facts">{[cand.yearsExperience != null ? `${cand.yearsExperience}y exp` : null, cand.location, cand.noticePeriod].filter(Boolean).join(' · ') || 'Details not supplied'}</span>
      {app.matchScore != null && <span className="pcard-match" title="Match score">{app.matchScore}%</span>}
    </div>
  </div>;
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
  const [askUnlink, unlinkModal] = useUnlinkFlow(user, () => load());
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
  // A hiring manager's / interviewer's decision on a Shortlisted candidate:
  // the server listed what this reader may do in `app.decisions`, so no
  // move_stage button is needed; reasons are still collected the same way.
  function decide(appId, status) {
    const app = (apps || []).find(a => a.id === appId);
    if (!app || pending.has(appId) || !(app.decisions || []).includes(toApiStatus(status))) return;
    if (REASON_STATUSES.includes(status)) setMoveModal({ appIds: [appId], toStatus: status, reason: true });
    else move(appId, status);
  }
  function requestMove(appId, status) {
    const app = (apps || []).find(a => a.id === appId);
    if (!canMove || pending.has(appId) || !app) return;
    if (!canPipelineMove(app.status, status)) {   // say why instead of silently snapping back
      const from = (APP_STATUS[pipelineStage(app.status)] || {}).label || app.status, to = (APP_STATUS[status] || {}).label || status;
      toast(`${from} → ${to} is not an allowed move.${pipelineStage(app.status) === 'sourced' ? ' Shortlist the candidate first.' : ''}`, 'error');
      return;
    }
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
    return <div className="card"><Empty art="none-yet" tone="error" title="Could not load the pipeline" text={loadError}
      action={<button className="btn" onClick={load}>Retry</button>} /></div>;
  }
  if (!apps) return <ListSkeleton rows={6} />;
  const cols = pipelineOrderFor(user);
  const activeApps = apps.filter((a) => !isDisqualified(a.status));
  return (
    <div>
      <div className="toolbar">
        <input placeholder="Search name / request…" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 200 }} />
        <SearchSelect value={pipeFilters.stage} ariaLabel="Stage" placeholder="Stage" emptyLabel="All stages"
          options={cols.map((s) => ({ value: s, label: APP_STATUS[s].label }))}
          onChange={(v) => setPipeFilters((f) => ({ ...f, stage: v }))} />
        <SearchSelect value={pipeFilters.recruiterId} ariaLabel="Recruiter" placeholder="Recruiter" emptyLabel="All recruiters"
          options={pairOpts(recruiterOptions)}
          onChange={(v) => setPipeFilters((f) => ({ ...f, recruiterId: v }))} />
        <SearchSelect value={pipeFilters.requestId} ariaLabel="Request" placeholder="Request" emptyLabel="All requests"
          options={(linkRequests || []).filter(isLinkable).map((r) => ({ value: String(r.id), label: `${shortReqCode(r.ticketNo)} · ${r.title}` }))}
          onChange={(v) => setPipeFilters((f) => ({ ...f, requestId: v }))} />
        <SearchSelect value={pipeFilters.projectId} ariaLabel="Project" placeholder="Project" emptyLabel="All projects"
          options={pairOpts(projectOptions)}
          onChange={(v) => setPipeFilters((f) => ({ ...f, projectId: v }))} />
        <div className="spacer" />
        <CountPill n={apps.length} total={total || null} noun="application" />
      </div>
      {capped && (
        <div className="notice notice-warn" style={{ marginBottom: 12 }}>
          Showing the first {apps.length} of {total} applications. Narrow the filters to see the rest — nothing was dropped silently.
        </div>
      )}
      {hasFullPipelineAccess(user) && (unlinkedTotal > 0 || (unlinked && unlinked.length > 0)) && (
        <div className="notice notice-info" style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span>{unlinkedTotal || unlinked.length} candidate{(unlinkedTotal || unlinked.length) === 1 ? '' : 's'} not on a request.
            {hasMoreUnlinked ? ' More are in the pool.' : ''}</span>
          <button className="btn btn-sm" onClick={onOpenCards}>View cards</button>
        </div>
      )}
      <div className="kanban">
        {hasFullPipelineAccess(user) && <div className="kan-col">
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
                      <span className="pcard-name" title={c.fullName}>{shortName(c.fullName)}</span>
                      <span className="pcard-role">{c.currentPosition || '—'}</span>
                    </div>
                  </div>
                  <HistoryBadge history={c.history} onOpen={() => onOpenCandidate(c.id, { tab: 'activity', focusPrior: true })} />
                </div>
              ))}
          </div>
        </div>}
        {cols.map((st) => {
          const items = activeApps.filter((a) => pipelineStage(a.status) === st);
          return (
            <PipelineColumn key={st} stage={st} apps={apps} pending={pending} canMove={canMove} onMove={requestMove}>
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
                      onMove={(s) => requestMove(a.id, s)} onDecide={(s) => decide(a.id, s)}
                      onReviewCv={cvReviewOpener(user, a)}
                      onUnlink={askUnlink ? () => askUnlink(a) : null}
                      btns={btns} />
                  ))}
              </div>
            </PipelineColumn>
          );
        })}
      </div>
      {moveModal && <Confirm title="Provide a reason" message={`Set status to "${APP_STATUS[moveModal.toStatus].label}". This is recorded in the audit trail.`} requireReason danger
        onConfirm={(reason) => { const m = moveModal; setMoveModal(null); move(m.appId, m.toStatus, reason); }}
        onClose={() => setMoveModal(null)} />}
      {unlinkModal}
    </div>
  );
}

function CandidateQuickView({ app, user, onClose, onChanged }) {
  const c = app.candidate || {};
  const toast = useToast();
  const titleId = useId();
  // Unsaved assessment edits must not vanish with the drawer: closing asks first.
  const assessDirty = useRef(false);
  const requestClose = useCallback(() => {
    if (assessDirty.current) {
      if (!window.confirm('Discard unsaved assessment changes?')) return;
      discardAssessUnsaved(app.id);
    }
    onClose();
  }, [onClose, app.id]);
  const { dialogRef, onDialogKeyDown } = useDialogFocus(requestClose);
  const [tab, setTab] = useState('profile'); // profile | assessment
  // Once opened, the assessment stays mounted (hidden) so switching to the
  // Candidate tab and back keeps any unsaved edits.
  const [assessOpened, setAssessOpened] = useState(false);
  const [cand, setCand] = useState(c);
  const [resumeBusy, setResumeBusy] = useState(false);
  const canEditCand = user?.permissions?.includes('candidate.edit');
  const canFeedback = user?.permissions?.includes('interview.feedback');
  // Opens the CV BESIDE this candidate's details instead of pushing the file
  // at the browser; Download is still offered inside that panel.
  function viewResume() { openCvReview(c.id, cand); }
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

  return toPageLevel(
    // The assessment tab gets a wider drawer: the form is a document laid out like the A4 sheet.
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) requestClose(); }}>
      <div ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId}
        tabIndex="-1" onKeyDown={onDialogKeyDown}
        style={{ maxWidth: tab === 'assessment' ? 960 : 560, marginLeft: 'auto', height: '100vh', borderRadius: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="modal-head" style={{ borderTop: '4px solid var(--green)' }}>
          <div>
            <h3 id={titleId} style={{ margin: 0 }}>{c.fullName}</h3>
            <div className="muted" style={{ fontSize: 12 }}>{c.candidateNo} · {app.applicationNo} · <AppStatusBadge status={app.status} /></div>
          </div>
          <button type="button" className="icon-btn" aria-label="Close candidate details" onClick={requestClose}><Icon name="close" size={16} /></button>
        </div>
        <div style={{ display: 'flex', gap: 4, padding: '0 16px', borderBottom: '1px solid var(--border)' }}>
          {/* Selecting a tab may not change its metrics. fontWeight used to be
              700 when selected and 500 when not, which widened the selected
              label — measured +11.16px on "Interview Assessment" at 1600 — and
              shoved the other tab sideways. Both tabs now carry 700, the same
              way `.seg-tab` and `.tabbar-btn` raise their base weight to their
              selected weight; the selection is still unmistakable from the
              green ink and the 2px green underline, and that underline was
              already reserved as `2px solid transparent` on the unselected tab,
              so it never moved anything either. */}
          {[['profile', 'Candidate'], ['assessment', 'Interview Assessment']].map(([k, label]) => (
            <button key={k} onClick={() => { setTab(k); if (k === 'assessment') setAssessOpened(true); }} className="btn btn-ghost" style={{ border: 'none', borderBottom: tab === k ? '2px solid var(--green)' : '2px solid transparent', borderRadius: 0, color: tab === k ? 'var(--green-700)' : 'var(--text-gray)', fontWeight: 700 }}>{label}</button>
          ))}
        </div>
        <div className="modal-body" style={{ flex: 1, overflowY: 'auto' }}>
          {tab === 'profile' ? (
            <>
              <div style={{ background: 'var(--ticket-chip-bg, #fbeef0)', border: '1px solid var(--ticket-chip-border, #f3d6db)', borderRadius: 10, padding: '12px 14px', marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                <div>
                  <div className="fine-label" style={{ color: 'var(--green-700)', fontWeight: 700 }}>Resume</div>
                  <div style={{ fontWeight: 600, marginTop: 2 }}>{cand.hasResume ? <CvFileLink name={cand.resumeName} onOpen={viewResume} /> : <span className="muted">No résumé attached</span>}</div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {cand.hasResume && <button className="btn btn-sm btn-secondary" onClick={viewResume}>Review CV</button>}
                  {cand.hasResume && <button className="btn btn-sm btn-ghost" onClick={() => downloadResume(cand, toast)}>Download</button>}
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
          ) : null}
          {(tab === 'assessment' || assessOpened) && (
            <div hidden={tab !== 'assessment'}>
              <AssessmentPanel app={app} canFeedback={canFeedback} onDirtyChange={(d) => { assessDirty.current = d; }} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Interview assessment — ONE canonical document, laid out like the approved
// Arabtec assessment sheet: Candidate Personal Information, HR Assessment
// (Big Five), Technical Assessment, Critical Flags, Final Recommendation.
// Which parts this user may see or change is decided on the server
// (lib/assessment-policy.js) and arrives as bundle.permissions; withheld values
// never arrive at all. This file makes no role decisions of its own.
const ASSESS_NOT_RECORDED = 'Not recorded';
const ASSESS_SECTIONS = {
  hr: { policy: 'assessment.behavioral', field: 'behavioral', just: 'behavioralJustification', justPolicy: 'assessment.finalRecommendation.behavioralJustification', title: 'HR Assessment — Behavioral (Big Five Model)', short: 'Behavioral', fitLabel: 'Behavioral Fit', evaluator: 'HR evaluation' },
  technical: { policy: 'assessment.technical', field: 'technical', just: 'technicalJustification', justPolicy: 'assessment.finalRecommendation.technicalJustification', title: 'Technical Assessment — Role Competency', short: 'Technical', fitLabel: 'Technical Fit', evaluator: 'Technical evaluation' },
};
// Used only when the server's metadata predates the candidate field list.
const ASSESS_CANDIDATE_FIELDS = [
  ['assessment.candidate.fullName', 'Full Name', 'fullName'], ['assessment.candidate.position', 'Position', 'position'],
  ['assessment.candidate.department', 'Department', 'department'], ['assessment.candidate.interviewDate', 'Interview Date', 'interview'],
  ['assessment.candidate.education', 'Education', 'education'], ['assessment.candidate.yearsExperience', 'Years of Experience', 'yearsExperience'],
  ['assessment.candidate.currentEmployer', 'Current Employer', 'currentEmployer'], ['assessment.candidate.availability', 'Notice / Availability', 'noticePeriod'],
  ['assessment.candidate.currentSalary', 'Current Salary', 'currentSalary'], ['assessment.candidate.expectedSalary', 'Expected Salary', 'expectedSalary'],
].map(([policy, label, key]) => ({ policy, label, key }));
const ASSESS_FIT_RANGE = { strong: '4.2+', acceptable: '3.5–4.1', borderline: '3.0–3.4', weak: '<3.0' };
const assessCriterionKey = (type, key) => `${ASSESS_SECTIONS[type].policy}.${key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())}`;
// Unsaved assessment edits, kept outside the React tree. The app swaps its
// whole shell at the 900px breakpoint, which unmounts any open drawer; edits
// parked here are restored when the same evaluation is reopened, as long as
// the saved record has not changed meanwhile (AR-06). Cleared on save/discard.
const ASSESS_UNSAVED = new Map();
// A deliberate "discard" (confirmed close or navigation) must not come back later.
function discardAssessUnsaved(appId) {
  for (const key of [...ASSESS_UNSAVED.keys()]) if (key.startsWith(`${appId}:`)) ASSESS_UNSAVED.delete(key);
}

// Form state from a saved evaluation (or blank). Scores are kept as strings:
// '' unanswered, '1'..'5', 'na'.
function assessFormState(existing, criteria, flagsMeta) {
  const rows = {};
  (criteria || []).forEach((cr) => {
    const r = existing?.rows?.[cr.key];
    rows[cr.key] = { score: r?.score == null ? '' : String(r.score), notes: r?.notes || '' };
  });
  const flags = {};
  (flagsMeta || []).forEach((f) => { flags[f.key] = !!existing?.criticalFlags?.[f.key]; });
  return { rows, flags, recommendation: existing?.recommendation || '', justification: existing?.justification || '' };
}
// Live section summary: numeric rows only, one-decimal half-up rounding, band
// from the server's fit thresholds. Mirrors the server, which stays authoritative.
function assessSummary(rows, criteria, fitLevels) {
  let sum = 0, scored = 0, na = 0, open = 0;
  (criteria || []).forEach((cr) => {
    const s = rows[cr.key]?.score;
    if (s === 'na') na++; else if (s) { sum += Number(s); scored++; } else open++;
  });
  const average = scored ? Math.round((sum / scored) * 10) / 10 : null;
  const fit = average == null ? null : (fitLevels || []).find((f) => average >= f.min) || null;
  return { average, scored, na, open, fit };
}
// One part's state for the progress strip, from the saved record.
function assessStepStatus(ev) {
  if (!ev) return { status: 'Not started', variant: 'soft' };
  return ev.submitted ? { status: 'Submitted', variant: 'success' } : { status: 'Draft', variant: 'warning' };
}
function assessStatusLine(ev) {
  if (!ev) return 'Status: Not started';
  return ev.submitted
    ? `Status: Submitted · Completed by ${ev.evaluatorName || ASSESS_NOT_RECORDED}${ev.updatedAt ? ' · ' + fmtDate(ev.updatedAt) : ''}`
    : `Status: Draft · Last saved by ${ev.evaluatorName || ASSESS_NOT_RECORDED}${ev.updatedAt ? ' · ' + fmtDate(ev.updatedAt) : ''}`;
}

// One evaluator's draft: everything needed to edit, save, submit and reopen an
// HR or Technical evaluation, independent of where its parts are drawn.
function useEvaluationDraft({ type, meta, existing, editable, perm, appId, onSaved, onDirtyChange }) {
  const toast = useToast();
  const s = ASSESS_SECTIONS[type];
  const criteria = (meta && (type === 'hr' ? meta.behavioralCriteria : meta.technicalCriteria)) || [];
  const flagsMeta = meta?.criticalFlags;
  const fresh = () => assessFormState(existing, criteria, flagsMeta);
  const [form, setForm] = useState(fresh);
  const [base, setBase] = useState(form); // what the server holds, as form state
  const [editing, setEditing] = useState(!existing?.submitted);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState(null); // { text, submit, retry }
  const [stale, setStale] = useState(false);
  const [restored, setRestored] = useState(false);
  // Why a SUBMITTED evaluation is being changed — required by the form, sent
  // with the save, and kept in the audit trail and the assessment history.
  const [editReason, setEditReason] = useState('');
  // Send a submission back to draft for its evaluator to revise — no edits of
  // one's own, a reason on record (POST …/reopen, audited as assessment.reopened).
  const [reopening, setReopening] = useState(false);
  async function reopen(reason) {
    setReopening(false);
    try { const r = await api.post(`/assessments/application/${appId}/reopen`, { evaluatorType: type, reason }); toast(`${s.short} evaluation reopened as a draft`); onSaved(r && r.assessment); }
    catch (e) { toast(e.message || 'Could not reopen', 'error'); }
  }
  const changingSubmitted = !!existing?.submitted && editing;
  const dirty = JSON.stringify(form) !== JSON.stringify(base);
  useEffect(() => { onDirtyChange && onDirtyChange(type, dirty); }, [dirty]);
  const unsavedKey = `${appId}:${type}`;
  const synced = useRef(false); // true once the form reflects the server record
  useEffect(() => {
    if (dirty) ASSESS_UNSAVED.set(unsavedKey, { form, base, editing });
    else if (synced.current) ASSESS_UNSAVED.delete(unsavedKey); // never before the first sync
  }, [form, base, editing, dirty]);

  // A refreshed evaluation (or the form metadata arriving) replaces the form
  // only when nothing is unsaved; otherwise the edits stay and the user is told
  // the record moved underneath them.
  const seen = useRef({ existing, n: criteria.length });
  useEffect(() => {
    if (seen.current.existing === existing && seen.current.n === criteria.length) return;
    seen.current = { existing, n: criteria.length };
    const next = assessFormState(existing, criteria, flagsMeta);
    if (criteria.length) synced.current = true;
    if (!dirty) {
      const parked = ASSESS_UNSAVED.get(unsavedKey);
      if (parked && criteria.length && JSON.stringify(parked.base) === JSON.stringify(next)) {
        setForm(parked.form); setBase(next); setEditing(parked.editing); setRestored(true); setStale(false);
      } else { setForm(next); setBase(next); setEditing(!existing?.submitted); setStale(false); }
    }
    else if (JSON.stringify(next) !== JSON.stringify(base)) setStale(true);
  }, [existing, criteria.length]);

  const visibleCriteria = criteria.filter((cr) => perm(assessCriterionKey(type, cr.key)).canView);
  // An average over a partly hidden section would reveal the hidden scores.
  const summary = visibleCriteria.length === criteria.length && criteria.length ? assessSummary(form.rows, criteria, meta?.fitLevels) : null;
  const locked = !editable || !editing;
  const setRow = (key, patch) => setForm((f) => ({ ...f, rows: { ...f.rows, [key]: { ...f.rows[key], ...patch } } }));
  const setFlag = (key, on) => setForm((f) => ({ ...f, flags: { ...f.flags, [key]: on } }));
  const setRecommendation = (v) => setForm((f) => ({ ...f, recommendation: v }));
  const setJustification = (v) => setForm((f) => ({ ...f, justification: v }));

  async function save(submit) {
    if (busyRef.current) return; // one save at a time — no duplicate submissions
    setError(null);
    if (changingSubmitted && !editReason.trim()) { setError({ text: 'Give a reason for changing a submitted evaluation.' }); return; }
    if (submit) {
      const missing = visibleCriteria.filter((cr) => !form.rows[cr.key]?.score).map((cr) => cr.label);
      if (missing.length) { setError({ text: `Answer every criterion (a score or N/A) before submitting. Missing: ${missing.join(', ')}.` }); return; }
      if (!form.recommendation) { setError({ text: 'Choose a recommendation before submitting.' }); return; }
    }
    busyRef.current = true; setBusy(true);
    const sent = form;
    // Only the parts this user may change are sent; the server keeps the rest.
    const section = {};
    criteria.forEach((cr) => {
      if (!perm(assessCriterionKey(type, cr.key)).canEdit) return;
      const r = sent.rows[cr.key];
      section[cr.key] = { score: !r.score ? null : r.score === 'na' ? 'na' : Number(r.score), notes: r.notes };
    });
    const body = { evaluatorType: type, submitted: !!submit, recommendation: sent.recommendation || null, [s.field]: section };
    if (changingSubmitted) body.editReason = editReason.trim();
    if (perm('assessment.criticalFlags').canEdit) body.criticalFlags = sent.flags;
    if (perm(s.justPolicy).canEdit) body[s.just] = sent.justification;
    try {
      const r = await api.post('/assessments/application/' + appId, body);
      setBase(sent); setStale(false); setEditing(!submit); setRestored(false); setEditReason('');
      toast(submit ? 'Evaluation submitted' : 'Draft saved');
      onSaved(r && r.assessment);
    } catch (e) {
      // The form is left exactly as it was so the save can be retried.
      setError({ text: `${e.message || 'Save failed'}. Your changes have not been lost.`, submit: !!submit, retry: true });
      toast(e.message || 'Save failed', 'error');
    } finally { busyRef.current = false; setBusy(false); }
  }
  function cancelEdit() {
    if (dirty && !window.confirm('Discard your unsaved changes to this evaluation?')) return;
    const next = fresh(); setForm(next); setBase(next); setEditing(false); setError(null); setStale(false); setRestored(false); setEditReason('');
  }
  return { type, criteria, visibleCriteria, form, dirty, editing, setEditing, editable, locked, busy, error, stale, restored, summary, existing,
    setRow, setFlag, setRecommendation, setJustification, save, cancelEdit, editReason, setEditReason, changingSubmitted,
    appId, reopening, setReopening, reopen };
}

function AssessmentPanel({ app, canFeedback, onDirtyChange }) {
  const toast = useToast();
  const [meta, setMeta] = useState(null);
  const [bundle, setBundle] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [dirtyParts, setDirtyParts] = useState({}); // { hr, technical, final }

  // The form needs both reads: the approved criteria (`meta`, the same for
  // every application, so fetched once and kept) and this application's
  // bundle. Each read settles on its own — a metadata failure is reported,
  // never swallowed into an endless skeleton, and a bundle that fails on a
  // refresh keeps the last one on screen with a visible caveat. A response
  // for an application the panel no longer shows is dropped.
  const metaRef = useRef(null);
  const gen = useRef(0);
  const load = useCallback(async () => {
    const mine = ++gen.current;
    const [m, b] = await Promise.allSettled([
      metaRef.current ? Promise.resolve(metaRef.current) : api.get('/assessments/meta'),
      api.get('/assessments/application/' + app.id),
    ]);
    if (mine !== gen.current) return;
    if (m.status === 'fulfilled' && m.value) { metaRef.current = m.value; setMeta(m.value); }
    const loadedBundle = b.status === 'fulfilled' && b.value && b.value.assessment;
    if (loadedBundle) setBundle(loadedBundle);
    const failure = b.status === 'rejected' ? b.reason
      : !loadedBundle ? new Error('The server returned no assessment for this application.')
        : m.status === 'rejected' ? m.reason : null;
    setLoadError(failure ? (failure.message || 'Request failed') : null);
  }, [app.id]);
  useEffect(() => { setBundle(null); setLoadError(null); load(); return () => { gen.current++; }; }, [load]);
  // A save answers with the fresh bundle; use it directly (and drop any older
  // read still in flight). Without one, re-read.
  const onSaved = useCallback((fresh) => {
    if (fresh) { gen.current++; setBundle(fresh); setLoadError(null); } else load();
  }, [load]);

  // Unsaved edits in either evaluation or the final decision guard leaving.
  const markDirty = useCallback((part, value) => setDirtyParts((d) => (!!d[part] === value ? d : { ...d, [part]: value })), []);
  const dirty = Object.values(dirtyParts).some(Boolean);
  useEffect(() => { onDirtyChange && onDirtyChange(dirty); }, [dirty]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    const navigate = (e) => { if (!window.confirm('Discard unsaved assessment changes?')) e.preventDefault(); else discardAssessUnsaved(app.id); };
    window.addEventListener('beforeunload', warn);
    window.addEventListener('ats:before-navigate', navigate);
    return () => { window.removeEventListener('beforeunload', warn); window.removeEventListener('ats:before-navigate', navigate); };
  }, [dirty]);

  // The resolved policy for this user and application. A bundle without one
  // (an older server) means "visible, editable when the caller may edit".
  const fallbackEdit = !!canFeedback && bundle?.canEdit !== false;
  const perm = (key) => {
    const p = bundle?.permissions?.[key] || { canView: true, canEdit: fallbackEdit };
    return { canView: !!p.canView, canEdit: !!p.canEdit && !!canFeedback };
  };
  const hr = useEvaluationDraft({ type: 'hr', meta, existing: bundle?.hr, editable: perm('assessment.behavioral').canEdit, perm, appId: app.id, onSaved, onDirtyChange: markDirty });
  const tech = useEvaluationDraft({ type: 'technical', meta, existing: bundle?.technical, editable: perm('assessment.technical').canEdit, perm, appId: app.id, onSaved, onDirtyChange: markDirty });

  if (!bundle) return loadError
    ? <LoadError title="Could not load the assessment" text={loadError} onRetry={load} />
    : <Skeleton rows={6} />;
  if (!bundle.unlocked) return <Empty art="none-yet" text="Interview assessment unlocks once this candidate is moved to an interview stage in the pipeline." />;
  if (!meta) return loadError
    ? <LoadError title="Could not load the assessment form" text={loadError} onRetry={load} />
    : <Skeleton rows={6} />;

  const ctx = bundle.context || {};
  const fmtInfo = (key, v) => {
    if (v == null || v === '') return ASSESS_NOT_RECORDED;
    if (key === 'interview') return `${fmtDate(v.scheduledAt)} · ${v.interviewNo}${v.type ? ' · ' + ivType(v.type) : ''}${v.status && v.status !== 'scheduled' ? ' · ' + v.status : ''}`;
    if (key === 'yearsExperience') return `${v} years`;
    if (key === 'currentSalary' || key === 'expectedSalary') return Number(v).toLocaleString();
    return String(v);
  };
  // A field the user may not see is absent from the bundle and from the page;
  // the grid simply reflows.
  const infoFields = (meta.candidateFields || ASSESS_CANDIDATE_FIELDS)
    .filter((f) => perm(f.policy).canView && Object.prototype.hasOwnProperty.call(ctx, f.key));
  const show = { hr: perm('assessment.behavioral').canView, technical: perm('assessment.technical').canView };
  const drafts = [['hr', hr], ['technical', tech]].filter(([t]) => show[t]).map(([, d]) => d);
  const flagGroups = perm('assessment.criticalFlags').canView ? drafts : [];
  const showFinal = perm('assessment.finalRecommendation').canView;
  const editableDrafts = drafts.filter((d) => d.editable);

  return (
    <div className="assess">
      {loadError && <RefetchError text={`Could not refresh this assessment: ${loadError}. Showing the last loaded evaluation.`} onRetry={load} />}
      <article className="assess-doc" aria-label="Interview assessment">
        {/* No document title here: the drawer header already names the assessment. The printed form keeps its title. */}
        <AssessmentProgress appId={app.id} steps={[
          ...(show.hr ? [{ key: 'hr', anchor: `assess-${app.id}-hr-title`, label: 'Behavioral (HR)', ...assessStepStatus(bundle.hr) }] : []),
          ...(show.technical ? [{ key: 'technical', anchor: `assess-${app.id}-technical-title`, label: 'Technical', ...assessStepStatus(bundle.technical) }] : []),
          ...(showFinal ? [{ key: 'final', anchor: `assess-${app.id}-final`, label: 'Final decision', ...(bundle.finalDecision ? { status: 'Recorded', variant: 'success' } : { status: 'Not recorded', variant: 'soft' }) }] : []),
        ]} />

        {infoFields.length > 0 && (
          <section className="assess-sec" aria-labelledby={`assess-${app.id}-info`}>
            <h3 className="assess-sec-title" id={`assess-${app.id}-info`}>Candidate details</h3>
            <dl className="assess-info">
              {infoFields.map((f) => (
                <div key={f.key} className="assess-info-cell"><dt>{f.label}</dt><dd>{fmtInfo(f.key, ctx[f.key])}</dd></div>
              ))}
            </dl>
          </section>
        )}

        {show.hr && <EvaluationForm type="hr" meta={meta} draft={hr} perm={perm} appId={app.id} readOnly={!hr.editable} onSaved={onSaved} />}
        {show.technical && <EvaluationForm type="technical" meta={meta} draft={tech} perm={perm} appId={app.id} readOnly={!tech.editable} onSaved={onSaved} />}

        {flagGroups.length > 0 && <AssessmentFlags meta={meta} drafts={flagGroups} canEditFlags={perm('assessment.criticalFlags').canEdit} />}

        {(showFinal || drafts.length > 0) && (
          <section className="assess-sec" aria-labelledby={`assess-${app.id}-final`}>
            <h3 className="assess-sec-title" id={`assess-${app.id}-final`}>Final Recommendation</h3>
            {showFinal && <FinalDecisionBox bundle={bundle} meta={meta} canFeedback={perm('assessment.finalRecommendation').canEdit} appId={app.id} onSaved={onSaved} onDirtyChange={markDirty} />}
            {drafts.map((d) => <AssessmentFit key={d.type} draft={d} meta={meta} appId={app.id} perm={perm} />)}
          </section>
        )}

        {editableDrafts.length > 0 && (
          <div className="assess-bar" role="group" aria-label="Save or submit evaluations">
            {editableDrafts.map((d) => <AssessmentSaveRow key={d.type} draft={d} />)}
          </div>
        )}
        <AssessmentHistory appId={app.id} refreshKey={`${bundle.hr?.updatedAt || ''}|${bundle.technical?.updatedAt || ''}|${bundle.finalDecision?.decidedAt || ''}`} />
      </article>
      <div className="assess-actions">
        <button type="button" className="btn btn-secondary" onClick={() => api.download(`/assessments/application/${app.id}/preview`).catch((e) => toast(e.message || 'Could not open the preview', 'error'))}>Preview printable form</button>
      </div>
    </div>
  );
}

// One assessment table (HR or Technical), drawn like the sheet.
function EvaluationForm({ type, meta, draft, perm, appId, readOnly }) {
  const s = ASSESS_SECTIONS[type];
  const id = `assess-${appId}-${type}`;
  const ev = draft.existing;
  const fitLabel = (v) => (meta.fitLevels || []).find((f) => f.value === v)?.label || v;
  return (
    <section className="assess-sec" aria-labelledby={id + '-title'}>
      <h3 className="assess-sec-title" id={id + '-title'}>{s.title}</h3>
      <p className="assess-sec-meta">
        {assessStatusLine(ev)}{readOnly ? ' · View only' : ''}{draft.dirty ? ' · Unsaved changes' : ''}
      </p>
      {draft.stale && <div className="assess-note assess-warn" role="status">This evaluation was saved by someone else while you were editing. Your edits are kept; saving will replace their version.</div>}
      {draft.restored && draft.dirty && <div className="assess-note" role="status" data-restored="true">Your unsaved changes were restored. Save or submit to keep them.</div>}
      {type === 'hr' && meta.behavioralInstruction && <p className="assess-instruction">{meta.behavioralInstruction}</p>}
      <table className="assess-table">
        <colgroup><col className="assess-col-crit" /><col className="assess-col-desc" /><col className="assess-col-score" /><col className="assess-col-notes" /></colgroup>
        <thead><tr><th scope="col">Criterion</th><th scope="col">What to Evaluate</th><th scope="col">Score 1–5</th><th scope="col">Notes</th></tr></thead>
        <tbody>
          {draft.visibleCriteria.map((cr) => (
            <ScoreRow key={cr.key} idBase={`${id}-${cr.key}`} label={cr.label} description={cr.description}
              value={draft.form.rows[cr.key]?.score} notes={draft.form.rows[cr.key]?.notes}
              readOnly={draft.locked || !perm(assessCriterionKey(type, cr.key)).canEdit} scoreGuide={meta.scoreGuide} naLabel={meta.naLabel}
              onChange={(v) => draft.setRow(cr.key, { score: v })} onNotes={(v) => draft.setRow(cr.key, { notes: v })} />
          ))}
        </tbody>
      </table>
      <p className="assess-guide">Score Guide: 5 Excellent • 4 Proficient • 3 Average • 2 Below Standard • 1 Unsuitable • N/A {meta.naLabel || 'Not Applicable'}</p>
      {draft.summary && (
        <p className="assess-summary">
          Average: <strong>{draft.summary.average != null ? draft.summary.average.toFixed(1) + ' / 5' : 'Not rated'}</strong>
          {draft.summary.fit && <> · Fit: <strong>{draft.summary.fit.label}</strong></>}
          {' · '}{draft.summary.scored} scored · {draft.summary.na} N/A{draft.summary.open ? ` · ${draft.summary.open} unanswered` : ''}
        </p>
      )}
      {draft.summary && draft.summary.scored === 0 && draft.summary.na > 0 && <div className="assess-note assess-warn">No scored evidence — every answered criterion is N/A, so this section is Not rated.</div>}
      {ev?.fitHistorical && <div className="assess-note">Previously recorded fit (manual, historical): {fitLabel(ev.savedFit)}. Fit is now derived from the scores.</div>}
    </section>
  );
}

// One criterion row: 1 2 3 4 5 N/A as a compact segmented control that sits
// inside the table cell; read-only shows the chosen value plainly.
function ScoreRow({ idBase, label, description, value, notes, onChange, onNotes, readOnly, scoreGuide, naLabel }) {
  const guide = scoreGuide || {};
  const na = naLabel || 'Not Applicable';
  const options = ['1', '2', '3', '4', '5', 'na'];
  const optionLabel = (v) => (v === 'na' ? `N/A — ${na}` : `${v} — ${guide[v] || ''}`);
  return (
    <tr>
      <th scope="row" className="assess-crit">{label}</th>
      <td className="assess-desc">{description}</td>
      <td className="assess-score">
        {readOnly
          ? (value
            ? <span className="assess-score-val" aria-label={`${label} score: ${optionLabel(value)}`}><strong>{value === 'na' ? 'N/A' : value}</strong><span>{value === 'na' ? na : guide[value]}</span></span>
            : <span className="assess-score-val assess-score-empty" aria-label={`${label} score: not answered`}>—</span>)
          : (
            <div className="assess-seg" role="radiogroup" aria-label={`${label} score`}>
              {options.map((v) => (
                <button key={v} type="button" role="radio" aria-checked={value === v} aria-label={optionLabel(v)} title={optionLabel(v)}
                  className={'assess-seg-btn' + (value === v ? ' on' : '')} onClick={() => onChange(value === v ? '' : v)}>{v === 'na' ? 'N/A' : v}</button>
              ))}
            </div>
          )}
      </td>
      <td className="assess-notes">
        {readOnly
          ? <div className="assess-notes-text">{notes || ''}</div>
          : <textarea id={idBase + '-notes'} rows="2" aria-label={`${label} notes`} placeholder="Notes" value={notes ?? ''} onChange={(e) => onNotes(e.target.value)} />}
      </td>
    </tr>
  );
}

// Critical Flags — one line per evaluation the user may see, each flag labelled
// with its own text so assistive technology announces what it means.
function AssessmentFlags({ meta, drafts, canEditFlags }) {
  const raised = drafts.some((d) => Object.values(d.form.flags || {}).some(Boolean));
  return (
    <section className="assess-sec" aria-label="Critical Flags — Review if Any Are True">
      <h3 className="assess-sec-title">Critical Flags — Review if Any Are True</h3>
      {drafts.map((d) => {
        const editable = canEditFlags && !d.locked;
        return (
          <div key={d.type} className="assess-flags" role="group" aria-label={`Critical flags — ${ASSESS_SECTIONS[d.type].evaluator}`}>
            <span className="assess-flags-who">{ASSESS_SECTIONS[d.type].evaluator}:</span>
            {(meta.criticalFlags || []).map((f) => {
              const fid = `assess-flag-${d.type}-${f.key}`;
              const on = !!d.form.flags[f.key];
              // View-only: marked as on the sheet, not shown as a greyed-out control.
              if (!editable) return <span key={f.key} className={'assess-box' + (on ? ' on' : '')} aria-label={`${f.label}: ${on ? 'flagged' : 'not flagged'}`}>{on ? '☒' : '☐'} {f.label}</span>;
              return (
                <label key={f.key} htmlFor={fid} className="assess-flag">
                  <input id={fid} type="checkbox" aria-label={f.label} checked={on}
                    onChange={(e) => d.setFlag(f.key, e.target.checked)} />
                  <span>{f.label}</span>
                </label>
              );
            })}
          </div>
        );
      })}
      {raised && <div className="assess-note"><span className="badge badge-warning">Review required</span> A critical flag is set. This does not reject the candidate.</div>}
    </section>
  );
}

// Behavioral Fit / Technical Fit lines of the Final Recommendation, with the
// evaluator's recommendation and the PDF's "Justification / Key Strengths".
function AssessmentFit({ draft, meta, appId, perm }) {
  const s = ASSESS_SECTIONS[draft.type];
  const fit = draft.summary?.fit?.value || null;
  const recId = `assess-${appId}-${draft.type}-rec`;
  const justId = `assess-${appId}-${draft.type}-just`;
  const just = perm(s.justPolicy);
  const justEditable = just.canEdit && !draft.locked;
  const recLabel = (meta.decisions || []).find((d) => d.value === draft.form.recommendation)?.label;
  return (
    <div className="assess-fit">
      <div className="assess-fit-line">
        <strong>{s.fitLabel}:</strong>
        {draft.summary
          ? (meta.fitLevels || []).map((f) => <span key={f.value} className={'assess-box' + (fit === f.value ? ' on' : '')}>{fit === f.value ? '☒' : '☐'} {f.label} ({ASSESS_FIT_RANGE[f.value] || f.range})</span>)
          : <span className="assess-muted">Not shown — part of this section is not visible to you.</span>}
      </div>
      <div className="assess-fit-row">
        <label htmlFor={recId}>{s.short} recommendation</label>
        {draft.locked
          ? <span id={recId} className="assess-fit-value">{recLabel || ASSESS_NOT_RECORDED}</span>
          : <select id={recId} aria-label={`${s.short} recommendation`} value={draft.form.recommendation} onChange={(e) => draft.setRecommendation(e.target.value)}>
            <option value="">— Select —</option>{(meta.decisions || []).map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select>}
      </div>
      {just.canView && (
        <div className="assess-fit-row assess-just">
          <label htmlFor={justId}>Justification / Key Strengths</label>
          {justEditable
            ? <textarea id={justId} rows="2" value={draft.form.justification} onChange={(e) => draft.setJustification(e.target.value)} placeholder="Evidence, examples, key strengths…" />
            : <div id={justId} className="assess-fit-value assess-just-text">{draft.form.justification || '—'}</div>}
        </div>
      )}
    </div>
  );
}

// Save / submit controls for one evaluation the user may edit.
// Stateless, like the other document sections: the draft hook owns the state.
function AssessmentSaveRow({ draft }) {
  const s = ASSESS_SECTIONS[draft.type];
  const ev = draft.existing;
  const reasonId = `assess-${draft.appId}-${draft.type}-reason`;
  const needReason = draft.changingSubmitted && !draft.editReason.trim();
  return (
    <div className="assess-bar-row">
      <div className="assess-bar-state"><strong>{s.short} assessment</strong> <span className="assess-muted">{assessStatusLine(ev).replace('Status: ', '')}{draft.dirty ? ' · Unsaved changes' : ''}</span></div>
      {draft.error && (
        <div className="assess-note assess-warn" role="alert">
          {draft.error.text}
          {draft.error.retry && <> <button type="button" className="btn btn-sm btn-secondary" disabled={draft.busy} onClick={() => draft.save(draft.error.submit)}>Retry</button></>}
        </div>
      )}
      {draft.changingSubmitted && (
        <div className="assess-reason">
          <label htmlFor={reasonId}>Reason for changing a submitted evaluation *</label>
          <textarea id={reasonId} rows="2" value={draft.editReason} onChange={(e) => draft.setEditReason(e.target.value)} placeholder="Recorded in the assessment history" />
        </div>
      )}
      <div className="btn-row">
        {!draft.editing
          ? <>
            <button type="button" className="btn btn-sm btn-secondary" aria-label={`Edit ${s.short.toLowerCase()} evaluation`} onClick={() => draft.setEditing(true)}>Edit evaluation</button>
            {ev?.submitted && <button type="button" className="btn btn-sm btn-ghost" onClick={() => draft.setReopening(true)}>Reopen for revision</button>}
          </>
          : <>
            <button type="button" className="btn btn-sm btn-secondary" aria-label={`Save ${s.short.toLowerCase()} draft`} onClick={() => draft.save(false)} disabled={draft.busy || needReason}>{draft.busy ? 'Saving…' : ev?.submitted ? 'Save as draft (withdraws submission)' : 'Save draft'}</button>
            <button type="button" className="btn btn-sm" aria-label={`Submit ${s.short.toLowerCase()} evaluation`} onClick={() => draft.save(true)} disabled={draft.busy || needReason}>{draft.busy ? 'Saving…' : ev?.submitted ? 'Submit changes' : 'Submit evaluation'}</button>
            {ev?.submitted && <button type="button" className="btn btn-sm btn-ghost" onClick={draft.cancelEdit} disabled={draft.busy}>Cancel edit</button>}
          </>}
      </div>
      {draft.reopening && <Confirm title={`Reopen the ${s.short.toLowerCase()} evaluation`} message="It goes back to draft so it can be revised and submitted again. The scores are kept. Give a reason — it is recorded in the assessment history." requireReason confirmLabel="Reopen" onConfirm={draft.reopen} onClose={() => draft.setReopening(false)} />}
    </div>
  );
}

// Where each part of the assessment stands, at the top of the form, each
// linked to its section. Statuses come from the saved record, not the form.
function AssessmentProgress({ appId, steps }) {
  return (
    <nav className="assess-progress" aria-label="Assessment progress">
      <ol>
        {steps.map((st) => (
          <li key={st.key}>
            <a href={`#${st.anchor}`} onClick={(e) => { e.preventDefault(); document.getElementById(st.anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>
              <span className="assess-progress-label">{st.label}</span>
              <Badge variant={st.variant}>{st.status}</Badge>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

// Who saved, submitted or reopened each part, when and why (GET …/history).
function AssessmentHistory({ appId, refreshKey }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (!open) return;
    api.get(`/assessments/application/${appId}/history`).then((r) => { setRows(r.history || []); setErr(null); }).catch((e) => setErr(e.message));
  }, [open, appId, refreshKey]);
  const what = (h) => ({
    'assessment.draft_saved': h.previousState === 'submitted' ? 'Withdrew to draft' : 'Saved a draft',
    // An update only follows a submission, so an update to draft is a withdrawal.
    'assessment.submitted': 'Submitted', 'assessment.updated': h.state === 'draft' ? 'Withdrew to draft' : 'Changed after submission',
    'assessment.reopened': 'Reopened for revision', 'assessment.final_decision': 'Recorded the final decision',
  })[h.action] || h.action;
  const part = (h) => (h.part === 'final' ? 'Final decision' : `${ASSESS_SECTIONS[h.part]?.short || h.part} evaluation`);
  return (
    <section className="assess-sec assess-history" aria-label="Assessment history">
      <button type="button" className="btn btn-sm btn-ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide history' : 'Show history'}
      </button>
      {open && (err ? <p className="assess-muted">{err}</p> : !rows ? <Skeleton rows={2} /> : rows.length === 0 ? <p className="assess-muted">Nothing recorded yet.</p> : (
        <ol className="assess-history-list">
          {rows.map((h, i) => (
            <li key={i}>
              <span className="assess-history-when">{fmtDate(h.at)}</span>
              <span><strong>{h.actor || 'System'}</strong> · {what(h)} — {part(h)}{h.decision ? `: ${h.decision}` : ''}{h.previous ? ` (was ${h.previous})` : ''}</span>
              {h.reason && <span className="assess-history-reason">Reason: {h.reason}</span>}
            </li>
          ))}
        </ol>
      ))}
    </section>
  );
}

function FinalDecisionBox({ bundle, meta, canFeedback, appId, onSaved, onDirtyChange }) {
  const toast = useToast();
  const fd = bundle.finalDecision;
  const choices = meta.finalDecisions || meta.decisions || [];
  // A historical value (e.g. "hired") is shown as such, never pre-selected.
  const savedOf = (f) => ({ decision: f && choices.some((d) => d.value === f.decision) ? f.decision : '', notes: f?.notes || '' });
  const parkedFinal = ASSESS_UNSAVED.get(`${appId}:final`);
  const [base, setBase] = useState(() => savedOf(fd));
  const restoreFinal = parkedFinal && JSON.stringify(parkedFinal.base) === JSON.stringify(savedOf(fd));
  const [decision, setDecision] = useState(restoreFinal ? parkedFinal.decision : base.decision);
  const [notes, setNotes] = useState(restoreFinal ? parkedFinal.notes : base.notes);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState(null);
  const dirty = decision !== base.decision || notes !== base.notes;
  useEffect(() => { onDirtyChange && onDirtyChange('final', dirty); }, [dirty]);
  useEffect(() => {
    if (dirty) ASSESS_UNSAVED.set(`${appId}:final`, { decision, notes, base });
    else ASSESS_UNSAVED.delete(`${appId}:final`);
  }, [decision, notes, base, dirty]);
  // Adopt a refreshed decision unless the user has an unsaved one.
  const seen = useRef(fd);
  useEffect(() => {
    if (seen.current === fd) return;
    seen.current = fd;
    if (dirty) return;
    const next = savedOf(fd); setBase(next); setDecision(next.decision); setNotes(next.notes);
  }, [fd]);
  async function save() {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null);
    const sent = { decision, notes };
    try { const r = await api.post(`/assessments/application/${appId}/final`, sent); setBase(sent); toast('Final decision recorded'); onSaved(r && r.assessment); }
    catch (e) { setError(`${e.message || 'Save failed'}. Your choice has not been lost.`); toast(e.message || 'Save failed', 'error'); }
    finally { busyRef.current = false; setBusy(false); }
  }
  const notesId = `assess-${appId}-final-notes`;
  return (
    <div className="assess-final">
      {!canFeedback ? (
        // View-only: the recorded choice as the sheet marks it, not greyed-out controls.
        <div className="assess-decision" role="group" aria-label={`Final decision: ${choices.find((d) => d.value === decision)?.label || 'not recorded'}`}>
          <strong>Decision:</strong>
          {choices.map((d) => <span key={d.value} className={'assess-box' + (decision === d.value ? ' on' : '')}>{decision === d.value ? '☒' : '☐'} {d.label}</span>)}
        </div>
      ) : (
      <div className="assess-decision" role="radiogroup" aria-label="Final decision">
        <strong>Decision:</strong>
        {choices.map((d) => {
          const id = `assess-${appId}-final-${d.value}`;
          return (
            <label key={d.value} htmlFor={id} className={'assess-box assess-choice' + (decision === d.value ? ' on' : '')}>
              <input id={id} type="radio" name={`assess-${appId}-final`} value={d.value} checked={decision === d.value} onChange={() => setDecision(d.value)} />
              <span>{d.label}</span>
            </label>
          );
        })}
      </div>
      )}
      {fd?.historical && <div className="assess-note">Recorded decision (historical vocabulary): {fd.decisionLabel || fd.decision}</div>}
      <p className="assess-muted assess-instruction">Records the panel's decision only. It does not move the candidate in the pipeline or create an offer.</p>
      {(canFeedback || notes) && (
        <div className="assess-fit-row">
          <label htmlFor={notesId}>Decision notes</label>
          {canFeedback
            ? <textarea id={notesId} rows="2" value={notes} onChange={(e) => setNotes(e.target.value)} />
            : <div id={notesId} className="assess-fit-value assess-just-text">{notes}</div>}
        </div>
      )}
      {error && <div className="assess-note assess-warn" role="alert">{error}</div>}
      <div className="assess-final-foot">
        {fd?.decidedByName && <span className="assess-muted">Decided by {fd.decidedByName}{fd.decidedAt ? ' · ' + fmtDate(fd.decidedAt) : ''}</span>}
        {canFeedback && <button type="button" className="btn btn-sm" onClick={save} disabled={busy || !decision}>{busy ? 'Saving…' : error ? 'Retry' : 'Record Final Decision'}</button>}
      </div>
    </div>
  );
}

// Opens the assessment from an interview the user is assigned to — the
// Technical Interviewer's way in, without access to the hiring request.
// Assessment drawers render through toPageLevel (the shared overlay host) so
// no page container's stacking context can put them under the phone top bar (AR-05).
function InterviewAssessmentDrawer({ applicationId, title, user, onClose }) {
  const titleId = useId();
  const assessDirty = useRef(false);
  const requestClose = useCallback(() => {
    if (assessDirty.current) {
      if (!window.confirm('Discard unsaved assessment changes?')) return;
      discardAssessUnsaved(applicationId);
    }
    onClose();
  }, [onClose, applicationId]);
  const { dialogRef, onDialogKeyDown } = useDialogFocus(requestClose);
  return toPageLevel(
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) requestClose(); }}>
      <div ref={dialogRef} className="modal assess-drawer" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex="-1" onKeyDown={onDialogKeyDown}>
        <div className="modal-head">
          <div><h3 id={titleId}>Interview assessment</h3>{title && <div className="assess-muted">{title}</div>}</div>
          <button type="button" className="icon-btn" aria-label="Close assessment" onClick={requestClose}><Icon name="close" size={16} /></button>
        </div>
        <div className="modal-body">
          <AssessmentPanel app={{ id: applicationId }} canFeedback={can(user, 'interview.feedback')} onDirtyChange={(d) => { assessDirty.current = d; }} />
        </div>
      </div>
    </div>
  );
}

// Administration → Interview Settings → Assessment Form → Visibility & Permissions.
// Edits the server's assessment field policy; the server validates, stores and
// audits it, and the same policy then drives the form, the API and the preview.
function AssessmentPolicyPage({ user }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [draft, setDraft] = useState(null); // overrides being edited
  const [busy, setBusy] = useState(false);
  const [showCriteria, setShowCriteria] = useState(false);
  // What the server would enforce for the current draft. The screen never
  // works the policy out itself (AR-03/AR-08): every unsaved change is
  // resolved by the same server code that enforces saved settings.
  const [preview, setPreview] = useState(null); // { valid, error?, effective? }
  const previewGen = useRef(0);
  const load = useCallback(async () => {
    setLoadError(null);
    try { const r = await api.get('/assessments/policy'); setData(r.policy); setDraft(r.policy.overrides); setPreview({ valid: true, effective: r.policy.effective }); }
    catch (e) { setLoadError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const dirty = !!data && JSON.stringify(draft) !== JSON.stringify(data.overrides);
  useEffect(() => {
    if (!data || !draft) return;
    const mine = ++previewGen.current;
    if (!dirty) { setPreview({ valid: true, effective: data.effective }); return; }
    api.post('/assessments/policy/preview', { overrides: draft })
      .then((r) => { if (mine === previewGen.current) setPreview(r); })
      .catch((e) => { if (mine === previewGen.current) setPreview({ valid: false, error: e.message }); });
  }, [draft, data]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    const navigate = (e) => { if (!window.confirm('Discard unsaved assessment permission changes?')) e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    window.addEventListener('ats:before-navigate', navigate);
    return () => { window.removeEventListener('beforeunload', warn); window.removeEventListener('ats:before-navigate', navigate); };
  }, [dirty]);

  if (loadError) return <LoadError title="Could not load assessment permissions" text={loadError} onRetry={load} />;
  if (!data || !draft) return <Skeleton rows={8} />;

  // Last server answer (valid previews only); while one is in flight the
  // previous answer stays on screen.
  const effective = (preview?.valid && preview.effective) || data.effective;
  const cell = (aud, key) => effective[aud]?.[key] || { view: false, edit: false, configured: { view: false, edit: false } };
  const parentOf = {};
  data.sections.forEach((s) => s.fields.forEach((f) => { parentOf[f.key] = s; }));
  const setRule = (aud, key, patch) => setDraft((d) => {
    const next = { ...(cell(aud, key).configured || cell(aud, key)), ...patch };
    if (patch.view === false) next.edit = false;
    if (patch.edit === true) next.view = true;
    const a = { ...(d[aud] || {}), [key]: { view: !!next.view, edit: !!next.edit } };
    // A section switched off takes its fields' own grants with it, so the
    // draft never holds a grant the server would refuse.
    const section = data.sections.find((s) => s.key === key);
    if (section && (section.gatesView && !next.view)) for (const f of section.fields) delete a[f.key];
    if (section && section.gatesEdit && !next.edit) for (const f of section.fields) if (a[f.key]?.edit) a[f.key] = { ...a[f.key], edit: false };
    return { ...d, [aud]: a };
  });
  const clearRule = (aud, key) => setDraft((d) => { const a = { ...(d[aud] || {}) }; delete a[key]; return { ...d, [aud]: a }; });

  async function save(overrides, message) {
    setBusy(true);
    try { const r = await api.put('/assessments/policy', { overrides }); setData(r.policy); setDraft(r.policy.overrides); setPreview({ valid: true, effective: r.policy.effective }); toast(message); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }

  const row = (key, label, { editable, depth = 0, hint = false }) => (
    <tr key={key} className={depth ? 'assess-pol-field' : 'assess-pol-section'}>
      <th scope="row">{label}{hint && <span className="assess-muted"> · follows its section unless changed</span>}</th>
      {data.audiences.map((a) => {
        const r = cell(a.key, key);
        const set = draft[a.key]?.[key];
        const parent = depth ? parentOf[key] : null;
        const parentRule = parent ? cell(a.key, parent.key) : null;
        // Shown exactly as enforced: a field its section blocks is unticked and locked.
        const viewLocked = !!(parent?.gatesView && !parentRule.view);
        const editLocked = viewLocked || !!(parent?.gatesEdit && !parentRule.edit);
        const lockNote = viewLocked ? `Hidden because “${parent.label}” is hidden for ${a.label}` : editLocked ? `Read-only because “${parent.label}” is read-only for ${a.label}` : undefined;
        return (
          <React.Fragment key={a.key}>
            <td className="assess-pol-cell">
              <input type="checkbox" aria-label={`${a.label}: view ${label}`} title={viewLocked ? lockNote : undefined}
                checked={!!r.view} disabled={viewLocked} onChange={(e) => setRule(a.key, key, { view: e.target.checked })} />
            </td>
            <td className="assess-pol-cell">
              {editable
                ? <input type="checkbox" aria-label={`${a.label}: edit ${label}`} title={editLocked ? lockNote : undefined}
                  checked={!!r.edit} disabled={editLocked} onChange={(e) => setRule(a.key, key, { edit: e.target.checked })} />
                : <span className="assess-muted" aria-label="Not editable from the assessment">—</span>}
              {set && <button type="button" className="assess-pol-reset" title="Reset to default" aria-label={`${a.label}: reset ${label} to default`} onClick={() => clearRule(a.key, key)}>↺</button>}
            </td>
          </React.Fragment>
        );
      })}
    </tr>
  );

  return (
    <div>
      <PageHead crumb="Administration / Interview Settings / Assessment Form" title="Assessment Visibility & Permissions"
        sub="Who may view or edit each part of the interview assessment. These rules apply to the form, the API and the printable form alike. They can only narrow existing access — salary always also requires the salary permission. A field cannot be shown while its section is hidden."
        actions={<>
          <button type="button" className="btn btn-ghost" disabled={busy || !dirty} onClick={() => setDraft(data.overrides)}>Discard</button>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => { if (window.confirm('Restore the default assessment permissions?')) save({}, 'Defaults restored'); }}>Restore defaults</button>
          <button type="button" className="btn" disabled={busy || !dirty || preview?.valid === false} onClick={() => save(draft, 'Assessment permissions saved')}>{busy ? 'Saving…' : 'Save changes'}</button>
        </>} />
      {preview?.valid === false && <div className="error-banner" role="alert">{preview.error}</div>}
      <div className="card card-pad assess-pol">
        <table className="assess-pol-table">
          <thead>
            <tr><th scope="col" rowSpan="2">Field / Section</th>{data.audiences.map((a) => <th key={a.key} scope="colgroup" colSpan="2">{a.label}</th>)}</tr>
            <tr>{data.audiences.map((a) => <React.Fragment key={a.key}><th scope="col">View</th><th scope="col">Edit</th></React.Fragment>)}</tr>
          </thead>
          <tbody>
            {data.sections.map((s) => {
              const criteria = s.key === 'assessment.behavioral' || s.key === 'assessment.technical';
              return (
                <React.Fragment key={s.key}>
                  {s.key === 'assessment.candidate'
                    ? <tr className="assess-pol-group"><th scope="rowgroup" colSpan={1 + data.audiences.length * 2}>{s.label}</th></tr>
                    : row(s.key, s.label, { editable: s.editable })}
                  {s.fields.filter(() => !criteria || showCriteria).map((f) => row(f.key, f.label, { editable: s.editable, depth: 1, hint: criteria }))}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
        <label className="assess-flag"><input type="checkbox" checked={showCriteria} onChange={(e) => setShowCriteria(e.target.checked)} /><span>Show per-criterion settings</span></label>
      </div>
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

/* Recommend a candidate (recruitment team, 25 Oct 2026): a hiring manager or
   technical interviewer hands recruitment a CV of someone they recommend. One
   short form and one file; the candidate lands in Shortlisted — the first stage
   they can see — marked "Recommended by …", and recruitment is notified. */
function RecommendCandidateModal({ request, onClose, onDone }) {
  const toast = useToast();
  const [f, setF] = useState({ fullName: '', email: '', phone: '', currentPosition: '', employer: '', yearsExperience: '', note: '' });
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const tooBig = file && file.size > UPLOAD_MAX_MB * 1024 * 1024;
  const ready = f.fullName.trim() && file && !tooBig && !busy;
  async function submit() {
    if (!f.fullName.trim()) { setProblem('Type the candidate’s name.'); return; }
    if (!file) { setProblem('Attach the CV (PDF or Word).'); return; }
    if (tooBig) { setProblem(`The CV is larger than ${UPLOAD_MAX_MB} MB.`); return; }
    setBusy(true); setProblem('');
    try {
      const r = await api.uploadTo('/applications/recommend', file, { requestId: request.id, ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, String(v || '').trim()])) });
      toast(r.reusedCandidate
        ? `${f.fullName.trim()} was already in the Talent Pool — added to Shortlisted as your recommendation.`
        : `${f.fullName.trim()} added to Shortlisted as your recommendation. Recruitment has been notified.`);
      onDone();
    } catch (e) {
      setProblem(e.message || 'Could not add the candidate.');
    } finally { setBusy(false); }
  }
  return (
    <Modal title={`Recommend a candidate — ${shortReqCode(request.ticketNo)}`} onClose={onClose} wide
      footer={<><button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button><button className="btn" onClick={submit} disabled={!ready}>{busy ? 'Adding…' : 'Add to Shortlisted'}</button></>}>
      <p className="muted" style={{ marginTop: 0 }}>
        Attach the CV and the name; the rest is optional. The candidate goes straight into <strong>Shortlisted</strong> for {request.title}, marked as your recommendation, and the recruitment team is notified to take it from there.
      </p>
      <div className="form-grid">
        <div className="field full"><label>Candidate name *</label><input value={f.fullName} onChange={(e) => set('fullName', e.target.value)} placeholder="e.g. Ahmed Mostafa" autoFocus /></div>
        <div className="field"><label>Email</label><input type="email" value={f.email} onChange={(e) => set('email', e.target.value)} placeholder="name@example.com" /></div>
        <div className="field"><label>Phone</label><input value={f.phone} onChange={(e) => set('phone', e.target.value)} placeholder="+20 1x xxx xxxx" /></div>
        <div className="field"><label>Current position</label><input value={f.currentPosition} onChange={(e) => set('currentPosition', e.target.value)} placeholder="e.g. Senior Site Engineer" /></div>
        <div className="field"><label>Current employer</label><input value={f.employer} onChange={(e) => set('employer', e.target.value)} placeholder="Company" /></div>
        <div className="field"><label>Years of experience</label><input type="number" min="0" max="60" value={f.yearsExperience} onChange={(e) => set('yearsExperience', e.target.value)} /></div>
        <div className="field full"><label>CV (PDF or Word) *</label>
          <input type="file" accept=".pdf,.doc,.docx" onChange={(e) => { setFile(e.target.files?.[0] || null); setProblem(''); }} />
          {file && <div className="muted" style={{ marginTop: 4 }}>{file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB{tooBig ? ` — larger than ${UPLOAD_MAX_MB} MB` : ''}</div>}
        </div>
        <div className="field full"><label>Why you recommend them <span className="muted">(optional)</span></label><textarea rows="2" value={f.note} onChange={(e) => set('note', e.target.value)} placeholder="e.g. worked with me on Soul, strong on finishing works and site coordination." /></div>
      </div>
      {problem && <div className="form-error" role="alert" style={{ marginTop: 8 }}>{problem}</div>}
    </Modal>
  );
}

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
        <div className="field"><label>Initial Status</label><select value={sel.initialStatus} onChange={(e) => setSel((s) => ({ ...s, initialStatus: e.target.value }))}>{LINK_ENTRY_STAGES.map((s) => <option key={s} value={s}>{APP_STATUS[s].label}</option>)}</select></div>
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
    // A specific CV version is fetched by its document id, never by filename.
    const res = await fetch(candidate.docId ? `/api/candidates/${candidate.id}/documents/${candidate.docId}/file` : `/api/candidates/${candidate.id}/resume`, {
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
    a.download = (candidate.docId ? candidate.docName : candidate.resumeName) || candidate.resumeName || `${candidate.candidateNo || 'candidate'}-cv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch { toast('Could not download the CV.', 'error'); }
}

// A sortable column header. Clicking toggles asc/desc. Three states — neutral, ascending, descending —
// that differ only in WHICH glyph sits in the caret box and what colour it is.
// The box itself is always occupied by a 16px icon, so the label never moves:
// the caret used to render nothing at all while unsorted and relied on the
// stylesheet alone to hold the gap open.
function SortTh({ label, col, sort, onSort, align, priority }) {
  const active = sort.by === col;
  const direction = active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  const mark = direction === 'ascending' ? 'chevronUp'
    : direction === 'descending' ? 'chevronDown'
    : 'sortNeutral';
  return (
    <th data-priority={priority} data-col={col} className={'sort-th' + (active ? ' active' : '')} style={align ? { textAlign: align } : null}
      onClick={() => onSort(col)} tabIndex="0" onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSort(col); } }} title={`Sort by ${label}`}
      role="columnheader" aria-sort={direction}>
      {/* The label and the caret need a flex row of their own. `.sort-caret`
          has always declared `flex: 0 0 16px` and `.sort-label` `overflow:
          hidden; text-overflow: ellipsis`, but nothing ever made their parent
          a flex container — and a `<th>` cannot become one without giving up
          its table-cell layout. So both declarations were inert: the label was
          an inline box, where text-overflow does nothing, and in a narrow
          column it guillotined mid-word while the caret was pushed clean
          outside the cell and clipped away, taking the sort affordance with
          it. This wrapper is the flex row they were written for. */}
      <span className="sort-th-inner">
        <span className="sort-label">{label}</span>
        <span className="sort-caret" data-sort={direction} aria-hidden="true"><Icon name={mark} size={16} /></span>
      </span>
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
    // Prefer Unlink: moving someone between requests is not a rejection and must
    // never email the candidate one. Once interviews/offers exist the old record
    // is kept, closed as Rejected with the move as its reason.
    try {
      await api.post(`/applications/${fromLink.applicationId}/unlink`, { reason: `Moved to ${dest.ticketNo} (${dest.title})` });
    } catch (e) {
      if (!/Disqualify|interview|offer|unlink/i.test(String(e && e.message))) throw e;
      await api.post(`/applications/${fromLink.applicationId}/move`, {
        status: 'rejected',
        reason: `Moved to ${dest.ticketNo} (${dest.title})`,
      });
    }
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
// Record links (review R9). While a record is open the address bar reads
// `#<route>/<id>`, so it can be copied into Teams or an email, and opening that
// link lands on the record. replaceState, not a hash assignment: it neither
// fires hashchange nor adds a history entry per record.
const RECORD_OPENERS = {
  requests: { pending: '__atsPendingRequestId', event: 'ats:open-request' },
  candidates: { pending: '__atsPendingCandidateId', event: 'ats:open-candidate' },
  offers: { pending: '__atsPendingOfferId', event: 'ats:open-offer' },
};
function useRecordUrl(route, id) {
  useEffect(() => {
    const base = window.location.pathname + window.location.search;
    const mine = '#' + route + '/';
    if (id != null) {
      if (window.location.hash !== mine + id) window.history.replaceState(null, '', base + mine + id);
      return () => { if (window.location.hash.startsWith(mine)) window.history.replaceState(null, '', base); };
    }
    if (window.location.hash.startsWith(mine)) window.history.replaceState(null, '', base);
    return undefined;
  }, [route, id]);
}

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
            <button className="rq-link-btn rq-link-btn-icon" onClick={() => { setMode('move'); setOpen((v) => !v); setError(''); setBlocking(null); }}
              aria-haspopup="dialog" aria-expanded={open} aria-label="Move to another request" title="Move to another request">
              <Icon name="chevronDown" size={16} />
            </button>
          )}
        </div>
      ) : canLink ? (
        <button className="rq-link-btn" onClick={() => { setMode('link'); setOpen((v) => !v); setError(''); setBlocking(null); }}
          aria-haspopup="dialog" aria-expanded={open}>Link to Request <Icon name="chevronDown" size={16} /></button>
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

/* A row's secondary actions behind one "More" button, so a table row keeps
   one visible action and never wraps its buttons onto the next row. Same
   popover and item styles as the candidate Action menu. `items` is a list of
   { label, onClick, danger?, disabled?, hidden? }. */
function RowMenu({ label = 'More', items, ariaLabel }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const popRef = useRef(null);
  const anchor = useViewportAnchor(open, wrapRef, { width: 220, minBelow: 200 });
  useEffect(() => {
    if (!open) return undefined;
    const inside = (t) => (wrapRef.current && wrapRef.current.contains(t)) || (popRef.current && popRef.current.contains(t));
    const onDown = (e) => { if (!inside(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const shown = (items || []).filter((it) => it && !it.hidden);
  if (!shown.length) return null;
  return (
    <div className="cc-action-wrap" ref={wrapRef} onClick={(e) => e.stopPropagation()}>
      <button type="button" className="btn btn-ghost btn-sm" aria-haspopup="menu" aria-expanded={open}
        aria-label={ariaLabel} onClick={() => setOpen((v) => !v)}>
        {label} <Icon name="chevronDown" size={16} />
      </button>
      {open && anchor && ReactDOM.createPortal(
        <div className="rq-pop" ref={popRef} role="menu" aria-label={ariaLabel}
          style={{ left: anchor.left, top: anchor.top, bottom: anchor.bottom, width: 220 }}>
          <div className="rq-pop-list" style={{ paddingTop: 6 }}>
            {shown.map((it) => (
              <div key={it.label} role="menuitem" aria-disabled={it.disabled || undefined}
                className={'menu-item' + (it.danger ? ' menu-item-danger' : '') + (it.disabled ? ' is-disabled' : '')}
                title={it.disabled && it.reason ? it.reason : undefined}
                onClick={() => { if (it.disabled) return; setOpen(false); it.onClick(); }}>{it.label}</div>
            ))}
          </div>
        </div>, document.body)}
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
        Action <Icon name="chevronDown" size={16} />
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
                  {candidate.hasResume && <Item onClick={() => { setOpen(false); openCvReview(candidate.id, candidate); }}>Review CV</Item>}
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

const POOL_STATUS = {
  new: 'New', considered: 'Previously Considered', shortlisted: 'Previously Shortlisted',
  blacklisted: 'Blacklisted', unknown: 'Unknown',
};
const poolKey = (status) => (Object.hasOwn(POOL_STATUS, status) ? status : 'unknown');
// List display rule: first two words of the name, capped in length, so a
// five-part name never breaks the layout. Full name stays in the tooltip, for
// screen readers, and on the profile itself.
const NAME_MAX = 22;
function shortName(full) {
  const two = String(full || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join(' ');
  if (!two) return '—';
  return two.length > NAME_MAX ? two.slice(0, NAME_MAX - 1).trimEnd() + '…' : two;
}
// The candidate's name carries the status as its tint (rendered inline in the
// Talent Pool table). Colour is never the only signal: hover shows it, and the
// full name plus status are read by screen readers.
// Legend swatches are drawn exactly like the names they explain.
function PoolStatusBadge({ status }) {
  const key = poolKey(status);
  return <span className={'pool-name pool-name-' + key}><span className="pool-name-text">{POOL_STATUS[key]}</span></span>;
}
function PoolStatusGuide() {
  const badges = Object.keys(POOL_STATUS).map((key) => <PoolStatusBadge key={key} status={key} />);
  return <div className="pool-status-guide">
    <span className="pool-status-caption pool-status-desktop-caption">Name colour</span>
    <div className="pool-status-desktop" aria-label="Candidate status legend">{badges}</div>
    <details className="pool-status-mobile"><summary>Name colour</summary><div>{badges}</div></details>
  </div>;
}

function CandidatesPage({ user, onNavigate, initialFilters }) {
  const isPhone = useIsPhone();
  const toast = useToast();
  const [candidates, setCandidates] = useState(null);
  // `setFiltersRaw` is referenced exactly once — by the `setFilters` wrapper
  // defined with the rest of the query state below, which also returns to
  // page 1. Nothing else in this component may call it.
  const [filters, setFiltersRaw] = useState(() => ({
    q: '', source: '', location: '', minExp: '', maxExp: '', noticePeriod: '',
    currentCompany: '', tag: '', currentPosition: '', university: '',
    graduationFrom: '', graduationTo: '',
    ...(initialFilters || {}),
  }));
  const [pipeFilters, setPipeFilters] = useState(() => ({
    stage: '', recruiterId: '', requestId: '', projectId: '',
    ...(initialFilters || {}),
  }));
  // (The effect that applies `initialFilters` lives with the rest of the query
  // state below — it changes the query, so it must use the query setters.)
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
  // A pipeline board is columns side by side: on a phone that is a horizontal
  // scroll through mostly-empty stages. Cards are the phone's first view.
  const [view, setView] = useState(() => (isPhone ? 'cards' : 'pipeline')); // pipeline | cards | table
  const [profileTab, setProfileTab] = useState(null);
  const [profileFocusPrior, setProfileFocusPrior] = useState(false);
  const CAND_FILTER_KEYS = ['q', 'source', 'location', 'minExp', 'maxExp', 'noticePeriod',
    'currentCompany', 'tag', 'currentPosition', 'university', 'graduationFrom', 'graduationTo',
    // Data-quality labels. OPT-IN only — with none selected the Talent Pool
    // shows everyone, flagged or not, which is the whole point of labelling
    // uncertainty instead of queueing it.
    'qualityFlag', 'departmentId'];

  useRecordUrl('candidates', selectedId);
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
  const [screenTab, setScreenTabRaw] = useState('all'); // Database fitness-screen filter
  // Server-side paging/sorting. The API returns a `pagination` envelope; the UI no
  // longer fetches the whole table and slices it in the browser.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeRaw] = useState(50);
  const [sort, setSort] = useState({ by: 'created', dir: 'desc' });

  /* --------------------------- the query setters ---------------------------
     `filters`, `screenTab`, `pageSize` and `sort` are all part of the server
     query, so changing any of them must return to page 1 — otherwise the user
     lands on a page that need not exist under the new query and sees an empty
     table.

     That reset used to live in an effect watching those values, which put it in
     a SECOND render: the first render already carried the new filter but the
     OLD page, so `load` ran once for (new filter, old page) and again for
     (new filter, page 1). Two requests, the first of them wrong.

     The reset therefore happens in the SAME event handler as the change, so
     React batches both into one render carrying the final intended query. To
     make that impossible to forget at a call site, the raw useState setters are
     named `*Raw` and are each referenced exactly ONCE — here. Every call site in
     this component, and every one added later, goes through these wrappers and
     gets the page reset for free. (`sort` does the same through `toggleSort`.)
     Paging itself is the one query change that must NOT reset the page, so
     `setPage` stays raw and is what <Pager onPage> receives.
     ---------------------------------------------------------------------- */
  const setFilters = useCallback((updater) => { setFiltersRaw(updater); setPage(1); }, []);
  const setScreenTab = useCallback((tab) => { setScreenTabRaw(tab); setPage(1); }, []);
  const setPageSize = useCallback((n) => { setPageSizeRaw(n); setPage(1); }, []);

  // Arriving with a filter from elsewhere (nothing sends one yet, but the
  // mechanism matches every other list page) — apply it whenever its identity
  // changes, not just on first mount. It changes the query, so it goes through
  // the wrapper above and returns to page 1 like any other filter change.
  useEffect(() => {
    if (!initialFilters) return;
    setFilters((f) => ({ ...f, ...initialFilters }));
    setPipeFilters((f) => ({ ...f, ...initialFilters }));
  }, [initialFilters, setFilters]);

  const [pageInfo, setPageInfo] = useState({ total: 0, totalPages: 1, hasMore: false });
  const [loadError, setLoadError] = useState(null);
  // Refetching is not the same as having no data. `busy` marks a query in
  // flight while the rows already on screen stay mounted; only `candidates`
  // being null (nothing has ever loaded) shows the skeleton.
  const [busy, setBusy] = useState(false);
  // A query change now costs exactly one request, but requests can still
  // overtake each other: type into the search box twice in quick succession and
  // the first answer may arrive after the second. Whichever answered last used
  // to win regardless of which was asked last. The skeleton hid that; keeping
  // the rows mounted does not, so only the newest request may write to state.
  const loadSeq = useRef(0);
  const btns = useResolvedButtons();
  // Requests available for linking. Fetched once, and only for a user who may
  // link — a recruiter without `candidate.link` is shown no control at all
  // rather than a dropdown that would fail on submit.
  const canLink = can(user, 'candidate.link');
  const [linkRequests, setLinkRequests] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [departmentError, setDepartmentError] = useState(false);
  useEffect(() => {
    api.get('/org/departments').then((r) => {
      setDepartments((r.departments || []).filter((d) => d.status === 'active'));
    }).catch(() => setDepartmentError(true));
  }, []);
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
    const seq = ++loadSeq.current;
    setBusy(true); setLoadError(null);
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => { if (v && CAND_FILTER_KEYS.includes(k)) params.set(k, v); });
    if (screenTab !== 'all') params.set('screeningStatus', screenTab);
    params.set('page', String(page));
    params.set('pageSize', String(pageSize));
    params.set('sort', sort.by);
    params.set('dir', sort.dir);
    try {
      const r = await api.get('/candidates?' + params.toString());
      if (seq !== loadSeq.current) return;          // a newer query is already in flight
      setCandidates(r.candidates);
      setPageInfo(r.pagination || { total: r.candidates.length, totalPages: 1, hasMore: false });
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setCandidates([]);
      setLoadError(e.message || 'Could not load candidates.');
    } finally {
      if (seq === loadSeq.current) setBusy(false);
    }
  }, [filters, screenTab, page, pageSize, sort]);
  useEffect(() => { load(); }, [load]);

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
  const SCREEN_TABS = [['all', 'All'], ['new', 'Not screened'], ['screening', 'In review'], ['fit', 'Fit'], ['unfit', 'Unfit']];
  const scOf = (c) => c.screeningStatus || 'new';
  // Both updates are dispatched from one event handler, so React batches them
  // into a single render carrying the final intended query: the new sort AND
  // page 1. Ordering within the handler does not matter — neither value is read
  // here, and the render that follows sees both.
  const toggleSort = (col) => {
    setSort((s) => ({ by: col, dir: s.by === col && s.dir === 'asc' ? 'desc' : 'asc' }));
    setPage(1);
  };
  const FILTER_LABELS = {
    q: 'Search', location: 'Location', currentCompany: 'Company',
    minExp: 'Min exp', maxExp: 'Max exp', tag: 'Tag',
    currentPosition: 'Role', university: 'University',
    graduationFrom: 'Graduated from', graduationTo: 'Graduated to', departmentId: 'Department',
    stage: 'Stage', recruiterId: 'Recruiter', requestId: 'Request', projectId: 'Project',
  };
  const mergedForChips = { ...filters, ...pipeFilters };
  const activeFilters = Object.entries(mergedForChips)
    .filter(([k, v]) => v && FILTER_LABELS[k] && v !== true)
    .map(([k, v]) => {
      let shown = v;
      if (k === 'departmentId') shown = departments.find((d) => String(d.id) === String(v))?.name || v;
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
  // Map screening state → canonical Badge variant + label. 'screening' uses
  // 'info' (green), the same treatment REQ_STATUS gives 'Sourcing'/'In
  // Progress' alongside 'Filled' — an in-progress state sharing success's
  // colour, distinguished by label, not a new colour.
  const SCREEN_CHIP = {
    new: ['soft', 'Not screened'], screening: ['info', 'In review'], fit: ['success', 'Fit'], unfit: ['critical', 'Unfit'],
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
          {/* No inline font-size here. This button sits in the same action row as
              "Bulk Upload CVs" and "Parse CV", which all inherit `.btn`; pinning
              this one to 11.5px made a single label visibly smaller than its
              neighbours, and the gap widened under browser zoom because a fixed
              px does not track the others' sizing. */}
          {/* One primary (Parse CV); every other action is the same
              secondary box (docs/audits/ui-rules.md, R17). */}
          {btns.add_candidate?.visible && (
            <button className="btn btn-secondary" onClick={() => setCreating(true)} title="Enter a candidate by hand, no CV reading">
              Add manually
            </button>
          )}
          {btns.add_candidate?.visible && (
            <button className="btn btn-secondary" title={UPLOAD_HINT} onClick={() => setImportOpen(true)}>Bulk Upload CVs</button>
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
        <button className="btn btn-secondary" onClick={runAsk} disabled={asking || !ask.trim()}>
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
      <FilterToolbar activeCount={activeFilters.length} search={<input placeholder="Search name / id / company / email…" value={filters.q} onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} />} count={<CountPill n={candidates ? shown.length : null} total={candidates ? candidates.length : null} noun="candidate" />}>
        <input placeholder="Location" value={filters.location} onChange={(e) => setFilters((f) => ({ ...f, location: e.target.value }))} />
        <input placeholder="Company" value={filters.currentCompany} onChange={(e) => setFilters((f) => ({ ...f, currentCompany: e.target.value }))} />
        <input placeholder="Grad from" type="number" value={filters.graduationFrom} onChange={(e) => setFilters((f) => ({ ...f, graduationFrom: e.target.value }))} title="Graduation year from" />
        <input placeholder="Grad to" type="number" value={filters.graduationTo} onChange={(e) => setFilters((f) => ({ ...f, graduationTo: e.target.value }))} title="Graduation year to" />
        <input placeholder="Tag" value={filters.tag} onChange={(e) => setFilters((f) => ({ ...f, tag: e.target.value }))} />
        {/* Data quality. Nothing is selected by default, so the Talent Pool
            shows every candidate — flagged people are members of the pool, not
            a queue parked outside it. */}
        <SearchSelect value={filters.qualityFlag || ''} ariaLabel="Data quality" title="Data quality" emptyLabel="All candidates" placeholder="Data quality"
          options={pairOpts(QUALITY_FLAGS)}
          onChange={(v) => setFilters((f) => ({ ...f, qualityFlag: v }))} />
        <SearchSelect value={filters.departmentId || ''} ariaLabel="Department" placeholder={departmentError ? 'Departments unavailable' : 'Department'}
          title="Candidates linked to a hiring request in this department, or whose current position is one of its designations"
          disabled={departmentError} emptyLabel="All departments"
          options={optsOf(departments)}
          onChange={(v) => setFilters((f) => ({ ...f, departmentId: v, disciplineClass: '' }))} />
        </FilterToolbar>
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
            <span key={k} className="chip-filter" title={label}>
              <span className="chip-filter-label">{label}</span>
              <button aria-label={`Remove ${label} filter`} onClick={() => clearFilter(k)}><Icon name="close" size={16} /></button>
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
        <div className="card"><Empty art="none-yet" tone="error" title="Could not load candidates" text={loadError}
          action={<button className="btn" onClick={load}>Retry</button>} /></div>
      ) : !candidates ? <ListSkeleton rows={7} /> : shown.length === 0 ? (
        <div className="card"><Empty art="none-yet"
          title={screenTab !== 'all' || filters.q ? 'No candidates in this view' : 'The talent pool is empty'}
          text={screenTab !== 'all' || filters.q
            ? 'Try the All tab, or clear the search and filter fields above.'
            : 'Add a candidate manually, or import CVs against a hiring request to populate the pool.'} /></div>
      ) : view === 'table' ? (
        <div>
          <PoolStatusGuide />
          <div className={'card flush' + (busy ? ' table-busy' : '')} aria-busy={busy}>
          <div className="table-wrap talent-table-wrap" role="region" aria-label="Talent Pool table" tabIndex={0}>
          <table className="table candidates-table talent-pool-table">
            <thead><tr>
              <th data-col="name" className={'sort-th' + (sort.by === 'name' ? ' active' : '')}
                aria-sort={sort.by === 'name' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}><div className="pool-candidate-heading">
                <input type="checkbox" aria-label="Select all on this page"
                  checked={shown.length > 0 && shown.every((c) => selected.has(c.id))}
                  ref={(el) => { if (el) el.indeterminate = selected.size > 0 && !shown.every((c) => selected.has(c.id)); }}
                  onChange={(e) => toggleAllShown(e.target.checked)} />
                <button className="sort-th-inner" title="Sort by Candidate" onClick={() => toggleSort('name')}>
                  Candidate<Icon name={sort.by === 'name' ? (sort.dir === 'asc' ? 'chevronUp' : 'chevronDown') : 'sortNeutral'} size={16} />
                </button>
              </div></th>
              <SortTh label="Position" col="position" sort={sort} onSort={toggleSort} />
              <SortTh label="University" col="university" sort={sort} onSort={toggleSort} />
              <SortTh label="Year" col="graduation" sort={sort} onSort={toggleSort} />
              <SortTh label="Location" col="location" sort={sort} onSort={toggleSort} />
              <th data-col="apply-date">Apply Date</th>
              <th data-col="ranking">Ranking (10)</th>
              <th data-col="request">Request</th>
            </tr></thead>
            <tbody>{shown.map((c) => (
              <tr key={c.id} className={'row-link' + (selected.has(c.id) ? ' row-selected' : '')}
                onClick={() => openProfile(c.id)}>
                <td data-label="Candidate"><div className="pool-candidate">
                  <label className="sel-hit" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" aria-label={`Select ${c.fullName}`}
                      checked={selected.has(c.id)} onChange={() => toggleSel(c.id)} />
                  </label>
                  {/* The name IS the status: one tinted pill, explained once by the
                      legend above. Two fixed lines (name, id) keep every row level. */}
                  <div className="pool-id">
                    <span className={'pool-name pool-name-' + poolKey(c.poolStatus)} title={`${c.fullName} — ${POOL_STATUS[poolKey(c.poolStatus)]}`}>
                      <span className="pool-name-text" aria-hidden="true">{shortName(c.fullName)}</span>
                      <span className="sr-only"><span>{c.fullName}</span>, {POOL_STATUS[poolKey(c.poolStatus)]}</span>
                    </span>
                    <span className="cell-sub" title={[c.candidateNo, ...(c.tags || [])].join(' · ')}>
                      {[c.candidateNo, ...(c.tags || []).slice(0, 2)].join(' · ')}
                    </span>
                  </div>
                  <div className="pool-id-actions">
                    {c.hasResume && <div className="pool-cv-actions" onClick={(e) => e.stopPropagation()}>
                      <button className="icon-btn" aria-label={`Review CV for ${c.fullName}`}
                        onClick={() => openCvReview(c.id, c)}><Icon name="eye" size={16} /></button>
                      <button className="icon-btn" aria-label={`Download ${c.resumeName || 'CV'}`}
                        onClick={() => downloadResume(c, toast)}><Icon name="download" size={16} /></button>
                    </div>}
                  </div>
                </div></td>
                <td data-label="Position" title={c.currentPosition || ''}>{c.currentPosition || '—'}</td>
                <td data-label="University" title={c.university || ''}>{c.university || '—'}</td>
                <td data-label="Year">{c.graduationYear ?? '—'}</td>
                <td data-label="Location" title={c.location || ''}>{c.location || '—'}</td>
                <td data-label="Apply Date" title={c.applyDateSource === 'application_email' ? 'Original application email received' : 'Candidate creation date'}>
                  <DateCell value={c.applyDate} dateOnly />
                </td>
                <td data-label="Ranking (10)"><span className="muted">Not scored</span></td>
                <td data-label="Request" onClick={(e) => e.stopPropagation()}>
                  {(() => {
                    // One request per row (two fixed lines); any further links are counted, not stacked.
                    const reqLinks = (c.links || []).filter((l) => l.requestId && l.requestTitle);
                    if (!reqLinks.length) return <span className="muted">—</span>;
                    const [l, ...more] = reqLinks;
                    const all = reqLinks.map((x) => `${shortReqCode(x.ticketNo)} — ${x.requestTitle}`).join('\n');
                    return <button className="pool-request-link" title={all}
                      onClick={() => openRequest(l.requestId, onNavigate)}>
                      <span className="pool-req-code">{shortReqCode(l.ticketNo)}{more.length ? ` +${more.length}` : ''}</span>
                      <span className="pool-req-title">{l.requestTitle}</span>
                    </button>;
                  })()}
                </td>
              </tr>
            ))}</tbody>
          </table>
          </div></div>
        </div>
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
                  <div className="cc-name" title={c.fullName}>
                    {shortName(c.fullName)}
                    <HistoryBadge history={c.history} onOpen={() => openProfile(c.id, { tab: 'activity', focusPrior: true })} />
                  </div>
                  <div className="cc-headline">{c.currentPosition || '—'}</div>
                  {/* Where the person stands, without opening them: stage and
                      request of the open application, then experience and
                      place (review T7 — the card said only name and title). */}
                  {(() => {
                    const act = activeLinkOf(c);
                    const st = act ? (APP_STATUS[pipelineStage(act.status)] || APP_STATUS[act.status]) : null;
                    const bits = [c.yearsExperience != null ? `${c.yearsExperience}y exp` : null, c.location || null].filter(Boolean);
                    return <div className="cc-facts">
                      {act ? <>{st && <Badge variant={st.variant}>{st.label}</Badge>}<span className="cc-req" title={act.requestTitle || ''}>{shortReqCode(act.ticketNo)}</span></>
                        : <span className="muted">Not on a request</span>}
                      {bits.length > 0 && <span className="muted">{bits.join(' · ')}</span>}
                    </div>;
                  })()}
                  <QualityBadges flags={c.qualityFlags} note={c.qualityNote} />
                </div>
                {/* `is-empty` lets the phone template drop a block that would only
                    say "— / —". Auto-ingested CVs rarely state a university, so
                    most cards would otherwise lead with missing data. The desktop
                    grid keeps the dashes, which hold card heights level. */}
                <div className={'cc-uni' + (!c.university && !c.major ? ' is-empty' : '')}>
                  <div className="cc-uni-name" title={c.university || ''}>{c.university || '—'}</div>
                  <div className={'cc-uni-major' + (!c.major ? ' is-empty' : '')} title={c.major || ''}>{c.major || '—'}</div>
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
// `html`: a Word CV rendered by the server. It is shown in a frame with an
// empty sandbox (no scripts, no same-origin, no forms), so a crafted document
// can only render, never act.
/**
 * A PDF drawn page by page onto canvases with the bundled pdf.js
 * (/vendor/pdfjs, loaded by index.html). Used where the browser cannot show a
 * PDF inside an iframe (phones, tablets). If pdf.js is missing or the file will
 * not parse, falls back to Open / Download so the CV is never a blank frame.
 */
function PdfPagesView({ url, fileName, zoom }) {
  const host = useRef(null);
  const [state, setState] = useState('loading'); // loading | ready | failed
  const [why, setWhy] = useState('');
  useEffect(() => {
    let alive = true, task = null;
    setState('loading');
    (async () => {
      if (!window.pdfjsLib) {
        await new Promise((res) => { window.addEventListener('pdfjs-ready', res, { once: true }); setTimeout(res, 4000); });
      }
      if (!window.pdfjsLib) throw new Error('pdf.js unavailable');
      task = window.pdfjsLib.getDocument({ url });
      const pdf = await task.promise;
      if (!alive || !host.current) return;
      host.current.textContent = '';
      const cssW = Math.max(240, host.current.clientWidth || 320);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        if (!alive) return;
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: (cssW / base.width) * dpr });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
        canvas.style.cssText = 'width:100%;height:auto;display:block;margin:0 0 8px;background:#fff';
        host.current.appendChild(canvas);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
        if (n === 1 && alive) setState('ready');
      }
    })().catch((e) => { if (alive) { setWhy(String((e && e.message) || e).slice(0, 120)); setState('failed'); } });
    return () => { alive = false; try { task && task.destroy(); } catch { /* already gone */ } };
  }, [url]);
  if (state === 'failed') {
    return (
      <div className="parse-review-cv-empty">
        This CV could not be drawn in the page.
        {why ? <small style={{ display: 'block', opacity: 0.7 }}>{why}</small> : null}
        <div style={{ marginTop: 10, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          <a href={url} target="_blank" rel="noopener" className="btn">Open CV</a>
          <a href={url} download={fileName || 'cv.pdf'} className="btn btn-secondary">Download</a>
        </div>
      </div>
    );
  }
  return (
    <div style={{ width: '100%' }}>
      {state === 'loading' && <div className="parse-review-cv-empty">Loading CV…</div>}
      <div ref={host} style={{ width: `${zoom * 100}%`, maxWidth: 'none' }} />
    </div>
  );
}

function CvFilePreview({ fileUrl, fileName, mimeType, html }) {
  const [zoom, setZoom] = useState(1);
  const zoomOut = () => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(2)));
  const zoomIn = () => setZoom((z) => Math.min(2, +(z + 0.1).toFixed(2)));
  // Kind comes from the MIME type OR the file name: a stored file whose type
  // was lost (application/octet-stream) must still preview, not dead-end.
  const ext = (String(fileName || '').match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';
  const isPdf = mimeType === 'application/pdf' || (ext === 'pdf' && (!mimeType || mimeType === 'application/octet-stream'));
  const isImage = (!!mimeType && mimeType.startsWith('image/')) || (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext) && (!mimeType || mimeType === 'application/octet-stream'));
  const isText = mimeType === 'text/plain' || (ext === 'txt' && (!mimeType || mimeType === 'application/octet-stream'));
  const isDoc = !!html;
  // Phones (and iPadOS, which reports a desktop UA) cannot render a PDF inside
  // an iframe: Android Chrome paints a blank frame, iOS Safari only page one.
  // Desktop browsers expose navigator.pdfViewerEnabled; where it is false, or
  // the device is a touch phone/tablet, hand the PDF to the browser's own viewer.
  // Only desktop Chrome / Edge / Firefox show a blob PDF reliably inside an
  // iframe under this app's CSP (object-src 'none'). Safari, DuckDuckGo and every
  // phone/tablet browser (all WebKit on iOS) get the pdf.js renderer instead.
  const ua = navigator.userAgent;
  const touchApple = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  const nativePdf = navigator.pdfViewerEnabled !== false && /Chrome|Chromium|Edg\/|Firefox/.test(ua)
    && !/Android|iPhone|iPad|iPod|CriOS|FxiOS/i.test(ua) && !touchApple;
  const noInlinePdf = !nativePdf;
  return (
    <div className="parse-review-cv">
      <div className="parse-review-cv-toolbar">
        <span className="parse-review-cv-name" title={fileName || ''}>{fileName || 'Original CV'}</span>
        {(isPdf || isImage || isDoc) && fileUrl && (
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
        ) : isDoc ? (
          <iframe title="Original CV" sandbox="" srcDoc={html} className="parse-review-cv-frame" style={{ transform: `scale(${zoom})` }} />
        ) : isPdf && noInlinePdf ? (
          <PdfPagesView url={fileUrl} fileName={fileName} zoom={zoom} />
        ) : isPdf || isText ? (
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

/* ===========================================================================
   CV REVIEW SIDE PANEL — one CV viewer for the whole product
   ---------------------------------------------------------------------------
   Before this, EVERY "open the CV" path in the app called `api.download(...)`,
   which pushes the file at the browser and leaves the recruiter to compare it
   against the record in another window. The Product Owner asked for the
   opposite: the CV opens ALONGSIDE the candidate's details, so the two can be
   checked against each other without switching context, and instead of
   approving each parsed value one by one the recruiter leaves ONE note at the
   bottom flagging anything irrelevant or needing checking.

   Reached by dispatching `ats:open-cv-review` (see `openCvReview`), which
   `CvReviewHost` — mounted once in the Shell — listens for. That is the same
   pattern `openRequest` already uses, and it is why a table cell, a row menu,
   a drawer, a profile tab and a pipeline card can all open this panel without
   any of them owning its state or threading props through the tree.

   Nothing here is new backend surface: the details come from GET
   /candidates/:id, the file from GET /candidates/:id/resume and the note from
   POST /candidates/:id/notes — the endpoint `NoteModal` has always used.
   ======================================================================== */

/**
 * The stored CV as an object URL.
 *
 * The resume endpoint requires an Authorization header, so a bare URL in an
 * <iframe> or <img> gets a 401 and renders nothing — the file has to be
 * fetched with the token and wrapped in a blob. The caller OWNS the returned
 * url and MUST revoke it; see useCvDocument.
 */
async function fetchDocBlobUrl(path) {
  const res = await fetch(`/api${path}`, {
    headers: api.token ? { Authorization: 'Bearer ' + api.token } : {},
  });
  if (!res.ok) {
    throw new Error(res.status === 404
      ? 'No CV is stored for this candidate yet.'
      : res.status === 403 ? 'You do not have access to this CV.'
      : 'Could not load the CV file.');
  }
  const blob = await res.blob();
  // Content-Type can carry a charset; CvFilePreview compares the bare type.
  const mimeType = String(res.headers.get('content-type') || blob.type || '').split(';')[0].trim();
  return { url: URL.createObjectURL(blob), mimeType };
}
function fetchResumeBlobUrl(candidateId) { return fetchDocBlobUrl(`/candidates/${candidateId}/resume`); }

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const isDocxFile = (mimeType, fileName) => mimeType === DOCX_MIME || mimeType === 'application/msword' || /\.docx?$/i.test(String(fileName || ''));

/**
 * One CV document for a side panel: the file as an object URL, plus, for a
 * Word file the browser cannot show, the server's HTML rendering of it
 * (`?as=html`). The URL is revoked on close and on a switch of document, and
 * one that arrives after close is revoked on arrival — the rule CvReviewPanel
 * has always kept, now kept once for every panel.
 */
function useCvDocument(path, fileName) {
  const [doc, setDoc] = useState(null);       // { url, mimeType, html? }
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    let alive = true, created = null;
    setBusy(true); setError(''); setDoc(null);
    fetchDocBlobUrl(path)
      .then(async (r) => {
        if (!alive) { URL.revokeObjectURL(r.url); return; }   // arrived after close
        created = r.url;
        let html = null;
        if (isDocxFile(r.mimeType, fileName)) {
          try { html = (await api.get(`${path}?as=html`)).html || null; } catch { /* download link stays */ }
        }
        if (alive) setDoc({ ...r, html });
      })
      .catch((e) => { if (alive) setError(e.message || 'Could not load the CV file.'); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; if (created) URL.revokeObjectURL(created); };
  }, [path, fileName]);
  return { doc, error, busy };
}

/** The CV filename as what it is: the way to open the CV in the side panel.
 *  A real <button> (keyboard, focus ring, pointer); Download stays separate. */
function CvFileLink({ name, onOpen, fallback = 'Attached résumé' }) {
  return <button type="button" className="cv-file-link" onClick={onOpen} title="Open the CV in the side panel">{name || fallback}</button>;
}

/* The CV in a page of its own (recruitment team, 25 Oct 2026): a new browser
   tab showing only the document, full height, through the same authenticated
   fetch the side panel uses — nothing is downloaded, nothing leaves the app.
   `#cv/<candidateId>` / `#cv/<candidateId>/doc/<docId>` for a candidate's CV
   (current or a stored version); `#document?path=…&name=…` for a file posted
   in a request thread. */
function cvFullPageHash(candidateId, doc) {
  if (!candidateId) return '';
  return '#cv/' + Number(candidateId) + (doc && doc.id ? '/doc/' + Number(doc.id) : '');
}
function documentFullPageHash(path, fileName, title) {
  if (!path) return '';
  const q = new URLSearchParams({ path });
  if (fileName) q.set('name', fileName);
  if (title) q.set('title', title);
  return '#document?' + q.toString();
}
function parseFullPageHash(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  let m = raw.match(/^cv\/(\d+)(?:\/doc\/(\d+))?$/);
  if (m) return { kind: 'cv', candidateId: Number(m[1]), docId: m[2] ? Number(m[2]) : null };
  if (raw.startsWith('document?')) {
    const q = new URLSearchParams(raw.slice('document?'.length));
    const path = q.get('path') || '';
    // Only this app's own API paths, never an absolute or protocol-relative URL.
    if (!/^\/[a-z]/i.test(path) || path.startsWith('//')) return null;
    return { kind: 'document', path, fileName: q.get('name') || null, title: q.get('title') || null };
  }
  return null;
}
function openFullPage(hash) {
  if (!hash) return;
  const url = window.location.pathname + window.location.search + hash;
  const w = window.open(url, '_blank');
  if (w) { try { w.opener = null; } catch { /* opener already detached */ } }
}
function useLocationHash() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}
/** The whole browser tab is the CV. Close returns to the Hub (or closes a tab we opened). */
function CvFullPage({ user, target }) {
  const toast = useToast();
  const isCv = target.kind === 'cv';
  const [cand, setCand] = useState(null);
  const [candError, setCandError] = useState('');
  useEffect(() => {
    if (!isCv) return undefined;
    let alive = true;
    api.get(`/candidates/${target.candidateId}`)
      .then((r) => { if (alive) setCand(r.candidate || null); })
      .catch((e) => { if (alive) setCandError(e.message || 'Could not load this candidate.'); });
    return () => { alive = false; };
  }, [isCv, target.candidateId]);
  const docName = isCv ? (target.docId ? (cand?.documents || []).find((d) => Number(d.id) === target.docId)?.name || null : cand?.resumeName || null) : target.fileName;
  const path = isCv
    ? (target.docId ? `/candidates/${target.candidateId}/documents/${target.docId}/file` : `/candidates/${target.candidateId}/resume`)
    : target.path;
  const { doc, error, busy } = useCvDocument(path, docName);
  const title = isCv ? (cand?.fullName || 'Candidate CV') : (target.title || target.fileName || 'Document');
  useEffect(() => { const prev = document.title; document.title = `${title} — CV`; return () => { document.title = prev; }; }, [title]);
  function close() {
    // A tab the Hub opened has no history to go back to: close it. One the
    // reader navigated to by hand goes back to the Hub.
    if (window.history.length <= 1) { window.close(); }
    window.location.hash = '';
  }
  async function download() {
    try {
      if (isCv) await downloadResume({ id: target.candidateId, resumeName: cand?.resumeName, candidateNo: cand?.candidateNo, docId: target.docId, docName }, toast);
      else await api.download(path, target.fileName || 'file');
    } catch (e) { toast(e.message || 'Download failed', 'error'); }
  }
  const canDownload = isCv ? !!(cand?.hasResume || doc) : !!doc;
  return (
    <div className="cvfull" role="document">
      <div className="cvfull-head">
        <div className="cvfull-head-id">
          <h1>{title}</h1>
          <span>{[cand?.candidateNo, docName].filter(Boolean).join(' · ') || (isCv ? 'Curriculum vitae' : 'Request attachment')}</span>
        </div>
        <div className="cvfull-actions">
          <button type="button" className="btn btn-secondary" disabled={!canDownload} onClick={download}>Download</button>
          <button type="button" className="btn btn-ghost" onClick={close}>Close</button>
        </div>
      </div>
      <div className="cvfull-body">
        {candError
          ? <div className="cvfull-state"><Empty art="failed" tone="error" text={candError} /></div>
          : busy
            ? <div className="cvfull-state"><Skeleton rows={6} /></div>
            : error
              ? <div className="cvfull-state"><Empty art="failed" tone="error" text={error} /></div>
              : <CvFilePreview fileUrl={doc?.url} fileName={docName} mimeType={doc?.mimeType} html={doc?.html} />}
      </div>
    </div>
  );
}

/** Open the CV review panel for a candidate from anywhere in the app. */
function openCvReview(candidateId, seed, doc) {
  if (!candidateId) return;
  // `doc` ({ id, name }) opens that CV version's own bytes instead of the current CV.
  window.dispatchEvent(new CustomEvent('ats:open-cv-review', { detail: { id: Number(candidateId), seed: seed || null, doc: doc && doc.id ? { id: Number(doc.id), name: doc.name || null } : null } }));
}

/** The rows shown beside the CV — only fields the CV itself can be checked against. */
function cvReviewDetailSections(c) {
  const list = (v) => (Array.isArray(v) && v.length ? v.join(', ') : null);
  return [
    ['Identity', [
      ['Name', c.fullName], ['Candidate No.', c.candidateNo], ['Email', c.email],
      ['Phone', c.phone], ['Nationality', c.nationality], ['Location', c.location],
      ['LinkedIn', c.linkedinUrl],
    ]],
    ['Experience', [
      ['Current position', c.currentPosition], ['Current company', c.currentCompany],
      ['Employer', c.employer], ['Current project', c.currentProject],
      ['Years of experience', c.yearsExperience != null ? `${c.yearsExperience}` : null],
      ['Notice period', c.noticePeriod],
    ]],
    ['Education', [
      ['University', c.university], ['Major', c.major],
      ['Graduation year', c.graduationYear != null ? `${c.graduationYear}` : null],
    ]],
    ['Skills & languages', [
      ['Skills', list(c.skills)], ['Languages', list(c.languages)],
      ['Certifications', list(c.certifications)],
    ]],
    ['Record', [
      ['Source', c.source], ['Tags', list(c.tags)],
      ['Expected salary', c.salaryVisible && c.expectedSalary != null ? `${c.expectedSalary}` : null],
      ['Parsed', c.parsedAt ? fmtDate(c.parsedAt) : null],
    ]],
  ];
}

/**
 * The CV beside the details, with one note at the bottom.
 *
 * THE OBJECT URL IS THE THING TO GET RIGHT. It is created in an effect keyed
 * on the candidate and revoked in that effect's cleanup — on close, and on a
 * switch to another candidate. A blob URL that is never revoked pins the whole
 * file in memory for the lifetime of the document, so a recruiter opening
 * twenty CVs in a session would be holding twenty files. The `alive` flag also
 * revokes a URL that arrives AFTER the panel closed, which is the case a plain
 * cleanup misses entirely.
 */
function CvReviewPanel({ candidateId, seed, doc, user, onClose }) {
  const toast = useToast();
  const titleId = useId();
  const { dialogRef, onDialogKeyDown } = useDialogFocus(onClose);
  const [cand, setCand] = useState(seed || null);
  const [loadError, setLoadError] = useState('');
  const [note, setNote] = useState('');
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteSaved, setNoteSaved] = useState(false);
  // No composer at all when the user cannot write notes — a control that is
  // guaranteed to 403 is worse than no control.
  const canNote = can(user, 'candidate.note');

  useEffect(() => {
    let alive = true;
    setLoadError('');
    api.get(`/candidates/${candidateId}`)
      .then((r) => { if (alive) setCand(r.candidate || null); })
      .catch((e) => { if (alive) setLoadError(e.message || 'Could not load this candidate.'); });
    return () => { alive = false; };
  }, [candidateId]);

  const { doc: cv, error: cvError, busy: cvBusy } = useCvDocument(doc ? `/candidates/${candidateId}/documents/${doc.id}/file` : `/candidates/${candidateId}/resume`, doc ? doc.name : (seed || {}).resumeName);

  async function saveNote() {
    const body = note.trim();
    if (!body || noteBusy) return;
    setNoteBusy(true);
    try {
      await api.post(`/candidates/${candidateId}/notes`, { body, noteType: 'note' });
      toast('Note saved to this candidate');
      setNote(''); setNoteSaved(true);
    } catch (e) {
      toast(e.message || 'Could not save the note.', 'error');
    } finally { setNoteBusy(false); }
  }

  const c = cand || {};
  const name = c.fullName || 'Candidate';
  const sections = cvReviewDetailSections(c).map(([s, rows]) => [s, rows.filter(([, v]) => v != null && v !== '')]);
  const filled = sections.filter(([, rows]) => rows.length > 0);

  return toPageLevel(
    <div className="modal-overlay cvrev-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="cvrev-panel" role="dialog" aria-modal="true" aria-labelledby={titleId}
        tabIndex="-1" onKeyDown={onDialogKeyDown}>
        <div className="modal-head cvrev-head">
          <div className="cvrev-head-id">
            <h3 id={titleId}>{name} — CV review</h3>
            <span className="cvrev-head-sub">{[c.candidateNo, doc ? doc.name : c.resumeName].filter(Boolean).join(' · ') || 'Checking the record against the document'}</span>
          </div>
          <button type="button" className="btn btn-secondary btn-sm" title="Open this CV alone in a new browser tab (no download)"
            onClick={() => openFullPage(cvFullPageHash(candidateId, doc))}>Open full page</button>
          <button type="button" className="icon-btn" aria-label="Close dialog" onClick={onClose}><Icon name="close" size={16} /></button>
        </div>

        <div className="cvrev-body">
          <div className="cvrev-details">
            <h4 className="cvrev-col-title">Details on record</h4>
            {loadError
              ? <Empty art="failed" tone="error" text={loadError} />
              : !cand
                ? <Skeleton rows={6} />
                : filled.length === 0
                  ? <Empty art="none-yet" text="Nothing is recorded for this candidate yet." />
                  : (
                    <table className="cvrev-table">
                      <tbody>
                        {filled.map(([section, rows]) => (
                          <React.Fragment key={section}>
                            <tr className="cvrev-section-row"><td colSpan={2}>{section}</td></tr>
                            {rows.map(([label, value]) => (
                              <tr key={section + label}><td>{label}</td><td>{value}</td></tr>
                            ))}
                          </React.Fragment>
                        ))}
                      </tbody>
                    </table>
                  )}
          </div>

          <div className="cvrev-cv">
            {cvBusy
              ? <div className="cvrev-cv-state"><Skeleton rows={5} /></div>
              : cvError
                ? (
                  <div className="cvrev-cv-state">
                    <Empty art="failed" tone="error" text={cvError} />
                  </div>
                )
                : <CvFilePreview fileUrl={cv?.url} fileName={doc ? doc.name : c.resumeName} mimeType={cv?.mimeType} html={cv?.html} />}
          </div>
        </div>

        {canNote ? (
          <div className="cvrev-note">
            <label className="cvrev-note-label" htmlFor={titleId + '-note'}>
              Anything irrelevant or needing checking?
            </label>
            <div className="cvrev-note-row">
              <textarea id={titleId + '-note'} rows="2" value={note} disabled={noteBusy}
                onChange={(e) => { setNote(e.target.value); setNoteSaved(false); }}
                placeholder="e.g. the title on the CV does not match the position on record — confirm with the candidate." />
              <button type="button" className="btn" onClick={saveNote} disabled={noteBusy || !note.trim()}>
                {noteBusy ? 'Saving…' : 'Save note'}
              </button>
            </div>
            <span className="cvrev-note-hint">
              {noteSaved
                ? 'Saved to this candidate’s notes.'
                : 'One note instead of approving every parsed value. It is saved to this candidate’s notes.'}
            </span>
          </div>
        ) : (
          <div className="cvrev-note">
            <span className="cvrev-note-hint">You do not have permission to add notes to candidates.</span>
          </div>
        )}

        <div className="modal-foot cvrev-foot">
          <button type="button" className="btn btn-secondary" disabled={!c.hasResume && !cv}
            onClick={() => downloadResume({ id: candidateId, resumeName: c.resumeName, candidateNo: c.candidateNo, docId: doc ? doc.id : null, docName: doc ? doc.name : null }, toast)}>
            Download CV
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

/**
 * A file that is not a candidate's own CV (a CV or attachment posted in a
 * request thread) opened in the same side panel, never a new tab. `path` is
 * the existing authenticated API path; Download stays a separate action.
 */
function openDocumentPanel(path, fileName, title) {
  if (!path) return;
  window.dispatchEvent(new CustomEvent('ats:open-document', { detail: { path, fileName: fileName || null, title: title || null } }));
}
function DocumentPanel({ path, fileName, title, onClose }) {
  const toast = useToast();
  const titleId = useId();
  const { dialogRef, onDialogKeyDown } = useDialogFocus(onClose);
  const { doc, error, busy } = useCvDocument(path, fileName);
  async function download() {
    try { await api.download(path, fileName || 'file'); } catch (e) { toast(e.message || 'Download failed', 'error'); }
  }
  return toPageLevel(
    <div className="modal-overlay cvrev-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="cvrev-panel" role="dialog" aria-modal="true" aria-labelledby={titleId}
        tabIndex="-1" onKeyDown={onDialogKeyDown}>
        <div className="modal-head cvrev-head">
          <div className="cvrev-head-id">
            <h3 id={titleId}>{title || fileName || 'Document'}</h3>
            {title && fileName && <span className="cvrev-head-sub">{fileName}</span>}
          </div>
          <button type="button" className="btn btn-secondary btn-sm" title="Open this file alone in a new browser tab (no download)"
            onClick={() => openFullPage(documentFullPageHash(path, fileName, title))}>Open full page</button>
          <button type="button" className="icon-btn" aria-label="Close dialog" onClick={onClose}><Icon name="close" size={16} /></button>
        </div>
        <div className="cvrev-body cvrev-body--doc">
          <div className="cvrev-cv">
            {busy
              ? <div className="cvrev-cv-state"><Skeleton rows={5} /></div>
              : error
                ? <div className="cvrev-cv-state"><Empty art="failed" tone="error" text={error} /></div>
                : <CvFilePreview fileUrl={doc?.url} fileName={fileName} mimeType={doc?.mimeType} html={doc?.html} />}
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-secondary" onClick={download}>Download</button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
function DocumentPanelHost() {
  const [open, setOpen] = useState(null);      // { path, fileName, title }
  useEffect(() => {
    const onOpen = (e) => { if (e.detail?.path) setOpen({ path: e.detail.path, fileName: e.detail.fileName, title: e.detail.title }); };
    window.addEventListener('ats:open-document', onOpen);
    return () => window.removeEventListener('ats:open-document', onOpen);
  }, []);
  if (!open) return null;
  return <DocumentPanel key={open.path} {...open} onClose={() => setOpen(null)} />;
}

/**
 * Mounted ONCE in the Shell. Every entry point calls `openCvReview(id)`; this
 * is what actually renders the panel, so no page owns the viewer's state.
 */
function CvReviewHost({ user }) {
  const [open, setOpen] = useState(null);      // { id, seed }
  useEffect(() => {
    const onOpen = (e) => { const id = e.detail?.id; if (id) setOpen({ id, seed: e.detail?.seed || null, doc: e.detail?.doc || null }); };
    window.addEventListener('ats:open-cv-review', onOpen);
    return () => window.removeEventListener('ats:open-cv-review', onOpen);
  }, []);
  if (!open) return null;
  return <CvReviewPanel key={open.id + ':' + (open.doc ? open.doc.id : 'cv')} candidateId={open.id} seed={open.seed} doc={open.doc} user={user} onClose={() => setOpen(null)} />;
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
  // The same gap Candidate Review had: a CV the reader found no name in cannot
  // become a candidate until someone types the name (see intake-review.jsx).
  const nameId = useId();
  const [typedName, setTypedName] = useState('');
  const nameProposed = !!(intake && intake.fields && intake.fields.some((f) => f.field === 'fullName'));
  const nameMissing = canSave && !nameProposed && !typedName.trim();
  // A Word CV cannot preview in the browser; the server renders it once the
  // intake exists (the same `?as=html` the CV side panels use).
  const [docHtml, setDocHtml] = useState(null);
  useEffect(() => {
    if (!intake || !isDocxFile(mimeType, fileName)) return undefined;
    let alive = true;
    api.get(`/candidates/intakes/${intake.id}/document?as=html`)
      .then((r) => { if (alive) setDocHtml(r.html || null); })
      .catch(() => { /* the download link stays */ });
    return () => { alive = false; };
  }, [intake && intake.id, mimeType, fileName]);

  async function save() {
    if (!canSave || saving || nameMissing) return;
    setSaving(true);
    try {
      const decisions = Object.fromEntries(intake.fields.map((f) => [f.field, true]));
      const r = await api.post(`/candidates/intakes/${intake.id}/review`, {
        decisions, version: intake.version, ...(nameProposed ? {} : { fullName: typedName.trim() }),
      });
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

  return toPageLevel(
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="parse-review-panel">
        <div className="parse-review-head">
          <h3>Parsed CV — review before saving</h3>
          <button className="icon-btn" onClick={onCancel} aria-label="Close"><Icon name="close" size={16} /></button>
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
            {canSave && !nameProposed && (
              <div className="field parse-review-name">
                <label htmlFor={nameId}>Candidate full name *</label>
                <input id={nameId} value={typedName} maxLength={200} autoComplete="off" placeholder="As written on the CV"
                  onChange={(e) => setTypedName(e.target.value)} />
                <div className="field-hint">The CV reader could not find a name in this CV. Type it as written on the CV beside this list.</div>
              </div>
            )}
          </div>
          <CvFilePreview fileUrl={fileUrl} fileName={fileName} mimeType={mimeType} html={docHtml} />
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="btn" onClick={save} disabled={!canSave || saving || nameMissing}>{saving ? 'Saving…' : 'Save candidate'}</button>
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
        <div className="muted fine-key" style={{ marginTop: 8 }}>
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
  // Side-by-side review rather than a download; the panel keeps Download.
  function view() { openCvReview(c.id, c); }
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
          <div style={{ fontWeight: 600 }}>{c.hasResume ? <CvFileLink name={c.resumeName} onOpen={view} /> : <span className="muted">No résumé on file</span>}</div>
        </div>
        {c.hasResume && <button className="btn btn-sm btn-secondary" onClick={view}>Review CV</button>}
        {c.hasResume && <button className="btn btn-sm btn-ghost" onClick={() => downloadResume(c, toast)}>Download</button>}
        {c.hasResume && canEdit && <button className="btn btn-sm btn-ghost" onClick={reparse} disabled={busy} title="Re-run the CV parser on the file already attached">{busy ? 'Working…' : 'Re-parse'}</button>}
        {canEdit && <label className="btn btn-sm btn-ghost" style={{ cursor: 'pointer' }}>{busy ? 'Uploading…' : (c.hasResume ? 'Replace' : '+ Upload CV')}<input type="file" style={{ display: 'none' }} onChange={upload} disabled={busy} accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,.txt" /></label>}
      </div>
      {(c.documents || []).length > 0 && (
        <>
          <div className="section-title">Other Documents</div>
          <table><thead><tr><th>Type</th><th>File</th><th>Uploaded</th></tr></thead>
            <tbody>{c.documents.map((d) => <tr key={d.id}><td><span className="chip">{d.doc_type}</span></td><td>{d.doc_type === 'cv' && d.cvViewable
                ? <span className="btn-row"><CvFileLink name={d.file_name} onOpen={() => openCvReview(c.id, c, { id: d.id, name: d.file_name })} />
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => downloadResume({ id: c.id, candidateNo: c.candidateNo, docId: d.id, docName: d.file_name }, toast)}>Download</button></span>
                : <>{d.file_name}{d.doc_type === 'cv' && d.cvProblem ? <span className="field-hint"> — {d.cvProblem === 'ambiguous' ? 'linked to more than one candidate; an administrator must resolve it' : 'original file not linked to this candidate; an administrator must resolve it'}</span> : null}</>}</td><td className="muted">{fmtDate(d.uploaded_at)}</td></tr>)}</tbody></table>
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
        sentence: `Interview ${iv.interviewNo || ''} (${ivType(iv.interviewType)} / ${ivMode(iv.mode)})`
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
          <Empty art="none-yet" title="You cannot see this"
            text={cat === 'interviews'
              ? 'Interviews are hidden from your role — the list is empty because you cannot see it, not because nothing happened.'
              : 'Offers are hidden from your role — the list is empty because you cannot see it, not because nothing happened.'} />
        ) : emptyAll ? (
          hidden.length
            ? <Empty art="none-yet" title="Nothing you can see has been recorded yet"
                text={`No activity is visible on this profile.${hidden.includes('interviews') ? ' Interviews are hidden from your role.' : ''}${hidden.includes('offers') ? ' Offers are hidden from your role.' : ''}`} />
            : <Empty art="none-yet" title="Nothing has happened yet" text="When this candidate is linked, interviewed or noted, the events will land here in order." />
        ) : emptyFilter ? (
          <Empty art="no-match" title="Nothing in this category" text="Try another chip, or All." />
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

/* The candidate's current application, in one line under the identity header:
   which request, what stage, who is recruiting, when it last moved. Purely
   presentational: it reads the DTO the candidate route already returns and
   navigates only through the caller's callback, so it can move with the module.
   History stays in the Applications tab; only a non-disqualified application
   counts as current, the same rule the pipeline uses for its Active count. */
function currentApplication(applications) {
  return (applications || []).find((a) => !isDisqualified(a.status)) || null;
}
function ApplicationContext({ application, count, onOpenRequest }) {
  if (!application) return <div className="app-context"><span className="muted">{count ? 'No active application. Earlier ones are under Applications.' : 'Not linked to a hiring request yet.'}</span></div>;
  return <div className="app-context">
    <span className="fine-label">Current application</span>
    <strong title={application.ticketNo}>{shortReqCode(application.ticketNo)}</strong>
    <span>{application.position || '—'}</span>
    <AppStatusBadge status={application.status} />
    <span className="muted">Recruiter: {application.recruiter?.name || '—'}</span>
    <span className="muted">Updated {fmtDateShort(application.lastActivityAt)}</span>
    {onOpenRequest && <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenRequest}>Open request</button>}
  </div>;
}

/* ----------------------------- Candidate Profile (6 tabs) ----------------------------- */
function CandidateProfile({ id, user, btns, onBack, onNavigate, initialTab, focusPrior }) {
  const toast = useToast();
  const [c, setC] = useState(null);
  const [tab, setTab] = useState(initialTab || 'overview');
  useEffect(() => { if (initialTab) setTab(initialTab); }, [initialTab]);
  const [editing, setEditing] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [loadError, setLoadError] = useState(null);

  // Every read is stamped with the id it was made for. A response for a
  // candidate the user has since navigated away from is dropped, never
  // rendered — opening A then B must show B, whichever answer lands last.
  const gen = useRef(0);
  const load = useCallback(async () => {
    const mine = ++gen.current;
    try {
      const r = await api.get('/candidates/' + id);
      if (mine !== gen.current) return;
      if (!r || !r.candidate) throw new Error('The server returned no candidate record.');
      setC(r.candidate); setLoadError(null);
    } catch (e) {
      if (mine !== gen.current) return;
      setLoadError(e.message || 'Request failed');
    }
  }, [id]);
  useEffect(() => {
    // A new id is a new record: clear the previous candidate at once so A's
    // name is never shown over B's tabs while B loads, and close any dialog
    // that was open for A.
    setC(null); setLoadError(null); setEditing(false); setNoteOpen(false);
    load();
    return () => { gen.current++; };
  }, [load]);

  const crumb = <div className="breadcrumb"><a href="#" onClick={(e) => { e.preventDefault(); onBack(); }}>← Talent Pool</a></div>;
  if (!c) return <div>{crumb}{loadError
    ? <LoadError title="Could not load this candidate" text={loadError} onRetry={load} />
    : <Skeleton rows={8} />}</div>;

  const canPrivacy = can(user, 'candidate.privacy');
  const current = currentApplication(c.applications);
  const TABS = [['overview', 'Overview'], ['cv', 'CV & Attachments'], ['applications', `Applications (${c.applications?.length || 0})`], ['interviews', 'Interviews'], ['offers', 'Offers'], ['activity', 'Activity log']];
  if (canPrivacy) TABS.push(['privacy', 'Data & Privacy']);
  return (
    <div>
      {crumb}
      {/* A refresh (after an edit, note or upload) that fails keeps the profile
          on screen and says it may not be current; only a first load with
          nothing to show takes the page. */}
      {loadError && <RefetchError text={`Could not refresh this profile: ${loadError}. Showing the last loaded details.`} onRetry={load} />}

      {/* Workable-style structured profile header over the existing record */}
      <div className="card profile-shell" style={{ padding: 0 }}>
        <div className="profile-header">
          <div className="ph-avatar">{initials(c.fullName)}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="ph-name">{c.fullName} <HistoryBadge history={c.history} onOpen={() => setTab('activity')} /></div>
            <div className="ph-headline">{c.currentPosition || '—'}{c.currentCompany ? ' · ' + c.currentCompany : ''}</div>
            <div className="ph-meta">
              <Badge variant="soft">{c.candidateNo}</Badge>
              <SourceChip source={c.source} />
              {c.yearsExperience != null && <Badge variant="soft">{c.yearsExperience}y exp</Badge>}
              {c.location && <Badge variant="soft">{c.location}</Badge>}
              {c.noticePeriod && <Badge variant="soft">Notice: {c.noticePeriod}</Badge>}
              <Badge variant="soft">{c.applicationCount} application{c.applicationCount === 1 ? '' : 's'}</Badge>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            {btns.edit_candidate?.visible && <button className="btn btn-secondary" onClick={() => setEditing(true)}>Edit</button>}
            {btns.add_note?.visible && <button className="btn btn-secondary" onClick={() => setNoteOpen(true)}>Add Note</button>}
          </div>
        </div>
        <ApplicationContext application={current} count={(c.applications || []).length}
          onOpenRequest={current?.requestId && onNavigate && (can(user, 'request.view_all') || can(user, 'request.view_own')) ? () => openRequest(current.requestId, onNavigate) : null} />
        <div className="profile-tabs">
          {TABS.map(([k, label]) => <button key={k} onClick={() => setTab(k)} className={'profile-tab' + (tab === k ? ' active' : '')}>{label}</button>)}
        </div>
      </div>

      {tab === 'overview' && (
        <div className="card card-pad profile-overview"><div className="form-grid">
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
          <div className="full"><Info label="Tags">{(c.tags || []).length ? c.tags.map((t) => <span key={t} className="chip" title={t}>{t}</span>) : '—'}</Info></div>
        </div></div>
      )}
      {tab === 'cv' && <CandidateCvTab c={c} user={user} btns={btns} onChanged={load} />}
      {tab === 'applications' && (
        <div className="card">
          {(c.applications || []).length === 0 ? <Empty art="none-yet" text="Not linked to any request yet." /> : (
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
          {(c.interviews || []).length === 0 ? <Empty art="none-yet" text="No interviews for this candidate (or none assigned to you)." /> : (
            <table><thead><tr><th>Interview</th><th>Request</th><th>Type / Mode</th><th>Round</th><th>Scheduled</th><th>Status</th><th>Outcome</th></tr></thead>
              <tbody>{c.interviews.map((iv) => (
                <tr key={iv.id}><td><strong>{iv.interviewNo}</strong></td><td title={iv.ticketNo}>{shortReqCode(iv.ticketNo)}</td><td>{ivType(iv.interviewType)} / {ivMode(iv.mode)}</td><td>{iv.round}</td>
                  <td className="muted">{fmtDate(iv.scheduledAt)}</td><td><IvStatusBadge status={iv.status} /></td>
                  <td>{iv.overallOutcome ? <Badge variant={(IV_OUTCOME[iv.overallOutcome] || {}).variant || 'soft'}>{(IV_OUTCOME[iv.overallOutcome] || {}).label}</Badge> : '—'}</td></tr>
              ))}</tbody></table>
          )}
          <div className="card-pad muted">Interviews link to a specific application/request; their status is independent of the application's pipeline status.</div>
        </div>
      )}
      {tab === 'offers' && (
        <div className="card">
          {(c.offers || []).length === 0 ? <Empty art="none-yet" text="No offers for this candidate." /> : (
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
  const { user } = useApp();
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
          {isSystemAdmin(user) && <button className="btn btn-danger" disabled={busy} onClick={erase}>Erase personal data…</button>}
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

// The candidate's answer to the invitation (audit A3, from GitHub PR #46).
// Only meaningful while the interview is still to happen.
const IV_RESPONSE = {
  pending: { label: 'No answer yet', variant: 'soft' },
  confirmed: { label: 'Confirmed', variant: 'success' },
  change_requested: { label: 'Wants another time', variant: 'warning' },
  declined: { label: 'Declined', variant: 'critical' },
};
const ivUpcoming = (iv) => ['scheduled', 'rescheduled'].includes(iv.status);
// Needs a reminder (audit A7): still ahead, within the next 24 hours, and either
// not yet confirmed by the candidate or not yet reminded for this version.
const ivNeedsReminder = (iv, now = Date.now()) => {
  const t = Date.parse(iv.scheduledAt);
  return ivUpcoming(iv) && t > now && t - now <= 86400000 && (iv.candidateResponse !== 'confirmed' || !iv.remindedAt);
};
const ivResponseLabel = (iv) => (ivUpcoming(iv) ? (IV_RESPONSE[iv.candidateResponse] || IV_RESPONSE.pending).label : '');
function IvResponseBadge({ iv }) {
  if (!ivUpcoming(iv)) return null;
  const r = IV_RESPONSE[iv.candidateResponse] || IV_RESPONSE.pending;
  // "No answer yet" with less than a day to go needs attention.
  const soon = (iv.candidateResponse || 'pending') === 'pending' && Date.parse(iv.scheduledAt) - Date.now() < 86400000;
  return <Badge variant={soon ? 'warning' : r.variant}>{r.label}</Badge>;
}

// Candidate + optional hiring request, for an interview or offer created
// standalone (from the Interviews / Offers list, not from an application).
// The candidate is picked from the Talent Pool, or typed in and created as a
// Talent Pool record on save — the same POST /candidates path, so its duplicate
// check still applies.
function StandaloneLinkFields({ user, link, setLink }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  const [requests, setRequests] = useState(null);
  const canAdd = can(user, 'candidate.add');
  const set = (k, v) => setLink((s) => ({ ...s, [k]: v }));
  useEffect(() => {
    api.get('/requests?pageSize=100').then((r) => setRequests(r.requests || [])).catch(() => setRequests([]));
  }, []);
  useEffect(() => {
    const term = q.trim();
    if (link.mode !== 'pick' || !term) { setRows([]); return; }
    const t = setTimeout(() => {
      api.get('/candidates?q=' + encodeURIComponent(term) + '&pageSize=8').then((r) => setRows(r.candidates || [])).catch(() => setRows([]));
    }, 180);
    return () => clearTimeout(t);
  }, [q, link.mode]);
  return (
    <div className="form-grid standalone-link">
      <div className="field full">
        <label>Candidate *</label>
        {canAdd && (
          <div className="seg-tabs" role="tablist" aria-label="Candidate source">
            <button type="button" role="tab" aria-selected={link.mode === 'pick'} className={'seg-tab' + (link.mode === 'pick' ? ' active' : '')} onClick={() => set('mode', 'pick')}>From Talent Pool</button>
            <button type="button" role="tab" aria-selected={link.mode === 'new'} className={'seg-tab' + (link.mode === 'new' ? ' active' : '')} onClick={() => set('mode', 'new')}>New candidate</button>
          </div>
        )}
      </div>
      {link.mode === 'pick' ? (
        <div className="field full">
          {link.candidate ? (
            <div className="standalone-picked">
              <strong>{link.candidate.fullName}</strong>
              <span className="muted">{link.candidate.candidateNo}{link.candidate.email ? ' · ' + link.candidate.email : ''}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => set('candidate', null)}>Change</button>
            </div>
          ) : (
            <>
              <input aria-label="Search the Talent Pool" placeholder="Search name, email, phone…" value={q} onChange={(e) => setQ(e.target.value)} />
              {rows.length > 0 && (
                <ul className="standalone-results" role="listbox">
                  {rows.map((c) => (
                    <li key={c.id} role="option" aria-selected="false" onClick={() => { set('candidate', c); setQ(''); }}>
                      <strong>{c.fullName}</strong> <span className="muted">{c.candidateNo}{c.currentPosition ? ' · ' + c.currentPosition : ''}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      ) : (
        <>
          <div className="field"><label>Full name *</label><input value={link.newName} onChange={(e) => set('newName', e.target.value)} /></div>
          <div className="field"><label>Email</label><input type="email" value={link.newEmail} onChange={(e) => set('newEmail', e.target.value)} /></div>
        </>
      )}
      <div className="field full">
        <label>Hiring request (optional)</label>
        <select value={link.requestId} onChange={(e) => set('requestId', e.target.value)}>
          <option value="">None — standalone</option>
          {(requests || []).map((r) => <option key={r.id} value={r.id}>{r.ticketNo} — {r.title}</option>)}
        </select>
      </div>
    </div>
  );
}
const EMPTY_LINK = { mode: 'pick', candidate: null, newName: '', newEmail: '', requestId: '' };
function standaloneLinkReady(link) {
  return link.mode === 'pick' ? !!link.candidate : !!link.newName.trim();
}
// Resolve the picked or typed candidate to an id; a typed one is created first.
async function resolveStandaloneLink(link) {
  let candidateId = link.candidate?.id;
  if (link.mode === 'new') {
    const r = await api.post('/candidates', { fullName: link.newName.trim(), email: link.newEmail.trim() || undefined, source: 'manual' });
    candidateId = r.candidate.id;
  }
  return { candidateId, requestId: link.requestId ? Number(link.requestId) : undefined };
}
// The interview assessment is kept on the candidate's application to a hiring
// request. Reuse the live application on that request, or create one at the
// entry stage through the normal application rules (one live application per
// candidate, request still open, …) — the server refuses with a clear message.
const APP_CLOSED = ['rejected', 'withdrawn', 'joined', 'offer_declined', 'offer_rejected'];
async function ensureApplication(candidateId, requestId) {
  const r = await api.get(`/candidates/${candidateId}`);
  const live = (r.candidate?.applications || []).find((a) => Number(a.requestId) === Number(requestId) && !APP_CLOSED.includes(a.status));
  if (live) return live.id;
  const created = await api.post('/applications', { candidateId, requestId, initialStatus: 'shortlisted' });   // an interview involves stakeholders: release at Shortlisted
  return created.application.id;
}

/* ===================== Interview scheduling & communications =====================
   Audit 2026-10-06 (INTERVIEW_IMPLEMENTATION_BRIEF.md). One interview per
   candidate; candidate & CV, interview & panel, and invitations in one form;
   explicit "Save" or "Save & send"; Cairo time throughout; truthful outcomes.
   ================================================================================ */
const IV_TZ = 'Africa/Cairo';
// Cairo wall time "YYYY-MM-DDTHH:mm" ↔ UTC instant, DST-correct.
function cairoOffsetMin(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: IV_TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - ms) / 60000;
}
function cairoInputToIso(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v || '');
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let t = wall - cairoOffsetMin(wall) * 60000;
  t = wall - cairoOffsetMin(t) * 60000; // settle across a DST change
  return new Date(t).toISOString();
}
function isoToCairoInput(iso) {
  if (!iso) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: IV_TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
function cairoTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d) ? "—" : d.toLocaleTimeString("en-GB", { timeZone: IV_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}
function cairoLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const s = d.toLocaleString('en-GB', { timeZone: IV_TZ, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const off = new Intl.DateTimeFormat('en-US', { timeZone: IV_TZ, timeZoneName: 'shortOffset' }).formatToParts(d).find((x) => x.type === 'timeZoneName')?.value || '';
  return `${s} · Cairo (${off})`;
}
const ivKey = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : 'k' + Date.now() + Math.random().toString(16).slice(2));
// Mirrors intlPhone() in backend/src/lib/interview-messages.js (audit A11):
// first of several numbers, Arabic-Indic digits, 00 prefix, and Egyptian
// mobiles in local form (010… → +2010…). The server decides; this only lets
// the form accept what the server will accept.
const toIntlPhone = (v) => {
  const first = String(v || '').split(/\s*(?:[,;|\/]|\bor\b|\s{2,})\s*/i).find((x) => /[0-9\u0660-\u0669\u06F0-\u06F9]/.test(x)) || '';
  let d = first.trim().replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x0660)).replace(/[\u06F0-\u06F9]/g, (c) => String(c.charCodeAt(0) - 0x06F0)).replace(/[\s\-().\u200e\u200f]/g, '');
  if (/^00[1-9]/.test(d)) d = '+' + d.slice(2);
  else if (/^01[0125]\d{8}$/.test(d)) d = '+20' + d.slice(1);
  else if (/^201[0125]\d{8}$/.test(d)) d = '+' + d;
  return /^\+[1-9]\d{7,14}$/.test(d) ? d : null;
};
const INTL_PHONE = (v) => !!toIntlPhone(v);
const EMAIL_FMT = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
const HTTPS_LINK = (v) => { try { return new URL(String(v || '').trim()).protocol === 'https:'; } catch { return false; } };
function ivDetailsProblem(mode, where) {
  const v = String(where || '').trim();
  if (mode === 'video' && !HTTPS_LINK(v)) return 'Add the meeting link (https://…) to send invitations.';
  if (mode === 'onsite' && !v) return 'Add the location to send invitations.';
  if (mode === 'phone' && !v) return 'Add the phone number or call arrangement to send invitations.';
  return null;
}

// Outcome of one recipient, in words that never overstate.
const DISPATCH_STATUS = {
  queued: { label: 'Queued', variant: 'soft' },
  accepted: { label: 'Accepted by the mail server', variant: 'success' },
  dry_run: { label: 'Test transport — not delivered', variant: 'warning' },
  not_sent: { label: 'Not sent', variant: 'warning' },
  failed: { label: 'Failed', variant: 'critical' },
  manual_handoff: { label: 'Opened in WhatsApp — not confirmed', variant: 'soft' },
};
// A phone call is also a person's action: started, not confirmed as reached.
const CALL_HANDOFF = { label: 'Call started — not confirmed', variant: 'soft' };
function DispatchList({ rows }) {
  if (!rows || !rows.length) return null;
  return (
    <ul className="iv-dispatch-list">
      {rows.map((r) => {
        const st = (r.channel === 'call' && r.status === 'manual_handoff' ? CALL_HANDOFF : DISPATCH_STATUS[r.status]) || { label: r.status, variant: 'soft' };
        return (
          <li key={r.id}>
            <span className="iv-dispatch-who"><strong>{r.recipientName || 'Recipient'}</strong>
              <span className="muted">{r.audience === 'candidate' ? 'Candidate' : r.audience === 'panel_removed' ? 'Removed from panel' : 'Panel'}{r.channel === 'whatsapp' ? ' · WhatsApp' : r.channel === 'call' ? ' · Phone call' : r.recipientAddress ? ' · ' + r.recipientAddress : ''}{r.attachCv ? ' · CV attached' : ''}</span></span>
            <Badge variant={st.variant}>{st.label}</Badge>
            {r.reason && r.status !== 'manual_handoff' && <span className="iv-dispatch-reason">{r.reason}</span>}
          </li>
        );
      })}
    </ul>
  );
}

// Open WhatsApp from a click. Browsers (Safari always, Chrome after a slow
// response) block a window opened after a server round trip, so the window is
// opened at once, inside the click, and pointed at wa.me when the hand-off is
// recorded. If the browser still blocks it, the link is shown to copy.
async function openWhatsAppWindow(record, toast) {
  let w = null;
  try { w = window.open('about:blank', '_blank'); } catch { w = null; }
  try {
    const r = await record();
    if (w && !w.closed) { try { w.opener = null; } catch { /* cross-origin later */ } w.location.href = r.link; }
    else { window.prompt ? window.prompt('Your browser blocked the WhatsApp window. Copy this link and open it:', r.link) : toast('Your browser blocked the WhatsApp window.', 'error'); }
    return r;
  } catch (e) {
    if (w && !w.closed) w.close();
    toast(e.message, 'error');
    return null;
  }
}

// The WhatsApp hand-off: edit, copy, open. Opening is a person sending it.
function WhatsAppHandoff({ phone, text, onText, onOpen, editable = true }) {
  const toast = useToast();
  const ok = INTL_PHONE(phone);
  return (
    <div className="iv-wa">
      <div className="iv-wa-head"><strong>WhatsApp message</strong><span className="muted">{ok ? toIntlPhone(phone) : phone ? `${phone} — not a mobile or international number (e.g. 01001234567 or +201001234567)` : 'No phone number'}</span></div>
      {editable
        ? <textarea rows="4" value={text} onChange={(e) => onText(e.target.value)} aria-label="WhatsApp message" />
        : <div className="iv-preview-body">{text}</div>}
      <div className="btn-row">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => { navigator.clipboard?.writeText(text).then(() => toast('Message copied')).catch(() => toast('Copy failed — select the text instead', 'error')); }}>Copy message</button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={!ok || !onOpen} onClick={onOpen}>Open WhatsApp</button>
      </div>
      <p className="field-hint">WhatsApp opens on this device with the message ready; you press send. The Hub records that it was opened, not that it was sent. No CV or private link is ever included.</p>
    </div>
  );
}

// The phone call (audit A11, from PR #46): the number as it is dialled, a
// Call button and the script to read. Calling is a person's action; the Hub
// records that the call was started, never that the candidate was reached.
function CallHandoff({ phone, valid, script, onCall }) {
  const toast = useToast();
  return (
    <div className="iv-wa">
      <div className="iv-wa-head"><strong>Phone call</strong><span className="muted">{valid ? phone : phone ? `${phone} — cannot be dialled; use a mobile (01001234567) or +20… form` : 'No phone number'}</span></div>
      <div className="iv-preview-body" aria-label="Call script">{script}</div>
      <div className="btn-row">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => { navigator.clipboard?.writeText(script).then(() => toast('Script copied')).catch(() => toast('Copy failed — select the text instead', 'error')); }}>Copy script</button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={!valid || !onCall} onClick={onCall}>Call</button>
      </div>
      <p className="field-hint">Call opens your phone app (on a computer: Teams or your phone link). The Hub records that the call was started, not that the candidate answered — record their answer on the interview.</p>
    </div>
  );
}

// Subject + body editor with placeholder chips that insert at the cursor.
function MessageEditor({ label, value, onChange, hasSubject = true, placeholders = [], error }) {
  const bodyRef = useRef(null);
  const insert = (name) => {
    const el = bodyRef.current; const token = `{{${name}}}`;
    if (!el) { onChange({ ...value, body: (value.body || '') + token }); return; }
    const s = el.selectionStart ?? (value.body || '').length; const e = el.selectionEnd ?? s;
    const body = (value.body || '').slice(0, s) + token + (value.body || '').slice(e);
    onChange({ ...value, body });
    setTimeout(() => { el.focus(); el.setSelectionRange(s + token.length, s + token.length); }, 0);
  };
  return (
    <div className="iv-editor">
      <div className="iv-editor-label">{label}</div>
      {hasSubject && <input aria-label={label + ' subject'} value={value.subject || ''} onChange={(e) => onChange({ ...value, subject: e.target.value })} placeholder="Subject" />}
      <textarea ref={bodyRef} rows="8" aria-label={label + ' message'} value={value.body || ''} onChange={(e) => onChange({ ...value, body: e.target.value })} />
      {placeholders.length > 0 && (
        <div className="iv-chips" aria-label="Insert a placeholder">
          {placeholders.map((p) => <button key={p.name} type="button" className="chip-btn" title={`${p.label} — inserts {{${p.name}}}`} onClick={() => insert(p.name)}>{phShort(p.label)}</button>)}
        </div>
      )}
      {error && <div className="iv-error" role="alert">{error}</div>}
    </div>
  );
}
// "What changed" / "Previous date|time" only mean something in an update.
const UPDATE_ONLY_PH = ['changes', 'previousDate', 'previousTime'];
const phFor = (all, code, kind = null) => (all || []).filter((p) => p.in.includes(code) && (kind === 'update' || kind === null || !UPDATE_ONLY_PH.includes(p.name)));
// "Time zone, e.g. Cairo time (GMT+3)" -> "Time zone": a chip names the value it fills in.
const phShort = (label) => String(label || '').split(/,| \(|:/)[0].trim();

// Messages are written ONCE as organisation templates (Interviews → Invitation
// templates) with variables — candidate name, position, place, date and time —
// filled in for each interview. Scheduling shows the finished text; changing
// the wording for one interview is an exception, folded away (owner, 12 Oct).
function TemplateNote({ custom, onCustom, children }) {
  return (
    <div className="iv-template-note">
      <p className="field-hint">These messages come from your <strong>invitation templates</strong>. The candidate’s name, the position, the place and the interview time are filled in for you — check the preview{custom ? '' : ', then send'}. To change the standard wording for everyone, use <strong>Interviews → Scheduling Setup</strong>.</p>
      <details className="iv-customize" open={custom} onToggle={(e) => onCustom(e.currentTarget.open)}>
        <summary>Change the wording for this interview only</summary>
        {custom && children}
      </details>
    </div>
  );
}

/* ----------------------------- Schedule form ----------------------------- */
// On-site interviews happen at Head Office or a company site (owner, 12 Oct):
// the place is chosen, not typed, and its name + address become the location
// that {{where}} puts in every message. "Other place" keeps free text.
const placeText = (p) => (p.address ? `${p.name} — ${p.address}` : p.name);
function InterviewPlacePicker({ places = [], value, onChange }) {
  const match = places.find((p) => placeText(p) === (value || '').trim());
  const [other, setOther] = useState(!!(value && !match));
  const sel = other ? 'other' : match ? match.key : '';
  return (
    <>
      <select value={sel} aria-label="Interview place" onChange={(e) => {
        const k = e.target.value;
        if (k === 'other') { setOther(true); if (match) onChange(''); return; }
        setOther(false);
        const p = places.find((x) => x.key === k);
        onChange(p ? placeText(p) : '');
      }}>
        <option value="">Choose the place…</option>
        {places.map((p) => <option key={p.key} value={p.key}>{p.key === 'hq' ? 'Head Office' : `Site — ${p.name}`}{p.project ? ` (${p.project})` : ''}</option>)}
        <option value="other">Other place…</option>
      </select>
      {other && <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="Office, meeting room or address" aria-label="Other place" />}
      {sel && sel !== 'other' && <span className="field-hint">{value}{match && !match.address ? ' — add the address in Scheduling Setup so candidates can find it' : ''}</span>}
    </>
  );
}

const IV_FORM_BLANK = { interviewType: 'technical', mode: 'video', scheduledAt: '', durationMin: 60, round: 1, locationOrLink: '', panel: [] };
const IV_LINK_BLANK = { mode: 'pick', candidate: null, newName: '', newEmail: '', newPhone: '', requestId: '' };
const IV_PROGRESS_BLANK = { candidateId: null, cvDone: false, applicationId: null, interviewId: null };

// `initialAt` is the slot clicked on the calendar; the form opens on that time.
function ScheduleInterviewModal({ application, user, onClose, onScheduled, initialAt }) {
  const toast = useToast();
  const [customMsgs, setCustomMsgs] = useState(false); // per-interview wording is the exception (TemplateNote)
  const [meta, setMeta] = useState(null);
  const [tpl, setTpl] = useState(null);
  const [f, setF] = useState(() => ({ ...IV_FORM_BLANK, scheduledAt: initialAt ? isoToCairoInput(new Date(initialAt).toISOString()) : '' }));
  const [link, setLink] = useState(IV_LINK_BLANK);
  const [cvFile, setCvFile] = useState(null);
  const [requests, setRequests] = useState(null);
  const [q, setQ] = useState(''); const [hits, setHits] = useState([]);
  const [dups, setDups] = useState(null);
  const [progress, setProgress] = useState(IV_PROGRESS_BLANK);
  const [stepError, setStepError] = useState(null); // { step, message }
  const [avail, setAvail] = useState({ state: 'idle' }); // idle|checking|ok|conflicts|unavailable
  const [ack, setAck] = useState(false); const [overlapReason, setOverlapReason] = useState('');
  const [msgs, setMsgs] = useState(null);
  const [preview, setPreview] = useState(null);
  const [rcpt, setRcpt] = useState({ candidate: true, panel: null, attachCv: [] });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { interview, dispatches, summary, sent }
  const [waText, setWaText] = useState('');
  const keys = useRef({ create: ivKey(), send: ivKey() });
  const busyRef = useRef(false);
  const waTouched = useRef(false);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const canAdd = can(user, 'candidate.add');

  useEffect(() => {
    api.get('/interviews/meta/form').then(setMeta).catch((e) => toast(e.message, 'error'));
    api.get('/interviews/message-templates').then((t) => { setTpl(t); setMsgs({ ...t.templates.invite }); setWaText(''); }).catch(() => setTpl({ templates: null, placeholders: [] }));
    if (!application) api.get('/requests?pageSize=100').then((r) => setRequests(r.requests || [])).catch(() => setRequests([]));
  }, []);
  // Talent Pool search for an existing candidate.
  useEffect(() => {
    const term = q.trim();
    if (application || link.mode !== 'pick' || !term) { setHits([]); return undefined; }
    const t = setTimeout(() => api.get('/candidates?q=' + encodeURIComponent(term) + '&pageSize=8').then((r) => setHits(r.candidates || [])).catch(() => setHits([])), 180);
    return () => clearTimeout(t);
  }, [q, link.mode]);

  const candidateId = application ? application.candidate?.id || application.candidateId : (link.mode === 'pick' ? link.candidate?.id : progress.candidateId);
  const startIso = cairoInputToIso(f.scheduledAt);
  const panelKey = f.panel.join(',');
  // Availability: candidate (block), panel (acknowledge), same place (warn).
  // A failed check is shown as "unavailable", never as "no conflict".
  useEffect(() => {
    if (!startIso || !panelKey) { setAvail({ state: 'idle' }); return undefined; }
    let live = true;
    setAvail((a) => ({ ...a, state: 'checking' }));
    const t = setTimeout(() => {
      const qs = new URLSearchParams({ start: startIso, durationMin: String(Number(f.durationMin) || 60), panel: panelKey });
      if (candidateId) qs.set('candidateId', String(candidateId));
      if (f.locationOrLink.trim()) qs.set('location', f.locationOrLink.trim());
      api.get('/interviews/clashes?' + qs.toString())
        .then((r) => { if (!live) return; const any = (r.clashes || []).length || (r.candidateConflicts || []).length || (r.locationWarnings || []).length;
          setAvail({ state: any ? 'conflicts' : 'ok', panel: r.clashes || [], candidate: r.candidateConflicts || [], location: r.locationWarnings || [], hours: r.hoursWarning || null }); })
        .catch(() => { if (live) setAvail({ state: 'unavailable' }); });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [startIso, f.durationMin, panelKey, candidateId, f.locationOrLink]);

  // Panel recipients default to everyone on the panel.
  const panelSel = rcpt.panel === null ? f.panel : rcpt.panel.filter((id) => f.panel.includes(id));
  const candEmail = application ? application.candidate?.email : link.mode === 'pick' ? link.candidate?.email : link.newEmail;
  const candPhone = application ? application.candidate?.phone : link.mode === 'pick' ? link.candidate?.phone : link.newPhone;
  const candName = application ? application.candidate?.fullName : link.mode === 'pick' ? link.candidate?.fullName : link.newName;
  // Live preview of the invitations from the server's own renderer.
  const previewKey = JSON.stringify({ msgs, startIso, f, candidateId, candName, candEmail, candPhone, req: link.requestId, app: application?.id });
  useEffect(() => {
    if (!msgs) return undefined;
    const t = setTimeout(() => {
      api.post('/interviews/message-preview', {
        applicationId: application?.id, candidateId: !application && link.mode === 'pick' ? link.candidate?.id : (progress.candidateId || undefined),
        candidateName: candName, candidateEmail: candEmail, candidatePhone: candPhone, requestId: link.requestId || undefined,
        scheduledAt: startIso, durationMin: Number(f.durationMin), mode: f.mode, interviewType: f.interviewType, locationOrLink: f.locationOrLink,
        panel: f.panel, messages: msgs,
      }).then((p) => { setPreview(p); if (!waTouched.current) setWaText(p.preview.whatsapp.body); }).catch(() => {});
    }, 350);
    return () => clearTimeout(t);
  }, [previewKey]);

  function togglePanel(id) { setF((s) => ({ ...s, panel: s.panel.includes(id) ? s.panel.filter((x) => x !== id) : [...s.panel, id] })); }
  const candReady = application ? true : link.mode === 'pick' ? !!link.candidate : !!link.newName.trim() && (!!link.newEmail.trim() || !!link.newPhone.trim());
  const contactProblem = !application && link.mode === 'new'
    ? (link.newEmail.trim() && !EMAIL_FMT(link.newEmail) ? 'The email address is not valid.' : link.newPhone.trim() && !INTL_PHONE(link.newPhone) ? 'Enter a mobile number (e.g. 01001234567) or the international form (+201001234567).' : null) : null;
  const blockedByCandidate = avail.state === 'conflicts' && (avail.candidate || []).length > 0;
  const needsAck = avail.state === 'conflicts' && (avail.panel || []).length > 0;
  const formReady = candReady && !contactProblem && !!startIso && f.panel.length > 0 && !blockedByCandidate && (!needsAck || (ack && overlapReason.trim()));
  const sendProblem = ivDetailsProblem(f.mode, f.locationOrLink) || (preview && Object.values(preview.errors || {})[0]) || null;

  // Each step keeps its result, so a failure part-way can be retried without
  // creating the candidate, application or interview a second time.
  async function save(send) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setStepError(null);
    let p = { ...progress };
    try {
      let cid = application ? (application.candidate?.id || application.candidateId) : link.mode === 'pick' ? link.candidate?.id : p.candidateId;
      if (!application && link.mode === 'new' && !p.candidateId) {
        try {
          const r = await api.post('/candidates', { fullName: link.newName.trim(), email: link.newEmail.trim() || undefined, phone: link.newPhone.trim() ? link.newPhone.replace(/[\s\-().]/g, '') : undefined, source: 'manual' });
          cid = r.candidate.id; p = { ...p, candidateId: cid }; setProgress(p);
        } catch (e) {
          if (e.status === 409 && e.data?.duplicates) { setDups(e.data.duplicates); throw Object.assign(new Error('This person may already be in the Talent Pool. Choose the existing record below, or change the details.'), { step: 'candidate' }); }
          throw Object.assign(e, { step: 'candidate' });
        }
      }
      if (cvFile && !p.cvDone && cid) {
        try { await api.upload(`/candidates/${cid}/resume?parse=0`, cvFile); p = { ...p, cvDone: true }; setProgress(p); }
        catch (e) { throw Object.assign(new Error(`The CV did not upload: ${e.message}. Try again, or remove the file to continue without a CV.`), { step: 'cv' }); }
      }
      let target = application ? { applicationId: application.id } : { candidateId: cid, requestId: link.requestId ? Number(link.requestId) : undefined };
      if (!application && link.requestId) {
        if (!p.applicationId) { p = { ...p, applicationId: await ensureApplication(cid, Number(link.requestId)) }; setProgress(p); }
        target = { applicationId: p.applicationId };
      }
      let iv = null;
      if (!p.interviewId) {
        try {
          const r = await api.post('/interviews', {
            ...target, idempotencyKey: keys.current.create, interviewType: f.interviewType, mode: f.mode, scheduledAt: startIso,
            durationMin: Number(f.durationMin), round: Number(f.round), locationOrLink: f.locationOrLink.trim(),
            panel: f.panel.map((id, i) => ({ interviewerId: id, isLead: i === 0 })),
            ...(needsAck ? { ackPanelOverlap: true, overlapReason: overlapReason.trim() } : {}),
          });
          iv = r.interview; p = { ...p, interviewId: iv.id }; setProgress(p);
        } catch (e) {
          if (e.data?.code === 'candidate_conflict') setAvail((a) => ({ ...a, state: 'conflicts', candidate: e.data.conflicts || [] }));
          if (e.data?.code === 'panel_conflict') setAvail((a) => ({ ...a, state: 'conflicts', panel: e.data.clashes || [] }));
          throw Object.assign(e, { step: 'interview' });
        }
      } else iv = (await api.get('/interviews/' + p.interviewId)).interview;
      let out = { interview: iv, dispatches: [], summary: null, sent: false };
      if (send) {
        try {
          await api.put(`/interviews/${iv.id}/messages`, { kind: 'invite', messages: { candidate: msgs.candidate, panel: msgs.panel, whatsapp: { body: waText || msgs.whatsapp.body } } });
          const r = await api.post(`/interviews/${iv.id}/send`, { kind: 'invite', batchKey: keys.current.send, candidate: !!rcpt.candidate, panel: panelSel, attachCv: rcpt.attachCv.filter((id) => panelSel.includes(id)) });
          out = { interview: r.interview || iv, dispatches: r.dispatches || [], summary: r.summary, sent: true };
        } catch (e) { throw Object.assign(new Error(`The interview is saved (${iv.interviewNo}), but the invitations were not sent: ${e.message}`), { step: 'send' }); }
      } else if (waTouched.current) {
        await api.put(`/interviews/${iv.id}/messages`, { kind: 'invite', messages: { whatsapp: { body: waText } } }).catch(() => {});
      }
      setResult(out);
      toast(send ? `Interview ${iv.interviewNo} saved` : `Interview ${iv.interviewNo} saved — no invitations sent`);
    } catch (e) {
      setStepError({ step: e.step || 'interview', message: e.message || 'Something went wrong' });
    } finally { busyRef.current = false; setBusy(false); }
  }
  function scheduleAnother() {
    // Keep the slot shape (time, type, mode, length); clear everything personal.
    setF((s) => ({ ...IV_FORM_BLANK, interviewType: s.interviewType, mode: s.mode, scheduledAt: s.scheduledAt, durationMin: s.durationMin, round: s.round }));
    setLink(IV_LINK_BLANK); setCvFile(null); setDups(null); setQ(''); setProgress(IV_PROGRESS_BLANK); setStepError(null);
    setAck(false); setOverlapReason(''); setRcpt({ candidate: true, panel: null, attachCv: [] });
    setMsgs(tpl?.templates ? { ...tpl.templates.invite } : null); waTouched.current = false; setWaText('');
    keys.current = { create: ivKey(), send: ivKey() }; setResult(null);
  }
  function openWhatsApp(ivId) {
    return openWhatsAppWindow(() => api.post(`/interviews/${ivId}/whatsapp-handoff`, { kind: 'invite' }), toast);
  }

  const { dialogRef, onDialogKeyDown } = useDialogFocus(onClose);
  const title = application ? `Schedule interview — ${application.candidate?.fullName || ''}` : 'Schedule interview';
  if (!meta || !msgs) return <Modal title={title} onClose={onClose}><Skeleton /></Modal>;
  const nameOf = (id) => meta.interviewers.find((u) => u.id === id)?.name || 'Panel member';

  if (result) {
    const iv = result.interview;
    return toPageLevel(
      <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) { onScheduled(); } }}>
        <div ref={dialogRef} className="modal iv-compose" role="dialog" aria-modal="true" aria-label="Interview saved" tabIndex="-1" onKeyDown={onDialogKeyDown}>
          <div className="modal-head"><h3>Interview {iv.interviewNo} saved</h3><button type="button" className="icon-btn" aria-label="Close dialog" onClick={() => onScheduled()}><Icon name="close" size={16} /></button></div>
          <div className="modal-body iv-result">
            <p><strong>{iv.candidate?.fullName}</strong> · {cairoLabel(iv.scheduledAt)} · {iv.durationMin} min · {ivMode(iv.mode)}</p>
            {result.sent ? <>
              <div className="section-title">Invitations</div>
              {result.summary?.dryRun && <div className="notice notice-warn">This server uses a test mail transport: messages were prepared but <strong>not delivered</strong>.</div>}
              <DispatchList rows={result.dispatches} />
            </> : <p className="muted">No invitations were sent. You can send them from the interview at any time.</p>}
            <WhatsAppHandoff phone={iv.candidate ? candPhone : null} text={waText} editable={false} onOpen={() => openWhatsApp(iv.id)} />
          </div>
          <div className="modal-foot">
            <button className="btn btn-ghost" onClick={() => onScheduled(iv.id)}>Open interview</button>
            <button className="btn btn-secondary" onClick={scheduleAnother}>Schedule another</button>
            <button className="btn" onClick={() => onScheduled()}>Done</button>
          </div>
        </div>
      </div>
    );
  }

  const progressNote = (progress.candidateId || progress.cvDone || progress.applicationId || progress.interviewId)
    ? [progress.candidateId && 'candidate created', progress.cvDone && 'CV uploaded', progress.applicationId && 'linked to the request', progress.interviewId && 'interview saved'].filter(Boolean).join(' · ') : null;
  return toPageLevel(
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="modal iv-compose" role="dialog" aria-modal="true" aria-label={title} tabIndex="-1" onKeyDown={onDialogKeyDown}>
        <div className="modal-head"><h3>{title}</h3><button type="button" className="icon-btn" aria-label="Close dialog" onClick={onClose}><Icon name="close" size={16} /></button></div>
        <div className="iv-compose-body">
          <div className="iv-compose-form">
            {/* 1 — Candidate & CV */}
            <section className="iv-step" aria-labelledby="iv-step-1">
              <h4 id="iv-step-1"><span className="iv-step-n">1</span>Candidate &amp; CV</h4>
              {application ? (
                <p className="muted">Application <strong>{application.applicationNo}</strong> — {application.candidate?.fullName}. Scheduling does not change the pipeline status.</p>
              ) : <>
                {canAdd && (
                  <div className="seg-tabs" role="tablist" aria-label="Candidate source">
                    <button type="button" role="tab" aria-selected={link.mode === 'pick'} className={'seg-tab' + (link.mode === 'pick' ? ' active' : '')} disabled={!!progress.candidateId} onClick={() => setLink((s) => ({ ...s, mode: 'pick' }))}>From Talent Pool</button>
                    <button type="button" role="tab" aria-selected={link.mode === 'new'} className={'seg-tab' + (link.mode === 'new' ? ' active' : '')} disabled={!!progress.candidateId} onClick={() => setLink((s) => ({ ...s, mode: 'new' }))}>New candidate</button>
                  </div>
                )}
                {link.mode === 'pick' ? (
                  link.candidate ? (
                    <div className="standalone-picked"><strong>{link.candidate.fullName}</strong>
                      <span className="muted">{link.candidate.candidateNo}{link.candidate.email ? ' · ' + link.candidate.email : ''}{link.candidate.hasResume ? ' · CV on file' : ''}</span>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLink((s) => ({ ...s, candidate: null }))}>Change</button></div>
                  ) : <>
                    <input aria-label="Search the Talent Pool" placeholder="Search name, email, phone…" value={q} onChange={(e) => setQ(e.target.value)} />
                    {hits.length > 0 && <ul className="standalone-results" role="listbox">{hits.map((c) => (
                      <li key={c.id} role="option" aria-selected="false" onClick={() => { setLink((s) => ({ ...s, candidate: c })); setQ(''); }}>
                        <strong>{c.fullName}</strong> <span className="muted">{c.candidateNo}{c.currentPosition ? ' · ' + c.currentPosition : ''}</span></li>))}</ul>}
                  </>
                ) : (
                  <div className="form-grid">
                    <div className="field full"><label>Full name *</label><input value={link.newName} disabled={!!progress.candidateId} onChange={(e) => setLink((s) => ({ ...s, newName: e.target.value }))} /></div>
                    <div className="field"><label>Email</label><input type="email" value={link.newEmail} disabled={!!progress.candidateId} onChange={(e) => setLink((s) => ({ ...s, newEmail: e.target.value }))} placeholder="name@example.com" /></div>
                    <div className="field"><label>Phone (international)</label><input value={link.newPhone} disabled={!!progress.candidateId} onChange={(e) => setLink((s) => ({ ...s, newPhone: e.target.value }))} placeholder="+20 100 123 4567" inputMode="tel" /></div>
                    <p className="field-hint full">An email or a phone number is required. The phone is used for WhatsApp.</p>
                  </div>
                )}
                {dups && dups.length > 0 && link.mode === 'new' && !progress.candidateId && (
                  <div className="notice notice-warn" role="status"><strong>Already in the Talent Pool?</strong>
                    <ul className="iv-dups">{dups.map((d) => (
                      <li key={d.id}><span>{d.fullName} · {d.candidateNo}{d.email ? ' · ' + d.email : ''}{d.phone ? ' · ' + d.phone : ''}</span>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setLink((s) => ({ ...s, mode: 'pick', candidate: { id: d.id, fullName: d.fullName, candidateNo: d.candidateNo, email: d.email, phone: d.phone } })); setDups(null); setStepError(null); }}>Use this candidate</button></li>))}</ul></div>
                )}
                <div className="field"><label>Hiring request (optional)</label>
                  <select value={link.requestId} disabled={!!progress.applicationId} onChange={(e) => setLink((s) => ({ ...s, requestId: e.target.value }))}>
                    <option value="">None — standalone interview</option>
                    {(requests || []).map((r) => {
                      const pending = r.status === 'pending_approval' || r.status === 'draft';
                      const paused = r.status === 'on_hold';
                      return <option key={r.id} value={r.id} disabled={pending || paused}>{r.ticketNo} — {r.title}{pending ? ' (awaiting approval)' : paused ? ' (on hold)' : ''}</option>;
                    })}
                  </select>
                  <span className="field-hint">Requests awaiting approval or on hold can match candidates, but their interviews wait.</span></div>
              </>}
              <div className="iv-cv">
                <span className="iv-cv-label">CV</span>
                {cvFile ? <span className="iv-cv-file">{cvFile.name}{progress.cvDone ? ' · uploaded' : ''}
                  {!progress.cvDone && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCvFile(null)}>Remove</button>}</span>
                  : (application?.candidate?.hasResume || link.candidate?.hasResume) ? <span className="muted">A CV is already on file.</span>
                    : <span className="muted">No CV attached</span>}
                {!progress.cvDone && (
                  <label className="btn btn-secondary btn-sm iv-file">{cvFile ? 'Replace file' : 'Attach CV'}
                    <input type="file" accept=".pdf,.doc,.docx,.txt,.png,.jpg,.jpeg" onChange={(e) => { const file = e.target.files && e.target.files[0]; if (file) setCvFile(file); e.target.value = ''; }} hidden /></label>
                )}
                <span className="field-hint">PDF, Word, text or image, up to 20 MB. Stored on the candidate; not read by AI for this booking.</span>
              </div>
            </section>

            {/* 2 — Interview & panel */}
            <section className="iv-step" aria-labelledby="iv-step-2">
              <h4 id="iv-step-2"><span className="iv-step-n">2</span>Interview &amp; panel</h4>
              <div className="form-grid">
                <div className="field"><label>Type</label><select value={f.interviewType} onChange={(e) => set('interviewType', e.target.value)}>{meta.types.map((t) => <option key={t} value={t}>{ivType(t)}</option>)}</select></div>
                <div className="field"><label>Mode</label><select value={f.mode} onChange={(e) => set('mode', e.target.value)}>{meta.modes.map((m) => <option key={m} value={m}>{ivMode(m)}</option>)}</select></div>
                <div className="field"><label>Date &amp; time (Cairo) *</label><input type="datetime-local" value={f.scheduledAt} onChange={(e) => set('scheduledAt', e.target.value)} />
                  {startIso && <span className="field-hint">{cairoLabel(startIso)}</span>}</div>
                <div className="field"><label>Duration (minutes)</label><input type="number" min="5" max="480" step="5" value={f.durationMin} onChange={(e) => set('durationMin', e.target.value)} /></div>
                <div className="field full">
                  <label>{f.mode === 'video' ? 'Meeting link' : f.mode === 'phone' ? 'Phone number or call arrangement' : 'Location'}</label>
                  {f.mode === 'onsite'
                    ? <InterviewPlacePicker places={meta?.places || []} value={f.locationOrLink} onChange={(v) => set('locationOrLink', v)} />
                    : <input value={f.locationOrLink} onChange={(e) => set('locationOrLink', e.target.value)}
                      placeholder={f.mode === 'video' ? 'https://… (paste the link from your calendar)' : '+20 100 000 0000'} />}
                  {f.mode === 'video' && f.locationOrLink.trim() && !HTTPS_LINK(f.locationOrLink) && <span className="iv-error">Use a full https:// meeting link.</span>}
                </div>
              </div>
              <div className="iv-sub">Panel *</div>
              <div className="iv-panel-pick">{meta.interviewers.map((u) => (
                <button key={u.id} type="button" title={u.name} aria-pressed={f.panel.includes(u.id)} className={'tag-toggle' + (f.panel.includes(u.id) ? ' on' : '')} onClick={() => togglePanel(u.id)}>{u.name}{f.panel[0] === u.id ? ' · lead' : ''}</button>))}</div>
              <div className="iv-avail" role="status" aria-live="polite">
                {avail.state === 'checking' && <span className="muted">Checking availability…</span>}
                {avail.state === 'ok' && <span className="iv-avail-ok">No conflicts for the candidate or the panel at this time.</span>}
                {avail.state === 'unavailable' && <div className="notice notice-warn">The availability check could not run, so conflicts are <strong>unknown</strong>. Saving still re-checks on the server.</div>}
                {avail.state === 'conflicts' && <>
                  {(avail.candidate || []).length > 0 && <div className="notice notice-danger"><strong>The candidate is already booked</strong> {avail.candidate.map((c) => `${cairoTime(c.start)}–${cairoTime(c.end)}`).join(', ')}. Choose another time.</div>}
                  {(avail.panel || []).length > 0 && <div className="notice notice-warn">
                    <strong>Panel already booked:</strong> {avail.panel.map((c) => `${c.name} (${cairoTime(c.start)}–${cairoTime(c.end)})`).join(' · ')}
                    <label className="iv-ack"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> Book anyway — the overlap is intended</label>
                    {ack && <input aria-label="Reason for the overlap" placeholder="Reason, e.g. joins for the first 15 minutes" value={overlapReason} onChange={(e) => setOverlapReason(e.target.value)} />}
                  </div>}
                  {avail.hours && <div className="notice">Outside the working week: {avail.hours.message} You can still book it.</div>}
                  {(avail.location || []).length > 0 && <div className="notice">Another interview uses the same {f.mode === 'video' ? 'meeting link' : 'location'} at an overlapping time ({avail.location.map((c) => `${cairoTime(c.start)}–${cairoTime(c.end)}`).join(', ')}). Check it is free.</div>}
                </>}
              </div>
            </section>

            {/* 3 — Invitations */}
            <section className="iv-step" aria-labelledby="iv-step-3">
              <h4 id="iv-step-3"><span className="iv-step-n">3</span>Invitations</h4>
              <div className="iv-recipients">
                <label className="iv-rcpt"><input type="checkbox" checked={!!rcpt.candidate} onChange={(e) => setRcpt((r) => ({ ...r, candidate: e.target.checked }))} />
                  <span><strong>{candName || 'Candidate'}</strong> <span className="muted">{candEmail ? candEmail : 'no email — use WhatsApp or add one'}</span></span></label>
                {f.panel.map((id) => {
                  const on = panelSel.includes(id);
                  const cvOk = !!cvFile || application?.candidate?.hasResume || link.candidate?.hasResume;
                  return (
                    <div key={id} className="iv-rcpt">
                      <label><input type="checkbox" checked={on} onChange={(e) => setRcpt((r) => ({ ...r, panel: e.target.checked ? [...panelSel, id] : panelSel.filter((x) => x !== id) }))} />
                        <span><strong>{nameOf(id)}</strong> <span className="muted">panel</span></span></label>
                      {on && cvOk && <label className="iv-attach"><input type="checkbox" checked={rcpt.attachCv.includes(id)} onChange={(e) => setRcpt((r) => ({ ...r, attachCv: e.target.checked ? [...r.attachCv, id] : r.attachCv.filter((x) => x !== id) }))} /> Attach the CV to this email</label>}
                    </div>
                  );
                })}
              </div>
              {preview?.channel?.blocked && <div className="notice notice-warn">{preview.channel.blocked.message} Saving still works; invitations would be recorded as not sent.</div>}
              {preview?.channel?.dryRun && <div className="notice">Test mail transport on this server: invitations are prepared, <strong>not delivered</strong>.</div>}
              <TemplateNote custom={customMsgs || !!preview?.errors?.candidate || !!preview?.errors?.panel} onCustom={setCustomMsgs}>
                <MessageEditor label="Candidate email" value={msgs.candidate} onChange={(v) => setMsgs((m) => ({ ...m, candidate: v }))} placeholders={phFor(tpl.placeholders, 'c', 'invite')} error={preview?.errors?.candidate} />
                <MessageEditor label="Panel email (each panelist gets their own)" value={msgs.panel} onChange={(v) => setMsgs((m) => ({ ...m, panel: v }))} placeholders={phFor(tpl.placeholders, 'p', 'invite')} error={preview?.errors?.panel} />
              </TemplateNote>
              <WhatsAppHandoff phone={candPhone} text={waText} editable={customMsgs} onText={(v) => { waTouched.current = true; setWaText(v); }} onOpen={progress.interviewId ? () => openWhatsApp(progress.interviewId) : null} />
              {!progress.interviewId && <p className="field-hint">“Open WhatsApp” is available once the interview is saved.</p>}
            </section>
          </div>

          <aside className="iv-preview" aria-label="Invitation preview">
            <div className="iv-preview-title">Preview</div>
            {!preview ? <Skeleton rows={4} /> : <>
              <div className="iv-preview-card">
                <div className="iv-preview-meta">To {preview.preview.candidate.to || <em>no email</em>}</div>
                <div className="iv-preview-subject">{preview.preview.candidate.subject}</div>
                <div className="iv-preview-body">{preview.preview.candidate.body}</div>
              </div>
              {preview.preview.panel.slice(0, 1).map((pm) => (
                <div key={pm.userId} className="iv-preview-card">
                  <div className="iv-preview-meta">To {pm.name}{pm.to ? ` <${pm.to}>` : ''}{preview.preview.panel.length > 1 ? ` · and ${preview.preview.panel.length - 1} more, each addressed separately` : ''}</div>
                  <div className="iv-preview-subject">{pm.subject}</div>
                  <div className="iv-preview-body">{pm.body}</div>
                </div>
              ))}
              <p className="field-hint">The calendar entry (.ics) is attached to each email in Cairo time. The interview reference is assigned on save.</p>
            </>}
          </aside>
        </div>
        <div className="modal-foot iv-foot">
          {stepError && <div className="iv-error iv-foot-error" role="alert">{stepError.message}{progressNote ? ` (Kept: ${progressNote}.)` : ''}</div>}
          {!stepError && progressNote && <span className="muted">Kept: {progressNote}</span>}
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-secondary" onClick={() => save(false)} disabled={busy || !formReady}>{busy ? 'Saving…' : 'Save interview'}</button>
          <button className="btn" onClick={() => save(true)} disabled={busy || !formReady || !!sendProblem || (!rcpt.candidate && panelSel.length === 0)}
            title={sendProblem || undefined}>{busy ? 'Saving…' : 'Save & send invitations'}</button>
        </div>
      </div>
    </div>
  );
}

/* ----------------- Communicate (invite / update / cancel) ---------------- */
function CommunicateModal({ iv, kind, onClose, onDone }) {
  const toast = useToast();
  const [customMsgs, setCustomMsgs] = useState(false); // per-interview wording is the exception (TemplateNote)
  const [data, setData] = useState(null);
  const [tplPh, setTplPh] = useState([]);
  const [msgs, setMsgs] = useState(null);
  const [rendered, setRendered] = useState(null);
  const [errors, setErrors] = useState({});
  const [sel, setSel] = useState(null);
  const [cv, setCv] = useState([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [waText, setWaText] = useState('');
  const [skipAsk, setSkipAsk] = useState(false);
  const batch = useRef(ivKey());
  const busyRef = useRef(false);
  const resultRef = useRef(null);
  useEffect(() => { if (result && resultRef.current) resultRef.current.scrollIntoView({ block: 'start' }); }, [result]);
  const load = useCallback(async () => {
    try {
      const d = await api.get(`/interviews/${iv.id}/messages?kind=${kind}`);
      setData(d); setRendered(d.rendered); setWaText(d.whatsapp.text || '');
      setMsgs({ candidate: { subject: d.messages.candidate.subject, body: d.messages.candidate.body }, panel: { subject: d.messages.panel.subject, body: d.messages.panel.body },
        ...(d.messages.panel_removed ? { panel_removed: { subject: d.messages.panel_removed.subject, body: d.messages.panel_removed.body } } : {}) });
      // A reminder is for the candidate; the panel can be ticked if wanted.
      setSel((s) => s || { candidate: d.recipients.some((r) => r.audience === 'candidate' && r.reachable), panel: kind === 'reminder' ? [] : d.recipients.filter((r) => r.audience !== 'candidate' && r.reachable).map((r) => r.userId) });
    } catch (e) { toast(e.message, 'error'); onClose(); }
  }, [iv.id, kind]);
  useEffect(() => { load(); api.get('/interviews/message-templates').then((t) => setTplPh(t.placeholders || [])).catch(() => {}); }, [load]);
  useEffect(() => {
    if (!msgs) return undefined;
    const t = setTimeout(() => {
      api.post(`/interviews/${iv.id}/messages/preview`, { kind, messages: { ...msgs, whatsapp: { body: data?.messages?.whatsapp?.body } } })
        .then((r) => { setErrors(r.errors || {}); if (r.rendered) setRendered(r.rendered); }).catch(() => {});
    }, 350);
    return () => clearTimeout(t);
  }, [JSON.stringify(msgs)]);
  const verb = { invite: 'invitation', update: 'update', cancel: 'cancellation', reminder: 'reminder' }[kind];
  async function send(retryFailed = false) {
    if (busyRef.current) return; busyRef.current = true; setBusy(true);
    try {
      await api.put(`/interviews/${iv.id}/messages`, { kind, messages: { ...msgs, whatsapp: { body: waText } } });
      const r = await api.post(`/interviews/${iv.id}/send`, retryFailed ? { kind, batchKey: batch.current, retryFailed: true }
        : { kind, batchKey: batch.current, candidate: !!sel.candidate, panel: sel.panel, attachCv: cv.filter((id) => sel.panel.includes(id)) });
      setResult(r); toast(r.replayed ? 'Already sent — nothing sent twice' : `${verb[0].toUpperCase() + verb.slice(1)} processed`);
      batch.current = ivKey();
    } catch (e) { toast(e.message, 'error'); } finally { busyRef.current = false; setBusy(false); }
  }
  async function openWhatsApp() {
    const r = await openWhatsAppWindow(async () => {
      await api.put(`/interviews/${iv.id}/messages`, { kind, messages: { whatsapp: { body: waText } } });
      return api.post(`/interviews/${iv.id}/whatsapp-handoff`, { kind });
    }, toast);
    if (r) load();
  }
  async function openCall() {
    try { const r = await api.post(`/interviews/${iv.id}/call-handoff`, { kind }); window.location.href = r.tel; load(); }
    catch (e) { toast(e.message, 'error'); }
  }
  async function skip(reason) {
    setSkipAsk(false);
    try { await api.post(`/interviews/${iv.id}/notice/skip`, { reason }); toast('Recorded: not sent'); onDone(); } catch (e) { toast(e.message, 'error'); }
  }
  const { dialogRef, onDialogKeyDown } = useDialogFocus(onClose);
  const title = { invite: 'Send invitations', update: 'Send the update', cancel: 'Send the cancellation', reminder: 'Send a reminder' }[kind];
  const failedLatest = (data?.dispatches || []).filter((r) => r.kind === kind && r.revision === iv.calendarSeq && r.channel === 'email');
  const hasFailed = (() => { const seen = new Set(); return failedLatest.some((r) => { if (seen.has(r.recipientKey)) return false; seen.add(r.recipientKey); return r.status === 'failed'; }); })();
  return toPageLevel(
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="modal iv-compose" role="dialog" aria-modal="true" aria-label={title} tabIndex="-1" onKeyDown={onDialogKeyDown}>
        <div className="modal-head"><h3>{title} — {iv.interviewNo}</h3><button type="button" className="icon-btn" aria-label="Close dialog" onClick={onClose}><Icon name="close" size={16} /></button></div>
        {!data || !msgs || !sel ? <div className="modal-body"><Skeleton rows={6} /></div> : (
          <div className="iv-compose-body">
            <div className="iv-compose-form">
              <p className="muted">{cairoLabel(iv.scheduledAt)} · {iv.durationMin} min · {ivMode(iv.mode)}{data.notice?.changes?.length && kind === 'update' ? ` · changed: ${data.notice.changes.map((c) => ({ date_time: 'date & time', duration: 'duration', location_or_link: 'location/link', mode: 'mode', panel: 'panel' })[c] || c).join(', ')}` : ''}</p>
              {result && <div className="iv-result-block" ref={resultRef}><div className="iv-sub">Result</div>{result.summary?.dryRun && <div className="notice notice-warn">Test transport — <strong>not delivered</strong>.</div>}<DispatchList rows={result.dispatches} /></div>}
              {data.detailsProblem && <div className="notice notice-warn">{data.detailsProblem}</div>}
              {data.channel.blocked && <div className="notice notice-warn">{data.channel.blocked.message}</div>}
              {data.channel.dryRun && <div className="notice">Test mail transport on this server: messages are prepared, <strong>not delivered</strong>.</div>}
              <div className="iv-sub">Recipients</div>
              <div className="iv-recipients">
                {data.recipients.map((r) => {
                  const isCand = r.audience === 'candidate';
                  const on = isCand ? sel.candidate : sel.panel.includes(r.userId);
                  return (
                    <div key={r.key + r.audience} className="iv-rcpt">
                      <label><input type="checkbox" disabled={!r.reachable} checked={on && r.reachable}
                        onChange={(e) => setSel((s) => (isCand ? { ...s, candidate: e.target.checked } : { ...s, panel: e.target.checked ? [...s.panel, r.userId] : s.panel.filter((x) => x !== r.userId) }))} />
                        <span><strong>{r.name}</strong> <span className="muted">{isCand ? 'Candidate' : r.audience === 'panel_removed' ? 'Removed from the panel' : r.added ? 'Added to the panel' : 'Panel'}{r.address ? ' · ' + r.address : ''}</span>
                          {r.problem && <span className="iv-error">{r.problem}</span>}</span></label>
                      {r.audience === 'panel' && on && r.canAttachCv && kind !== 'cancel' && <label className="iv-attach"><input type="checkbox" checked={cv.includes(r.userId)} onChange={(e) => setCv((x) => (e.target.checked ? [...x, r.userId] : x.filter((y) => y !== r.userId)))} /> Attach the CV</label>}
                    </div>
                  );
                })}
              </div>
              <TemplateNote custom={customMsgs || !!errors.candidate || !!errors.panel || !!errors.panel_removed} onCustom={setCustomMsgs}>
              <MessageEditor label="Candidate email" value={msgs.candidate} onChange={(v) => setMsgs((m) => ({ ...m, candidate: v }))} placeholders={phFor(tplPh, 'c', kind)} error={errors.candidate} />
              <MessageEditor label="Panel email" value={msgs.panel} onChange={(v) => setMsgs((m) => ({ ...m, panel: v }))} placeholders={phFor(tplPh, 'p', kind)} error={errors.panel} />
              {msgs.panel_removed && data.recipients.some((r) => r.audience === 'panel_removed') && <MessageEditor label="Removed panelist" value={msgs.panel_removed} onChange={(v) => setMsgs((m) => ({ ...m, panel_removed: v }))} placeholders={phFor(tplPh, 'r')} error={errors.panel_removed} />}
              </TemplateNote>
              <WhatsAppHandoff phone={data.whatsapp.phone} text={waText} editable={customMsgs} onText={setWaText} onOpen={data.whatsapp.valid ? openWhatsApp : null} />
              {data.call && <CallHandoff phone={data.call.phone} valid={data.call.valid} script={data.call.script} onCall={data.call.valid ? openCall : null} />}
            </div>
            <aside className="iv-preview" aria-label="Preview">
              <div className="iv-preview-title">Preview</div>
              {rendered && <>
                <div className="iv-preview-card"><div className="iv-preview-meta">Candidate</div><div className="iv-preview-subject">{rendered.candidate.subject}</div><div className="iv-preview-body">{rendered.candidate.body}</div></div>
                {Object.entries(rendered.panel || {}).slice(0, 1).map(([uid, pm]) => (
                  <div key={uid} className="iv-preview-card"><div className="iv-preview-meta">Panel{pm.asInvite ? ' (new member — invitation)' : ''}</div><div className="iv-preview-subject">{pm.subject}</div><div className="iv-preview-body">{pm.body}</div></div>))}
                {Object.entries(rendered.panelRemoved || {}).slice(0, 1).map(([uid, pm]) => (
                  <div key={uid} className="iv-preview-card"><div className="iv-preview-meta">Removed panelist</div><div className="iv-preview-subject">{pm.subject}</div><div className="iv-preview-body">{pm.body}</div></div>))}
              </>}
            </aside>
          </div>
        )}
        <div className="modal-foot iv-foot">
          {!result && data?.notice && !data.notice.communicated && !data.notice.skipped && kind !== 'invite' && <button className="btn btn-ghost" onClick={() => setSkipAsk(true)}>Don’t send</button>}
          {hasFailed && <button className="btn btn-secondary" disabled={busy} onClick={() => send(true)}>Retry failed</button>}
          <button className={result ? 'btn' : 'btn btn-ghost'} onClick={result ? onDone : onClose}>{result ? 'Done' : 'Cancel'}</button>
          {!result && <button className="btn" disabled={busy || !sel || !!(data && data.detailsProblem) || Object.keys(errors).length > 0 || !(sel?.candidate || sel?.panel?.length)} onClick={() => send(false)}>{busy ? 'Sending…' : `Send ${verb}`}</button>}
        </div>
        {skipAsk && <Confirm title="Don’t send this change" message="Record why the candidate and panel are not being told (e.g. agreed by phone)." requireReason confirmLabel="Record" onConfirm={skip} onClose={() => setSkipAsk(false)} />}
      </div>
    </div>
  );
}

/* --------------------------- Reschedule / edit --------------------------- */
function RescheduleModal({ iv, onClose, onSaved }) {
  const toast = useToast();
  const [meta, setMeta] = useState(null);
  const [f, setF] = useState({ scheduledAt: isoToCairoInput(iv.scheduledAt), durationMin: iv.durationMin || 60, mode: iv.mode, locationOrLink: iv.locationOrLink || '', panel: iv.panel.map((m) => m.id) });
  const [avail, setAvail] = useState({ state: 'idle' });
  const [ack, setAck] = useState(false); const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  useEffect(() => { api.get('/interviews/meta/form').then(setMeta).catch(() => {}); }, []);
  const startIso = cairoInputToIso(f.scheduledAt);
  const panelKey = f.panel.join(',');
  useEffect(() => {
    if (!startIso || !panelKey) { setAvail({ state: 'idle' }); return undefined; }
    let live = true; setAvail((a) => ({ ...a, state: 'checking' }));
    const t = setTimeout(() => {
      const qs = new URLSearchParams({ start: startIso, durationMin: String(Number(f.durationMin) || 60), panel: panelKey, candidateId: String(iv.candidate?.id || ''), excludeId: String(iv.id) });
      if (f.locationOrLink.trim()) qs.set('location', f.locationOrLink.trim());
      api.get('/interviews/clashes?' + qs.toString()).then((r) => { if (!live) return; const any = (r.clashes || []).length || (r.candidateConflicts || []).length || (r.locationWarnings || []).length; setAvail({ state: any ? 'conflicts' : 'ok', panel: r.clashes || [], candidate: r.candidateConflicts || [], location: r.locationWarnings || [], hours: r.hoursWarning || null }); })
        .catch(() => { if (live) setAvail({ state: 'unavailable' }); });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [startIso, f.durationMin, panelKey, f.locationOrLink]);
  const needsAck = avail.state === 'conflicts' && (avail.panel || []).length > 0;
  const blocked = avail.state === 'conflicts' && (avail.candidate || []).length > 0;
  async function save() {
    setBusy(true);
    try {
      const r = await api.put(`/interviews/${iv.id}`, { scheduledAt: startIso, durationMin: Number(f.durationMin), mode: f.mode, locationOrLink: f.locationOrLink.trim(),
        panel: f.panel.map((id, i) => ({ interviewerId: id, isLead: i === 0 })), ...(needsAck ? { ackPanelOverlap: true, overlapReason: reason.trim() } : {}) });
      toast(r.changes?.length ? 'Interview updated — review the update to send' : 'Saved — nothing changed that needs telling');
      onSaved(r.changes || []);
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }
  return (
    <Modal title={`Reschedule / edit — ${iv.interviewNo}`} onClose={onClose} wide
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !startIso || !f.panel.length || blocked || (needsAck && !(ack && reason.trim()))} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</button></>}>
      {!meta ? <Skeleton /> : <>
        <div className="form-grid">
          <div className="field"><label>Date &amp; time (Cairo)</label><input type="datetime-local" value={f.scheduledAt} onChange={(e) => set('scheduledAt', e.target.value)} />{startIso && <span className="field-hint">{cairoLabel(startIso)}</span>}</div>
          <div className="field"><label>Duration (minutes)</label><input type="number" min="5" max="480" step="5" value={f.durationMin} onChange={(e) => set('durationMin', e.target.value)} /></div>
          <div className="field"><label>Mode</label><select value={f.mode} onChange={(e) => set('mode', e.target.value)}>{meta.modes.map((m) => <option key={m} value={m}>{ivMode(m)}</option>)}</select></div>
          <div className="field"><label>{f.mode === 'video' ? 'Meeting link' : f.mode === 'phone' ? 'Phone / arrangement' : 'Place'}</label>{f.mode === 'onsite'
            ? <InterviewPlacePicker places={meta?.places || []} value={f.locationOrLink} onChange={(v) => set('locationOrLink', v)} />
            : <input value={f.locationOrLink} onChange={(e) => set('locationOrLink', e.target.value)} />}</div>
        </div>
        <div className="iv-sub">Panel</div>
        <div className="iv-panel-pick">{meta.interviewers.map((u) => <button key={u.id} type="button" title={u.name} aria-pressed={f.panel.includes(u.id)} className={'tag-toggle' + (f.panel.includes(u.id) ? ' on' : '')} onClick={() => setF((s) => ({ ...s, panel: s.panel.includes(u.id) ? s.panel.filter((x) => x !== u.id) : [...s.panel, u.id] }))}>{u.name}</button>)}</div>
        <div className="iv-avail" role="status">
          {avail.state === 'checking' && <span className="muted">Checking availability…</span>}
          {avail.state === 'ok' && <span className="iv-avail-ok">No conflicts at this time.</span>}
          {avail.state === 'unavailable' && <div className="notice notice-warn">Availability could not be checked; conflicts are unknown. Saving re-checks on the server.</div>}
          {avail.hours && <div className="notice">Outside the working week: {avail.hours.message} You can still book it.</div>}
          {blocked && <div className="notice notice-danger"><strong>The candidate is already booked then.</strong> Choose another time.</div>}
          {needsAck && <div className="notice notice-warn"><strong>Panel already booked:</strong> {avail.panel.map((c) => c.name).join(', ')}
            <label className="iv-ack"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> Book anyway — the overlap is intended</label>
            {ack && <input aria-label="Reason for the overlap" placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />}</div>}
        </div>
        <p className="muted">After saving, you choose whether and how to tell the candidate and panel.</p>
      </>}
    </Modal>
  );
}

/* ------------- Scheduling Setup (working week, places, templates) ---------- */
function InterviewTemplatesModal({ onClose }) {
  const toast = useToast();
  const [t, setT] = useState(null);
  const [kind, setKind] = useState('invite');
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [hqAddr, setHqAddr] = useState('');
  const [ww, setWw] = useState(null);
  useEffect(() => { api.get('/interviews/message-templates').then((r) => { setT(r); setDraft(JSON.parse(JSON.stringify(r.templates))); setHqAddr(r.headOfficeAddress || ''); setWw(r.workingWeek || null); }).catch((e) => toast(e.message, 'error')); }, []);
  async function save() {
    setBusy(true); setErr(null);
    try { const r = await api.put('/interviews/message-templates', { templates: draft, headOfficeAddress: hqAddr, ...(ww ? { workingWeek: ww } : {}) }); setT((x) => ({ ...x, templates: r.templates, headOfficeAddress: r.headOfficeAddress })); toast('Scheduling Setup saved'); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function reset() {
    setBusy(true);
    try { const r = await api.put('/interviews/message-templates', { reset: true }); setDraft(JSON.parse(JSON.stringify(r.templates))); toast('Templates reset to the defaults'); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }
  const labels = { candidate: 'Candidate email', panel: 'Panel email', whatsapp: 'WhatsApp (candidate)', call: 'Phone call script (candidate)', panel_removed: 'Removed panelist' };
  const codes = { candidate: 'c', panel: 'p', whatsapp: 'w', call: 'k', panel_removed: 'r' };
  return (
    <Modal title="Scheduling Setup" onClose={onClose} wide
      footer={t?.canEdit ? <><button className="btn btn-ghost" onClick={reset} disabled={busy}>Reset templates to defaults</button><button className="btn btn-ghost" onClick={onClose}>Close</button><button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save Scheduling Setup'}</button></> : <button className="btn" onClick={onClose}>Close</button>}>
      {!t || !draft ? <Skeleton /> : <div className="iv-tpl-body">
        <p className="muted">The organisation’s interview scheduling rules and default wording. Each interview starts from these templates and can be edited before sending. Placeholders are filled in for each recipient; only the ones listed under each message can be used there.{t.canEdit ? '' : ' You can view these; changing them needs the Notifications permission.'}</p>
        {ww && <div className="field">
          <label>Working week</label>
          <div className="btn-row" role="group" aria-label="Working days">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => (
              <label key={d} className="iv-rcpt"><input type="checkbox" disabled={!t.canEdit} checked={ww.days.includes(i)}
                onChange={(e) => setWw((w) => ({ ...w, days: e.target.checked ? [...w.days, i].sort() : w.days.filter((x) => x !== i) }))} /> {d}</label>
            ))}
          </div>
          <div className="btn-row">
            <label htmlFor="iv-ww-start" className="muted">From</label><input id="iv-ww-start" type="time" disabled={!t.canEdit} value={ww.start} onChange={(e) => setWw((w) => ({ ...w, start: e.target.value }))} />
            <label htmlFor="iv-ww-end" className="muted">to</label><input id="iv-ww-end" type="time" disabled={!t.canEdit} value={ww.end} onChange={(e) => setWw((w) => ({ ...w, end: e.target.value }))} />
            <span className="muted">Cairo time</span>
          </div>
          <span className="field-hint">The interview calendar shows these days and hours. Booking outside them shows a warning; it is never blocked.</span>
        </div>}
        <div className="field">
          <label htmlFor="iv-hq-addr">Head Office address</label>
          <input id="iv-hq-addr" value={hqAddr} disabled={!t.canEdit} maxLength={300} onChange={(e) => setHqAddr(e.target.value)} placeholder="Street, district, city — shown to candidates for Head Office interviews" />
          <span className="field-hint">On-site interviews pick Head Office or a company site; the place and its address fill {'{{where}}'} in every message. Site addresses come from Organization Structure.</span>
        </div>
        <div className="seg-tabs" role="tablist">{[['invite', 'Invitation'], ['update', 'Update'], ['cancel', 'Cancellation'], ['reminder', 'Reminder']].map(([k, l]) => <button key={k} role="tab" aria-selected={kind === k} className={'seg-tab' + (kind === k ? ' active' : '')} onClick={() => setKind(k)}>{l}</button>)}</div>
        {err && <div className="notice notice-danger">{err}</div>}
        {t.audiences[kind].map((aud) => (
          <MessageEditor key={kind + aud} label={labels[aud]} hasSubject={t.hasSubject[aud]} value={draft[kind][aud]}
            onChange={(v) => setDraft((d) => ({ ...d, [kind]: { ...d[kind], [aud]: t.hasSubject[aud] ? v : { body: v.body } } }))}
            placeholders={t.canEdit ? phFor(t.placeholders, codes[aud], kind) : []} />
        ))}
      </div>}
    </Modal>
  );
}

/* ---------------------- Communications on an interview -------------------- */
function InterviewComms({ iv, canManage, onOpen }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { if (canManage) api.get(`/interviews/${iv.id}/dispatches`).then((r) => setRows(r.dispatches || [])).catch(() => setRows([])); }, [iv.id, iv.calendarSeq, canManage]);
  if (!canManage) return null;
  const n = iv.notice;
  const pending = n && !n.communicated && !n.skipped;
  const batches = [];
  for (const r of rows || []) { let b = batches.find((x) => x.key === r.batchKey); if (!b) { b = { key: r.batchKey, kind: r.kind, at: r.createdAt, rows: [] }; batches.push(b); } b.rows.push(r); }
  return (
    <div className="card card-pad iv-comms">
      <div className="row-between"><div className="section-title" style={{ marginTop: 0 }}>Communications</div>
        {['scheduled', 'rescheduled'].includes(iv.status) && <button className="btn btn-secondary btn-sm" onClick={() => onOpen('invite')}>Send invitations</button>}</div>
      {pending && (
        <div className="notice notice-warn" role="status">
          {n.kind === 'cancel' ? 'The cancellation has not been sent to anyone yet.' : 'The changes to this interview have not been sent yet.'}
          <div className="btn-row"><button className="btn btn-sm" onClick={() => onOpen(n.kind)}>{n.kind === 'cancel' ? 'Review & send cancellation' : 'Review & send update'}</button></div>
        </div>
      )}
      {n && n.skipped && <p className="muted">Not sent on purpose by {n.skippedBy}: {n.skipReason}</p>}
      {rows === null ? <Skeleton rows={2} /> : batches.length === 0 ? <p className="muted">Nothing sent yet.</p> : batches.map((b) => (
        <div key={b.key} className="iv-batch">
          <div className="iv-batch-head"><strong>{{ invite: 'Invitation', update: 'Update', cancel: 'Cancellation', reminder: 'Reminder' }[b.kind] || b.kind}</strong> <span className="muted">{fmtDate(b.at)}</span></div>
          <DispatchList rows={b.rows} />
        </div>
      ))}
    </div>
  );
}

/* ============================ Interview calendar ============================
   The first screen of Interviews. Arabtec works Saturday to Thursday, 09:00 to
   17:00, and the grid shows exactly that. It widens itself (Friday, an early
   or late hour) only when an interview is already booked there, so nothing
   booked is ever hidden. Presentation only: times are the browser's local
   time; the server keeps storing ISO UTC.
   ========================================================================== */
const CAL_WORK_DAYS = [6, 0, 1, 2, 3, 4];   // Sat..Thu, in display order (Date#getDay)
const CAL_HOURS = [9, 17];                  // visible working hours [start, end) when no setting is loaded
// The organisation's working week (Scheduling Setup → interview_working_week),
// sent with the interview list. Defaults match the server: Sat–Thu, 09:00–17:00.
const CAL_DEFAULT_WEEK = { days: [0, 1, 2, 3, 4, 6], start: '09:00', end: '17:00' };
const CAL_WEEK_ORDER = [6, 0, 1, 2, 3, 4, 5]; // Saturday first, as the calendar is laid out
const calWeekOf = (ww) => (ww && Array.isArray(ww.days) && ww.days.length ? ww : CAL_DEFAULT_WEEK);
const calIsWorkDay = (d, ww) => calWeekOf(ww).days.includes(d.getDay());
const calHHMM = (t) => { const [h, m] = String(t || '').split(':').map(Number); return { h: h || 0, m: m || 0 }; };
const CAL_SLOT_MIN = 30;                    // a click books on the half hour
const CAL_HOUR_PX = 56;                     // desktop; phones use 88 so a slot is a 44px target

function calDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function calAddDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function calSameDay(a, b) { return calDay(a).getTime() === calDay(b).getTime(); }
function calWeekStart(d) { const x = calDay(d); return calAddDays(x, -((x.getDay() - CAL_WORK_DAYS[0] + 7) % 7)); }
function calStart(iv) { const d = new Date(iv.scheduledAt); return iv.scheduledAt && !isNaN(d) ? d : null; }
function calEnd(iv) { const s = calStart(iv); return s && new Date(s.getTime() + (Number(iv.durationMin) || 60) * 60000); }
function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// The [from, to) a view shows. The page fetches exactly this range.
function calRange(view, anchor) {
  if (view === 'day') { const from = calDay(anchor); return { from, to: calAddDays(from, 1) }; }
  if (view === 'month') {
    const from = calWeekStart(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
    const to = calAddDays(calWeekStart(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0)), 7);
    return { from, to };
  }
  const from = calWeekStart(anchor);
  return { from, to: calAddDays(from, 7) };
}
// Weekday columns, Saturday first: the working days from Scheduling Setup; a
// non-working day (Friday by default) joins only when something is booked on it.
function calWeekdays(interviews, ww) {
  const work = calWeekOf(ww).days;
  const booked = new Set(interviews.map((iv) => calStart(iv)?.getDay()).filter((d) => d != null));
  return CAL_WEEK_ORDER.filter((d) => work.includes(d) || booked.has(d));
}
function calWeekDates(weekStart, weekdays) { return weekdays.map((w) => calAddDays(weekStart, (w - CAL_WORK_DAYS[0] + 7) % 7)); }
// Hours the grid shows: the working hours from Scheduling Setup (09–17 by
// default), widened to fit anything booked outside them.
function calHourSpan(interviews, ww) {
  const w = calWeekOf(ww), ws = calHHMM(w.start), we = calHHMM(w.end);
  let start = ww ? ws.h : CAL_HOURS[0];
  let end = ww ? we.h + (we.m ? 1 : 0) : CAL_HOURS[1];
  for (const iv of interviews) {
    const s = calStart(iv); if (!s) continue;
    const e = calEnd(iv);
    start = Math.min(start, s.getHours());
    end = Math.max(end, calSameDay(s, e) ? e.getHours() + (e.getMinutes() ? 1 : 0) : 24);
  }
  return [start, Math.min(end, 24)];
}
// One day's interviews as blocks: top/height in px, and side-by-side lanes
// when they overlap, so two interviews at 10:00 are both visible and clickable.
function calLayoutDay(interviews, hourStart, hourPx = CAL_HOUR_PX) {
  const items = interviews.map((iv) => ({ iv, s: calStart(iv), e: calEnd(iv) })).filter((x) => x.s)
    .sort((a, b) => a.s - b.s || b.e - a.e);
  const out = []; let group = []; let groupEnd = 0;
  const flush = () => { const lanes = Math.max(...group.map((g) => g.lane)) + 1; for (const g of group) out.push({ ...g, lanes }); group = []; };
  for (const it of items) {
    if (group.length && it.s >= groupEnd) flush();
    const taken = new Set(group.filter((g) => g.e > it.s).map((g) => g.lane));
    let lane = 0; while (taken.has(lane)) lane++;
    group.push({ ...it, lane }); groupEnd = Math.max(groupEnd, it.e);
  }
  if (group.length) flush();
  return out.map(({ iv, s, e, lane, lanes }) => ({
    iv, lane, lanes,
    top: (((s.getHours() - hourStart) * 60 + s.getMinutes()) / 60) * hourPx,
    height: Math.max(22, ((e - s) / 3600000) * hourPx - 2),
  }));
}
// The server refuses a start in the past, so the calendar never offers one.
function calSlotOpen(start, now) { return start.getTime() > now.getTime(); }
// Clicking a day (month view) books its first open half hour: the start of the
// working day, or the next half hour if the day has already started. Null when the day is over.
function calFirstOpenSlot(day, now, ww) {
  const ws = calHHMM(calWeekOf(ww).start);
  const at = new Date(day); at.setHours(ws.h, ws.m, 0, 0);
  if (at > now) return at;
  const next = new Date(now); next.setSeconds(0, 0);
  next.setMinutes(Math.ceil((next.getMinutes() + 1) / CAL_SLOT_MIN) * CAL_SLOT_MIN);
  return calSameDay(next, day) ? next : null;
}
function calStep(view, anchor, dir, ww) {
  if (view === 'month') return new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1);
  if (view !== 'day') return calAddDays(anchor, dir * 7);
  let next = calAddDays(anchor, dir);
  for (let i = 0; i < 6 && !calIsWorkDay(next, ww); i++) next = calAddDays(next, dir); // day-by-day skips non-working days
  return next;
}
function calTitle(view, anchor) {
  if (view === 'month') return anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  if (view === 'day') return anchor.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const from = calWeekStart(anchor); const to = calAddDays(from, 5); // Saturday – Thursday
  const head = from.toLocaleDateString(undefined, from.getMonth() === to.getMonth() ? { day: 'numeric' } : { day: 'numeric', month: 'short' });
  return `${head} – ${to.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}
const calSlotLabel = (d) => d.toLocaleString(undefined, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

function CalEvent({ iv, style, onOpen }) {
  const status = IV_STATUS[iv.status];
  return (
    <button type="button" className={'cal-ev cal-s-' + iv.status} style={style} onClick={() => onOpen(iv.id)}
      title={`${iv.candidate?.fullName || 'Candidate'} · ${ivType(iv.interviewType)} · ${fmtWhen(iv.scheduledAt)}${ivResponseLabel(iv) ? ' · ' + ivResponseLabel(iv) : ''}`}>
      <span className="cal-ev-time">{timeOf(iv.scheduledAt)} · {ivType(iv.interviewType)}</span>
      <span className="cal-ev-who">{iv.candidate?.fullName || '—'}</span>
      {iv.status !== 'scheduled' && <span className="cal-ev-status">{status ? status.label : iv.status}</span>}
    </button>
  );
}

function CalTimeGrid({ view, anchor, interviews, now, canSchedule, hourPx, ww, onOpen, onCreateAt }) {
  const days = view === 'day' ? [calDay(anchor)] : calWeekDates(calRange('week', anchor).from, calWeekdays(interviews, ww));
  const [h0, h1] = calHourSpan(interviews, ww);
  const slots = [];
  for (let m = h0 * 60; m < h1 * 60; m += CAL_SLOT_MIN) slots.push(m);
  const hours = [];
  for (let h = h0; h < h1; h++) hours.push(h);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return (
    <div className="cal-grid" style={{ '--cal-cols': days.length, '--cal-hour': hourPx + 'px' }}>
      <div className="cal-head">
        <div className="cal-corner" />
        {days.map((d) => (
          <div key={+d} className={'cal-dayhead' + (calSameDay(d, now) ? ' today' : '') + (calIsWorkDay(d, ww) ? '' : ' offday')}>
            <span className="cal-dow">{d.toLocaleDateString(undefined, { weekday: 'short' })}</span>
            <span className="cal-dom">{d.getDate()}</span>
          </div>
        ))}
      </div>
      <div className="cal-body" style={{ height: (h1 - h0) * hourPx }}>
        <div className="cal-times" aria-hidden="true">
          {hours.map((h) => <div key={h} className="cal-time">{String(h).padStart(2, '0')}:00</div>)}
        </div>
        {days.map((d) => {
          const mine = interviews.filter((iv) => { const s = calStart(iv); return s && calSameDay(s, d); });
          return (
            <div key={+d} className={'cal-col' + (calIsWorkDay(d, ww) ? '' : ' offday')}>
              {slots.map((m) => {
                const at = new Date(d); at.setHours(0, m, 0, 0);
                return canSchedule && calSlotOpen(at, now)
                  ? <button key={m} type="button" className="cal-slot" aria-label={'Schedule an interview on ' + calSlotLabel(at)} onClick={() => onCreateAt(at)} />
                  : <div key={m} className={'cal-slot' + (calSlotOpen(at, now) ? '' : ' past')} />;
              })}
              {calSameDay(d, now) && nowMin >= h0 * 60 && nowMin < h1 * 60 && (
                <div className="cal-now" style={{ top: ((nowMin - h0 * 60) / 60) * hourPx }} aria-hidden="true" />
              )}
              {calLayoutDay(mine, h0, hourPx).map(({ iv, top, height, lane, lanes }) => (
                <CalEvent key={iv.id} iv={iv} onOpen={onOpen}
                  style={{ top, height, insetInlineStart: `calc(${lane} * 100% / ${lanes} + 2px)`, width: `calc(100% / ${lanes} - 4px)` }} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CalMonth({ anchor, interviews, now, canSchedule, ww, onOpen, onCreateAt, onPickDay }) {
  const { from, to } = calRange('month', anchor);
  const weekdays = calWeekdays(interviews, ww);
  const weeks = [];
  for (let w = from; w < to; w = calAddDays(w, 7)) weeks.push(calWeekDates(w, weekdays));
  return (
    <div className="cal-month" style={{ '--cal-cols': weekdays.length }}>
      <div className="cal-month-head">
        {weeks[0].map((d) => <div key={d.getDay()} className="cal-dow">{d.toLocaleDateString(undefined, { weekday: 'short' })}</div>)}
      </div>
      {weeks.map((week) => (
        <div key={+week[0]} className="cal-month-row">
          {week.map((d) => {
            const items = interviews.filter((iv) => { const s = calStart(iv); return s && calSameDay(s, d); })
              .sort((a, b) => calStart(a) - calStart(b));
            const slot = canSchedule ? calFirstOpenSlot(d, now, ww) : null;
            return (
              <div key={+d} className={'cal-mcell' + (d.getMonth() === anchor.getMonth() ? '' : ' out') + (calSameDay(d, now) ? ' today' : '')}>
                {slot && <button type="button" className="cal-mfill" aria-label={'Schedule an interview on ' + calSlotLabel(slot)} onClick={() => onCreateAt(slot)} />}
                <button type="button" className="cal-mdate" aria-label={'Open ' + d.toDateString() + ' in day view'} onClick={() => onPickDay(d)}>{d.getDate()}</button>
                {items.slice(0, 3).map((iv) => (
                  <button key={iv.id} type="button" className={'cal-mev cal-s-' + iv.status} onClick={() => onOpen(iv.id)}
                    title={`${iv.candidate?.fullName || 'Candidate'} · ${fmtWhen(iv.scheduledAt)}${ivResponseLabel(iv) ? ' · ' + ivResponseLabel(iv) : ''}`}>
                    <span className="cal-ev-time">{timeOf(iv.scheduledAt)}</span> {iv.candidate?.fullName || '—'}
                  </button>
                ))}
                {items.length > 3 && <button type="button" className="cal-more" onClick={() => onPickDay(d)}>+{items.length - 3} more</button>}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// Phones get one day at a time; this strip jumps across the working week.
function CalDayStrip({ anchor, now, ww, onPick }) {
  return (
    <div className="cal-strip" role="tablist" aria-label="Day of the week">
      {calWeekDates(calWeekStart(anchor), calWeekdays([], ww)).map((d) => (
        <button key={+d} type="button" role="tab" aria-selected={calSameDay(d, anchor)} onClick={() => onPick(d)}
          className={'cal-strip-day' + (calSameDay(d, anchor) ? ' active' : '') + (calSameDay(d, now) ? ' today' : '')}>
          <span>{d.toLocaleDateString(undefined, { weekday: 'short' })}</span><strong>{d.getDate()}</strong>
        </button>
      ))}
    </div>
  );
}

function InterviewCalendar({ view, anchor, setAnchor, setView, interviews, now, canSchedule, isPhone, ww, onOpen, onCreateAt }) {
  const pickDay = (d) => { setAnchor(d); setView('day'); };
  return (
    <>
      <div className="cal-toolbar">
        <div className="cal-nav">
          <button type="button" className="btn btn-ghost btn-sm" aria-label="Previous" onClick={() => setAnchor(calStep(view, anchor, -1, ww))}><Icon name="chevronLeft" size={16} /></button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAnchor(new Date())}>Today</button>
          <button type="button" className="btn btn-ghost btn-sm" aria-label="Next" onClick={() => setAnchor(calStep(view, anchor, 1, ww))}><Icon name="chevronRight" size={16} /></button>
        </div>
        <h2 className="cal-title">{calTitle(view, anchor)}</h2>
      </div>
      {isPhone && view === 'day' && <CalDayStrip anchor={anchor} now={now} ww={ww} onPick={setAnchor} />}
      {view === 'month'
        ? <CalMonth anchor={anchor} interviews={interviews} now={now} canSchedule={canSchedule} ww={ww} onOpen={onOpen} onCreateAt={onCreateAt} onPickDay={pickDay} />
        : <CalTimeGrid view={view} anchor={anchor} interviews={interviews} now={now} canSchedule={canSchedule}
            hourPx={isPhone ? 88 : CAL_HOUR_PX} ww={ww} onOpen={onOpen} onCreateAt={onCreateAt} />}
    </>
  );
}

function InterviewsPage({ user, initialFilters }) {
  const [loadError, setLoadError] = useState(null);
  const [data, setData] = useState(null);
  // `thisWeek` is client-side only — there is no date-range param on
  // GET /interviews, so it filters the loaded rows below, the same way
  // RequestsPage's `openOnly`/`attention` do for the same reason.
  const [filter, setFilter] = useState({ status: '', q: '', thisWeek: false, needsReminder: false });
  // `openId` jumps straight to one interview (a dashboard action item always
  // names a specific one); a plain filter narrows the list instead.
  const [selected, setSelected] = useState(initialFilters?.openId ?? null);
  useRecordUrl('interviews', selected);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createAt, setCreateAt] = useState(null); // the calendar slot that opened the form
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const loadSeq = useRef(0);
  // The calendar is the first screen; a dashboard link that carries list
  // filters still lands on the list it was built for. Phones get one day.
  const isPhone = useIsPhone();
  const [view, setView] = useState(() => (initialFilters && !initialFilters.openId ? 'list' : isPhone ? 'day' : 'week'));
  const [anchor, setAnchor] = useState(() => new Date());
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setTimeout(() => setNow(new Date()), 60000); return () => clearTimeout(t); }, [now]);
  useEffect(() => { if (isPhone && (view === 'week' || view === 'month')) setView('day'); }, [isPhone, view]);
  const canSchedule = can(user, 'interview.schedule');
  // Calendar views fetch only what they show; the key changes when the visible
  // range does, not on every click inside it.
  const rangeKey = view === 'list' ? '' : (() => { const r = calRange(view, anchor); return r.from.toISOString() + '|' + r.to.toISOString(); })();

  useEffect(() => {
    if (!initialFilters) return;
    if (initialFilters.openId) { setSelected(initialFilters.openId); return; }
    setFilter((f) => ({ ...f, ...initialFilters }));
  }, [initialFilters]);

  // Same refetch contract as RequestsPage: keep the current rows mounted, mark
  // the list busy, and let only the newest request write its result.
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setBusy(true); setLoadError(null);
    const params = new URLSearchParams();
    Object.entries(filter).forEach(([k, v]) => { if (k !== 'thisWeek' && k !== 'needsReminder' && v) params.set(k, v); });
    if (rangeKey) { const [from, to] = rangeKey.split('|'); params.set('from', from); params.set('to', to); }
    try {
      const r = await api.get('/interviews?' + params.toString());
      if (seq !== loadSeq.current) return;
      setData(r);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setLoadError(e.message);
    } finally {
      if (seq === loadSeq.current) setBusy(false);
    }
  }, [filter, rangeKey]);
  useEffect(() => { load(); }, [load]);

  if (selected) return <InterviewDetail id={selected} user={user} onBack={() => { setSelected(null); load(); }} />;

  const isCalendar = view !== 'list';
  const shown = (data ? data.interviews : []).filter((iv) => {
    if (isCalendar) return true;
    if (filter.needsReminder && !ivNeedsReminder(iv)) return false;
    if (!filter.thisWeek) return true;
    if (!ivUpcoming(iv)) return false; // a rescheduled interview is still ahead
    const days = daysUntil(iv.scheduledAt);
    return days != null && days >= 0 && days <= 7;
  });

  return (
    <div>
      <PageHead crumb="Recruitment / Interviews" title={data?.scoped ? 'My Interviews' : 'Interviews'}
        sub={data?.scoped ? 'Interviews where you are on the panel.' : 'Every interview links to a candidate, and to an application and request when scheduled from the pipeline. Interview status is tracked separately from application status.'}
        actions={<>
          {data?.scoped ? <Badge variant="info">My panel</Badge> : <Badge variant="info">All interviews</Badge>}
          <ViewToggle value={view} onChange={setView}
            options={isPhone ? [['day', 'Day'], ['list', 'List']] : [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['list', 'List']]} />
          {(can(user, 'interview.schedule') || can(user, 'interview.edit') || can(user, 'notification.manage')) && <button className="btn btn-secondary" onClick={() => setTemplatesOpen(true)}>Scheduling Setup</button>}
          {can(user, 'interview.schedule') && <button className="btn" onClick={() => setCreating(true)}>Schedule interview</button>}
        </>} />
      {(creating || createAt) && (
        <ScheduleInterviewModal user={user} initialAt={createAt}
          onClose={() => { setCreating(false); setCreateAt(null); }}
          onScheduled={(openId) => { setCreating(false); setCreateAt(null); load(); if (openId) setSelected(openId); }} />
      )}
      {templatesOpen && <InterviewTemplatesModal onClose={() => { setTemplatesOpen(false); load(); }} />}
      <FilterToolbar activeCount={(filter.status ? 1 : 0) + (!isCalendar && filter.thisWeek ? 1 : 0) + (!isCalendar && filter.needsReminder ? 1 : 0)}
        search={<input placeholder="Search interview no / type…" value={filter.q} onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))} />}
        count={<CountPill n={data ? shown.length : null} total={data ? data.interviews.length : null} noun="interview" suffix={isCalendar ? 'in view' : null} />}>
        <select value={filter.status} onChange={(e) => setFilter((f) => ({ ...f, status: e.target.value }))}>
          <option value="">All statuses</option>{Object.entries(IV_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
        {!isCalendar && (
          <label className="switch" title="Scheduled interviews in the next 7 days">
            <input type="checkbox" checked={filter.thisWeek} onChange={(e) => setFilter((f) => ({ ...f, thisWeek: e.target.checked }))} />
            This week
          </label>
        )}
        {!isCalendar && (
          <label className="switch" title="Interviews in the next 24 hours that are not confirmed, or not yet reminded">
            <input type="checkbox" checked={filter.needsReminder} onChange={(e) => setFilter((f) => ({ ...f, needsReminder: e.target.checked }))} />
            Needs a reminder{data ? ` (${data.interviews.filter((x) => ivNeedsReminder(x)).length})` : ''}
          </label>
        )}
      </FilterToolbar>
      {/* A refetch that fails keeps the rows already on screen and reports it
          above them; only a failure with nothing to fall back on takes the page. */}
      {loadError && data ? <RefetchError text={loadError} onRetry={load} /> : null}
      {isCalendar && canSchedule && data ? <Hint emoji="calendar">Click any open half hour to schedule an interview there. Past times are greyed out.</Hint> : null}
      {loadError && !data ? <LoadError text={loadError} onRetry={load} /> : !data ? <ListSkeleton rows={6} /> : isCalendar ? (
        // An empty week still draws the grid: the empty slots are how you book.
        <div className={'card flush cal-card' + (busy ? ' table-busy' : '')} aria-busy={busy}>
          <InterviewCalendar view={view} anchor={anchor} setAnchor={setAnchor} setView={setView} interviews={shown} now={now}
            canSchedule={canSchedule} isPhone={isPhone} ww={data.workingWeek} onOpen={setSelected} onCreateAt={setCreateAt} />
        </div>
      ) : shown.length === 0 ? (
        <div className="card"><Empty art="none-yet"
          title={filter.q || filter.status || filter.thisWeek ? 'No interviews match these filters' : 'No interviews scheduled'}
          text={filter.q || filter.status || filter.thisWeek
            ? 'Try clearing the search box or the filters above.'
            : 'Interviews scheduled from a candidate\u2019s application will appear here with date, panel and outcome.'} /></div>
      ) : (
        <div className={'card flush' + (busy ? ' table-busy' : '')} aria-busy={busy}><div className="table-wrap">
          <table className="table responsive-table">
            <thead><tr><th>Scheduled</th><th>Candidate</th><th>Request</th><th>Type / Mode</th><th data-priority="secondary">Interview</th><th>Status</th><th>Outcome</th><th data-priority="secondary">Application</th></tr></thead>
            <tbody>{shown.map((iv) => (
              <tr key={iv.id} className="row-link" onClick={() => setSelected(iv.id)}>
                <td data-label="Scheduled"><DateCell value={iv.scheduledAt} /></td>
                <td data-label="Candidate">
                  <div className="idcell">
                    <span className="idcell-av">{initials(iv.candidate?.fullName || '?')}</span>
                    <span className="idcell-txt">
                      <span className="cell-strong clamp-2" title={iv.candidate?.fullName || undefined}>{iv.candidate?.fullName || '—'}</span>
                      <span className="cell-sub clamp-2" title={iv.candidate?.currentPosition || undefined}>{iv.candidate?.currentPosition || '—'}</span>
                    </span>
                  </div>
                </td>
                <td data-label="Request"><span className="code-pill" title={iv.request?.ticketNo}>{shortReqCode(iv.request?.ticketNo)}</span><div className="cell-sub clamp-2" title={iv.request?.title || undefined}>{iv.request?.title || '—'}</div></td>
                <td data-label="Type / Mode"><span className="cell-strong">{ivType(iv.interviewType)}</span><div className="cell-sub">{ivMode(iv.mode)}</div></td>
                <td data-priority="secondary" data-label="Interview"><span className="cell-sub-only">{iv.interviewNo}</span><div className="cell-sub">Round {iv.round}</div></td>
                <td data-label="Status"><IvStatusBadge status={iv.status} />{ivUpcoming(iv) && <> <IvResponseBadge iv={iv} /></>}</td>
                <td data-label="Outcome">{iv.overallOutcome ? <Badge variant={(IV_OUTCOME[iv.overallOutcome] || {}).variant || 'soft'}>{(IV_OUTCOME[iv.overallOutcome] || {}).label || iv.overallOutcome}</Badge> : <span className="muted">—</span>}</td>
                <td data-priority="secondary" data-label="Application" title="Application pipeline status (tracked separately)">{iv.application?.status ? <AppStatusBadge status={iv.application.status} /> : <span className="muted">—</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div></div>
      )}
    </div>
  );
}

// An interview scheduled without a hiring request has no assessment sheet yet:
// the sheet belongs to the candidate's application on a request. This asks
// which request the interview is for, links it, then the sheet opens.
function LinkInterviewModal({ iv, user, onClose, onLinked }) {
  const toast = useToast();
  const [apps, setApps] = useState(null);
  const [requests, setRequests] = useState(null);
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const canLink = can(user, 'interview.edit');
  useEffect(() => {
    if (!canLink) return;
    api.get(`/candidates/${iv.candidate?.id}`).then((r) => {
      const live = (r.candidate?.applications || []).filter((a) => !APP_CLOSED.includes(a.status));
      setApps(live);
      const pre = iv.request ? live.find((a) => Number(a.requestId) === Number(iv.request.id)) : live[0];
      setChoice(pre ? 'app:' + pre.id : iv.request ? 'req:' + iv.request.id : '');
    }).catch(() => setApps([]));
    api.get('/requests?pageSize=100').then((r) => setRequests(r.requests || [])).catch(() => setRequests([]));
  }, []);
  async function save() {
    setBusy(true);
    try {
      const [kind, val] = choice.split(':');
      const applicationId = kind === 'app' ? Number(val) : await ensureApplication(iv.candidate.id, Number(val));
      await api.post(`/interviews/${iv.id}/link-application`, { applicationId });
      toast('Interview linked — the assessment is ready');
      onLinked();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }
  if (!canLink) {
    return (
      <Modal title="Interview assessment" onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
        <p style={{ marginTop: 0 }}>This interview is not linked to a hiring request yet, so it has no assessment sheet.</p>
        <p className="muted">Ask HR or the recruiter to open this interview and choose its hiring request; the sheet then appears here.</p>
      </Modal>
    );
  }
  const linkedReqIds = new Set((apps || []).map((a) => Number(a.requestId)));
  const openReqs = (requests || []).filter((r) => !linkedReqIds.has(Number(r.id)) && !['closed', 'cancelled', 'rejected', 'filled', 'expired'].includes(r.status));
  return (
    <Modal title="Which hiring request is this interview for?" onClose={onClose}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn" onClick={save} disabled={busy || !choice || apps === null}>{busy ? 'Linking…' : 'Link and open assessment'}</button></>}>
      <p className="muted" style={{ marginTop: 0 }}>The interview assessment is kept with {iv.candidate?.fullName || 'the candidate'}'s application to a hiring request. Choose it once; the sheet then opens from this interview.</p>
      {apps === null || requests === null ? <Skeleton rows={2} /> : (
        <div className="field">
          <label htmlFor="link-iv-choice">Hiring request</label>
          <select id="link-iv-choice" value={choice} onChange={(e) => setChoice(e.target.value)}>
            <option value="">— Select —</option>
            {apps.length > 0 && <optgroup label="Already applied">
              {apps.map((a) => <option key={'a' + a.id} value={'app:' + a.id}>{a.ticketNo || 'Request'} — {a.position || ''} ({a.applicationNo})</option>)}
            </optgroup>}
            {openReqs.length > 0 && <optgroup label="Add the candidate to">
              {openReqs.map((r) => <option key={'r' + r.id} value={'req:' + r.id}>{r.ticketNo} — {r.title}</option>)}
            </optgroup>}
          </select>
        </div>
      )}
    </Modal>
  );
}

// After an interview is Completed (audit A10): what happens next, in one place.
// The interview never moves the application by itself (owner rule); moving it
// is an explicit click here, through the same /applications/:id/move route and
// checks as the pipeline board. Reject / hold need a reason and stay on the board.
function NextStepBox({ iv, user, onAssess, onLink, onMoved }) {
  const toast = useToast();
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const app = iv.application;
  const given = (iv.feedback || []).length; const panelN = (iv.panel || []).length;
  const targets = app ? Object.keys(APP_STATUS).filter((t) => t !== app.status && !REASON_STATUSES.includes(t) && canPipelineMove(app.status, t)) : [];
  async function move() {
    if (!to || busy) return;
    setBusy(true);
    try { await api.post(`/applications/${app.id}/move`, { status: toApiStatus(to) }); toast(`Application moved to ${(APP_STATUS[to] || {}).label || to}`); setTo(''); onMoved(); }
    catch (e) { toast(moveErrorText(e), 'error'); } finally { setBusy(false); }
  }
  return (
    <section className="card card-pad iv-next-step" aria-label="Next step" style={{ marginBottom: 16 }}>
      <div className="section-title" style={{ marginTop: 0 }}>Next step</div>
      <p className="muted">Feedback: <strong>{given} of {panelN}</strong> panel member{panelN === 1 ? '' : 's'}{given < panelN ? ' — waiting for the rest' : ' — complete'}.{' '}
        {app ? <>Application: <AppStatusBadge status={app.status} /></> : 'This interview is not linked to an application yet.'}</p>
      <div className="btn-row">
        {app ? <button className="btn btn-secondary" onClick={onAssess}>Open assessment</button>
          : <button className="btn btn-secondary" onClick={onLink}>Link to application</button>}
        {app && can(user, 'candidate.move_stage') && targets.length > 0 && <>
          <select value={to} onChange={(e) => setTo(e.target.value)} aria-label="Move the application to">
            <option value="">Move the application to…</option>
            {targets.map((t) => <option key={t} value={t}>{APP_STATUS[t].label}</option>)}
          </select>
          <button className="btn" disabled={!to || busy} onClick={move}>{busy ? 'Moving…' : 'Move'}</button>
        </>}
      </div>
      {app && <p className="field-hint">Nothing moves on its own. To reject or put the candidate on hold, use the pipeline — it asks for the reason.</p>}
    </section>
  );
}

function InterviewDetail({ id, user, onBack }) {
  const toast = useToast();
  const [iv, setIv] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [fbOpen, setFbOpen] = useState(false);
  const [action, setAction] = useState(null);
  const [assessOpen, setAssessOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [reopenAsk, setReopenAsk] = useState(false);
  const [resched, setResched] = useState(false);
  const [answerBusy, setAnswerBusy] = useState(false);
  const [comm, setComm] = useState(null); // 'invite' | 'update' | 'cancel'
  const btns = useResolvedButtons();
  const load = useCallback(async () => { setLoadError(null); try { setIv((await api.get('/interviews/' + id)).interview); } catch (e) { setLoadError(e.message); } }, [id]);
  useEffect(() => { load(); }, [id]);
  if (loadError) return <LoadError text={loadError} onRetry={load} />;
  if (!iv) return <Skeleton rows={8} />;

  async function setAnswer(response) {
    if (response === (iv.candidateResponse || 'pending')) return;
    setAnswerBusy(true);
    try { await api.post(`/interviews/${id}/response`, { response }); toast('Answer saved: ' + IV_RESPONSE[response].label); await load(); }
    catch (e) { toast(e.message, 'error'); }
    finally { setAnswerBusy(false); }
  }
  async function setStatus(status, reason) {
    try {
      await api.post(`/interviews/${id}/status`, { status, reason }); toast(status === 'scheduled' ? 'Interview reopened' : 'Interview ' + status.replace('_', '-')); await load();
      // A cancellation is communicated explicitly: offer it straight away.
      if (status === 'cancelled' && canManageComms) setComm('cancel');
    }
    catch (e) { toast(e.message, 'error'); }
  }
  const canManageComms = can(user, 'interview.edit');
  const canEdit = btns.cancel_interview?.visible || btns.complete_interview?.visible;
  const canFeedback = btns.add_feedback?.visible;
  // A No-Show is the attendance record (audit A8): reopen it, don't cancel it.
  const active = !['cancelled', 'completed', 'no_show'].includes(iv.status);
  // Completed / No-Show / feedback open only once the interview has happened
  // (audit A4/A5). The server decides when; this only hides early buttons.
  const opensAt = (k) => (iv.actionsOpenAt && iv.actionsOpenAt[k] ? Date.parse(iv.actionsOpenAt[k]) : Infinity); // missing = not open (server refuses too)
  const isOpen = (k) => Date.now() >= opensAt(k);
  const upcoming = ['scheduled', 'rescheduled'].includes(iv.status);
  const firstOpen = Math.min(opensAt('completed'), opensAt('no_show'), opensAt('feedback'));
  const showWhenOpens = upcoming && !isOpen('completed') && (canFeedback || btns.complete_interview?.visible);

  return (
    <div>
      <PageHead back={<button className="back-link" onClick={onBack}><Icon name="back" size={16} />Interviews</button>}
        title={<> {ivType(iv.interviewType)} interview — {iv.candidate?.fullName}</>} sub={<> <strong>{iv.interviewNo}</strong> · <IvStatusBadge status={iv.status} /> · {fmtDate(iv.scheduledAt)}</>}
        actions={<>
          {can(user, 'candidate.view') && (iv.application || iv.status !== 'cancelled') && <button className="btn" onClick={() => (iv.application ? setAssessOpen(true) : setLinkOpen(true))}>Open assessment</button>}
          {canFeedback && (iv.status === 'completed' || (upcoming && isOpen('feedback'))) && <button className="btn btn-secondary" onClick={() => setFbOpen(true)}>{iv.myFeedback ? 'Update My Feedback' : 'Add Feedback'}</button>}
          {btns.complete_interview?.visible && upcoming && isOpen('completed') && <button className="btn btn-secondary" onClick={() => setStatus('completed')}>Mark Completed</button>}
          {btns.complete_interview?.visible && upcoming && isOpen('no_show') && <button className="btn btn-secondary" onClick={() => setStatus('no_show', 'Candidate did not attend')}>Mark No-Show</button>}
          {btns.complete_interview?.visible && ['completed', 'no_show'].includes(iv.status) && <button className="btn btn-secondary" onClick={() => setReopenAsk(true)}>Reopen interview</button>}
          {canManageComms && upcoming && Date.parse(iv.scheduledAt) > Date.now() && <button className="btn btn-secondary" onClick={() => setComm('reminder')}>Send reminder</button>}
          {can(user, 'interview.edit') && ['scheduled', 'rescheduled'].includes(iv.status) && <button className="btn btn-secondary" onClick={() => setResched(true)}>Reschedule / edit</button>}
          {btns.cancel_interview?.visible && active && <button className="btn btn-danger" onClick={() => setAction({ title: 'Cancel Interview', run: (reason) => { setAction(null); setStatus('cancelled', reason); } })}>Cancel</button>}
        </>} />



      {iv.status === 'completed' && <NextStepBox iv={iv} user={user} onAssess={() => setAssessOpen(true)} onLink={() => setLinkOpen(true)} onMoved={load} />}
      {showWhenOpens && <p className="muted" style={{ margin: '0 0 16px' }}>{Number.isFinite(firstOpen)
        ? <>Feedback opens at the start ({cairoTime(iv.actionsOpenAt.feedback)}), No-Show 15 minutes after it ({cairoTime(iv.actionsOpenAt.no_show)}) and Completed at the scheduled end ({cairoTime(iv.actionsOpenAt.completed)}), Cairo time.</>
        : <>This interview has no valid time, so it cannot be marked or given feedback. Reschedule it first.</>}</p>}
      <div className="detail-grid">
        <div className="card card-pad">
          <div className="section-title" style={{ marginTop: 0 }}>Links</div>
          <Info label="Candidate">{iv.candidate?.fullName} ({iv.candidate?.candidateNo})</Info>
          <Info label="Request">{iv.request ? <><span title={iv.request.ticketNo}>{shortReqCode(iv.request.ticketNo)}</span> — {iv.request.title}</> : <span className="muted">None — standalone</span>}</Info>
          <Info label="Application">{iv.application ? <>{iv.application.applicationNo} · <strong>pipeline:</strong> <AppStatusBadge status={iv.application.status} /></> : <span className="muted">None — standalone</span>}</Info>
          <p className="muted">The application's pipeline status is shown for context and is <strong>not</strong> changed by this interview.</p>
          <div className="section-title">Details</div>
          <Info label="Type / Mode">{ivType(iv.interviewType)} · {ivMode(iv.mode)}</Info>
          <Info label="Round">{iv.round}</Info>
          <Info label="When">{cairoLabel(iv.scheduledAt)}</Info>
          {upcoming && <Info label="Candidate's answer">{canManageComms
            ? <div className="seg-tabs resp-picker" role="radiogroup" aria-label="Candidate's answer">
                {Object.entries(IV_RESPONSE).map(([k, r]) => (
                  <button key={k} type="button" role="radio" aria-checked={(iv.candidateResponse || 'pending') === k}
                    className={'seg-tab' + ((iv.candidateResponse || 'pending') === k ? ' active' : '')}
                    disabled={answerBusy} onClick={() => setAnswer(k)}>{r.label}</button>
                ))}
              </div>
            : <IvResponseBadge iv={iv} />}
            {iv.candidateResponse === 'declined' && btns.cancel_interview?.visible && <p className="field-hint">The candidate declined. The interview stays booked until you cancel it.</p>}</Info>}
          <Info label="Duration">{iv.durationMin} min</Info>
          <Info label="Location / Link">{/^https?:\/\//i.test(iv.locationOrLink || '')
            ? <a className="btn btn-secondary btn-sm" href={iv.locationOrLink} target="_blank" rel="noopener noreferrer" title={iv.locationOrLink}>Join {iv.mode === 'video' ? 'video call' : 'link'}</a>
            : (iv.locationOrLink || '—')}</Info>
          <Info label="Organizer">{iv.organizer?.name}</Info>
          {iv.cv && <Info label="CV">{iv.cv.available
            ? <button type="button" className="btn btn-secondary btn-sm" title={iv.cv.fileName || undefined} onClick={() => openCvReview(iv.cv.candidateId)}>Open CV{iv.cv.fileName ? ` — ${iv.cv.fileName}` : ''}</button>
            : <span className="muted">No CV attached</span>}</Info>}
          {iv.overlapReason && <Info label="Panel overlap">{iv.overlapReason}</Info>}
          {iv.cancelReason && <Info label="Cancel Reason">{iv.cancelReason}</Info>}
          <div className="section-title">Panel</div>
          <div>{iv.panel.map((m) => <span key={m.id} className="chip" title={m.name + (m.isLead ? ' (lead)' : '')}>{m.name}{m.isLead ? ' (lead)' : ''}</span>)}</div>
        </div>

        <div className="card card-pad">
          <div className="row-between"><div className="section-title" style={{ marginTop: 0 }}>Feedback</div>
            {iv.overallOutcome && <Badge variant={(IV_OUTCOME[iv.overallOutcome] || {}).variant || 'soft'}>{(IV_OUTCOME[iv.overallOutcome] || {}).label}</Badge>}</div>
          {(iv.feedback || []).length === 0 ? <p className="muted">No feedback yet.</p> : iv.feedback.map((f) => (
            <div key={f.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
              <div className="row-between"><strong>{f.interviewerName}</strong>{f.recommendation && <Badge variant={['strong_yes', 'yes'].includes(f.recommendation) ? 'success' : 'critical'}>{REC_LABEL[f.recommendation]}</Badge>}</div>
              {f.overallScore != null && <div className="muted">Score: {f.overallScore}/5</div>}
              {f.comments && <div style={{ marginTop: 4 }}>{f.comments}</div>}
              <div className="muted fine-key">{fmtDate(f.submittedAt)}</div>
            </div>
          ))}
          <InterviewComms iv={iv} canManage={canManageComms} onOpen={setComm} />
          <div className="section-title">Activity</div>
          {(iv.activity || []).map((a) => <div key={a.id} style={{ fontSize: 12.5, padding: '4px 0' }}><strong style={{ textTransform: 'capitalize' }}>{a.type.replace(/_/g, ' ')}</strong>{a.note ? ' — ' + a.note : ''} <span className="muted">· {a.actor_name} · {fmtDate(a.occurred_at)}</span></div>)}
        </div>
      </div>

      {fbOpen && <FeedbackModal interviewId={id} onClose={() => setFbOpen(false)} onSaved={() => { setFbOpen(false); load(); }} />}
      {resched && <RescheduleModal iv={iv} onClose={() => setResched(false)} onSaved={async (changes) => { setResched(false); await load(); if (changes.length) setComm('update'); }} />}
      {comm && <CommunicateModal iv={iv} kind={comm} onClose={() => { setComm(null); load(); }} onDone={() => { setComm(null); load(); }} />}
      {assessOpen && <InterviewAssessmentDrawer applicationId={iv.application.id} user={user} title={`${iv.candidate?.fullName || ''} · ${iv.interviewNo}`} onClose={() => setAssessOpen(false)} />}
      {reopenAsk && <Confirm title="Reopen interview" confirmLabel="Reopen"
        message={`Move this interview back to Scheduled? It was marked ${iv.status === 'no_show' ? 'No-Show' : 'Completed'}. Feedback and the assessment are kept; the change is recorded in the audit trail.`}
        onConfirm={() => { setReopenAsk(false); setStatus('scheduled', iv.status === 'no_show' ? 'Reopened after No-Show' : 'Reopened after Completed'); }} onClose={() => setReopenAsk(false)} />}
      {linkOpen && <LinkInterviewModal iv={iv} user={user} onClose={() => setLinkOpen(false)} onLinked={async () => { setLinkOpen(false); await load(); setAssessOpen(true); }} />}
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

// The offer letter beside the form. It is the server's own letter
// (lib/offer-letter.js) — the same renderer as the issued letter — re-rendered
// as the recruiter types, with every empty variable drawn as a blank to fill.
// The frame is sandboxed with no scripts: the letter is a document, not an app.
function OfferLetterPane({ draft, offerId }) {
  const [html, setHtml] = useState('');
  const [err, setErr] = useState(null);
  const [scale, setScale] = useState(0.6);
  const wrapRef = useRef(null);
  const key = JSON.stringify(draft || {});
  useEffect(() => {
    const ctl = new AbortController();
    const t = setTimeout(() => {
      const req = offerId ? api.html(`/offers/${offerId}/preview`, { signal: ctl.signal })
        : api.html('/offers/letter-draft', { method: 'POST', body: draft, signal: ctl.signal });
      req.then((h) => { setHtml(h); setErr(null); }).catch((e) => { if (e.name !== 'AbortError') setErr(e.message); });
    }, offerId ? 0 : 350);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [key, offerId]);
  // The letter is an A4 page (≈ 820px wide with its margin); scale it to the pane.
  useEffect(() => {
    const el = wrapRef.current; if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setScale(Math.min(1, e.contentRect.width / 820)));
    ro.observe(el); return () => ro.disconnect();
  }, []);
  if (err) return <div className="offer-letter-pane"><p className="muted">{err}</p></div>;
  return (
    <div className="offer-letter-pane" ref={wrapRef} aria-label="Offer letter preview">
      <div className="offer-letter-scale" style={{ height: Math.round(2290 * scale) }}>
        <iframe title="Offer letter" sandbox="allow-same-origin allow-modals" srcDoc={html}
          style={{ width: 820, height: 2290, transform: `scale(${scale})`, transformOrigin: '0 0' }} />
      </div>
    </div>
  );
}

// One form for creating and editing an offer, with the letter beside it.
// `offer` (edit) pre-fills it; an edit sends only what changed.
const OFFER_BLANK = { titlePrefix: '', salutationName: '', positionTitle: '', currency: 'EGP', salaryComponents: {}, joiningDate: '', expiryDate: '', benefits: '', notes: '' };
function OfferFormModal({ application, offer, user, onClose, onSaved }) {
  const toast = useToast();
  const [meta, setMeta] = useState(null);
  const init = offer
    ? { ...OFFER_BLANK, titlePrefix: offer.titlePrefix || '', salutationName: offer.salutationName || '', positionTitle: offer.positionTitle || '', currency: offer.currency || 'EGP',
        salaryComponents: offer.salaryComponents || (offer.salaryOffered != null ? { basic: offer.salaryOffered } : {}),
        joiningDate: offer.joiningDate || '', expiryDate: offer.expiryDate || '', benefits: offer.benefits || '', notes: offer.notes || '' }
    : { ...OFFER_BLANK, positionTitle: application?.position || '' };
  const [f, setF] = useState(init);
  const [link, setLink] = useState(EMPTY_LINK);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const setComp = (k, v) => setF((s) => ({ ...s, salaryComponents: { ...s.salaryComponents, [k]: v } }));
  useEffect(() => { api.get('/offers/meta/form').then(setMeta).catch(() => {}); }, []);
  const comps = Object.fromEntries(Object.entries(f.salaryComponents).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, Number(v)]));
  const total = Object.values(comps).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  const termsLocked = offer && ['pending_approval', 'approved'].includes(offer.status);
  // What the letter pane renders: the form as it stands, nothing saved.
  const draft = {
    applicationId: application?.id, candidateId: link.candidate?.id,
    candidateName: link.mode === 'new' ? link.newName : (offer?.candidate?.fullName || undefined),
    requestId: link.requestId || offer?.requestId || undefined,
    titlePrefix: f.titlePrefix, salutationName: f.salutationName, positionTitle: f.positionTitle, currency: f.currency,
    salaryComponents: meta?.canEditSalary ? comps : undefined, expiryDate: f.expiryDate,
  };
  async function save() {
    setBusy(true);
    try {
      const body = { titlePrefix: f.titlePrefix || null, salutationName: f.salutationName, positionTitle: f.positionTitle, currency: f.currency,
        joiningDate: f.joiningDate || undefined, expiryDate: f.expiryDate || undefined, notes: f.notes,
        ...(meta?.canSeeSalary ? { benefits: f.benefits } : {}),
        ...(meta?.canEditSalary ? { salaryComponents: Object.keys(comps).length ? comps : null } : {}) };
      if (offer) {
        const r = await api.put('/offers/' + offer.id, body);
        toast(r.offer.status === 'pending_approval' && offer.status === 'approved' ? 'Saved — the changed terms go back to the HR Director for approval' : 'Offer saved');
        onSaved(r.offer);
      } else {
        const target = application ? { applicationId: application.id } : await resolveStandaloneLink(link);
        const r = await api.post('/offers', { ...target, ...body });
        toast('Offer created: ' + r.offer.offerNo); onSaved(r.offer);
      }
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }
  const { dialogRef, onDialogKeyDown } = useDialogFocus(onClose);
  const createBlocked = !offer && !application && (!standaloneLinkReady(link) || (!link.requestId && !f.positionTitle.trim()));
  const title = offer ? `Edit offer — ${offer.offerNo}` : application ? `Create offer — ${application.candidate?.fullName || ''}` : 'Create offer';
  return toPageLevel(
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="modal offer-compose" role="dialog" aria-modal="true" aria-label={title} tabIndex="-1" onKeyDown={onDialogKeyDown}>
        <div className="modal-head"><h3>{title}</h3><button type="button" className="icon-btn" aria-label="Close dialog" onClick={onClose}><Icon name="close" size={16} /></button></div>
        <div className="offer-compose-body">
          <div className="offer-compose-form">
            {offer ? null : application
              ? <p className="muted">Links to application <strong>{application.applicationNo}</strong>. Creating an offer moves the application to <strong>Issuing Offer</strong>.</p>
              : <><StandaloneLinkFields user={user} link={link} setLink={setLink} />
                <p className="muted">A standalone offer is not tied to a pipeline: no application moves and no seat is filled. It still needs HR Director approval before it can be sent.</p></>}
            {termsLocked && <div className="notice notice-warn">This offer is {offer.status === 'approved' ? 'approved' : 'waiting for approval'}. Changing the salary, breakdown, currency, position or joining date sends it back to the HR Director. The title, salutation, expiry and notes do not.</div>}
            <div className="section-title">Addressee</div>
            <div className="form-grid">
              <div className="field"><label>Title</label>
                <select value={f.titlePrefix} onChange={(e) => set('titlePrefix', e.target.value)}>
                  <option value="">Choose…</option>{(meta?.titlePrefixes || ['Mr.', 'Ms.', 'Mrs.', 'Eng.', 'Dr.']).map((t) => <option key={t} value={t}>{t}</option>)}
                </select></div>
              <div className="field"><label>Salutation name</label><input value={f.salutationName} onChange={(e) => set('salutationName', e.target.value)} placeholder="First name (optional)" /></div>
              <div className="field full"><label>Position{application || offer ? '' : ' *'}</label><input value={f.positionTitle} onChange={(e) => set('positionTitle', e.target.value)} /></div>
            </div>
            {meta?.canEditSalary ? <>
              <div className="section-title">Total monthly salary (net)</div>
              <div className="form-grid">
                {(meta.salaryComponents || []).map((c) => (
                  <div key={c.key} className="field"><label>{c.label}{c.key === 'basic' ? ' *' : ''}</label>
                    <input type="number" min="0" step="0.01" inputMode="decimal" value={f.salaryComponents[c.key] ?? ''} onChange={(e) => setComp(c.key, e.target.value)} /></div>
                ))}
                <div className="field"><label>Currency</label><input value={f.currency} onChange={(e) => set('currency', e.target.value)} /></div>
                <div className="field"><label>Total</label><div className="offer-total">{f.currency} {total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div></div>
              </div>
            </> : meta && <p className="muted">Salary is hidden — your role cannot set offer salary.</p>}
            <div className="section-title">Dates</div>
            <div className="form-grid">
              <div className="field"><label>Joining date</label><input type="date" value={f.joiningDate} onChange={(e) => set('joiningDate', e.target.value)} /></div>
              <div className="field"><label>Offer expiry</label><input type="date" value={f.expiryDate} onChange={(e) => set('expiryDate', e.target.value)} />
                <span className="field-hint">The letter says it is valid until this date. Left empty, it is valid for {meta?.defaultValidityDays || 5} days from the date it is sent.</span></div>
            </div>
            <div className="section-title">Internal</div>
            <div className="form-grid">
              {meta?.canSeeSalary && <div className="field full"><label>Benefits note</label><input value={f.benefits} onChange={(e) => set('benefits', e.target.value)} placeholder="Not printed on the letter" /></div>}
              <div className="field full"><label>Notes</label><textarea rows="3" value={f.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Not printed on the letter" /></div>
            </div>
          </div>
          {meta?.canSeeSalary
            ? <OfferLetterPane draft={draft} />
            : <div className="offer-letter-pane"><p className="muted">The letter preview shows the salary, which your role cannot view.</p></div>}
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn" onClick={save} disabled={busy || createBlocked}>{busy ? 'Saving…' : offer ? 'Save changes' : 'Create offer'}</button>
        </div>
      </div>
    </div>
  );
}
// Kept as the name other screens import.
function CreateOfferModal({ application, user, onClose, onCreated }) {
  return <OfferFormModal application={application} user={user} onClose={onClose} onSaved={() => onCreated()} />;
}

// The saved offer's letter, exactly as it will be (or was) issued.
function OfferLetterModal({ offer, onClose }) {
  const frameHost = useRef(null);
  const { dialogRef, onDialogKeyDown } = useDialogFocus(onClose);
  function print() { const fr = frameHost.current?.querySelector('iframe'); try { fr?.contentWindow?.print(); } catch { /* the browser's own print still works */ } }
  return toPageLevel(
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="modal offer-letter-modal" role="dialog" aria-modal="true" aria-label={'Offer letter ' + offer.offerNo} tabIndex="-1" onKeyDown={onDialogKeyDown}>
        <div className="modal-head"><h3>Offer letter — {offer.offerNo}</h3><button type="button" className="icon-btn" aria-label="Close dialog" onClick={onClose}><Icon name="close" size={16} /></button></div>
        <div className="modal-body" ref={frameHost}><OfferLetterPane offerId={offer.id} /></div>
        <div className="modal-foot"><button className="btn btn-ghost" onClick={onClose}>Close</button><button className="btn btn-secondary" onClick={print}>Print / save as PDF</button></div>
      </div>
    </div>
  );
}

function OffersPage({ user, initialFilters }) {
  const [loadError, setLoadError] = useState(null);
  const [offers, setOffers] = useState(null);
  // `toIssue` is client-side — the API's `status` filter is a single exact
  // value, and "to issue" (draft + approved, not yet sent) spans two of them.
  const [filter, setFilter] = useState({ status: '', q: '', joiningFrom: '', joiningTo: '', toIssue: false });
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const loadSeq = useRef(0);
  useRecordUrl('offers', selected);
  // Opened from a record link (`#offers/<id>`): pending id on a fresh mount,
  // event when the page is already on screen — same as requests and candidates.
  useEffect(() => {
    if (window.__atsPendingOfferId) { setSelected(window.__atsPendingOfferId); window.__atsPendingOfferId = null; }
    function onOpen(e) { if (e.detail && e.detail.id) setSelected(e.detail.id); }
    window.addEventListener('ats:open-offer', onOpen);
    return () => window.removeEventListener('ats:open-offer', onOpen);
  }, []);

  useEffect(() => {
    if (!initialFilters) return;
    setFilter((f) => ({ ...f, ...initialFilters }));
  }, [initialFilters]);

  // Same refetch contract as RequestsPage. The shape check stays — an offers
  // payload that is not an array is a real failure, not an empty list.
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setBusy(true); setLoadError(null);
    const params = new URLSearchParams();
    Object.entries(filter).forEach(([k, v]) => { if (k !== 'toIssue' && v) params.set(k, v); });
    try {
      const result = await api.get('/offers?' + params.toString());
      if (!Array.isArray(result?.offers)) throw new Error('Offers are temporarily unavailable. Please retry.');
      if (seq !== loadSeq.current) return;
      setOffers(result.offers);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setLoadError(e.message || 'Could not load offers. Please retry.');
    } finally {
      if (seq === loadSeq.current) setBusy(false);
    }
  }, [filter]);
  useEffect(() => { load(); }, [load]);

  if (selected) return <OfferDetail id={selected} user={user} onBack={() => { setSelected(null); load(); }} />;

  const shown = (offers || []).filter((o) => !filter.toIssue || o.status === 'draft' || o.status === 'approved');

  return (
    <div>
      <PageHead crumb="Recruitment / Offers" title="Offers"
        sub="Offer preparation, approval, result tracking and joining date. Compensation is not shown in this list."
        actions={can(user, 'offer.create') ? <button className="btn" onClick={() => setCreating(true)}>Create offer</button> : null} />
      {creating && <CreateOfferModal user={user} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); load(); }} />}
      <FilterToolbar activeCount={(filter.status ? 1 : 0) + (filter.toIssue ? 1 : 0) + (filter.joiningFrom ? 1 : 0)}
        search={<input placeholder="Search offer no / position…" value={filter.q} onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))} />}
        count={<CountPill n={offers ? shown.length : null} total={offers ? offers.length : null} noun="offer" />}>
        <select value={filter.status} onChange={(e) => setFilter((f) => ({ ...f, status: e.target.value }))}>
          <option value="">All statuses</option>{Object.entries(OFFER_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
        <label className="switch" title="Approved and waiting to go out — not held for approval">
          <input type="checkbox" checked={filter.toIssue} onChange={(e) => setFilter((f) => ({ ...f, toIssue: e.target.checked }))} />
          To issue
        </label>
        <label className="muted" style={{ fontSize: 12 }}>Joining from <input type="date" value={filter.joiningFrom} onChange={(e) => setFilter((f) => ({ ...f, joiningFrom: e.target.value }))} /></label>
      </FilterToolbar>
      {loadError && offers ? <RefetchError text={loadError} onRetry={load} /> : null}
      {loadError && !offers ? <LoadError text={loadError} onRetry={load} /> : !offers ? <ListSkeleton rows={5} /> : shown.length === 0 ? (
        <div className="card"><Empty art="none-yet"
          title={filter.q || filter.status || filter.joiningFrom || filter.toIssue ? 'No offers match these filters' : 'No offers raised yet'}
          text={filter.q || filter.status || filter.joiningFrom || filter.toIssue
            ? 'Try clearing the search box, status filter or joining-date range.'
            : 'Offers raised from a candidate\u2019s application will appear here with approval state and joining date.'} /></div>
      ) : (
        <div className={'card flush' + (busy ? ' table-busy' : '')} aria-busy={busy}><div className="table-wrap">
          <table className="table responsive-table">
            <thead><tr><th>Offer</th><th>Candidate</th><th>Request</th><th>Position</th><th data-priority="secondary">Project</th><th>Status</th><th data-priority="secondary">Prepared by</th><th data-priority="secondary">Approved by</th><th>Joining</th></tr></thead>
            <tbody>{shown.map((o) => (
              <tr key={o.id} className="row-link" onClick={() => setSelected(o.id)}>
                <td data-label="Offer"><span className="code-pill">{o.offerNo}</span></td>
                <td data-label="Candidate">
                  <div className="idcell">
                    <span className="idcell-av">{initials(o.candidate?.fullName || '?')}</span>
                    <span className="idcell-txt"><span className="cell-strong clamp-2" title={o.candidate?.fullName || undefined}>{o.candidate?.fullName || '—'}</span></span>
                  </div>
                </td>
                <td data-label="Request">{o.request
                  ? <span className="code-pill" title={o.request.ticketNo}>{shortReqCode(o.request.ticketNo)}</span>
                  : <span className="muted" title="Created without a hiring request">—</span>}</td>
                <td data-label="Position"><span className="cell-strong clamp-2" title={o.positionTitle || undefined}>{o.positionTitle || '—'}</span></td>
                <td data-priority="secondary" data-label="Project" className="cell-sub-only"><span className="clamp-2" title={o.project?.name || undefined}>{o.project?.name || '—'}</span></td>
                <td data-label="Status"><OfferStatusBadge status={o.status} /></td>
                <td data-priority="secondary" data-label="Prepared by" className="cell-sub-only">{o.preparedBy?.name || '—'}</td>
                <td data-priority="secondary" data-label="Approved by" className="cell-sub-only">{o.approvedBy?.name || '—'}</td>
                <td data-label="Joining"><DateCell value={o.joiningDate} dateOnly />
                  {/* An offer still open for an answer shows how long it has (review O4). */}
                  {o.expiryDate && ['draft', 'pending_approval', 'approved', 'sent'].includes(o.status) && (() => {
                    const d = daysUntil(o.expiryDate + 'T23:59:59');
                    if (d == null) return null;
                    const n = Math.ceil(d);
                    return <div className={'cell-sub' + (n <= 3 ? ' text-warn' : '')}>{n < 0 ? 'Expired' : n === 0 ? 'Expires today' : `Expires in ${n} day${n === 1 ? '' : 's'}`}</div>;
                  })()}</td>
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
  const [loadError, setLoadError] = useState(null);
  const [action, setAction] = useState(null);
  const [editing, setEditing] = useState(false);
  const [letter, setLetter] = useState(false);
  const btns = useResolvedButtons();
  const load = useCallback(async () => { setLoadError(null); try { setO((await api.get('/offers/' + id)).offer); } catch (e) { setLoadError(e.message); } }, [id]);
  useEffect(() => { load(); }, [id]);
  if (loadError) return <LoadError text={loadError} onRetry={load} />;
  if (!o) return <Skeleton rows={8} />;

  async function act(path, body, okMsg) {
    try {
      const r = await api.post(`/offers/${id}/${path}`, body || {}); setO(r.offer);
      // Issuing and delivery are separate facts: say what is known, no more.
      if (r.delivery) toast(r.delivery.state === 'queued' ? `${okMsg}. Email queued to ${r.delivery.to}.` : `${okMsg}. No email was sent: ${r.delivery.message}`, r.delivery.state === 'queued' ? undefined : 'warn');
      else toast(okMsg);
    }
    catch (e) { toast(e.message, 'error'); }
  }
  const editable = can(user, 'offer.edit') && ['draft', 'pending_approval', 'approved'].includes(o.status);
  const s = o.status;
  // One approval layer: the HR Director. The approve/reject controls are shown
  // only to a user who actually holds the director permission the server
  // checks, so nobody is offered a button that would come back as 403.
  const isDirector = can(user, 'offer.approve_director');
  const step = (o.approvals || [])[0];
  const approval = s === 'pending_approval'
    ? (isDirector ? 'Waiting on your approval.' : 'Waiting on HR Director approval.')
    : s === 'rejected_by_approver' ? `Rejected by the HR Director${step?.comment ? ': ' + step.comment : ''}`
      : o.approvedBy ? `Approved by ${o.approvedBy.name}${step?.decided_at ? ' · ' + fmtDate(step.decided_at) : ''}`
        : s === 'draft' ? 'Not yet submitted. The HR Director approves every offer before it is sent.' : null;
  return (
    <div>
      <PageHead back={<button className="back-link" onClick={onBack}><Icon name="back" size={16} />Offers</button>}
        title={<> Offer — {o.candidate?.fullName}</>} sub={<> <strong>{o.offerNo}</strong> · <OfferStatusBadge status={o.status} /> · <span title={o.request?.ticketNo}>{shortReqCode(o.request?.ticketNo)}</span></>}
        actions={<>
          {o.salaryVisible && <button className="btn btn-secondary" onClick={() => setLetter(true)}>Preview letter</button>}
          {editable && <button className="btn btn-secondary" onClick={() => setEditing(true)}>Edit</button>}
          {btns.submit_offer?.visible && s === 'draft' && <button className="btn" onClick={() => act('submit', {}, 'Sent to the HR Director for approval')}>Submit for approval</button>}
          {btns.approve_offer?.visible && isDirector && s === 'pending_approval' && <button className="btn" onClick={() => act('approve', {}, 'Offer approved')}>Approve</button>}
          {btns.reject_offer_approval?.visible && isDirector && s === 'pending_approval' && <button className="btn btn-danger" onClick={() => setAction({ title: 'Reject Offer', path: 'reject-approval', body: (r) => ({ reason: r }), msg: 'Offer rejected' })}>Reject</button>}
          {btns.send_offer?.visible && s === 'approved' && <button className="btn" onClick={() => act('send', {}, 'Offer issued')}>Send Offer</button>}
          {btns.accept_offer?.visible && s === 'sent' && <button className="btn" onClick={() => act('result', { result: 'accepted' }, 'Marked accepted')}>Mark Accepted</button>}
          {btns.reject_offer_candidate?.visible && ['sent', 'accepted'].includes(s) && <button className="btn btn-danger" onClick={() => setAction({ title: 'Mark Rejected by Candidate', path: 'result', body: (r) => ({ result: 'rejected_by_candidate', reason: r }), msg: 'Marked rejected by candidate' })}>Rejected by Candidate</button>}
          {btns.withdraw_offer?.visible && !['joined', 'withdrawn', 'rejected_by_candidate'].includes(s) && <button className="btn btn-danger" onClick={() => setAction({ title: 'Withdraw Offer', path: 'result', body: (r) => ({ result: 'withdrawn', reason: r }), msg: 'Offer withdrawn' })}>Withdraw</button>}
          {btns.mark_joined?.visible && s === 'accepted' && <button className="btn" onClick={() => act('result', { result: 'joined' }, 'Marked joined')}>Mark Joined</button>}
        </>} />



      <div className="detail-grid">
        <div className="card card-pad">
          <div className="section-title" style={{ marginTop: 0 }}>Offer</div>
          <Info label="Candidate">{o.candidate?.fullName} ({o.candidate?.candidateNo})</Info>
          <Info label="Request">{o.request ? <><span title={o.request.ticketNo}>{shortReqCode(o.request.ticketNo)}</span> — {o.request.title}</> : <span className="muted">None — standalone</span>}</Info>
          <Info label="Application">{o.application ? <>{o.application.applicationNo} · <strong>pipeline:</strong> <AppStatusBadge status={o.application.status} /></> : <span className="muted">None — standalone</span>}</Info>
          <Info label="Position">{o.positionTitle}</Info>
          <Info label="Project">{o.project?.name}</Info>
          {o.titlePrefix && <Info label="Addressed as">{o.titlePrefix} {o.candidate?.fullName}</Info>}
          {o.salaryVisible
            ? <Info label="Total monthly salary (net)">{o.salaryOffered != null ? `${o.currency} ${Number(o.salaryOffered).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '—'}</Info>
            : <Info label="Salary Offered"><span className="muted">Restricted</span></Info>}
          {o.salaryVisible && o.salaryComponents && <Info label="Breakdown">{Object.entries(o.salaryComponents).map(([k, v]) => `${({ basic: 'Basic', accommodation: 'Accommodation', transportation: 'Transportation', others: 'Others', area_allowance: 'Area allowance' })[k] || k} ${Number(v).toLocaleString('en-US')}`).join(' · ')}</Info>}
          {o.salaryVisible && o.benefits && <Info label="Benefits note">{o.benefits}</Info>}
          <Info label="Joining Date">{fmtDateShort(o.joiningDate)}</Info>
          {o.expiryDate && <Info label="Offer expiry">{fmtDateShort(o.expiryDate)}</Info>}
          <Info label="Prepared By">{o.preparedBy?.name}</Info>
          {approval && <Info label="Approval">{approval}</Info>}
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
      {editing && <OfferFormModal offer={o} user={user} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load(); }} />}
      {letter && <OfferLetterModal offer={o} onClose={() => setLetter(false)} />}
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
    if (this.props.page) return <LoadError title="This screen ran into a problem" text={msg} onRetry={() => this.setState({ err: null })} />;

    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, fontFamily: 'Arial, Helvetica, sans-serif', color: 'var(--ink, #1A1A1A)' }} role="alert">
        <div style={{ maxWidth: 460, textAlign: 'center' }}>
          <h2 style={{ margin: '0 0 8px' }}>Something went wrong</h2>
          <p style={{ margin: '0 0 16px', color: 'var(--muted, #6F6A64)' }}>The page hit an unexpected error. Reloading usually clears it. If it keeps happening, tell your administrator.</p>
          <button className="btn" onClick={() => window.location.reload()}>Reload the app</button>
          <details style={{ marginTop: 16, textAlign: 'left' }}><summary style={{ fontSize: 12, cursor: 'pointer', color: 'var(--muted, #6F6A64)' }}>Technical detail</summary>
            <pre className="fine-key" style={{ whiteSpace: 'pre-wrap', marginTop: 8, color: 'var(--muted, #6F6A64)' }}>{msg}</pre></details>
        </div>
      </div>
    );
  }
}

/* ----------------------------- Root App ----------------------------- */
class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error, info) { console.error('ui.render_failed', error, info); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="fatal-state" id="main-content" role="alert">
        <div className="card card-pad fatal-state-card">
          <div className="fatal-state-mark" aria-hidden="true">!</div>
          <p className="eyebrow">Interface recovery</p>
          <h1>We could not display this page.</h1>
          <p className="muted">Your recruitment data is safe. Reload the interface, or sign out and start a fresh session.</p>
          <div className="fatal-state-actions">
            <button className="btn" onClick={() => window.location.reload()}>Reload interface</button>
            <button className="btn btn-ghost" onClick={this.props.onSignOut}>Sign out</button>
          </div>
        </div>
      </main>
    );
  }
}

function App() {
  const [booting, setBooting] = useState(true);
  const [user, setUser] = useState(null);
  const [branding, setBranding] = useState(null);
  const locationHash = useLocationHash();
  const fullPage = parseFullPageHash(locationHash);

  const loadBranding = useCallback(async () => {
    try { const { branding } = await api.get('/settings/branding'); const ver = branding.logo_uploaded_at ? new Date(branding.logo_uploaded_at).getTime() : Date.now(); setHasCustomLogo(!!branding.logo_stored_name, ver); setBranding(branding); applyBranding(branding); return branding; }
    catch { return null; }
  }, []);

  useEffect(() => {
    (async () => {
      await loadBranding();
      if (api.token) { try { const { user } = await api.get('/auth/me'); setUser(user); } catch { api.setToken(null); } }
      // The owner's knowledge lines ride on the public system settings; a
      // failure keeps the bundled list.
      if (api.token) api.get('/settings/system').then((r) => applyOwnKnowledgeLines(r.settings?.knowledge_lines)).catch(() => {});
      setBooting(false);
    })();
  }, []);

  async function onLogin(u) { setUser(u); api.get('/settings/system').then((r) => applyOwnKnowledgeLines(r.settings?.knowledge_lines)).catch(() => {}); await loadBranding(); }
  async function onLogout() { try { await api.post('/auth/logout', {}); } catch {} api.setToken(null); setUser(null); }

  if (booting) return <div className="boot-loading">Loading Arabtec Recruitment Hub…</div>;
  if (!user) return <Login branding={branding} onLogin={onLogin} />;
  // `#cv/<id>` / `#document?…`: the CV alone, in this tab, after the same
  // sign-in and password gates as the rest of the app (25 Oct 2026).
  if (fullPage && !user.mustChangePassword) return <ToastProvider><CvFullPage user={user} target={fullPage} /></ToastProvider>;
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
      <AppErrorBoundary key={user.id} onSignOut={onLogout}>
        <Shell user={user} branding={branding} onLogout={onLogout} refreshBranding={loadBranding} />
      </AppErrorBoundary>
    </AppCtx.Provider>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <ErrorBoundary label="root">
    <ToastProvider><App /></ToastProvider>
  </ErrorBoundary>
);
