// A DocumentParser for text documents. NOT AI.
//
// Turning bytes into text is decoding, not inference — and having one real
// parser means the whole parse pipeline is exercisable end to end today,
// without a model and without waiting for the AI phase.
//
// It handles what it can and ABSTAINS on everything else. PDF and DOCX support
// belongs in the AI phase alongside the Ollama adapter; guessing at binary
// formats here would produce plausible-looking garbage, which is worse than a
// clear "I cannot read this".

import type {
  AIOutcome, DocumentParser, ParsedDocument, SourceDocument,
} from '../../modules/shared/kernel/ai/index.js';
import { AI_CAPABILITIES } from '../../modules/shared/kernel/ai/index.js';

const READABLE = /^(text\/|application\/(json|xml))/i;

export class PlainTextDocumentParser implements DocumentParser {
  readonly modelId = 'plain-text-decoder';
  readonly version = '1.0.0';

  async parse(document: SourceDocument): Promise<AIOutcome<ParsedDocument>> {
    const provenance = {
      capability: AI_CAPABILITIES.DOCUMENT_PARSE,
      modelId: this.modelId,
      promptVersionId: 'n/a',
      producedAt: new Date(),
    };

    if (!READABLE.test(document.mimeType)) {
      return {
        abstained: true,
        reason: `${document.mimeType} needs a parser this deployment does not have.`,
        // PERMANENT: this file will never be readable by this parser. A
        // different deployment needs a different parser, not a retry.
        permanent: true,
        provenance,
      };
    }

    const text = new TextDecoder('utf-8', { fatal: false }).decode(document.bytes);
    if (text.trim() === '') {
      // PERMANENT: the bytes are what they are.
      return {
        abstained: true, reason: 'The document contains no text.',
        permanent: true, provenance,
      };
    }

    // Form feed is the conventional page break in extracted text.
    const pages = text.split('\f').map((p) => p.trim()).filter((p) => p !== '');

    return {
      content: {
        text,
        pageCount: Math.max(1, pages.length),
        pages: pages.length > 0 ? pages : [text],
      },
      // Decoding is exact. This is not a model's guess.
      confidence: 1,
      reasoningSummary: 'Decoded as UTF-8 text; no inference performed.',
      sourcesUsed: [document.documentId],
      provenance,
    };
  }
}
