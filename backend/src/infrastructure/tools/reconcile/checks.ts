// Reconciliation checks — PURE functions over row snapshots.
//
// No database, no I/O. The source layer fetches rows; this file decides what is
// wrong with them. Same discipline as the domain layer, and for the same reason:
// these rules are the gate on a one-way migration, so they must be testable
// exhaustively without standing up Postgres.
//
// WHY THIS EXISTS (risk R2): the new Requisition aggregate re-checks H1–H3 on
// every `fromState()`. Legacy rows that violate them will throw on load rather
// than migrate silently. This tool finds them BEFORE the migration runs, so the
// exceptions are a reviewed list instead of a production incident.

import { LEGACY_STAGE_ALIASES, LEGACY_STATE_ALIASES } from '../../../modules/hiring/index.js';

/* ------------------------------- row shapes ------------------------------- */

export interface LegacyRequisitionRow {
  id: number;
  ticket_no: string | null;
  status: string | null;
  headcount: number | null;
  headcount_filled: number | null;
}

export interface LegacySeatRow {
  id: number;
  request_id: number;
  seat_no: number | null;
  status: string | null;
  filled_by_application_id: number | null;
}

export interface LegacyApplicationRow {
  id: number;
  application_no: string | null;
  candidate_id: number | null;
  request_id: number | null;
  status: string | null;
}

export interface LegacySnapshot {
  requisitions: readonly LegacyRequisitionRow[];
  seats: readonly LegacySeatRow[];
  applications: readonly LegacyApplicationRow[];
}

/* --------------------------------- findings -------------------------------- */

/**
 * BLOCKING — the migration cannot proceed until a human resolves it.
 * WARNING  — migrates safely, but someone should know.
 */
export type Severity = 'BLOCKING' | 'WARNING';

export type FindingCode =
  | 'H1_SEAT_COUNT_MISMATCH'
  | 'H2_OVERFILLED'
  | 'H3_FILLED_SEAT_WITHOUT_APPLICATION'
  | 'H3_APPLICATION_IN_TWO_SEATS'
  | 'H4_HIRED_WITHOUT_SEAT'
  | 'H4_SEAT_HOLDER_NOT_HIRED'
  | 'H5_CANDIDATE_HIRED_TWICE'
  | 'HEADCOUNT_FILLED_DRIFT'
  | 'DUPLICATE_LIVE_APPLICATION'
  | 'DUPLICATE_BUSINESS_NUMBER'
  | 'UNMAPPED_REQUISITION_STATUS'
  | 'UNMAPPED_APPLICATION_STAGE'
  | 'ORPHAN_SEAT_APPLICATION'
  | 'ORPHAN_APPLICATION_REQUISITION'
  | 'MISSING_HEADCOUNT';

export interface Finding {
  readonly code: FindingCode;
  readonly severity: Severity;
  readonly entity: 'requisition' | 'seat' | 'application' | 'candidate';
  readonly entityId: number | string;
  readonly message: string;
  /** Everything a human needs to decide, without opening the database. */
  readonly detail: Record<string, unknown>;
  /** What the migration would do if this were resolved automatically. */
  readonly suggestedRemedy: string;
}

export interface ReconciliationReport {
  readonly generatedAt: string;
  readonly counts: {
    requisitions: number; seats: number; applications: number;
    blocking: number; warnings: number;
  };
  readonly byCode: Readonly<Record<string, number>>;
  readonly findings: readonly Finding[];
  /** False when any BLOCKING finding exists. */
  readonly migrationSafe: boolean;
}

/* -------------------------------- constants -------------------------------- */

/** Legacy seat vocabulary. `reserved` and `reopened` both mean "available". */
const SEAT_OPEN = new Set(['open', 'reserved', 'reopened']);
const SEAT_FILLED = 'filled';

/** Legacy application statuses meaning "this person was hired". */
const LEGACY_HIRED = new Set(['joined', 'hired']);

/** Legacy application statuses that are terminal — a candidate may re-apply after. */
const LEGACY_TERMINAL = new Set([
  'joined', 'hired', 'rejected', 'withdrawn', 'offer_declined', 'offer_rejected',
]);

/** Legacy requisition statuses that are terminal — H5 ignores hires on these. */
const LEGACY_REQ_TERMINAL = new Set(['closed', 'cancelled', 'expired', 'rejected']);

/* --------------------------------- checks ---------------------------------- */

