// Move an interview's start relative to now, straight in the test database.
// Booking refuses past times on purpose, so suites that need an interview
// that has already started (to mark it Completed / No-Show or give feedback)
// book it in the future and then move it. Never loosen the route guards for
// tests instead. `minutesFromNow` < 0 means it started that long ago.
export function backdateInterview(db, id, minutesFromNow) {
  const at = new Date(Date.now() + minutesFromNow * 60000).toISOString();
  db.run('UPDATE interview SET scheduled_at = ? WHERE id = ?', [at, id]);
  return at;
}
