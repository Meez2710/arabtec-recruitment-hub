// Smoke tests for the document-understanding and extraction layers.
//
// EVERY ASSERTION IS ABOUT DATA, NOT ABOUT NOT THROWING. A test that only
// proves "no exception occurred" would have passed against the parser this
// replaces, including on the cases it got wrong. Each test names a value and
// follows it to the far end of the stage under test.
//
// SCOPE. Docling, the OCR engine and the model are TEST DOUBLES here, so these
// prove PIPELINE INTEGRATION — routing, the OCR trigger, reconciliation, the
// evidence gate and the validation split. They say nothing about real Docling
// or real OCR quality, which needs those services running.

import { describe, expect, it } from 'vitest';

import type {
  AIOutcome, DocumentParser, ExtractedResume, OcrEngine, OcrPageOutcome,
  OcrPageRequest, ParsedDocument, ResumeExtractor, SourceDocument,
} from '../../../modules/shared/kernel/ai/index.js';
import { AI_CAPABILITIES } from '../../../modules/shared/kernel/ai/index.js';
import { CandidateProposal } from '../../../modules/talent/domain/proposal.js';
import { DocumentUnderstandingPipeline } from '../document/document-understanding-pipeline.js';
import { assessDocumentQuality } from '../document/quality-gate.js';
import { classifyDocument } from '../document/routing.js';
import { buildStructuredDocument } from '../document/structure-builder.js';
import { buildProposedFields } from '../resume-parse-handler.js';
import type { ProposedFieldInput, WithheldField } from '../resume-parse-handler.js';
import { PlainTextDocumentParser } from '../plain-text-parser.js';

/* --------------------------------- doubles --------------------------------- */

const PROVENANCE = {
  capability: AI_CAPABILITIES.DOCUMENT_PARSE,
  modelId: 'stub-layout',
  promptVersionId: 'n/a',
  producedAt: new Date('2026-01-01T00:00:00Z'),
};

const stubParser = (
  build: (document: SourceDocument) => AIOutcome<ParsedDocument>,
  version = 'stub/1.0.0',
): DocumentParser => ({ version, parse: async (document) => build(document) });

const fromMarkdown = (markdown: string): AIOutcome<ParsedDocument> => ({
  content: { text: markdown, pageCount: 1, pages: [markdown], markdown },
  confidence: 1,
  reasoningSummary: 'stub',
  sourcesUsed: ['stub'],
  provenance: PROVENANCE,
});

const stubOcr = (
  byPage: Record<number, string>,
  asked: number[] = [],
): OcrEngine & { readonly asked: number[] } => ({
  name: 'stub-ocr',
  version: '1.0.0',
  asked,
  recognize: async (request: OcrPageRequest): Promise<OcrPageOutcome> => {
    asked.push(request.page);
    const text = byPage[request.page];
    if (text === undefined) return { ok: false, reason: 'no text', permanent: true };
    return {
      ok: true,
      result: {
        page: request.page,
        text,
        lines: text.split('\n').map((line, index) => ({
          text: line,
          box: { x: 0.1, y: 0.1 + index * 0.05, width: 0.8, height: 0.04 },
          confidence: 0.92,
        })),
        confidence: 0.92,
        engine: 'stub-ocr',
      },
    };
  },
});

/** A model that returns exactly the résumé a test hands it. */
const stubExtractor = (resume: Partial<ExtractedResume>, confidence = 0.95): ResumeExtractor => ({
  version: 'stub-extractor/1.0.0',
  extract: async () => ({
    content: {
      skills: [], employment: [], education: [], languages: [],
      certifications: [], uncertainFields: [], ...resume,
    },
    confidence,
    reasoningSummary: 'stub',
    sourcesUsed: ['stub'],
    provenance: {
      capability: AI_CAPABILITIES.RESUME_EXTRACT,
      modelId: 'stub-model',
      promptVersionId: 'v1',
      producedAt: new Date(),
    },
  }),
});

const EMPTY_RESUME: ExtractedResume = {
  skills: [], employment: [], education: [], languages: [],
  certifications: [], uncertainFields: [],
};

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

const source = (over: Partial<SourceDocument> = {}): SourceDocument => ({
  documentId: 'doc-1',
  filename: 'cv.pdf',
  mimeType: 'application/pdf',
  bytes: PDF_BYTES,
  ...over,
});

