// Exercise the real read-only verification script without accessing a host.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../deploy/on-prem/06-verify.sh', import.meta.url));
function verify(t, ready) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ats-readiness-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = path.join(dir, 'fixture.sh');
  writeFileSync(fixture, `
sudo() {
  case "$*" in
    *grep*) echo 4001 ;;
    *rev-parse*) echo disposable-commit ;;
    *psql*) echo f ;;
    *) return 0 ;;
  esac
}
cat() { echo disposable-commit; }
stat() { echo 750; }
systemctl() { return 0; }
curl() {
  case "$*" in
    */api/health/ready) [ "$FIXTURE_READY" = true ] ;;
    */api/health/watcher|*/api/health/parsing) return 22 ;;
    */arabtec-design-system.css) echo 'design system' ;;
    */app.jsx) echo 'function App' ;;
    *) echo '{"ok":true}' ;;
  esac
}
`);
  return spawnSync('bash', [script], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, BASH_ENV: fixture, FIXTURE_READY: String(ready) },
  });
}

test('post-deploy verification fails when liveness is healthy but initialization is not ready', t => {
  const result = verify(t, false);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /VERIFY FAILED/);
});

test('post-deploy verification passes ready service without misreporting protected diagnostics', t => {
  const result = verify(t, true);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /unreachable/);
  assert.match(result.stdout, /authenticated/i);
});
