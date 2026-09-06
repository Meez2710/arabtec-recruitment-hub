#!/usr/bin/env node
// ============================================================================
// m365-sync.mjs — the ONE scheduled mailbox scan.
//
// Runs a single delegated Microsoft 365 inbox pass against career@arabtecegy.com
// and exits. arabtec-m365-sync.timer fires it at 08:00 Africa/Cairo.
//
//   node m365-sync.mjs            # one pass
//   node m365-sync.mjs --status   # report the connection, scan nothing
//
// WHY THIS AND NOT AN HTTP CALL. deploy/on-prem/cv-scan.sh logs into the ATS
// with a service account's password to reach POST /api/candidates/inbox-scan.
// The mailbox endpoints are System Admin routes, so the same pattern here would
// mean a System Admin password sitting in a file on disk — a far worse
// credential than the one it replaces. This script instead loads the app's own
// modules and runs the same function the admin button runs, against the same
// database, with the same environment file the service already uses. No ATS
// login, no password, no second HTTP hop.
//
// SAFE TO RUN TWICE. mailbox_ingestion.dedup_key is UNIQUE, so a pass that
// overlaps the app's own manual scan cannot produce a duplicate intake — the
// second claim simply loses and is skipped.
//
// Config: /etc/arabtec-ats/ats.env — the SAME file arabtec-ats.service reads.
// Nothing extra: the Microsoft credentials and MICROSOFT_TOKEN_ENCRYPTION_KEY
// are already there because the app itself needs them.
// ============================================================================
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

// The installed app root. 04-app.sh checks the repo out at /opt/arabtec-ats.
const APP_ROOT = process.env.ATS_APP_ROOT || '/opt/arabtec-ats';
const BACKEND = path.join(APP_ROOT, 'backend');
const mod = (rel) => pathToFileURL(path.join(BACKEND, rel)).href;

const log = (fields) => console.log(JSON.stringify({ t: new Date().toISOString(), ...fields }));

function fail(message, detail) {
  console.error(JSON.stringify({ t: new Date().toISOString(), level: 'error', msg: message, detail }));
  process.exit(1);
}

const statusOnly = process.argv.includes('--status');

let store; let sync; let db;
try {
  db = await import(mod('src/lib/db.js'));
  store = await import(mod('src/lib/microsoft/connection-store.js'));
  sync = await import(mod('src/lib/microsoft/mailbox-sync.js'));
} catch (e) {
  fail('could not load the ATS modules — is ATS_APP_ROOT correct and has `npm ci` run?',
    String((e && e.message) || e));
}

// The app creates the tables at boot. A missing one means this timer fired
// before arabtec-ats.service ever started successfully; say so plainly rather
// than failing on a SQL error.
try {
  db.get('SELECT 1 FROM microsoft_connection LIMIT 1');
} catch (e) {
  fail('the microsoft_connection table does not exist — start arabtec-ats.service first',
    String((e && e.message) || e));
}

const status = store.connectionStatus();

if (statusOnly) {
  log({ msg: 'microsoft.status', ...status, recentIngestions: undefined });
  process.exit(status.connected ? 0 : 1);
}

if (!status.connected) {
  // NOT an error worth waking anyone at 08:00 for if it is simply not set up
  // yet; it IS one once someone has connected and the grant has lapsed.
  if (status.status === 'RECONNECT_REQUIRED') {
    fail('Microsoft 365 connection requires sign-in again — a System Admin must reconnect '
      + 'from Configuration > Microsoft 365 in the ATS', status.lastError || null);
  }
  log({ level: 'warn', msg: 'microsoft.not_connected', status: status.status });
  process.exit(0);
}

const result = await sync.runMailboxSync();

log({ msg: 'microsoft.sync.result', ...result });

if (!result.ok) process.exit(1);
// A failed attachment is recorded and reported, but it is not a failed RUN —
// systemd should not mark the unit failed because one CV would not parse.
process.exit(0);
