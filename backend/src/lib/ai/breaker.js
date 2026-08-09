// Circuit breaker for the AI gateway.
//
// WHY THE ATS NEEDS ONE. When the GPU service is down, every upload otherwise
// waits the full timeout before failing. Twenty recruiters uploading during an
// outage means twenty three-minute hangs and a queue that never drains. The
// breaker converts a slow failure into an immediate, honest one — which is the
// difference between "the AI is unavailable" and "the ATS is broken".
//
// Deliberately in-process and not persisted. It describes what THIS process has
// observed in the last minute; persisting it would make one process's bad luck
// everyone's outage, and surviving a restart is exactly the wrong behaviour for
// a signal whose whole purpose is to be current.

import { aiConfig } from './config.js';

const state = {
  consecutiveFailures: 0,
  openedAt: 0,
  lastFailureCode: null,
  lastSuccessAt: 0,
  totalFailures: 0,
  totalSuccesses: 0,
};

const now = () => Date.now();

/** OPEN — refuse fast. HALF_OPEN — allow one probe. CLOSED — normal. */
export function breakerState() {
  const { breakerThreshold, breakerCooldownMs } = aiConfig();
  if (state.consecutiveFailures < breakerThreshold) return 'CLOSED';
  return now() - state.openedAt >= breakerCooldownMs ? 'HALF_OPEN' : 'OPEN';
}

/** True when a call must be refused without touching the network. */
export const breakerIsOpen = () => breakerState() === 'OPEN';

export function recordSuccess() {
  state.consecutiveFailures = 0;
  state.openedAt = 0;
  state.lastFailureCode = null;
  state.lastSuccessAt = now();
  state.totalSuccesses += 1;
}

/**
 * Only ENVIRONMENT failures count. A rejected document is not evidence that the
 * service is unhealthy — counting it would let a stack of corrupt PDFs trip the
 * breaker and stop everyone else's parsing.
 */
export function recordFailure(code) {
  state.totalFailures += 1;
  state.lastFailureCode = code;
  state.consecutiveFailures += 1;
  if (state.consecutiveFailures === aiConfig().breakerThreshold) state.openedAt = now();
}

/** Safe to expose on /health: counts and codes only, never document content. */
export function breakerHealth() {
  return {
    state: breakerState(),
    consecutiveFailures: state.consecutiveFailures,
    lastFailureCode: state.lastFailureCode,
    lastSuccessAt: state.lastSuccessAt ? new Date(state.lastSuccessAt).toISOString() : null,
    totalSuccesses: state.totalSuccesses,
    totalFailures: state.totalFailures,
  };
}

/** Test-only. Production has no reason to forget what it just observed. */
export function __resetBreakerForTest() {
  state.consecutiveFailures = 0; state.openedAt = 0; state.lastFailureCode = null;
  state.lastSuccessAt = 0; state.totalFailures = 0; state.totalSuccesses = 0;
}
