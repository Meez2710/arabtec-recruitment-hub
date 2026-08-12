// The production CV parsing provider: the document pipeline behind the
// interface `routes/candidates.js` already speaks.
//
// WHY AN ADAPTER RATHER THAN A ROUTE REWRITE. The routes, `cv-mapper` and the
// candidate columns are working, tested business logic. Migrating the parser
// should not require rewriting them, so this file translates the extraction
// result into the two shapes the routes already consume.
//
// IT ADDS NO POLICY. Which values may be persisted was decided upstream, in
// `resume-parse-handler.buildProposedFields`: a value is only present here if
// it was LOCATED in the document and passed DETERMINISTIC VALIDATION. This file
// maps that outcome onto the legacy trust vocabulary and nothing more — the one
// judgement it makes is that a model reading alone is never `verified`.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

/* --------------------------- compiled pipeline ---------------------------- */

// The document layer is TypeScript, compiled to dist/ by `npm run build`. A
// missing build is a deployment defect and must fail loudly rather than
// silently degrade to no parsing at all.
//
// fileURLToPath, not url.pathname: a path containing a space or a drive letter
// is mangled by the raw pathname, and the failure looks like a missing build.
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist');
const distUrl = (relative) => pathToFileURL(path.join(DIST, relative)).href;

let modules = null;
async function load() {
  if (modules !== null) return modules;
  try {
    const [composition, handler, proposal] = await Promise.all([
      import(distUrl('api/composition-root.js')),
      import(distUrl('infrastructure/ai/resume-parse-handler.js')),
      import(distUrl('modules/talent/domain/proposal.js')),
    ]);
    modules = { composition, handler, proposal };
    return modules;
  } catch (error) {
    throw new Error(
      'The document pipeline is not built. Run `npm run build` in backend/ '
      + `before starting the server. (${error && error.message})`,
    );
  }
}

let composed = null;
async function ai() {
  const { composition } = await load();
  // ONE composition root: the same function api/main.ts calls.
  composed ??= composition.composeAI(process.env);
  return composed;
}

/** Test-only. Forces the next call to re-read the environment. */
export function resetPipeline() { composed = null; cache.clear(); }

/** What was wired, for the startup log and /api/health. */
export async function pipelineDescription() {
  return (await ai()).description;
}

/** The competency evaluator, or null when no model is configured. */
export async function getEvaluator() {
  return (await ai()).evaluator ?? null;
}

/* -------------------------------- routing --------------------------------- */

const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

// Advisory only: the pipeline sniffs the magic bytes and corrects this.
function mimeFor(filePath) {
  return MIME_BY_EXT[path.extname(String(filePath || '')).toLowerCase()]
    || 'application/octet-stream';
}

/* --------------------------------- cache ---------------------------------- */

// `POST /parse-cv` calls parseLegacy() and parseEntities() on the same upload,
// which used to parse the file twice — measurably wasteful once a layout engine
// and a model are involved. Keyed on identity (path + size + mtime), so an
// edited file is never served from the cache.
const cache = new Map();
const CACHE_LIMIT = 8;

function cacheKey(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${filePath}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

function remember(key, value) {
  if (key === null) return value;
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, value);
  return value;
}

/* ------------------------------ trust mapping ------------------------------ */

/** Confidence assigned to a value both an independent rule and the model read. */
const AGREED = 0.9;
/** Confidence assigned to a value a deterministic rule read. */
const DETERMINISTIC = 0.75;

/**
 * Map a proposable field onto the legacy trust vocabulary `cv-mapper` reads.
 *
 * Everything reaching this function has ALREADY been located in the document
 * and validated, so the only remaining question is who read it:
 *
 *   verified  — a deterministic rule read it, or a rule and the model agreed.
 *   likely    — the model read it alone. Persistable, and never `verified`:
 *               nothing a model says on its own is.
 *
 * Values that were withheld upstream never arrive here at all; they are
 * reported as `rejected` so the parse report still shows them.
 */
export function trustOf(field) {
  return field.confidence >= DETERMINISTIC ? 'verified' : 'likely';
}

/** Proposal field name -> the legacy rich shape's entity key. */
const ENTITY_KEY = {
  fullName: 'full_name',
  email: 'email',
  phone: 'phone',
  location: 'location',
  currentCompany: 'current_company',
  currentPosition: 'current_position',
  yearsExperience: 'years_experience',
  university: 'university',
  major: 'major',
  graduationYear: 'graduation_year',
};

const GROUPS = {
  personal: ['full_name', 'email', 'phone', 'location'],
  employment: ['current_company', 'current_position', 'years_experience', 'role_applied'],
  education: ['university', 'major', 'graduation_year', 'degree'],
};

