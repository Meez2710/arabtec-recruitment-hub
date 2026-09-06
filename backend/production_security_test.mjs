import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const mode = process.env.SECURITY_TEST_CASE;
if (!mode) {
  // An OPTIONAL integration must never stop the app from serving.
  //
  // Listing the MS_* keys in render.yaml is enough for the platform to CREATE
  // those entries, so a blank-but-present variable made validateConfigOrThrow
  // refuse to boot and took a working production deploy down (Render,
  // 6 Sep 2026). Nothing was at risk: the integration reports itself off and
  // every route refuses with the list of what is missing. Only DATABASE_URL and
  // JWT_SECRET may be fatal.
  test('an optional integration cannot block production startup', () => {
    const base = {
      ...process.env,
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://user@host/db',
      JWT_SECRET: 'a'.repeat(40),
      CORS_ORIGINS: 'https://arabtec.onrender.com',
      MS_TENANT_ID: '', MS_CLIENT_ID: '', MS_CLIENT_SECRET: '',
      MICROSOFT_TOKEN_ENCRYPTION_KEY: '',
    };
    const validate = (extra) => {
      const child = spawnSync(process.execPath, ['--experimental-sqlite', '-e',
        "import('./src/lib/config.js').then(m=>{const r=m.validateConfig();"
        + "process.stdout.write(JSON.stringify({ok:r.ok,ms:r.summary.microsoftMailbox}));})"],
      { cwd: process.cwd(), env: { ...base, ...extra }, encoding: 'utf8', timeout: 30000 });
      return JSON.parse(child.stdout || '{}');
    };

    // Exactly the Render failure: one MS var present, no encryption key.
    const half = validate({ MS_CLIENT_ID: 'set-but-incomplete' });
    assert.equal(half.ok, true, 'a half-configured M365 must not refuse startup');
    assert.equal(half.ms, false, 'and must report itself off');

    const noKey = validate({ MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's' });
    assert.equal(noKey.ok, true, 'a missing encryption key must not refuse startup');
    assert.equal(noKey.ms, false);

    const badKey = validate({ MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's',
      MICROSOFT_TOKEN_ENCRYPTION_KEY: 'too-short' });
    assert.equal(badKey.ok, true, 'a malformed encryption key must not refuse startup');
    assert.equal(badKey.ms, false);

    const good = validate({ MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's',
      MICROSOFT_TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32) });
    assert.equal(good.ok, true);
    assert.equal(good.ms, true, 'a fully configured M365 must still report enabled');

    // The two that genuinely must be fatal are unchanged.
    const noCore = spawnSync(process.execPath, ['--experimental-sqlite', '-e',
      "import('./src/lib/config.js').then(m=>{process.stdout.write(String(m.validateConfig().ok));})"],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 30000,
      env: { ...base, DATABASE_URL: '', JWT_SECRET: '' } });
    assert.equal(noCore.stdout.trim(), 'false', 'DATABASE_URL / JWT_SECRET must still be fatal');
  });

  for (const scenario of ['schema-failure', 'flags-failure', 'seed-failure', 'http-boundaries']) {
    test(scenario, () => {
      const child = spawnSync(process.execPath, ['--experimental-sqlite', fileURLToPath(import.meta.url)], {
        env: { ...process.env, SECURITY_TEST_CASE: scenario }, encoding: 'utf8', timeout: 30000,
      });
      assert.equal(child.status, 0, child.stdout + child.stderr);
    });
  }
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arabtec-security-'));
  Object.assign(process.env, {
    DOTENV_CONFIG_PATH: path.join(dir, 'absent.env'), NODE_ENV: 'production', PORT: '0',
    DATABASE_URL: `file:${path.join(dir, 'test.db')}`, PG_ENGINE: '',
    JWT_SECRET: 'disposable-security-test-secret-32-characters',
    SEED_ADMIN_PASSWORD: 'Disposable#Admin12345', SEED_DEMO_DATA: 'true',
    UPLOAD_DIR: path.join(dir, 'uploads'), SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '',
    ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', SENTRY_DSN: '', RATE_LIMIT_DISABLED: 'true',
    CV_INBOX: path.join(dir, 'inbox'), CV_PARSER_PROVIDER: 'document-pipeline',
  });
  const express = (await import('express')).default;
  let server;
  const originalListen = express.application.listen;
  express.application.listen = function (...args) {
    server = originalListen.apply(this, args);
    return server;
  };
  let bootFinished = false;
  const logs = [];
  for (const level of ['log', 'error']) {
    const original = console[level];
    console[level] = (...args) => {
      const line = args.join(' ');
      logs.push(line);
      if (/Ready\. API health|Initialisation failed|Boot-seed check failed/.test(line)) bootFinished = true;
      original(...args);
    };
  }
  const mockName = `security-fixture-${process.pid}.html`;
  const mockPath = fileURLToPath(new URL(`../frontend/public/${mockName}`, import.meta.url));
  try {
    const db = await import('./src/lib/db.js');
    if (mode === 'schema-failure') db.exec('PRAGMA query_only = ON');
    if (mode === 'seed-failure' || mode === 'flags-failure') {
      (await import('./src/lib/schema.js')).ensureSchema();
      const table = mode === 'seed-failure' ? 'users' : 'system_setting';
      db.exec(`CREATE TRIGGER reject_boot BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'disposable boot failure'); END`);
    }
    await import('./src/server.js');
    const deadline = Date.now() + 15000;
    while (!bootFinished && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    assert.ok(bootFinished, 'boot did not finish');
    const base = `http://127.0.0.1:${server.address().port}`;
    const raw = (url, method = 'GET', token) => new Promise((resolve, reject) => {
      const req = http.request(base, { path: url, method, headers: token ? { authorization: `Bearer ${token}` } : {} }, res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      });
      req.on('error', reject);
      req.end();
    });
    if (mode !== 'http-boundaries') {
      assert.equal((await raw('/api/health')).status, 200);
      const response = await raw('/api/auth/me');
      assert.equal(response.status, 503, `${mode} must leave the API gate closed`);
      assert.equal(response.headers['retry-after'], '5');
      assert.equal((await raw('/api/health/ready')).status, 503);
    } else {
      const failures = [];
      const check = async (label, fn) => { try { await fn(); } catch (e) { failures.push(`${label}: ${e.message}`); } };
      await check('readiness success', async () => assert.equal((await raw('/api/health/ready')).status, 200));
      const { adminToken } = await import('./test-support/admin-session.mjs');
      const token = await adminToken(base);
      await check('AI mount requires authentication', async () => assert.equal((await raw('/api/ai/capabilities')).status, 401));
      await check('AI mount exposes read-only capabilities', async () => {
        const response = await raw('/api/ai/capabilities', 'GET', token);
        assert.equal(response.status, 200);
        assert.equal(JSON.parse(response.body).writes, false);
        assert.equal(JSON.parse(response.body).configured, false);
      });
      const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'recruiter@arabtec.com', password: 'Arabtec@123' }) });
      assert.equal(login.status, 200);
      const recruiter = await login.json();
      for (const route of ['/api/health/watcher', '/api/health/parsing']) {
        await check(`${route} anonymous`, async () => assert.equal((await raw(route)).status, 401));
        await check(`${route} recruiter`, async () => assert.equal((await raw(route, 'GET', recruiter.token)).status, 403));
        await check(`${route} admin`, async () => assert.equal((await raw(route, 'GET', token)).status, 200));
      }
      const { createJob, completeJob } = await import('./src/lib/parsing/jobs.js');
      const owner = db.get('SELECT id FROM users WHERE email=?', ['admin@arabtec.com']).id;
      const jobId = createJob(owner);
      completeJob(jobId, { preview: ['private CV body'] });
      await check('owner polling', async () => assert.equal((await raw(`/api/candidates/parse-cv-async/${jobId}`, 'GET', token)).status, 200));
      await check('non-owner polling', async () => assert.equal((await raw(`/api/candidates/parse-cv-async/${jobId}`, 'GET', recruiter.token)).status, 404));
      fs.writeFileSync(mockPath, 'PRIVATE MOCKUP');
      for (const method of ['GET', 'HEAD']) {
        for (const url of [`/${mockName}`, `/${mockName.replace('.html', '%2ehtml')}`, `/%73${mockName.slice(1)}`, `/unused/%2e%2e/${mockName}`, `/${mockName}/`, '/%zz']) {
          await check(`${method} ${url}`, async () => assert.ok([400, 404].includes((await raw(url, method)).status)));
        }
        for (const url of ['/', '/index.html', '/%69ndex.html', '/styles.css', '/users']) {
          await check(`${method} valid ${url}`, async () => assert.equal((await raw(url, method)).status, 200));
        }
      }
      const { DatabaseSync } = await import('node:sqlite');
      const prepare = DatabaseSync.prototype.prepare;
      DatabaseSync.prototype.prepare = function (sql) {
        if (sql === 'SELECT 1 AS ok') throw new Error('sensitive-db-host.internal secret connection detail');
        return prepare.call(this, sql);
      };
      await check('DB probe sanitization', async () => {
        const response = await raw('/api/health/db');
        assert.equal(response.status, 503);
        assert.ok(!response.body.includes('sensitive-db-host'));
      });
      DatabaseSync.prototype.prepare = prepare;
      assert.deepEqual(failures, []);
    }
  } finally {
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
    fs.rmSync(mockPath, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
