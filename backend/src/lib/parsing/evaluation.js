// Candidate competency evaluation, rendered for the notes timeline.
//
// Replaces the 0–100 "score / recommendation" evaluation. A number invites
// sorting candidates by it, and a number a model produced is neither calibrated
// nor explainable — which is not a basis for a hiring decision anyone can
// defend. The four qualitative levels say what the evidence supports and
// nothing more.
//
// It consumes the `ResumeProposal`, so the evaluator sees each value together
// with the source line it was read from. Quotes the model returns are verified
// against that data inside the evaluator; anything it could not have read is
// dropped before it reaches this file.

import { getEvaluator, parseDocument } from './pipeline-provider.js';

/**
 * Evaluate one already-parsed CV against a request.
 *
 * Returns null when no evaluator is configured, when the document could not be
 * parsed, or when the model abstained. A null is a normal outcome: the
 * candidate record is unaffected and the recruiter carries on.
 *
 * @param {string} filePath  the stored CV
 * @param {{ title?: string, position?: string, description?: string, requirements?: string }} request
 * @returns {Promise<{ body: string, evaluation: object } | null>}
 */
export async function evaluateAgainstRequest(filePath, request) {
  const evaluator = await getEvaluator();
  if (evaluator === null) return null;

  const parsed = await parseDocument(filePath);
  if (!parsed.ok) return null;

  // The evaluator reads exactly what a reviewer would: the proposable fields
  // with the source line each was read from. Nothing withheld reaches it.
  const outcome = await evaluator.evaluate({
    fields: parsed.fields,
    documentId: parsed.documentId,
  }, {
    title: request.title || request.position || '',
    ...(request.description ? { description: request.description } : {}),
    ...(request.requirements ? { requirements: request.requirements } : {}),
  });

  // An abstention carries `abstained`; a proposal carries `content`.
  if ('abstained' in outcome) return null;
  return { body: renderEvaluation(outcome.content), evaluation: outcome.content };
}

/**
 * Render an evaluation as the markdown body of a candidate note.
 *
 * Every competency shows its level and the evidence that supports it. A
 * competency with no evidence is shown as such rather than hidden, because
 * "the CV does not say" is the most useful thing a screener can be told.
 *
 * @param {object} evaluation
 * @returns {string}
 */
export function renderEvaluation(evaluation) {
  const lines = [`**Competency assessment — ${evaluation.overall}**`, ''];

  if (evaluation.summary) lines.push(evaluation.summary, '');

  for (const competency of evaluation.competencies) {
    lines.push(`**${competency.competency}: ${competency.level}**`);
    if (competency.rationale) lines.push(competency.rationale);
    for (const quote of competency.evidence) lines.push(`> ${quote}`);
    lines.push('');
  }

  if (evaluation.gaps.length > 0) {
    lines.push('**No evidence in the CV for:**');
    for (const gap of evaluation.gaps) lines.push(`- ${gap}`);
    lines.push('');
  }

  lines.push(
    '_Assessed from the CV only. Levels reflect what the document evidences, '
    + 'not a judgement of the candidate._',
    `_Model: ${evaluation.modelId} · prompt: ${evaluation.promptVersionId} `
    + `· document: ${evaluation.documentId}_`,
  );
  return lines.join('\n');
}
