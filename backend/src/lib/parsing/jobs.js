// In-process job tracking for the async CV-parse flow.
//
// EPHEMERAL BY DESIGN. A job lost to a server restart just means the
// recruiter re-uploads — there is nothing here a database needs to remember,
// because the only durable output of a parse, the intake, is still written by
// createIntake() exactly as the synchronous /parse-cv route always has. This
// tracks the in-flight request only, so a route can answer immediately and
// let the two Claude calls run after the response has already gone out.

import crypto from 'node:crypto';

/** @type {Map<string, { status: 'processing'|'done'|'error', updatedAt: number, payload?: object, message?: string }>} */
const jobs = new Map();

const JOB_TTL_MS = 15 * 60 * 1000;

function sweep() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.updatedAt > JOB_TTL_MS) jobs.delete(id);
  }
}

/** Register a new job as processing and return its id. */
export function createJob() {
  sweep();
  const id = crypto.randomUUID();
  jobs.set(id, { status: 'processing', updatedAt: Date.now() });
  return id;
}

/** Mark a job done with its result payload — the same shape /parse-cv returns. */
export function completeJob(id, payload) {
  jobs.set(id, { status: 'done', updatedAt: Date.now(), payload });
}

/** Mark a job failed. Kept distinct from a parse that legitimately found nothing. */
export function failJob(id, message) {
  jobs.set(id, { status: 'error', updatedAt: Date.now(), message });
}

/** @returns {object|null} */
export function getJob(id) {
  return jobs.get(id) ?? null;
}
