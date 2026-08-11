// Talent mappers. Pure, total, no decisions.

import type {
  candidate, candidateDocument, candidateProposal, cvIntakeBatch, cvIntakeItem,
} from '../../../infrastructure/db/schema/index.js';
import type { CandidateDocument, CandidateProps } from '../domain/candidate.js';
import type {
  CandidateProposalProps, ProposalGeneration, ProposedField,
} from '../domain/proposal.js';
import type { ProvenanceMap } from '../domain/provenance.js';
import type { CvIntakeBatchProps, IntakeField, IntakeItem } from '../domain/cv-intake.js';
import { toNumber } from '../../../infrastructure/db/numeric.js';

export type CandidateRow = typeof candidate.$inferSelect;
export type CandidateInsert = typeof candidate.$inferInsert;
export type DocumentRow = typeof candidateDocument.$inferSelect;
export type DocumentInsert = typeof candidateDocument.$inferInsert;
export type ProposalRow = typeof candidateProposal.$inferSelect;
export type ProposalInsert = typeof candidateProposal.$inferInsert;

const strings = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];

/**
 * Normalised forms for duplicate DETECTION only.
 *
 * Never used for identity or uniqueness — see the schema note. Lowercase and
 * strip separators so "+20 100 123 4567" and "00201001234567" collide.
 */
export const dedupEmail = (email: string | null): string | null =>
  email === null ? null : email.trim().toLowerCase();

export const dedupPhone = (phone: string | null): string | null => {
  if (phone === null) return null;
  const digits = phone.replace(/\D/g, '').replace(/^00/, '');
  // Last 9 digits: enough to match across country-code spellings, short enough
  // that a local and an international form of the same number agree.
  return digits.length === 0 ? null : digits.slice(-9);
};

export const dedupLinkedin = (url: string | null): string | null => {
  if (url === null) return null;
  const cleaned = url.trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  return cleaned === '' ? null : cleaned;
};

/* ------------------------------- candidate --------------------------------- */

export const candidateToProps = (
  row: CandidateRow,
  documents: readonly DocumentRow[],
): CandidateProps => ({
  id: row.id,
  tenantId: row.tenantId,
  candidateNo: row.candidateNo,
  fullName: row.fullName,
  email: row.email,
  phone: row.phone,
  nationality: row.nationality,
  location: row.location,
  linkedinUrl: row.linkedinUrl,
  currentCompany: row.currentCompany,
  currentPosition: row.currentPosition,
  // numeric arrives as a string; without this "3.5" would flow into the domain
  // as text and every comparison against it would be a string comparison.
  yearsExperience: row.yearsExperience === null ? null : toNumber(row.yearsExperience),
  noticePeriod: row.noticePeriod,
  university: row.university,
  major: row.major,
  graduationYear: row.graduationYear,
  skills: strings(row.skills),
  languages: strings(row.languages),
  certifications: strings(row.certifications),
  tags: strings(row.tags),
  source: row.source,
  ownerRecruiterId: row.ownerRecruiterId,
  state: row.state,
  documents: [...documents]
    .sort((a, b) => a.uploadedAt.getTime() - b.uploadedAt.getTime() || a.id - b.id)
    .map(documentToProps),
  provenance: reviveProvenance(row.provenance),
  createdBy: row.createdBy,
  version: row.version,
});

export const documentToProps = (row: DocumentRow): CandidateDocument => ({
  documentId: row.documentId,
  docType: row.docType,
  fileName: row.fileName,
  fileHash: row.fileHash,
  fileSize: row.fileSize,
  mimeType: row.mimeType,
  note: row.note,
  uploadedBy: row.uploadedBy,
  uploadedAt: row.uploadedAt,
});

/** jsonb has no Date type, so `at` comes back as a string and must be revived. */
const reviveProvenance = (raw: unknown): ProvenanceMap => {
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Record<string, ProvenanceMap[string]> = {};
  for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const entry = value as Record<string, unknown>;
    out[field] = {
      source: entry['source'] as ProvenanceMap[string]['source'],
      at: new Date(entry['at'] as string),
      actorId: typeof entry['actorId'] === 'number' ? entry['actorId'] : null,
      ...(typeof entry['taskId'] === 'string' ? { taskId: entry['taskId'] } : {}),
      ...(typeof entry['modelId'] === 'string' ? { modelId: entry['modelId'] } : {}),
      ...('acceptedValue' in entry ? { acceptedValue: entry['acceptedValue'] } : {}),
    };
  }
  return out;
};

/**
 * The searchable blob.
 *
 * Deliberately includes skills, tags and certifications: a recruiter searching
 * "Primavera" means "who knows Primavera", and that lives in a jsonb array no
 * ILIKE over `full_name` will ever reach.
 */
export const searchTextOf = (p: CandidateProps): string => [
  p.fullName, p.candidateNo, p.email, p.phone, p.location, p.nationality,
  p.currentCompany, p.currentPosition, p.university, p.major, p.source,
  ...p.skills, ...p.tags, ...p.certifications, ...p.languages,
].filter((v): v is string => typeof v === 'string' && v.trim() !== '').join(' ');

export const candidateToRow = (p: CandidateProps): CandidateInsert => ({
  id: p.id,
  tenantId: p.tenantId,
  candidateNo: p.candidateNo,
  fullName: p.fullName,
  email: p.email,
  phone: p.phone,
  nationality: p.nationality,
  location: p.location,
  linkedinUrl: p.linkedinUrl,
  currentCompany: p.currentCompany,
  currentPosition: p.currentPosition,
  yearsExperience: p.yearsExperience === null ? null : p.yearsExperience.toFixed(1),
  noticePeriod: p.noticePeriod,
  university: p.university,
  major: p.major,
  graduationYear: p.graduationYear,
  skills: p.skills,
  languages: p.languages,
  certifications: p.certifications,
  tags: p.tags,
  source: p.source,
  ownerRecruiterId: p.ownerRecruiterId,
  state: p.state,
  provenance: p.provenance,
  dedupEmail: dedupEmail(p.email),
  dedupPhone: dedupPhone(p.phone),
  dedupLinkedin: dedupLinkedin(p.linkedinUrl),
  searchText: searchTextOf(p),
  createdBy: p.createdBy,
  version: p.version,
});