const NORMAL_CV = [
  '# Ahmed Hassan', '', 'Cairo, Egypt', 'ahmed.hassan@example.test', '+20 100 123 4567', '',
  '## EXPERIENCE', '', 'Senior Structural Engineer at Arabtec Construction', '2019 - Present', '',
  '## EDUCATION', '', 'BSc in Civil Engineering, Cairo University, 2015', '',
  '## SKILLS', '', '- AutoCAD', '- ETABS',
].join('\n');

const textPipeline = (markdown = NORMAL_CV, ocrEngine?: OcrEngine) =>
  new DocumentUnderstandingPipeline({
    textParser: new PlainTextDocumentParser(),
    layoutParser: stubParser(() => fromMarkdown(markdown)),
    ...(ocrEngine !== undefined ? { ocrEngine } : {}),
  });

/** Parse, then run the evidence + validation stage exactly as production does. */
const run = async (
  pipeline: DocumentUnderstandingPipeline,
  document: SourceDocument,
  resume: ExtractedResume = EMPTY_RESUME,
  aiConfidence = 0,
): Promise<{
  parsed: AIOutcome<ParsedDocument>;
  fields: readonly ProposedFieldInput[];
  withheld: readonly WithheldField[];
}> => {
  const parsed = await pipeline.parse(document);
  if ('abstained' in parsed) return { parsed, fields: [], withheld: [] };
  const out = buildProposedFields({
    resume, document: parsed.content, aiConfidence, parser: 'test', parserVersion: '1',
  });
  return { parsed, ...out };
};

const get = (fields: readonly ProposedFieldInput[], name: string) =>
  fields.find((f) => f.field === name);

const withheldFor = (withheld: readonly WithheldField[], name: string) =>
  withheld.find((w) => w.field === name);

/* ------------------------------ 1. normal PDF ------------------------------ */

describe('1. normal text PDF', () => {
  it('routes as PDF, parses, and never touches the OCR engine', async () => {
    const ocr = stubOcr({});
    const parsed = await textPipeline(NORMAL_CV, ocr).parse(source());
    expect('abstained' in parsed).toBe(false);
    if ('abstained' in parsed) return;
    expect(parsed.content.structure?.ocrApplied).toBe(false);
    // The point of a CONDITIONAL OCR layer: a clean PDF never pays for it.
    expect(ocr.asked).toEqual([]);
  });

  it('recovers headings as canonical sections', async () => {
    const parsed = await textPipeline().parse(source());
    if ('abstained' in parsed) throw new Error('unexpected abstention');
    const canonical = parsed.content.structure?.sections.map((s) => s.canonical);
    expect(canonical).toContain('experience');
    expect(canonical).toContain('education');
    expect(canonical).toContain('skills');
  });
});

/* --------------------------- 2. multi-column PDF --------------------------- */

describe('2. multi-column PDF', () => {
  it('restores reading order from geometry instead of interleaving columns', () => {
    // Emitted in the WRONG order on purpose: a reader that trusts emission
    // order produces "Right top / Left top / Left bottom".
    const structure = buildStructuredDocument({
      provenance: { parser: 'stub', parserVersion: '1', convertedAt: new Date() },
      blocks: [
        { page: 1, text: 'Right column top', box: { x: 0.55, y: 0.10, width: 0.4, height: 0.05 } },
        { page: 1, text: 'Left column top', box: { x: 0.05, y: 0.10, width: 0.4, height: 0.05 } },
        { page: 1, text: 'Left column bottom', box: { x: 0.05, y: 0.50, width: 0.4, height: 0.05 } },
        { page: 1, text: 'Right column bottom', box: { x: 0.55, y: 0.50, width: 0.4, height: 0.05 } },
      ],
    });
    expect(structure.blocks.map((b) => b.text)).toEqual([
      'Left column top', 'Right column top', 'Left column bottom', 'Right column bottom',
    ]);
    expect(structure.blocks.map((b) => b.readingOrder)).toEqual([1, 2, 3, 4]);
  });
});

/* --------------------------------- 3. DOCX --------------------------------- */

