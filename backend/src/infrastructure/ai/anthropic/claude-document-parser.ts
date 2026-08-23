// Reading the document — the `DocumentParser` port, backed by Claude.
//
// WHAT THIS REPLACES. The Docling sidecar, the HTTP OCR engine and the local
// pdfjs/mammoth reader were three services that had to agree about one page.
// Claude reads the PDF itself, including scanned pages and Arabic, so the
// routing/OCR/reconciliation layer has nothing left to decide.
//
// IT STILL RETURNS A STRUCTURED DOCUMENT. The extraction layer locates every
// proposed value in a block and cites it back to a page; a parser that returned
// a flat blob would silently withhold every field. Claude is therefore asked
// for MARKDOWN, and the existing structure builder turns that into blocks,
// sections and pages exactly as it does for a sidecar's markdown.

import type Anthropic from '@anthropic-ai/sdk';
import type {
  AIOutcome, DocumentParser, ParsedDocument, SourceDocument,
} from '../../../modules/shared/kernel/ai/index.js';
import { AI_CAPABILITIES } from '../../../modules/shared/kernel/ai/index.js';
import { blocksFromMarkdown, buildStructuredDocument } from '../document/structure-builder.js';
import {
  clientFor, PROMPT_VERSION, textOf, type ClaudeConfig,
} from './client.js';

export const PARSER_VERSION = 'claude-document-parser@1';

const SYSTEM = [
  'You transcribe curricula vitae into Markdown for a construction and',
  'engineering recruiter in the MENA region.',
  '',
  'Rules:',
  '- Reproduce the document faithfully. Transcribe, never summarise, never',
  '  reorder, never invent a heading the document does not have.',
  '- Use "#"-style headings for the document\'s own section headings, "-" for',
  '  bullets, and Markdown tables for tabular content.',
  '- Preserve reading order. For a two-column layout, finish the logical',
  '  reading order of the page rather than reading straight across.',
  '- Keep Arabic text in Arabic. Do not translate, transliterate or reorder it.',
  '- Separate pages with a line containing only "---".',
  '- Output ONLY the Markdown. No preamble, no commentary, no code fence.',
].join('\n');

/** Image media types Claude accepts. TIFF is not among them. */
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const TEXT_TYPES = new Set(['text/plain', 'text/markdown']);
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const abstain = (reason: string, permanent: boolean): AIOutcome<ParsedDocument> => ({
  abstained: true,
  reason,
  permanent,
  provenance: {
    capability: AI_CAPABILITIES.DOCUMENT_PARSE,
    modelId: PARSER_VERSION,
    promptVersionId: PROMPT_VERSION,
    producedAt: new Date(),
  },
});

/**
 * Build the user content for one document.
 *
 * A PDF goes to Claude as a document block — it is read natively, pages and
 * all. A DOCX has no such block type, so its text is extracted locally first;
 * that is the ONE piece of local document handling left in this deployment.
 */
const contentFor = async (
  document: SourceDocument,
): Promise<Anthropic.ContentBlockParam[] | { readonly error: string }> => {
  const mime = document.mimeType;
  const instruction: Anthropic.TextBlockParam = {
    type: 'text',
    text: 'Transcribe this document to Markdown, following the rules exactly.',
  };

  if (mime === 'application/pdf') {
    return [{
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: Buffer.from(document.bytes).toString('base64'),
      },
    }, instruction];
  }

  if (IMAGE_TYPES.has(mime)) {
    return [{
      type: 'image',
      source: {
        type: 'base64',
        media_type: mime as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
        data: Buffer.from(document.bytes).toString('base64'),
      },
    }, instruction];
  }

  if (TEXT_TYPES.has(mime)) {
    const text = Buffer.from(document.bytes).toString('utf8');
    if (text.trim() === '') return { error: 'The document contains no text.' };
    return [{ type: 'text', text: `<document>\n${text}\n</document>` }, instruction];
  }

  if (mime === DOCX) {
    // mammoth ships no bundled types; the one call used here is stable.
    const mammoth = (await import('mammoth')) as unknown as {
      extractRawText(input: { buffer: Buffer }): Promise<{ value: string }>;
    };
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(document.bytes) });
    if (value.trim() === '') return { error: 'The Word document contains no text.' };
    return [{ type: 'text', text: `<document>\n${value}\n</document>` }, instruction];
  }

  return { error: `This deployment cannot read "${mime}" documents.` };
};

export class ClaudeDocumentParser implements DocumentParser {
  readonly version = PARSER_VERSION;

  private readonly client: Anthropic;

  constructor(private readonly config: ClaudeConfig) {
    this.client = clientFor(config);
  }

  async parse(document: SourceDocument): Promise<AIOutcome<ParsedDocument>> {
    const started = Date.now();

    const content = await contentFor(document);
    // PERMANENT: a format this deployment cannot read does not become readable
    // on a retry, and neither does an empty file.
    if ('error' in content) return abstain(content.error, true);

    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create({
        model: this.config.model,
        max_tokens: 16_000,
        system: SYSTEM,
        // Transcription is mechanical. Effort buys accuracy on judgement, and
        // there is no judgement here — only faithful reading.
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content }],
      });
    } catch (error) {
      // TEMPORARY: a network or rate-limit failure is about the moment, not
      // the document. The SDK has already retried.
      return abstain(
        `Claude could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        false,
      );
    }

    // A refusal is a first-class answer here, not an exception: the reviewer is
    // told the model declined rather than being shown an empty CV.
    if (message.stop_reason === 'refusal') {
      return abstain('Claude declined to read this document.', true);
    }

    const markdown = textOf(message);
    if (markdown === '') return abstain('Claude returned no text for this document.', false);

    const pages = markdown.split(/^---$/m).map((p) => p.trim()).filter((p) => p !== '');
    const effective = pages.length > 0 ? pages : [markdown];

    const blocks = effective.flatMap(
      (page, index) => blocksFromMarkdown(page, index + 1, 'native'),
    );

    const structure = buildStructuredDocument({
      blocks,
      provenance: {
        parser: PARSER_VERSION,
        parserVersion: this.config.model,
        convertedAt: new Date(),
        pipelineVersion: PROMPT_VERSION,
      },
    });

    return {
      content: {
        text: effective.join('\n\n'),
        markdown,
        pageCount: effective.length,
        pages: effective,
        structure,
      },
      // The parser's job is faithfulness, and it either produced text or
      // abstained above. Judgement about individual VALUES happens downstream.
      confidence: 0.9,
      reasoningSummary: `Transcribed ${effective.length} page(s) with ${this.config.model}.`,
      sourcesUsed: [document.documentId],
      provenance: {
        capability: AI_CAPABILITIES.DOCUMENT_PARSE,
        modelId: `${this.config.model}/${PARSER_VERSION}`,
        promptVersionId: PROMPT_VERSION,
        producedAt: new Date(),
        latencyMs: Date.now() - started,
      },
    };
  }
}