export const documentToRow = (
  candidateId: number, d: CandidateDocument,
): DocumentInsert => ({
  candidateId,
  documentId: d.documentId,
  docType: d.docType,
  fileName: d.fileName,
  fileHash: d.fileHash,
  fileSize: d.fileSize,
  mimeType: d.mimeType,
  note: d.note,
  uploadedBy: d.uploadedBy,
  uploadedAt: d.uploadedAt,
});

/* -------------------------------- proposal --------------------------------- */

export const proposalToProps = (row: ProposalRow): CandidateProposalProps => ({
  id: row.id,
  tenantId: row.tenantId,
  candidateId: row.candidateId,
  origin: row.origin,
  taskId: row.taskId,
  modelId: row.modelId,
  documentId: row.documentId,
  status: row.status,
  generation: reviveGeneration(row.generation),
  fields: reviveFields(row.fields),
  reviewedBy: row.reviewedBy,
  reviewedAt: row.reviewedAt,
  createdAt: row.createdAt,
  version: row.version,
});

/** jsonb has no Date type, so `generatedAt` returns as a string. */
const reviveGeneration = (raw: unknown): ProposalGeneration | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const g = raw as Record<string, unknown>;
  if (typeof g['modelId'] !== 'string') return null;
  return {
    capability: String(g['capability'] ?? ''),
    modelId: g['modelId'],
    promptVersionId: String(g['promptVersionId'] ?? ''),
    documentHash: typeof g['documentHash'] === 'string' ? g['documentHash'] : null,
    parserVersion: typeof g['parserVersion'] === 'string' ? g['parserVersion'] : null,
    extractorVersion: typeof g['extractorVersion'] === 'string' ? g['extractorVersion'] : null,
    generatedAt: new Date(String(g['generatedAt'] ?? 0)),
  };
};

const reviveFields = (raw: unknown): ProposedField[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
    .map((f) => ({
      field: String(f['field'] ?? ''),
      value: f['value'],
      confidence: typeof f['confidence'] === 'number' ? f['confidence'] : 0,
      evidence: typeof f['evidence'] === 'string' ? f['evidence'] : null,
      decision: (f['decision'] ?? 'PENDING') as ProposedField['decision'],
    }))
    .filter((f) => f.field !== '');
};

export const proposalToRow = (p: CandidateProposalProps): ProposalInsert => ({
  id: p.id,
  tenantId: p.tenantId,
  candidateId: p.candidateId,
  origin: p.origin,
  taskId: p.taskId,
  modelId: p.modelId,
  documentId: p.documentId,
  status: p.status,
  generation: p.generation,
  fields: p.fields,
  reviewedBy: p.reviewedBy,
  reviewedAt: p.reviewedAt,
  version: p.version,
  createdAt: p.createdAt,
});


/* ------------------------------- CV intake --------------------------------- */

export type IntakeBatchRow = typeof cvIntakeBatch.$inferSelect;
export type IntakeBatchInsert = typeof cvIntakeBatch.$inferInsert;
export type IntakeItemRow = typeof cvIntakeItem.$inferSelect;
export type IntakeItemInsert = typeof cvIntakeItem.$inferInsert;

export const intakeToProps = (
  row: IntakeBatchRow, items: readonly IntakeItemRow[],
): CvIntakeBatchProps => ({
  id: row.id,
  tenantId: row.tenantId,
  label: row.label,
  status: row.status,
  uploadedBy: row.uploadedBy,
  items: [...items].sort((a, b) => a.id - b.id).map(intakeItemToProps),
  createdAt: row.createdAt,
  version: row.version,
});

export const intakeItemToProps = (row: IntakeItemRow): IntakeItem => ({
  itemId: row.itemId,
  fileName: row.fileName,
  fileHash: row.fileHash,
  mimeType: row.mimeType,
  fileSize: row.fileSize,
  status: row.status,
  extracted: reviveIntakeFields(row.extracted),
  generation: reviveGeneration(row.generation),
  candidateId: row.candidateId,
  note: row.note,
});

const reviveIntakeFields = (raw: unknown): IntakeField[] =>
  (Array.isArray(raw) ? raw : [])
    .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
    .map((f) => ({
      field: String(f['field'] ?? ''),
      value: f['value'],
      confidence: typeof f['confidence'] === 'number' ? f['confidence'] : 0,
      evidence: typeof f['evidence'] === 'string' ? f['evidence'] : null,
    }))
    .filter((f) => f.field !== '');

export const intakeToRow = (p: CvIntakeBatchProps): IntakeBatchInsert => ({
  id: p.id,
  tenantId: p.tenantId,
  label: p.label,
  status: p.status,
  uploadedBy: p.uploadedBy,
  version: p.version,
  createdAt: p.createdAt,
});

export const intakeItemToRow = (batchId: number, i: IntakeItem): IntakeItemInsert => ({
  batchId,
  itemId: i.itemId,
  fileName: i.fileName,
  fileHash: i.fileHash,
  mimeType: i.mimeType,
  fileSize: i.fileSize,
  status: i.status,
  extracted: i.extracted,
  generation: i.generation,
  candidateId: i.candidateId,
  note: i.note,
});