describe('3. DOCX', () => {
  it('is identified from its container bytes plus its extension', () => {
    const route = classifyDocument({
      filename: 'ahmed.docx',
      // Deliberately mislabelled by the client: bytes and extension decide.
      mimeType: 'application/octet-stream',
      bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]),
    });
    expect(route.format).toBe('docx');
    expect(route.parserKind).toBe('layout');
  });

  it('refuses a ZIP that is not a Word document rather than guessing', () => {
    const route = classifyDocument({
      filename: 'photos.zip',
      mimeType: 'application/zip',
      bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    });
    expect(route.supported).toBe(false);
    expect(route.reason).toMatch(/not a Word document/);
  });

  it('extracts fields through the pipeline from DOCX-derived markdown', async () => {
    const { fields } = await run(textPipeline(), source({
      filename: 'ahmed.docx',
      mimeType: 'application/octet-stream',
      bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]),
    }));
    expect(get(fields, 'fullName')?.value).toBe('Ahmed Hassan');
  });
});

/* --------------------------- 4. Arabic / mixed ----------------------------- */

describe('4. Arabic and mixed-language CV', () => {
  const ARABIC_CV = [
    '# أحمد حسن', '', 'ahmed@example.test', '٠١٠٠١٢٣٤٥٦٧', '',
    '## الخبرات', '', 'مهندس إنشائي at شركة العربية للإنشاءات', '',
    '## التعليم', '', 'بكالوريوس in الهندسة المدنية, Cairo University, ٢٠١٥',
  ].join('\n');

  it('detects Arabic headings as canonical sections', async () => {
    const parsed = await textPipeline(ARABIC_CV).parse(source());
    if ('abstained' in parsed) throw new Error('unexpected abstention');
    const canonical = parsed.content.structure?.sections.map((s) => s.canonical);
    expect(canonical).toContain('experience');
    expect(canonical).toContain('education');
  });

  it('reads an Arabic-Indic phone number that an ASCII rule cannot see', async () => {
    const { parsed, fields } = await run(textPipeline(ARABIC_CV), source());
    if ('abstained' in parsed) throw new Error('unexpected abstention');
    expect(parsed.content.detectedLanguage).toMatch(/^ar/);
    // The measured Arabic failure: "٠١٠٠١٢٣٤٥٦٧" matched no [0-9] rule at all.
    expect(get(fields, 'phone')?.value).toBe('01001234567');
    // The Arabic name survives in its own script — never transliterated.
    expect(get(fields, 'fullName')?.value).toBe('أحمد حسن');
  });
});

/* ------------------------------ 5. image-only ------------------------------ */

describe('5. image-only / scanned CV', () => {
  it('triggers OCR and builds the document from the recognised text', async () => {
    const ocr = stubOcr({ 1: 'Ahmed Hassan\nahmed.hassan@example.test\n+20 100 123 4567' });
    const pipeline = new DocumentUnderstandingPipeline({
      textParser: new PlainTextDocumentParser(),
      // A layout parser that cannot read a scan — real Docling behaviour on an
      // image with no text layer.
      layoutParser: stubParser(() => ({
        abstained: true, reason: 'The document produced no text.',
        permanent: true, provenance: PROVENANCE,
      })),
      ocrEngine: ocr,
    });

    const parsed = await pipeline.parse(source({
      filename: 'scan.png', mimeType: 'image/png', bytes: PNG_BYTES,
    }));
    expect('abstained' in parsed).toBe(false);
    if ('abstained' in parsed) return;

    expect(ocr.asked).toEqual([1]);
    expect(parsed.content.structure?.ocrApplied).toBe(true);
    expect(parsed.content.text).toContain('Ahmed Hassan');
    expect(parsed.content.structure?.provenance.ocrEngine).toBe('stub-ocr');
    // THE OCR CEILING: recognised text is never presented at full confidence.
    expect(parsed.confidence).toBeLessThanOrEqual(0.8);
  });

  it('marks the page degraded rather than empty when no OCR engine is configured', async () => {
    const pipeline = new DocumentUnderstandingPipeline({
      textParser: new PlainTextDocumentParser(),
      layoutParser: stubParser(() => ({
        content: { text: ' ', pageCount: 1, pages: [' '] },
        confidence: 1, reasoningSummary: 'stub', sourcesUsed: ['stub'], provenance: PROVENANCE,
      })),
    });
    const parsed = await pipeline.parse(source());
    if ('abstained' in parsed) throw new Error('unexpected abstention');
    expect(parsed.content.structure?.degradedPages).toEqual([1]);
    expect(parsed.content.structure?.pages[0]?.ocrStatus).toBe('unavailable');
    // "We could not read it" is not "it was blank".
    expect(parsed.content.structure?.pages[0]?.ocrReason).toMatch(/no OCR engine/);
  });
});

