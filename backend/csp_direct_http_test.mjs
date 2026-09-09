// The on-prem install is served over plain HTTP on the LAN (http://10.20.0.9:4001).
//
// `upgrade-insecure-requests` is honoured by browsers over http, not just https:
// with it set, every asset the SPA requests is rewritten to https://10.20.0.9:4001,
// which answers nothing — the app loads as a blank page for every user. That is
// why the header was hand-edited on the production box in September 2026, which
// in turn meant the next `git checkout` of main would have silently reverted it.
// This suite is the reason the deployment no longer needs a local patch.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND = path.dirname(fileURLToPath(import.meta.url));

// The CSP string is built once at module load, so each case needs its own
// process — reading the env at call time inside one process would not prove
// what the deployed server actually sends.
function probe(env) {
  const child = spawnSync(process.execPath, ['-e', `
    import('./src/lib/security-headers.js').then((m) => {
      const headers = {};
      const res = { setHeader: (k, v) => { headers[k] = v; }, removeHeader() {} };
      m.securityHeaders({}, res, () => {});
      process.stdout.write(JSON.stringify({ headers, summary: m.securityConfigSummary() }));
    });
  `], {
    cwd: BACKEND,
    env: { ...process.env, NODE_ENV: 'production', DIRECT_HTTP: '', CSP_REPORT_ONLY: '', ...env },
    encoding: 'utf8',
    timeout: 30000,
  });
  return JSON.parse(child.stdout || '{}');
}

test('a TLS-terminated production deployment still upgrades sub-resources', () => {
  const { headers, summary } = probe({});
  assert.match(headers['Content-Security-Policy'], /upgrade-insecure-requests/);
  assert.equal(summary.directHttp, false);
});

test('DIRECT_HTTP drops the upgrade directive that would blank the plain-HTTP install', () => {
  const { headers, summary } = probe({ DIRECT_HTTP: 'true' });
  assert.doesNotMatch(headers['Content-Security-Policy'], /upgrade-insecure-requests/);
  assert.equal(summary.directHttp, true);
  // Everything else about production hardening is unchanged. HSTS is kept
  // deliberately: browsers ignore it over http, so it costs nothing here and is
  // correct the moment TLS is put in front.
  assert.match(headers['Strict-Transport-Security'], /max-age=\d+; includeSubDomains/);
  assert.equal(headers['X-Frame-Options'], 'DENY');
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.match(headers['Content-Security-Policy'], /frame-ancestors 'none'/);
});

test('the opt-out is explicit — only the exact string turns it off', () => {
  for (const value of ['1', 'yes', 'TRUE', 'false']) {
    assert.match(probe({ DIRECT_HTTP: value }).headers['Content-Security-Policy'],
      /upgrade-insecure-requests/, `DIRECT_HTTP=${value} must not disable it`);
  }
});

test('development is unaffected', () => {
  const { headers } = probe({ NODE_ENV: 'development' });
  assert.doesNotMatch(headers['Content-Security-Policy'], /upgrade-insecure-requests/);
  assert.equal(headers['Strict-Transport-Security'], undefined);
});
