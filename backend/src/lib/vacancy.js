// Shared, safe vacancy/seat automation (Phase 3 logic, reused by applications
// and offers). Single source of truth so joining via a moved application OR via
// an accepted offer cannot overfill or double-count.
import { run as dbRun, get as dbGet, tx } from './db.js';

// True if the request still has a fillable seat.
export function hasOpenSeat(requestId) {
  const open = dbGet("SELECT COUNT(*) c FROM requisition_seat WHERE request_id=? AND status IN ('open','reopened','reserved')", [requestId]).c;
  return open > 0;
}

// Atomically fill one seat for an application and update request count/status.
// Throws { code: 'NO_SEAT' } if no seat is available (overfill protection).
export function fillSeatAndCount(request, applicationId) {
  return tx(() => {
    const seat = dbGet("SELECT * FROM requisition_seat WHERE request_id=? AND status IN ('open','reopened','reserved') ORDER BY seat_no LIMIT 1", [request.id]);
    if (!seat) throw Object.assign(new Error('No open seat available to fill.'), { code: 'NO_SEAT' });
    dbRun("UPDATE requisition_seat SET status='filled', filled_by_application_id=?, filled_at=? WHERE id=?", [applicationId, new Date().toISOString(), seat.id]);
    const filled = dbGet("SELECT COUNT(*) c FROM requisition_seat WHERE request_id=? AND status='filled'", [request.id]).c;
    let newStatus = request.status;
    if (filled >= request.headcount) newStatus = 'filled';
    else if (filled > 0) newStatus = 'partially_filled';
    dbRun('UPDATE recruitment_request SET headcount_filled=?, status=?, updated_at=? WHERE id=?', [filled, newStatus, new Date().toISOString(), request.id]);
    return { filled, newStatus };
  });
}

// True if this application has already filled a seat (prevents double-count).
export function applicationAlreadyFilledSeat(applicationId) {
  return !!dbGet("SELECT 1 FROM requisition_seat WHERE filled_by_application_id=?", [applicationId]);
}