/* ---------------------------- 6. partial OCR ------------------------------- */

describe('6. partial OCR — one bad page among good ones', () => {
  const threePages = () => buildStructuredDocument({
    provenance: { parser: 'stub', parserVersion: '1', convertedAt: new Date() },
    blocks: [
      { page: 1, text: 'A'.repeat(400), kind: 'paragraph' },
      { page: 2, text: '', kind: 'figure' },
      { page: 3, text: 'C'.repeat(400), kind: 'paragraph' },
    ],
  });

  it('the quality gate asks for exactly the unreadable page', () => {
    const quality = assessDocumentQuality(threePages());
    expect(quality.needsOcr).toEqual([2]);
    expect(quality.pages.find((p) => p.page === 2)?.findings).toContain('image-only');
    expect(quality.pages.find((p) => p.page === 1)?.sufficient).toBe(true);
  });

  it('OCR runs on that page only, and nothing is duplicated', async () => {
    const ocr = stubOcr({ 2: 'Recovered certificate page text' });
    const pipeline = new DocumentUnderstandingPipeline({
      textParser: new PlainTextDocumentParser(),
      layoutParser: stubParser(() => ({
        content: { text: 'x', pageCount: 3, pages: ['x'], structure: threePages() },
        confidence: 1, reasoningSummary: 'stub', sourcesUsed: ['stub'], provenance: PROVENANCE,
      })),
      ocrEngine: ocr,
      pageImages: { pageImage: async () => ({ bytes: PNG_BYTES, mimeType: 'image/png' }) },
    });

    const parsed = await pipeline.parse(source());
    if ('abstained' in parsed) throw new Error('unexpected abstention');

    expect(ocr.asked).toEqual([2]);
    expect(parsed.content.text).toContain('Recovered certificate page text');
    expect(parsed.content.structure?.pages[0]?.ocrStatus).toBe('not-needed');
    expect(parsed.content.structure?.pages[1]?.ocrStatus).toBe('applied');
    expect(parsed.content.structure?.pages[2]?.ocrStatus).toBe('not-needed');
    // Native page 1 appears ONCE — reconciliation chose, it did not concatenate.
    expect(parsed.content.text.split('A'.repeat(400)).length - 1).toBe(1);
  });
});

/* -------------------------- 7. structured extraction ----------------------- */

describe('7. structured extraction', () => {
  it('reads every stated field from a normal CV with rules alone', async () => {
    const { fields } = await run(textPipeline(), source());
    expect(get(fields, 'fullName')?.value).toBe('Ahmed Hassan');
    expect(get(fields, 'email')?.value).toBe('ahmed.hassan@example.test');
    expect(get(fields, 'location')?.value).toBe('Cairo, Egypt');
    expect(get(fields, 'currentPosition')?.value).toBe('Senior Structural Engineer');
    expect(get(fields, 'currentCompany')?.value).toBe('Arabtec Construction');
    expect(get(fields, 'university')?.value).toBe('Cairo University');
    expect(get(fields, 'graduationYear')?.value).toBe(2015);
    expect(get(fields, 'skills')?.value).toEqual(['AutoCAD', 'ETABS']);
  });

  it('does not invent a major from the word "education" in prose', async () => {
    const { fields } = await run(textPipeline([
      '# Sara Ali', 'sara.ali@example.test', '', 'I have no education section on this CV.',
    ].join('\n')), source());
    // The measured failure: a global keyword search made this "major: Education".
    expect(get(fields, 'major')).toBeUndefined();
  });

  it('does not accept a section heading as a person\'s name', async () => {
    const { fields } = await run(textPipeline([
      '## CONTACT INFORMATION', 'someone@example.test',
    ].join('\n')), source());
    expect(get(fields, 'fullName')).toBeUndefined();
  });
});

/* --------------------------- 8 & 9. evidence, provenance ------------------- */