export function reconcile(snapshot: LegacySnapshot): ReconciliationReport {
  const findings: Finding[] = [
    ...checkSeatIntegrity(snapshot),
    ...checkHireBijection(snapshot),
    ...checkCandidateUniqueness(snapshot),
    ...checkDuplicates(snapshot),
    ...checkVocabulary(snapshot),
    ...checkOrphans(snapshot),
  ];

  const byCode: Record<string, number> = {};
  for (const f of findings) byCode[f.code] = (byCode[f.code] ?? 0) + 1;

  const blocking = findings.filter((f) => f.severity === 'BLOCKING').length;

  return {
    generatedAt: new Date().toISOString(),
    counts: {
      requisitions: snapshot.requisitions.length,
      seats: snapshot.seats.length,
      applications: snapshot.applications.length,
      blocking,
      warnings: findings.length - blocking,
    },
    byCode,
    findings,
    migrationSafe: blocking === 0,
  };
}

/** H1, H2, H3, and the stored-vs-actual drift on `headcount_filled`. */
function checkSeatIntegrity(s: LegacySnapshot): Finding[] {
  const out: Finding[] = [];
  const seatsByReq = groupBy(s.seats, (r) => r.request_id);

  for (const req of s.requisitions) {
    const seats = seatsByReq.get(req.id) ?? [];
    const filled = seats.filter((x) => x.status === SEAT_FILLED);

    if (req.headcount === null || req.headcount < 1) {
      out.push({
        code: 'MISSING_HEADCOUNT', severity: 'BLOCKING',
        entity: 'requisition', entityId: req.id,
        message: `Requisition ${req.ticket_no ?? req.id} has headcount ${String(req.headcount)}.`,
        detail: { headcount: req.headcount, seatRows: seats.length },
        suggestedRemedy: 'Set headcount to the approved figure before migrating.',
      });
      continue; // every other seat check depends on a usable headcount
    }

    // H1 — the new aggregate throws on load if this does not hold.
    if (seats.length !== req.headcount) {
      out.push({
        code: 'H1_SEAT_COUNT_MISMATCH', severity: 'BLOCKING',
        entity: 'requisition', entityId: req.id,
        message: `Requisition ${req.ticket_no ?? req.id} has ${seats.length} seat rows for headcount ${req.headcount}.`,
        detail: {
          headcount: req.headcount, seatRows: seats.length,
          filled: filled.length, open: seats.filter((x) => SEAT_OPEN.has(x.status ?? '')).length,
          delta: seats.length - req.headcount,
        },
        suggestedRemedy: seats.length < req.headcount
          ? `Create ${req.headcount - seats.length} open seat(s), or reduce headcount to ${seats.length}.`
          : `Remove ${seats.length - req.headcount} surplus open seat(s), or raise headcount to ${seats.length}.`,
      });
    }

    // H2 — overfill.
    if (filled.length > req.headcount) {
      out.push({
        code: 'H2_OVERFILLED', severity: 'BLOCKING',
        entity: 'requisition', entityId: req.id,
        message: `Requisition ${req.ticket_no ?? req.id} has ${filled.length} filled seats against headcount ${req.headcount}.`,
        detail: { headcount: req.headcount, filled: filled.length,
          applicationIds: filled.map((x) => x.filled_by_application_id) },
        suggestedRemedy: 'Reverse the surplus hire(s), or raise headcount to match what was actually hired.',
      });
    }

    // H3a — a filled seat with nobody in it.
    for (const seat of filled) {
      if (seat.filled_by_application_id === null) {
        out.push({
          code: 'H3_FILLED_SEAT_WITHOUT_APPLICATION', severity: 'BLOCKING',
          entity: 'seat', entityId: seat.id,
          message: `Seat ${seat.seat_no} on requisition ${req.id} is FILLED with no application.`,
          detail: { requisitionId: req.id, seatNo: seat.seat_no },
          suggestedRemedy: 'Identify the hire and bind it, or return the seat to open.',
        });
      }
    }

    // H3b — one application occupying two seats.
    const holders = filled.map((x) => x.filled_by_application_id).filter((x): x is number => x !== null);
    for (const [appId, count] of countOccurrences(holders)) {
      if (count > 1) {
        out.push({
          code: 'H3_APPLICATION_IN_TWO_SEATS', severity: 'BLOCKING',
          entity: 'application', entityId: appId,
          message: `Application ${appId} occupies ${count} seats on requisition ${req.id}.`,
          detail: { requisitionId: req.id, seatCount: count },
          suggestedRemedy: 'Release the duplicate seat(s); one hire consumes exactly one seat.',
        });
      }
    }

    // Stored counter vs reality. Not blocking — the new model derives it.
    if (req.headcount_filled !== null && req.headcount_filled !== filled.length) {
      out.push({
        code: 'HEADCOUNT_FILLED_DRIFT', severity: 'WARNING',
        entity: 'requisition', entityId: req.id,
        message: `headcount_filled says ${req.headcount_filled}; ${filled.length} seats are actually filled.`,
        detail: { stored: req.headcount_filled, actual: filled.length },
        suggestedRemedy: 'No action — the new model derives fill state from seats and drops this column.',
      });
    }
  }
  return out;
}

