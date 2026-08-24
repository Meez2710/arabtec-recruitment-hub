// Bridge from the live Express routes to the compiled recruiter AI.
//
// Same shape as parsing/pipeline-provider.js: the logic is TypeScript compiled
// to dist/, and this is the one place the JS server reaches it. Kept separate
// from the parsing bridge because these two answer to different rules — see the
// header of claude-recruiter-ai.ts.

import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist');
const distUrl = (rel) => pathToFileURL(path.join(DIST, rel)).href;

let mods = null;
async function load() {
  if (mods !== null) return mods;
  try {
    const [ai, client] = await Promise.all([
      import(distUrl('infrastructure/ai/anthropic/claude-recruiter-ai.js')),
      import(distUrl('infrastructure/ai/anthropic/client.js')),
    ]);
    mods = { ai, client };
    return mods;
  } catch (error) {
    throw new Error(
      'The AI modules are not built. Run `npm run build` in backend/ before '
      + `starting the server. (${error && error.message})`,
    );
  }
}

/** Test-only. Forces the next call to re-read the environment. */
export function resetRecruiterAi() { mods = null; }

/** The configured model, or null when this deployment has no key. */
export async function recruiterAiStatus() {
  const { client } = await load();
  const cfg = client.claudeConfigFrom(process.env);
  return cfg === undefined
    ? { configured: false, model: null }
    : { configured: true, model: cfg.model };
}

const NOT_CONFIGURED = {
  ok: false,
  reason: 'No AI is configured. Set ANTHROPIC_API_KEY and restart the server.',
};

/**
 * Rank candidates against a requisition.
 * Returns `{ ok:false, reason }` rather than throwing — a shortlist that could
 * not be produced is a message on a panel, not a failed page load.
 */
export async function suggestCandidates(requisition, candidates, limit) {
  const { ai, client } = await load();
  const cfg = client.claudeConfigFrom(process.env);
  if (cfg === undefined) return NOT_CONFIGURED;
  return ai.matchCandidates(cfg, requisition, candidates, limit);
}

/** Turn a recruiter's sentence into candidate-list filters. */
export async function interpretSearch(query) {
  const { ai, client } = await load();
  const cfg = client.claudeConfigFrom(process.env);
  if (cfg === undefined) return NOT_CONFIGURED;
  return ai.translateSearch(cfg, query);
}
