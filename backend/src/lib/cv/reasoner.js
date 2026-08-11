import { aiGateStatus } from './ai-parser.js';

export async function evaluateCandidate(parsedCandidate, jobRequest, { timeoutMs = 30000 } = {}) {
  if (!aiGateStatus().allowed) return null;
  
  const systemPrompt = `You are an expert HR Agent Reasoner. Evaluate the candidate's structured data against the Job Requirements.
Calculate and verify if their claimed years of experience make mathematical sense based on their graduation year.
Score them from 0 to 100 based on alignment with the job.
Return ONLY a valid JSON object matching this exact schema:
{
  "score": <number 0-100>,
  "recommendation": "Highly Recommended" | "Recommended" | "Needs Review" | "Not Recommended",
  "strengths": ["<string>", "<string>"],
  "weaknesses": ["<string>", "<string>"],
  "summary": "<short paragraph explaining the evaluation>"
}`;

  const promptText = `
Candidate Profile:
${JSON.stringify(parsedCandidate, null, 2)}

Job Request (Requirements):
Title: ${jobRequest.title || jobRequest.position || ''}
Description: ${jobRequest.description || ''}
Requirements: ${jobRequest.requirements || ''}
  `;

  try {
    if (process.env.OLLAMA_BASE_URL) {
      const ollamaBase = process.env.OLLAMA_BASE_URL.replace(/\/$/, '');
      const ollamaModel = process.env.OLLAMA_MODEL || 'llama3.2';
      const origTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      if (ollamaBase.includes('runpod.net')) {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      }
      
      let res;
      try {
        res = await fetch(`${ollamaBase}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: ollamaModel,
            system: systemPrompt,
            prompt: promptText.slice(0, 10000),
            stream: false,
            format: {
              type: "object",
              properties: {
                score: { type: "number" },
                recommendation: { type: "string" },
                strengths: { type: "array", items: { type: "string" } },
                weaknesses: { type: "array", items: { type: "string" } },
                summary: { type: "string" }
              },
              required: ["score", "recommendation", "summary"]
            },
            options: { temperature: 0.1 }
          })
        });
      } finally {
        if (ollamaBase.includes('runpod.net')) {
          if (origTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
          else process.env.NODE_TLS_REJECT_UNAUTHORIZED = origTls;
        }
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Ollama API error (${res.status}): ${text}`);
      }
      const data = await res.json();
      const raw = data?.response || '';
      const jsonStr = raw.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();
      const start = jsonStr.indexOf('{');
      const end = jsonStr.lastIndexOf('}');
      if (start === -1 || end === -1) throw new Error('AI returned malformed JSON');
      return JSON.parse(jsonStr.slice(start, end + 1));
    } else {
      // Fallback to Anthropic if no Ollama
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: String(process.env.ANTHROPIC_API_KEY).trim() });
      const model = process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest';
      const msg = await client.messages.create({
        model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: promptText.slice(0, 10000) }],
      }, { timeout: timeoutMs });
      const raw = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start === -1 || end === -1) return null;
      return JSON.parse(raw.slice(start, end + 1));
    }
  } catch (err) {
    console.error('[reasoner] Evaluation failed:', err.message);
    return null; // Reasoner failure should not crash the pipeline
  }
}
