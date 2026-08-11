// Field provenance — where every value on a candidate came from.
//
// THE REQUIREMENT: always distinguish user-entered, AI-suggested and approved-AI
// data. That is a GDPR/PDPL obligation as much as a product one — a candidate
// may ask why a system holds a fact about them, and "a model inferred it from a
// PDF" is a different answer from "they typed it".
//
// This file is PURE DOMAIN and knows nothing about AI beyond a task id it treats
// as an opaque string. No import from `kernel/ai`, deliberately: the Candidate
// aggregate must compile and behave identically in a deployment with no AI
// configured at all.
//
// A field with NO provenance entry is user-entered by default. The alternative —
// requiring an entry per field — means one forgotten call silently mislabels
// human data as machine data, which is the failure that matters.

/**
 * How a value got here.
 *
 * `AI_SUGGESTED` never appears on the candidate itself: a suggestion lives on a
 * proposal until someone accepts it. It exists in this union because the
 * proposal review screen reads the same vocabulary.
 */
export const FIELD_SOURCES = ['USER', 'AI_SUGGESTED', 'AI_APPROVED', 'IMPORT'] as const;
export type FieldSource = (typeof FIELD_SOURCES)[number];

export interface FieldProvenance {
  readonly source: FieldSource;
  readonly at: Date;
  /** The human responsible. Null only for an unattended import. */
  readonly actorId: number | null;
  /** Set for AI_APPROVED: which extraction produced it, and from which model. */
  readonly taskId?: string;
  readonly modelId?: string;
  /** Set for AI_APPROVED: the value the human saw when they accepted. */
  readonly acceptedValue?: unknown;
}

/** field name -> provenance. Absent key means USER. */
export type ProvenanceMap = Readonly<Record<string, FieldProvenance>>;

export const userEntry = (actorId: number, at: Date): FieldProvenance =>
  ({ source: 'USER', at, actorId });

export const importEntry = (at: Date, actorId: number | null = null): FieldProvenance =>
  ({ source: 'IMPORT', at, actorId });

/**
 * A field a human reviewed and accepted from a proposal.
 *
 * Records the value as accepted. If the field is later edited by hand the entry
 * is replaced by a USER one — so "approved AI data" always means the value
 * still standing is the one that was approved, not merely that AI touched the
 * field once.
 */
export const aiApprovedEntry = (input: {
  actorId: number; at: Date; taskId: string; modelId: string; value: unknown;
}): FieldProvenance => ({
  source: 'AI_APPROVED',
  at: input.at,
  actorId: input.actorId,
  taskId: input.taskId,
  modelId: input.modelId,
  acceptedValue: input.value,
});

export const sourceOf = (map: ProvenanceMap, field: string): FieldSource =>
  map[field]?.source ?? 'USER';

/** Fields whose current value came from an accepted AI proposal. */
export const aiApprovedFields = (map: ProvenanceMap): readonly string[] =>
  Object.entries(map).filter(([, p]) => p.source === 'AI_APPROVED').map(([field]) => field);

export const withProvenance = (
  map: ProvenanceMap,
  fields: readonly string[],
  entry: FieldProvenance,
): ProvenanceMap => {
  if (fields.length === 0) return map;
  const next: Record<string, FieldProvenance> = { ...map };
  for (const field of fields) next[field] = entry;
  return next;
};