const EMPTY_FIELD = { value: null, method: null, confidence: 0, validation: 'missing' };

function emptyGroups() {
  const out = { personal: {}, employment: {}, education: {}, metadata: {} };
  for (const [group, fields] of Object.entries(GROUPS)) {
    for (const key of fields) out[group][key] = { ...EMPTY_FIELD };
  }
  return out;
}

/**
 * Build the rich shape `cv-mapper` consumes, plus the evidence it has no room
 * for.
 *
 * The extra keys are additive: `toCandidatePayload` reads only `value` and
 * `validation`, so nothing downstream changes, while a reviewer gains the
 * citation the previous parser could never produce.
 */
function toRichShape(result) {
  const { fields, withheld, structure, parsed, generation } = result;
  const out = emptyGroups();
  const flat = {};

  for (const field of fields) {
    const key = ENTITY_KEY[field.field];
    if (key === undefined) continue;
    const ref = field.evidenceRef;
    flat[key] = {
      value: field.value,
      method: field.confidence >= AGREED
        ? 'agreed'
        : (field.confidence >= DETERMINISTIC ? 'deterministic' : 'ai'),
      confidence: field.confidence,
      validation: trustOf(field),
      // Additive provenance. Never consulted by the persistence gate.
      evidence: field.evidence ?? null,
      source: ref === undefined ? null : {
        page: ref.page ?? null,
        blockId: ref.blockId ?? null,
        sectionId: ref.section ?? null,
      },
    };
  }

  // Values the evidence/validation stage refused. Reported so the parse report
  // can show a reviewer what was found and rejected, never persisted.
  for (const entry of withheld) {
    const key = ENTITY_KEY[entry.field];
    if (key === undefined || flat[key] !== undefined) continue;
    flat[key] = {
      value: null,
      method: null,
      confidence: 0,
      validation: 'rejected',
      evidence: null,
      source: null,
      rejected_value: typeof entry.value === 'string' ? entry.value : String(entry.value ?? ''),
      reason: entry.reason,
    };
  }

  for (const [group, keys] of Object.entries(GROUPS)) {
    for (const key of keys) out[group][key] = flat[key] ?? { ...EMPTY_FIELD };
  }

  const found = Object.values(flat).filter((f) => f.value !== null && f.value !== '').length;
  const confidences = fields.map((f) => f.confidence);
  const overall = confidences.length === 0
    ? 0
    : Number((confidences.reduce((a, b) => a + b, 0) / confidences.length).toFixed(3));
  const core = (flat.full_name?.value ? 1 : 0)
    + ((flat.email?.value || flat.phone?.value) ? 1 : 0);

  out.metadata = {
    parse_status: core >= 2 ? 'done' : (found > 0 ? 'partial' : 'failed'),
    parse_status_reason: found > 0 ? null : 'No candidate field could be supported by the document.',
    overall_confidence: overall,
    fields_found: found,
    fields_missing: Object.keys(ENTITY_KEY).length - found,
    core_fields_found: core,
    sections_detected: structure.sections.map((s) => s.canonical ?? 'other'),
    parsed_by: 'document-pipeline',
    engine_version: 4,
    // Additive: what an auditor needs to trace this parse.
    generation,
    withheld_fields: withheld.map((w) => ({ field: w.field, reason: w.reason })),
    ocr_applied: structure.ocrApplied,
    degraded_pages: structure.degradedPages,
    page_count: structure.pages.length,
    detected_language: parsed.detectedLanguage ?? null,
  };
  return out;
}

/** The failure shape, used for every abstention. Never throws at a route. */
function failedRich(reason) {
  const out = emptyGroups();
  out.metadata = {
    parse_status: 'failed',
    parse_status_reason: reason,
    overall_confidence: 0,
    fields_found: 0,
    fields_missing: Object.keys(ENTITY_KEY).length,
    core_fields_found: 0,
    sections_detected: [],
    parsed_by: 'document-pipeline',
    engine_version: 4,
    generation: null,
    withheld_fields: [],
    ocr_applied: false,
    degraded_pages: [],
    page_count: 0,
    detected_language: null,
  };
  return out;
}

/* -------------------------------- the parse -------------------------------- */

/**
 * Run the whole pipeline for one file, once.
 *
 * Returns the proposable fields alongside the legacy shapes, so a caller that
 * wants evidence (the evaluator) does not have to re-parse to get it.
 */
