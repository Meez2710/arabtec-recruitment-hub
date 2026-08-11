// AiParser — the ONLY module permitted to send CV content off this server.
// Isolated deliberately: a reviewer can audit outbound data handling by reading
// this one file.
//
// Four independent gates must ALL pass. Default in every environment is OFF.
//   1. CV_AI_PARSING_ENABLED === 'true'      explicit environment opt-in
//   2. feature.ai_parsing flag enabled       runtime toggle, defaults disabled
//   3. ANTHROPIC_API_KEY present
//   4. caller passes { allowAi: true }       explicit opt-in at the call site
//
// The previous implementation gated on key presence alone, so simply setting the
// key would have started sending CV text externally with no review.
import { isEnabled } from '../feature-flags.js';

export function aiGateStatus({ allowAi = false } = {}) {
  const envEnabled = String(process.env.CV_AI_PARSING_ENABLED || '').trim().toLowerCase() === 'true';
  let flagEnabled = false;
  try { flagEnabled = isEnabled('feature.ai_parsing'); } catch { flagEnabled = false; }
  const hasKey = !!String(process.env.ANTHROPIC_API_KEY || '').trim() || !!String(process.env.OLLAMA_BASE_URL || '').trim();
  return {
    envEnabled, flagEnabled, hasKey, callerOptIn: !!allowAi,
    allowed: envEnabled && flagEnabled && hasKey && !!allowAi,
  };
}

export function isAiEnabled(opts) { return aiGateStatus(opts).allowed; }

/**
 * Returns null when the gate is closed or the call fails — the orchestrator then
 * keeps the heuristic result. Never throws, never logs CV text.
 */
export async function aiExtract(text, filename, { allowAi = false, timeoutMs = 20000 } = {}) {
  if (!isAiEnabled({ allowAi }) || !text) return null;
  try {
    if (process.env.OLLAMA_BASE_URL) {
      const ollamaBase = process.env.OLLAMA_BASE_URL.replace(/\/$/, '');
      const ollamaModel = process.env.OLLAMA_MODEL || 'llama3.2';
      const systemPrompt = 'Extract candidate details from this CV. Respond with ONLY a JSON object: {full_name, email, phone, years_experience (integer or null), role_applied}. Phone numbers are Egyptian (MENA region).';
      const res = await fetch(`${ollamaBase}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ollamaModel,
          system: systemPrompt,
          prompt: text.slice(0, 12000),
          stream: false,
          format: {
            type: "object",
            properties: {
              full_name: { type: "string" },
              email: { type: "string" },
              phone: { type: "string" },
              years_experience: { type: "number" },
              role_applied: { type: "string" }
            },
            required: ["full_name"]
          },
          options: { temperature: 0, num_ctx: 8192 }
        })
      });
      const data = await res.json();
      const raw = data?.response || '';
      const jsonStr = raw.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();
      const start = jsonStr.indexOf('{');
      const end = jsonStr.lastIndexOf('}');
      if (start === -1 || end === -1) return null;
      return JSON.parse(jsonStr.slice(start, end + 1));
    } else {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: String(process.env.ANTHROPIC_API_KEY).trim() });
      const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
      const msg = await client.messages.create({
        model,
        max_tokens: 512,
        system: 'Extract candidate details from this CV. Respond with ONLY a JSON object: {full_name, email, phone, years_experience (integer or null), role_applied}. Phone numbers are Egyptian (MENA region).',
        messages: [{ role: 'user', content: text.slice(0, 12000) }],
      }, { timeout: timeoutMs });
      const raw = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start === -1 || end === -1) return null;
      return JSON.parse(raw.slice(start, end + 1));
    }
  } catch (err) {
    console.error('[ai-parser] Extraction failed:', err.message);
    return null;                                        // fall back to heuristic
  }
}