/** H4 — the bijection between hired applications and filled seats, both ways. */
function checkHireBijection(s: LegacySnapshot): Finding[] {
  const out: Finding[] = [];
  const seatByApp = new Map<number, LegacySeatRow>();
  for (const seat of s.seats) {
    if (seat.status === SEAT_FILLED && seat.filled_by_application_id !== null) {
      seatByApp.set(seat.filled_by_application_id, seat);
    }
  }
  const appById = new Map(s.applications.map((a) => [a.id, a]));

  for (const app of s.applications) {
    const hired = LEGACY_HIRED.has(app.status ?? '');
    const seat = seatByApp.get(app.id);

    if (hired && !seat) {
      out.push({
        code: 'H4_HIRED_WITHOUT_SEAT', severity: 'BLOCKING',
        entity: 'application', entityId: app.id,
        message: `Application ${app.application_no ?? app.id} is '${app.status}' but occupies no seat.`,
        detail: { requisitionId: app.request_id, candidateId: app.candidate_id, status: app.status },
        suggestedRemedy: 'Bind an open seat, or correct the stage if this hire did not happen.',
      });
    }
  }

  for (const [appId, seat] of seatByApp) {
    const app = appById.get(appId);
    if (app && !LEGACY_HIRED.has(app.status ?? '')) {
      out.push({
        code: 'H4_SEAT_HOLDER_NOT_HIRED', severity: 'BLOCKING',
        entity: 'seat', entityId: seat.id,
        message: `Seat ${seat.seat_no} is held by application ${appId}, which is '${app.status}', not hired.`,
        detail: { requisitionId: seat.request_id, applicationStatus: app.status },
        suggestedRemedy: 'Release the seat, or correct the application stage to hired.',
      });
    }
  }
  return out;
}

/** H5 — a candidate holding filled seats on more than one live requisition. */
function checkCandidateUniqueness(s: LegacySnapshot): Finding[] {
  const liveReq = new Set(
    s.requisitions.filter((r) => !LEGACY_REQ_TERMINAL.has(r.status ?? '')).map((r) => r.id),
  );
  const filledAppIds = new Set(
    s.seats.filter((x) => x.status === SEAT_FILLED && x.filled_by_application_id !== null)
      .map((x) => x.filled_by_application_id as number),
  );

  const byCandidate = new Map<number, LegacyApplicationRow[]>();
  for (const app of s.applications) {
    if (app.candidate_id === null) continue;
    if (!filledAppIds.has(app.id)) continue;
    if (app.request_id === null || !liveReq.has(app.request_id)) continue;
    push(byCandidate, app.candidate_id, app);
  }

  const out: Finding[] = [];
  for (const [candidateId, apps] of byCandidate) {
    if (apps.length > 1) {
      out.push({
        code: 'H5_CANDIDATE_HIRED_TWICE', severity: 'BLOCKING',
        entity: 'candidate', entityId: candidateId,
        message: `Candidate ${candidateId} holds ${apps.length} filled seats across live requisitions.`,
        detail: { applicationIds: apps.map((a) => a.id), requisitionIds: apps.map((a) => a.request_id) },
        suggestedRemedy: 'Reverse the hire(s) that did not actually happen; one person occupies one seat.',
      });
    }
  }
  return out;
}