export async function parseDocument(filePath) {
  const key = cacheKey(filePath);
  if (key !== null && cache.has(key)) return cache.get(key);

  const { handler } = await load();
  const { capabilities } = await ai();
  const { documentParser, resumeExtractor } = capabilities;

  let bytes;
  try {
    bytes = new Uint8Array(fs.readFileSync(filePath));
  } catch (error) {
    return remember(key, {
      ok: false,
      reason: `The document could not be read from storage: ${error.message}`,
      rich: failedRich('The document could not be read from storage.'),
      fields: [],
    });
  }

  const filename = path.basename(filePath);
  const parsed = await documentParser.parse({
    documentId: filename, filename, mimeType: mimeFor(filePath), bytes,
  });

  if ('abstained' in parsed) {
    return remember(key, {
      ok: false,
      reason: parsed.reason,
      permanent: parsed.permanent,
      rich: failedRich(parsed.reason),
      fields: [],
    });
  }

  // With no model configured the extractor contributes nothing and the
  // deterministic rules answer alone — a complete, valid deployment.
  let extracted = EMPTY_RESUME;
  let aiConfidence = 0;
  let generation = null;
  if (resumeExtractor !== undefined) {
    const outcome = await resumeExtractor.extract(parsed.content);
    if (!('abstained' in outcome)) {
      extracted = outcome.content;
      aiConfidence = outcome.confidence;
      generation = {
        modelId: outcome.provenance.modelId,
        modelDigest: outcome.provenance.modelDigest ?? null,
        promptVersionId: outcome.provenance.promptVersionId,
        parserVersion: documentParser.version ?? null,
        extractorVersion: resumeExtractor.version ?? null,
        generatedAt: outcome.provenance.producedAt.toISOString(),
      };
    }
  }

  // THE VALIDATION SPLIT. Evidence is located in the document and deterministic
  // rules judge the value; neither consults the extractor's own confidence.
  const { fields, withheld } = handler.buildProposedFields({
    resume: extracted,
    document: parsed.content,
    aiConfidence,
    parser: 'document-pipeline',
    parserVersion: documentParser.version ?? 'unversioned',
  });

  const structure = parsed.content.structure ?? { sections: [], pages: [], ocrApplied: false, degradedPages: [] };

  return remember(key, {
    ok: fields.length > 0,
    reason: fields.length > 0 ? null : 'No candidate field could be supported by the document.',
    fields,
    withheld,
    parsed: parsed.content,
    documentId: filename,
    generation,
    rich: fields.length > 0
      ? toRichShape({ fields, withheld, structure, parsed: parsed.content, generation })
      : failedRich('No candidate field could be supported by the document.'),
  });
}

/** An extraction that says nothing. Used when no model is configured. */
const EMPTY_RESUME = {
  skills: [], employment: [], education: [], languages: [],
  certifications: [], uncertainFields: [],
};

/* ------------------------------ the provider ------------------------------- */

/**
 * The flat shape `POST /parse-cv` and `/inbox-scan` still return.
 *
 * Only document-supported, validated values appear. The legacy flat parser had
 * no trust concept and returned whatever a regex matched; routes use these as
 * fallbacks when the mapper skipped a field, so letting an unsupported value
 * through here would defeat the gate.
 */
function toLegacyShape(result) {
  if (!result.ok) {
    return {
      full_name: null,
      email: null,
      phone: null,
      years_experience: null,
      role_applied: null,
      raw_text: '',
      extraction_status: 'failed',
    };
  }
  const value = (name) => result.fields.find((f) => f.field === name)?.value ?? null;
  return {
    full_name: value('fullName'),
    email: value('email'),
    phone: value('phone'),
    years_experience: value('yearsExperience'),
    role_applied: null,
    raw_text: result.parsed.text,
    extraction_status: 'partial',
  };
}

/**
 * The fields a human still has to decide on.
 *
 * Values the MODEL alone read: located in the document and well-formed, but
 * with no independent deterministic rule agreeing. They are never written to a
 * candidate record by the import — they are raised as a PENDING proposal.
 *
 * Uses the same cached parse as the route's own call, so asking for these costs
 * nothing extra.
 */
export async function reviewableFields(filePath) {
  const result = await parseDocument(filePath);
  if (!result.ok) return { fields: [], generation: null, documentId: null };
  return {
    fields: result.fields.filter((f) => f.confidence < DETERMINISTIC),
    generation: result.generation,
    documentId: result.documentId,
  };
}

/** @type {import('./registry.js').ParserProvider} */
export const pipelineParserProvider = {
  name: 'document-pipeline',
  parseLegacy: async (filePath) => toLegacyShape(await parseDocument(filePath)),
  parseEntities: async (filePath) => (await parseDocument(filePath)).rich,
};
