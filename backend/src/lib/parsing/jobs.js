// In-process job tracking for the async CV-parse flow.
//
// EPHEMERAL BY DESIGN. A job lost to a server restart just means the
// recruiter re-uploads — there is nothing here a database needs to remember,
// because the only durable output of a parse, the intake, is still written by
// createIntake() exactly as the synchronous /parse-cv route always has. This
// tracks the in-flight request only, so a route can answer immediately and
// let the two Claude calls run after the response has already gone out.

import crypto from 'node:crypto';

/** @type {Map<string, { ownerId: number, status: 'processing'|'done'|'error', createdAt: number, updatedAt: number, payload?: object, message?: string }>} */
const jobs = new Map();

const JOB_TTL_MS = 15 * 60 * 1000;
const MAX_JOBS = 1000;

function sweep() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt >= JOB_TTL_MS) jobs.delete(id);
  }
}

/** Register a new job as processing and return its id. */
export function createJob(ownerId) {
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0) throw new TypeError('A parse job requires an owner.');
  sweep();
  while (jobs.size >= MAX_JOBS) jobs.delete(jobs.keys().next().value);
  const id = crypto.randomUUID();
  const now = Date.now();
  jobs.set(id, { ownerId, status: 'processing', createdAt: now, updatedAt: now });
  return id;
}

/** Mark a job done with its result payload — the same shape /parse-cv returns. */
export function completeJob(id, payload) {
  sweep();
  const job = jobs.get(id);
  if (job) jobs.set(id, { ownerId: job.ownerId, createdAt: job.createdAt, status: 'done', updatedAt: Date.now(), payload });
}

/** Mark a job failed. Kept distinct from a parse that legitimately found nothing. */
export function failJob(id, message) {
  sweep();
  const job = jobs.get(id);
  if (job) jobs.set(id, { ownerId: job.ownerId, createdAt: job.createdAt, status: 'error', updatedAt: Date.now(), message });
}

/** @returns {object|null} */
export function getJob(id, ownerId) {
  sweep();
  const job = jobs.get(id);
  if (!job || job.ownerId !== ownerId) return null;
  const { ownerId: _ownerId, createdAt: _createdAt, ...result } = job;
  return result;
}