/** Constraints the new schema will enforce, checked before it does. */
function checkDuplicates(s: LegacySnapshot): Finding[] {
  const out: Finding[] = [];

  const liveByPair = new Map<string, LegacyApplicationRow[]>();
  for (const app of s.applications) {
    if (LEGACY_TERMINAL.has(app.status ?? '')) continue;
    if (app.candidate_id === null || app.request_id === null) continue;
    push(liveByPair, `${app.candidate_id}:${app.request_id}`, app);
  }
  for (const [key, apps] of liveByPair) {
    if (apps.length > 1) {
      const [candidateId, requisitionId] = key.split(':');
      out.push({
        code: 'DUPLICATE_LIVE_APPLICATION', severity: 'BLOCKING',
        entity: 'application', entityId: apps[0]!.id,
        message: `Candidate ${candidateId} has ${apps.length} live applications to requisition ${requisitionId}.`,
        detail: { applicationIds: apps.map((a) => a.id), statuses: apps.map((a) => a.status) },
        suggestedRemedy: 'Withdraw the duplicates; the new schema enforces one live application per pair.',
      });
    }
  }

  for (const [label, values] of [
    ['ticket_no', s.requisitions.map((r) => r.ticket_no)],
    ['application_no', s.applications.map((a) => a.application_no)],
  ] as const) {
    for (const [value, count] of countOccurrences(values.filter((v): v is string => !!v))) {
      if (count > 1) {
        out.push({
          code: 'DUPLICATE_BUSINESS_NUMBER', severity: 'BLOCKING',
          entity: label === 'ticket_no' ? 'requisition' : 'application', entityId: value,
          message: `${label} '${value}' appears ${count} times.`,
          detail: { field: label, value, count },
          suggestedRemedy: 'Renumber the duplicates; these become UNIQUE constraints.',
        });
      }
    }
  }
  return out;
}

/** Any status the alias maps do not cover would migrate to nothing. */
function checkVocabulary(s: LegacySnapshot): Finding[] {
  const out: Finding[] = [];

  for (const [value, count] of countOccurrences(
    s.requisitions.map((r) => (r.status ?? '').toLowerCase()).filter(Boolean),
  )) {
    if (!(value in LEGACY_STATE_ALIASES)) {
      out.push({
        code: 'UNMAPPED_REQUISITION_STATUS', severity: 'BLOCKING',
        entity: 'requisition', entityId: value,
        message: `Requisition status '${value}' (${count} rows) has no mapping to a canonical state.`,
        detail: { value, rows: count, known: Object.keys(LEGACY_STATE_ALIASES) },
        suggestedRemedy: 'Add a mapping to LEGACY_STATE_ALIASES, or correct the rows.',
      });
    }
  }

  for (const [value, count] of countOccurrences(
    s.applications.map((a) => (a.status ?? '').toLowerCase()).filter(Boolean),
  )) {
    if (!(value in LEGACY_STAGE_ALIASES)) {
      out.push({
        code: 'UNMAPPED_APPLICATION_STAGE', severity: 'BLOCKING',
        entity: 'application', entityId: value,
        message: `Application stage '${value}' (${count} rows) has no mapping to a canonical stage.`,
        detail: { value, rows: count, known: Object.keys(LEGACY_STAGE_ALIASES) },
        suggestedRemedy: 'Add a mapping to LEGACY_STAGE_ALIASES, or correct the rows.',
      });
    }
  }
  return out;
}

/** Referential integrity the legacy schema did not enforce. */
function checkOrphans(s: LegacySnapshot): Finding[] {
  const out: Finding[] = [];
  const reqIds = new Set(s.requisitions.map((r) => r.id));
  const appIds = new Set(s.applications.map((a) => a.id));

  for (const seat of s.seats) {
    if (seat.filled_by_application_id !== null && !appIds.has(seat.filled_by_application_id)) {
      out.push({
        code: 'ORPHAN_SEAT_APPLICATION', severity: 'BLOCKING',
        entity: 'seat', entityId: seat.id,
        message: `Seat ${seat.id} references application ${seat.filled_by_application_id}, which does not exist.`,
        detail: { requisitionId: seat.request_id, applicationId: seat.filled_by_application_id },
        suggestedRemedy: 'Clear the reference and return the seat to open.',
      });
    }
  }

  for (const app of s.applications) {
    if (app.request_id === null || !reqIds.has(app.request_id)) {
      out.push({
        code: 'ORPHAN_APPLICATION_REQUISITION', severity: 'BLOCKING',
        entity: 'application', entityId: app.id,
        message: `Application ${app.application_no ?? app.id} references requisition ${String(app.request_id)}, which does not exist.`,
        detail: { requisitionId: app.request_id },
        suggestedRemedy: 'Re-point to the correct requisition, or archive the application.',
      });
    }
  }
  return out;
}

/* --------------------------------- helpers --------------------------------- */

function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) push(map, key(item), item);
  return map;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function countOccurrences<T>(values: readonly T[]): Map<T, number> {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return counts;
}
