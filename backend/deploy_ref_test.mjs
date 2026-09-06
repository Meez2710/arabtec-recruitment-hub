// Runs the actual deployment script against disposable local Git repositories.
// Only sudo and npm are replaced; Git ref resolution and checkout stay real.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const source = readFileSync(new URL('../deploy/on-prem/04-app.sh', import.meta.url), 'utf8');
function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...options });
  assert.equal(result.status, 0, `${cmd} ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'ats-deploy-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = path.join(root, 'upstream');
  const checkout = path.join(root, 'checkout');
  mkdirSync(upstream);
  const git = (...args) => run('git', ['-C', checkout, ...args]);
  const upstreamGit = (...args) => run('git', ['-C', upstream, ...args]);
  upstreamGit('init', '-b', 'main');
  upstreamGit('config', 'user.name', 'Deployment Test');
  upstreamGit('config', 'user.email', 'deploy-test@example.invalid');
  mkdirSync(path.join(upstream, 'backend'));
  writeFileSync(path.join(upstream, 'backend', 'package.json'), '{}\n');
  writeFileSync(path.join(upstream, '.gitignore'), 'backend/dist/\n/DEPLOYED_SHA\n');
  upstreamGit('add', '.');
  upstreamGit('commit', '-m', 'first');
  const first = upstreamGit('rev-parse', 'HEAD');
  upstreamGit('tag', '-a', 'v1.0', '-m', 'release one');
  upstreamGit('branch', 'release/pilot');
  writeFileSync(path.join(upstream, 'README'), 'second\n');
  upstreamGit('add', '.');
  upstreamGit('commit', '-m', 'second');
  const second = upstreamGit('rev-parse', 'HEAD');
  run('git', ['clone', upstream, checkout]);
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'sudo'), '#!/bin/sh\n[ "$1" = "-u" ] || exit 99\nshift 2\nexec "$@"\n', { mode: 0o755 });
  writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\necho "$*" >> "$BUILD_LOG"\nif [ "$1" = "run" ] && [ "$2" = "build" ]; then mkdir -p dist; fi\n', { mode: 0o755 });
  const script = path.join(root, '04-app.sh');
  writeFileSync(script, source.replace(/^APP_ROOT=.*$/m, `APP_ROOT='${checkout}'`));
  const log = path.join(root, 'build.log');
  const deploy = ref => spawnSync('bash', [script], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ATS_REPO: upstream, ATS_REF: ref, BUILD_LOG: log },
  });
  return { root, checkout, first, second, git, upstreamGit, deploy, log };
}

for (const ref of ['main', 'origin/main', 'refs/heads/main', 'release/pilot', 'v1.0', 'refs/tags/v1.0', 'full-sha', 'short-sha']) {
  test(`deploys ${ref} at its exact commit`, t => {
    const f = fixture(t);
    const requested = ref === 'full-sha' ? f.first : ref === 'short-sha' ? f.first.slice(0, 12) : ref;
    const expected = ['main', 'origin/main', 'refs/heads/main'].includes(ref) ? f.second : f.first;
    const result = f.deploy(requested);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(f.git('rev-parse', 'HEAD'), expected);
    assert.equal(readFileSync(path.join(f.checkout, 'DEPLOYED_SHA'), 'utf8').trim(), expected);
    assert.equal(readFileSync(f.log, 'utf8'), 'ci --include=dev\nrun build\n');
  });
}

for (const dirty of ['tracked', 'staged', 'untracked']) {
  test(`rejects ${dirty} edits before fetch, checkout, or build`, t => {
    const f = fixture(t);
    const edited = path.join(f.checkout, dirty === 'untracked' ? 'local-notes' : 'README');
    writeFileSync(edited, 'local work\n');
    if (dirty === 'staged') f.git('add', 'README');
    const before = f.git('status', '--porcelain');
    const result = f.deploy('release/pilot');
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /working tree is dirty/);
    assert.equal(f.git('rev-parse', 'HEAD'), f.second);
    assert.equal(f.git('status', '--porcelain'), before);
    assert.equal(existsSync(path.join(f.checkout, '.git', 'FETCH_HEAD')), false);
    assert.equal(existsSync(f.log), false);
  });
}

for (const ref of ['missing-release', '--help', 'main~1', 'refs/heads/missing']) {
  test(`rejects invalid or missing ref ${ref} without checkout or build`, t => {
    const f = fixture(t);
    const result = f.deploy(ref);
    assert.notEqual(result.status, 0);
    assert.equal(f.git('rev-parse', 'HEAD'), f.second);
    assert.equal(existsSync(f.log), false);
    assert.equal(existsSync(path.join(f.checkout, 'DEPLOYED_SHA')), false);
  });
}

test('rejects an ambiguous branch/tag name and permits an explicit tag', t => {
  const f = fixture(t);
  f.upstreamGit('tag', 'main', f.first);
  const result = f.deploy('main');
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /ambiguous/);
  assert.equal(existsSync(f.log), false);
  const explicit = f.deploy('refs/tags/main');
  assert.equal(explicit.status, 0, explicit.stdout + explicit.stderr);
  assert.equal(f.git('rev-parse', 'HEAD'), f.first);
});

test('a deployment marker does not prevent the next deployment', t => {
  const f = fixture(t);
  assert.equal(f.deploy('main').status, 0);
  const second = f.deploy('release/pilot');
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(f.git('rev-parse', 'HEAD'), f.first);
});
