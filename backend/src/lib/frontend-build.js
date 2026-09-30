// Compiles the single-page app's JSX once, on the server, and serves plain
// JavaScript to every browser.
//
// Until now each browser downloaded the in-browser Babel compiler (~3 MB) and
// compiled >500 KB of JSX on every page load, which made the first screen slow
// (~6 s measured) and forced the Content Security Policy to allow
// 'unsafe-eval'. The same vendored compiler now runs here instead, once per
// file change: the browser receives ready-to-run code (~0.4 s to first
// screen), never loads Babel, and the policy drops 'unsafe-eval'.
//
// Output is modern JavaScript (the React preset only — no down-levelling to
// ES5), run in strict mode as before. Every browser the product supports runs
// it natively. Results are cached per file and rebuilt when the file changes.
//
// Compiling takes ~3 s of CPU. At start-up it runs on a worker thread, so the
// server keeps answering requests (logins, health checks) meanwhile; a request
// for a file that is still compiling waits for the worker rather than
// compiling it a second time.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { withOrgStructurePage } from './org-structure-app-patch.js';

// Served name → source file, in the order index.html loads them.
export const FRONTEND_SOURCES = {
  'intake-review.js': 'intake-review.jsx',
  'cv-intake.js': 'cv-intake.jsx',
  'email-settings.js': 'email-settings.jsx',
  'org-structure.js': 'org-structure.jsx',
  'app.js': 'app.jsx',
};
// app.jsx gets the Organization Structure page inserted before it is compiled,
// exactly as the /app.jsx route has always served it.
const TRANSFORMS = { 'app.js': withOrgStructurePage };

let babel = null;
function compiler(frontendDir) {
  if (babel) return babel;
  const ctx = vm.createContext({ window: {}, console });
  ctx.self = ctx;
  vm.runInContext(fs.readFileSync(path.join(frontendDir, 'vendor/babel.min.js'), 'utf8'), ctx, { filename: 'babel.min.js' });
  babel = ctx.Babel;
  return babel;
}

function stampOf(frontendDir, name) {
  const st = fs.statSync(path.join(frontendDir, FRONTEND_SOURCES[name]));
  return `${st.mtimeMs}:${st.size}`;
}

function compileOne(frontendDir, name) {
  const file = FRONTEND_SOURCES[name];
  const stamp = stampOf(frontendDir, name);
  const transform = TRANSFORMS[name] || ((s) => s);
  const source = transform(fs.readFileSync(path.join(frontendDir, file), 'utf8'));
  const out = compiler(frontendDir).transform(source, {
    filename: file, presets: ['react'], compact: false, comments: false, sourceMaps: false,
  }).code;
  // Strict mode, exactly as the in-browser compiler ran these files.
  const code = `"use strict";\n${out}\n`;
  const etag = '"' + crypto.createHash('sha1').update(code).digest('hex').slice(0, 20) + '"';
  return { name, stamp, code, etag };
}

// ---- worker side ----------------------------------------------------------
if (!isMainThread && workerData && workerData.frontendBuild) {
  for (const name of Object.keys(FRONTEND_SOURCES)) {
    try { parentPort.postMessage({ ok: true, entry: compileOne(workerData.frontendDir, name) }); }
    catch (e) { parentPort.postMessage({ ok: false, name, error: String(e && e.message || e) }); }
  }
}

// ---- main-thread side -----------------------------------------------------
const cache = new Map(); // served name -> { stamp, code, etag }
let warming = null;      // Promise while the start-up worker runs

/** Compile every file on a worker thread; resolves with the elapsed ms. */
export function warmFrontend(frontendDir) {
  if (warming) return warming;
  const t0 = Date.now();
  warming = new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { frontendBuild: true, frontendDir } });
    w.unref(); // never keep the process alive for the warm-up alone
    const errors = [];
    w.on('message', (m) => { if (m.ok) cache.set(m.entry.name, m.entry); else errors.push(`${m.name}: ${m.error}`); });
    w.on('error', reject);
    w.on('exit', () => (errors.length ? reject(new Error(errors.join('; '))) : resolve(Date.now() - t0)));
  }).finally(() => { warming = null; });
  return warming;
}

/**
 * The compiled JavaScript for one served file ({ code, etag }), or null for an
 * unknown name. Rebuilt when the source changes; waits for the start-up worker
 * instead of compiling the same file twice.
 */
export async function compiledFrontend(frontendDir, name) {
  if (!FRONTEND_SOURCES[name]) return null;
  const stamp = stampOf(frontendDir, name);
  let hit = cache.get(name);
  if (hit && hit.stamp === stamp) return hit;
  if (warming) {
    try { await warming; } catch { /* fall through to compiling here */ }
    hit = cache.get(name);
    if (hit && hit.stamp === stamp) return hit;
  }
  const entry = compileOne(frontendDir, name);
  cache.set(name, entry);
  return entry;
}