describe('8. evidence and 9. provenance', () => {
  it('every proposed field cites a page and a block that exist in the document', async () => {
    const { parsed, fields } = await run(textPipeline(), source());
    if ('abstained' in parsed) throw new Error('unexpected abstention');
    const blockIds = new Set(parsed.content.structure?.blocks.map((b) => b.id));

    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      expect(field.evidence).toBeTruthy();
      expect(field.evidenceRef).toBeDefined();
      expect(field.evidenceRef?.page).toBe(1);
      expect(blockIds.has(field.evidenceRef?.blockId ?? '')).toBe(true);
    }
  });

  it('the citation survives being raised onto the CandidateProposal aggregate', async () => {
    const { fields } = await run(textPipeline(), source());
    const proposal = CandidateProposal.raise({
      id: 1, tenantId: 1, candidateId: 7, origin: 'resume.extract',
      fields, now: new Date(),
    });
    const name = proposal.fields.find((f) => f.field === 'fullName');
    expect(name?.value).toBe('Ahmed Hassan');
    expect(name?.evidenceRef?.blockId).toBeDefined();
    // Raised PENDING — never accepted by the extraction path.
    expect(name?.decision).toBe('PENDING');
    expect(proposal.status).toBe('PENDING');
    expect(proposal.acceptedPatch()).toEqual({});
  });
});

/* ------------------------------ 10. validation ----------------------------- */

describe('10. deterministic validation', () => {
  it('withholds a malformed email even when the model is certain about it', async () => {
    const { fields, withheld } = await run(
      textPipeline('# Sara Ali\n\nnot-an-email'),
      source(),
      (await stubExtractor({ email: 'not-an-email' }, 0.99).extract({
        text: '', pageCount: 1, pages: [],
      }) as { content: ExtractedResume }).content,
      0.99,
    );
    expect(get(fields, 'email')).toBeUndefined();
    expect(withheldFor(withheld, 'email')?.reason).toMatch(/well-formed/);
  });

  it('withholds a years claim its graduation year contradicts', async () => {
    const { fields, withheld } = await run(textPipeline([
      '# Sara Ali', 'sara@example.test', '',
      '## SUMMARY', 'I have 40 years of experience.', '',
      '## EDUCATION', 'BSc in Civil Engineering, Cairo University, 2020',
    ].join('\n')), source());
    expect(get(fields, 'yearsExperience')).toBeUndefined();
    expect(withheldFor(withheld, 'yearsExperience')?.reason).toMatch(/not reconcilable/);
  });
});

/* ------------------------- 11. the hallucination gate ---------------------- */

describe('11. unsupported values and abstention', () => {
  it('withholds a model value that is nowhere in the document', async () => {
    const extracted = (await stubExtractor({
      fullName: 'Ahmed Hassan',
      // Nowhere in the document below.
      location: 'Dubai, United Arab Emirates',
    }).extract({ text: '', pageCount: 1, pages: [] }) as { content: ExtractedResume }).content;

    const { fields, withheld } = await run(
      textPipeline('# Ahmed Hassan\n\nahmed@example.test'), source(), extracted, 0.95,
    );

    // THE HALLUCINATION GATE: an invented location is not proposed at all.
    expect(get(fields, 'location')).toBeUndefined();
    expect(withheldFor(withheld, 'location')?.reason).toMatch(/could not be located/);

    // The name IS in the document and a rule found it too — agreement is earned.
    expect(get(fields, 'fullName')?.confidence).toBe(0.9);
  });

  it('never gives a model-only value the confidence of a rule', async () => {
    const extracted = (await stubExtractor({
      // Stated in the prose but under no LANGUAGES heading, so the
      // section-scoped rule stays silent and the model is the only reader.
      languages: ['Arabic', 'English'],
    }, 1).extract({ text: '', pageCount: 1, pages: [] }) as { content: ExtractedResume }).content;

    const { fields } = await run(
      textPipeline('# Sara Ali\n\nsara@example.test\n\nFluent in Arabic and English.'),
      source(), extracted, 1,
    );
    const languages = get(fields, 'languages');
    expect(languages?.value).toEqual(['Arabic', 'English']);
    // Located and well-formed, so usable — but capped below a rule's weight
    // however confident the model claimed to be.
    expect(languages?.confidence).toBeLessThanOrEqual(0.5);
  });

  it('proposes nothing when the document supports nothing', async () => {
    const { fields } = await run(textPipeline('....'), source());
    expect(fields).toEqual([]);
  });
});

/* ------------------- 12. non-proposable fields never leak ------------------ */

describe('12. the proposable whitelist', () => {
  it('never proposes a field the Candidate aggregate would refuse', async () => {
    const { fields } = await run(textPipeline(), source());
    // `degree` and `headline` are extracted but are not proposable fields.
    expect(fields.map((f) => f.field)).not.toContain('degree');
    expect(fields.map((f) => f.field)).not.toContain('headline');
  });
});
