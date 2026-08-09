// AI composition root — the single place a capability handler is registered.
//
// Mirrors lib/parsing/composition.js deliberately: everything that decides
// WHICH implementation runs lives in one file, and nothing else in the
// application may register a handler. An unconfigured runtime does nothing at
// all rather than guessing.
//
// Called once at boot. Safe to call again (tests do): registration is a map
// write and orphan recovery is idempotent.

import { registerAiHandler, recoverOrphanedTasks, drainQueue } from './runner.js';
import { handleResumeParse } from './resume-intake.js';
import { AI_CAPABILITIES } from './capabilities.js';
import { aiConfig } from './config.js';

/**
 * @returns {{registered: string[], enabled: boolean, recovered: number}}
 */
export function configureAi() {
  // The handler is registered even when the feature is OFF. It is unreachable
  // — the route refuses before submitting — and registering unconditionally
  // means enabling the flag is genuinely a configuration change, not a code
  // path that has never run in this process.
  registerAiHandler(AI_CAPABILITIES.RESUME_PARSE, handleResumeParse);

  const { enabled } = aiConfig();
  let recovered = 0;
  if (enabled) {
    // A task left RUNNING belongs to a process that is gone; it can never
    // finish on its own. Requeue once, then start draining.
    recovered = recoverOrphanedTasks();
    setImmediate(() => { drainQueue(); });
  }

  return { registered: [AI_CAPABILITIES.RESUME_PARSE], enabled, recovered };
}
