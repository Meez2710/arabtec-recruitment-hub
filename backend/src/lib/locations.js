// Hiring locations (recruitment team request, 25 Oct 2026).
//
// A hiring request is FOR somewhere: the Head Office, or one of the company's
// sites. In the data model every one of those is a `project` row — the API has
// always required `projectId` on a request and every report, filter and seat
// hangs off it — so this module does not add a second table. It adds meaning:
//
//   • one project row IS the Head Office (code HEAD-OFFICE, created on demand);
//   • every other active project is a "site" the form can be for;
//   • a site's `location` column holds the AREA it is in ("Cairo Area",
//     "North Coast Area", …), and the list of areas lives in system settings
//     so the recruitment team can add or rename one without a release.
//
// Nothing here needs org.manage: the recruitment team keeps this list current
// under its own permission (location.manage).
import { Projects, SystemSettings } from './models.js';

export const HEAD_OFFICE_CODE = 'HEAD-OFFICE';
export const HEAD_OFFICE_NAME = 'Head Office';
export const AREAS_SETTING = 'location_areas';
export const DEFAULT_AREAS = ['Cairo Area', 'North Coast Area'];

// What the 17 production projects carried in `location` before areas existed.
// Normalised once, in place, the first time the list is read; anything else is
// left exactly as typed.
const LEGACY_AREA = {
  cairo: 'Cairo Area', 'new cairo': 'Cairo Area', giza: 'Cairo Area',
  'ras el hikma': 'North Coast Area', 'ras el hekma': 'North Coast Area', 'north coast': 'North Coast Area',
};
const norm = (s) => String(s || '').trim().toLowerCase();
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

export const isHeadOffice = (p) => !!p && p.code === HEAD_OFFICE_CODE;

export function areas() {
  try {
    const raw = SystemSettings.get(AREAS_SETTING);
    if (raw) { const list = JSON.parse(raw); if (Array.isArray(list) && list.length) return list.map(clean).filter(Boolean); }
  } catch { /* fall through to the defaults */ }
  return [...DEFAULT_AREAS];
}
export function setAreas(list) {
  const out = [];
  for (const a of Array.isArray(list) ? list : []) { const v = clean(a); if (v && !out.some((x) => norm(x) === norm(v))) out.push(v); }
  if (!out.length) throw Object.assign(new Error('At least one area is required.'), { status: 400 });
  SystemSettings.upsert(AREAS_SETTING, JSON.stringify(out));
  return out;
}

/** The Head Office project row, created the first time anything asks for it. */
export function ensureHeadOffice() {
  let p = Projects.byCode(HEAD_OFFICE_CODE);
  if (!p) p = Projects.create({ code: HEAD_OFFICE_CODE, name: HEAD_OFFICE_NAME, location: areas()[0] || DEFAULT_AREAS[0], status: 'active' });
  return p;
}

/** One-time, idempotent: 'Cairo' → 'Cairo Area', 'Ras El Hikma' → 'North Coast Area'. */
export function normaliseLegacyAreas() {
  let changed = 0;
  for (const p of Projects.all()) {
    const mapped = LEGACY_AREA[norm(p.location)];
    if (mapped && p.location !== mapped) { Projects.update(p.id, { location: mapped }); changed += 1; }
  }
  return changed;
}

/** The area a project is in, as the form shows it. */
export const areaOf = (p) => (p && p.location ? clean(p.location) : null);

/** "Head Office", or "Soul · Cairo Area" — the one way a request's place is printed. */
export function locationLabel(project, requestLocation) {
  if (!project) return requestLocation || null;
  if (isHeadOffice(project)) return HEAD_OFFICE_NAME;
  const area = requestLocation || areaOf(project);
  return area && norm(area) !== norm(project.name) ? `${project.name} · ${area}` : project.name;
}
/** What `recruitment_request.location` should hold for a project when the form left it blank. */
export const autoLocation = (project) => (isHeadOffice(project) ? HEAD_OFFICE_NAME : areaOf(project));

function siteOut(p) {
  return { id: p.id, code: p.code, name: p.name, area: areaOf(p), status: p.status, isHeadOffice: isHeadOffice(p) };
}

/** Everything the Locations page and the request form need, in one read. */
export function locationsPayload() {
  normaliseLegacyAreas();
  const ho = ensureHeadOffice();
  const sites = Projects.all().filter((p) => !isHeadOffice(p)).map(siteOut)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return { areas: areas(), headOffice: siteOut(ho), sites };
}

function codeFor(name) {
  const base = 'PRJ-' + clean(name).toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 12);
  let code = base || 'PRJ-SITE', n = 2;
  while (Projects.byCode(code)) code = `${base}${n++}`;
  return code;
}
export function createSite({ name, area }) {
  const n = clean(name);
  if (!n) throw Object.assign(new Error('A site name is required.'), { status: 400 });
  if (norm(n) === norm(HEAD_OFFICE_NAME)) throw Object.assign(new Error('Head Office already exists.'), { status: 409 });
  if (Projects.all().some((p) => norm(p.name) === norm(n))) throw Object.assign(new Error('A site with this name already exists.'), { status: 409 });
  const a = clean(area);
  if (!a) throw Object.assign(new Error('Choose the area this site is in.'), { status: 400 });
  return siteOut(Projects.create({ code: codeFor(n), name: n, location: a, status: 'active' }));
}
const SITE_STATUSES = ['active', 'on_hold', 'closed'];
export function updateSite(id, { name, area, status } = {}) {
  const p = Projects.byId(Number(id));
  if (!p) throw Object.assign(new Error('Site not found.'), { status: 404 });
  const patch = {};
  if (name !== undefined) {
    const n = clean(name);
    if (!n) throw Object.assign(new Error('A site name is required.'), { status: 400 });
    if (isHeadOffice(p) && norm(n) !== norm(HEAD_OFFICE_NAME)) throw Object.assign(new Error('The Head Office cannot be renamed.'), { status: 400 });
    if (Projects.all().some((q) => q.id !== p.id && norm(q.name) === norm(n))) throw Object.assign(new Error('A site with this name already exists.'), { status: 409 });
    patch.name = n;
  }
  if (area !== undefined) { const a = clean(area); if (!a) throw Object.assign(new Error('Choose the area.'), { status: 400 }); patch.location = a; }
  if (status !== undefined) {
    if (!SITE_STATUSES.includes(status)) throw Object.assign(new Error(`Status must be one of: ${SITE_STATUSES.join(', ')}.`), { status: 400 });
    if (isHeadOffice(p) && status !== 'active') throw Object.assign(new Error('The Head Office is always available.'), { status: 400 });
    patch.status = status;
  }
  return siteOut(Projects.update(p.id, patch));
}
