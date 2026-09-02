// Wait until the server's readiness gate has actually opened.
//
// WHY THIS EXISTS. Eight suites started with `await setTimeout(900)` and then
// logged in. 900ms is not a fact about the server, it is a guess about the
// machine: seeding hashes nine bcrypt passwords at 10 rounds, and on a loaded
// CI box that alone outruns the sleep. When it does, the first login hits the
// readiness gate in server.js and gets 503 — which the suite reports as
// "admin logs in with bootstrap password (200) got 503", a failure that reads
// like a broken auth system and is really a race in the fixture. Re-running
// passed, so it was logged as flake and lived for months.
//
// /api/health cannot be the probe: it is deliberately liveness-only and returns
// 200 from the moment the port binds, precisely so a platform health check does
// not fail during warm-up. The gate itself is what has to be observed, so this
// polls an ordinary /api route instead. GET /api/auth/me unauthenticated answers
// 503 while the gate is shut and 401 once it is open — no credentials needed,
// no state touched.

/**
 * Poll until the API stops returning 503, or throw.
 *
 * @param {string} base      e.g. 'http://localhost:4404'
 * @param {number} timeoutMs give up after this long (default 20s)
 */
export async function waitForReady(base, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/auth/me`);
      if (r.status !== 503) return;          // gate open (401 unauthenticated)
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = e.message;                       // port not listening yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`server at ${base} was not ready within ${timeoutMs}ms (last: ${last})`);
}
