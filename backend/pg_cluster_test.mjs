// Proves the concurrency harness itself before any test relies on it.
//
//   node pg_cluster_test.mjs            (uses PG_TEST_URL, or --own)
//   node pg_cluster_test.mjs --own      (starts a local disposable PostgreSQL)
//
// A harness that silently fails to achieve real concurrency would make every
// race test that follows a false negative, so its properties are asserted here:
// distinct OS processes, distinct ports, one shared database, real overlap, a
// working safety guard, and clean teardown.

import { startCluster, assertDisposable } from './test-harness/pg-cluster.mjs';

let pass = 0; let fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (x ? ` ${x}` : '')); ok ? pass++ : fail++; };

/* ------------------------- guard, before anything ------------------------- */
console.log('\n— safety guard —');
for (const bad of [
  'postgres://u:p@db.example.com:5432/arabtec',
  'postgres://u:p@127.0.0.1:5432/production',
  'postgres://u:p@127.0.0.1:5432/arabtec_prod',
  // Deliberately rejected: the rule matches whole delimited tokens, so a name
  // that merely CONTAINS "test" does not qualify. Stricter is the safe error.
  'postgres://u:p@127.0.0.1:5432/txtest',
]) {
  let threw = false;
  try { assertDisposable(bad); } catch { threw = true; }
  c(`refuses a non-disposable database name (${bad.split('/').pop()})`, threw);
}
for (const good of [
  'postgres://u:p@127.0.0.1:5432/arabtec_test',
  'postgres://u:p@127.0.0.1:5432/ci_db?sslmode=disable',
]) {
  let ok = true;
  try { assertDisposable(good); } catch { ok = false; }
  c(`accepts a disposable database name (${good.split('/').pop().split('?')[0]})`, ok);
}
c('refuses an unparseable DSN', (() => { try { assertDisposable('nonsense'); return false; } catch { return true; } })());

/* ------------------------------ the cluster ------------------------------- */
const own = process.argv.includes('--own') || !process.env.PG_TEST_URL;
let cluster = null;
try {
  console.log('\n— starting 3 independent backends on one database —');
  cluster = await startCluster({ processes: 3, ownDatabase: own });

  c('three child processes started', cluster.pids.length === 3, `pids=${cluster.pids.join(',')}`);
  c('every child is a DISTINCT OS process', new Set(cluster.pids).size === 3);
  c('the parent is not one of them', !cluster.pids.includes(process.pid));
  c('every child has its own port', new Set(cluster.ports).size === 3, `ports=${cluster.ports.join(',')}`);
  c('all children are alive', cluster.children.every((x) => x.proc.exitCode === null));

  // Same database: a row written through one process must be visible via another.
  const token = await cluster.login('recruiter@arabtec.com');
  c('login succeeded through child 0', typeof token === 'string' && token.length > 10);

  const made = await cluster.api(0, '/api/candidates', {
    method: 'POST', token,
    body: { fullName: 'Cluster Probe', email: 'cluster.probe@example.com' },
  });
  c('created a candidate through child 0', made.status === 201, `got ${made.status}`);
  const seen = await cluster.api(1, `/api/candidates/${made.json.candidate.id}`, { token });
  c('child 1 sees the row child 0 wrote — one shared database', seen.status === 200, `got ${seen.status}`);
  c('the two calls really went to different processes',
    made.viaPid !== seen.viaPid, `${made.viaPid} vs ${seen.viaPid}`);

  console.log('\n— requests genuinely overlap —');
  // Each child reports the PID that served it; a spread across children proves
  // the parent is not serialising onto one backend.
  const results = await cluster.race(
    Array.from({ length: 12 }, (_, i) => () => cluster.api(i, '/api/health')),
  );
  const servedBy = results.filter((r) => r.status === 'fulfilled').map((r) => r.value.viaPid);
  c('all 12 overlapping requests completed', servedBy.length === 12, `${servedBy.length}/12`);
  c('they were spread across every child', new Set(servedBy).size === 3,
    `distinct pids=${new Set(servedBy).size}`);

  c('no idle-in-transaction connection remains', cluster.idleInTransaction() === 0,
    `n=${cluster.idleInTransaction()}`);
} catch (e) {
  c(`harness startup or assertions threw: ${e.message}`, false);
} finally {
  if (cluster) {
    const pids = [...cluster.pids];
    await cluster.stop();
    await new Promise((r) => setTimeout(r, 300));
    const alive = pids.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
    c('teardown left no orphan process', alive.length === 0, alive.length ? `alive=${alive}` : '');
  }
}

console.log(`\n${fail === 0 ? '✓' : '✗'} harness: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
