// Lets a behaviour suite run against a disposable PostgreSQL instead of its
// scratch SQLite file, because production runs PostgreSQL. Opt-in only:
// without SUITE_PG_URL every suite keeps its own SQLite database.
// Refuses anything that is not loopback or not named as disposable.
export function suiteDatabaseUrl(sqliteUrl) {
  const pg = process.env.SUITE_PG_URL;
  if (!pg) return sqliteUrl;
  const u = new URL(pg.replace(/^postgres(ql)?:/, 'http:'));
  const name = u.pathname.slice(1);
  if (!/^arabtec_scratch_test_[a-z0-9_]+$/.test(name)) throw new Error(`REFUSING SUITE_PG_URL: database "${name}" is not a disposable arabtec_scratch_test_* database`);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new Error(`REFUSING SUITE_PG_URL: host ${u.hostname} is not loopback`);
  process.env.PG_NO_SSL ||= 'true';
  return pg;
}
