// Build a `StructuredDocument` from whatever structure a parser recovered.
//
// TWO INPUTS, ONE OUTPUT. A layout-aware parser that reports real blocks with
// geometry is used as-is. A parser that reports only Markdown and page text is
// re-structured here, because Markdown headings, list markers and pipe tables
// ARE structure — throwing them away and calling the result "plain text" would
// discard what the layout pass recovered.
//
// This is a pure function of its input: no I/O, no model, no network. It is the
// only place that knows how Markdown maps onto blocks, so changing that mapping
// cannot leak into the pipeline or the extractor.

import type {
  BlockKind, CanonicalSection, DocumentBlock, DocumentPage, DocumentSection,
  DocumentTable, ExtractionMethod, LayoutBox, StructuredDocument, TableCell,
} from '../../../modules/shared/kernel/ai/index.js';

/**
 * A block as a parser reports it, before ids and ordering are assigned.
 *
 * Deliberately looser than `DocumentBlock`: an adapter should not have to
 * invent ids or a global sequence, which are this module's job.
 */
export interface RawBlock {
  readonly page: number;
  readonly kind?: BlockKind;
  readonly text: string;
  readonly level?: number;
  readonly box?: LayoutBox;
  readonly table?: DocumentTable;
  readonly method?: ExtractionMethod;
  readonly confidence?: number;
}

/* ---------------------------- section vocabulary --------------------------- */

/**
 * Heading text to canonical section, in the languages this deployment sees.
 *
 * Matching is done on a lowercased, punctuation-stripped heading, so "WORK
 * EXPERIENCE:" and "Work Experience" collide. Arabic entries are matched on the
 * same folded form produced by `foldHeading` below.
 */
const SECTION_WORDS: ReadonlyArray<readonly [CanonicalSection, readonly string[]]> = [
  ['contact', ['contact', 'contact information', 'contact details', 'personal information',
    'personal details', 'بيانات الاتصال', 'معلومات الاتصال', 'البيانات الشخصية']],
  ['summary', ['summary', 'profile', 'professional summary', 'objective', 'about',
    'career objective', 'نبذة', 'الملخص', 'الهدف الوظيفي']],
  ['experience', ['experience', 'work experience', 'professional experience',
    'employment', 'employment history', 'work history', 'career history',
    'الخبرات', 'الخبرة العملية', 'الخبرات العملية', 'التاريخ الوظيفي']],
  ['education', ['education', 'academic background', 'academic qualifications',
    'qualifications', 'التعليم', 'المؤهلات', 'المؤهلات العلمية', 'الدراسة']],
  ['skills', ['skills', 'technical skills', 'core skills', 'competencies',
    'key skills', 'المهارات', 'المهارات التقنية']],
  ['certifications', ['certifications', 'certificates', 'licenses',
    'certifications and licenses', 'الشهادات', 'الدورات']],
  ['languages', ['languages', 'language proficiency', 'اللغات']],
  ['projects', ['projects', 'selected projects', 'key projects', 'المشاريع']],
  ['links', ['links', 'online profiles', 'portfolio', 'references', 'روابط']],
];

/** Lowercase, strip punctuation and collapse spaces. Script-preserving. */
const foldHeading = (text: string): string => text
  .toLowerCase()
  .replace(/[:\-–—_*#|]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/** Canonical section for a heading, or 'other' when it matches nothing known. */
export const canonicalSectionFor = (heading: string): CanonicalSection => {
  const folded = foldHeading(heading);
  if (folded === '') return 'other';
  for (const [canonical, words] of SECTION_WORDS) {
    for (const word of words) {
      // Equality, not substring: "no education section" must not match
      // 'education'. A heading IS its whole text.
      if (folded === word) return canonical;
    }
  }
  return 'other';
};

/* ------------------------------ markdown → blocks -------------------------- */

const HEADING = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM = /^\s*(?:[-*+•]|\d+[.)])\s+(.*)$/;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
/** A Markdown table's separator, e.g. `| --- | :--: |`. Carries no content. */
const TABLE_DIVIDER = /^\s*\|[\s:|-]+\|\s*$/;

const splitRow = (line: string): string[] => {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map((cell) => cell.trim());
};

/**
 * Consume a run of table rows starting at `start`.
 *
 * Returns the table and the index of the first line after it. A table is kept
 * as a grid rather than flattened, because a CV's dated employment table loses
 * which date belonged to which role the moment it becomes prose.
 */
const readTable = (lines: readonly string[], start: number): {
  readonly table: DocumentTable; readonly text: string; readonly next: number;
} => {
  const rows: string[][] = [];
  let i = start;
  let headerRows = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (TABLE_DIVIDER.test(line)) {
      // Everything read so far was the header.
      if (rows.length > 0) headerRows = rows.length;
      i += 1;
      continue;
    }
    if (!TABLE_ROW.test(line)) break;
    rows.push(splitRow(line));
    i += 1;
  }

  const cells: TableCell[] = [];
  let columnCount = 0;
  rows.forEach((row, rowIndex) => {
    columnCount = Math.max(columnCount, row.length);
    row.forEach((text, columnIndex) => {
      cells.push({
        row: rowIndex,
        column: columnIndex,
        text,
        ...(rowIndex < headerRows ? { header: true } : {}),
      });
    });
  });

  return {
    table: { rowCount: rows.length, columnCount, cells },
    // A readable linearisation for the flat views. The grid above stays the
    // authoritative form; this is a rendering of it, not a replacement.
    text: rows.map((row) => row.join(' | ')).join('\n'),
    next: i,
  };
};

/**
 * Turn one page of Markdown (or plain text) into blocks.
 *
 * Plain text degrades gracefully: with no Markdown syntax present every
 * non-empty paragraph becomes a `paragraph` block, which is still a truthful
 * structure — just a flat one.
 */
export const blocksFromMarkdown = (
  markdown: string,
  page: number,
  method: ExtractionMethod = 'native',
): RawBlock[] => {
  const lines = markdown.split(/\r?\n/);
  const blocks: RawBlock[] = [];
  let paragraph: string[] = [];

  const flush = (): void => {
    if (paragraph.length === 0) return;
    // Joined with a newline, NOT a space: in a CV the line break is content.
    // "John Doe / Software Engineer / email" collapsed onto one line makes the
    // name indistinguishable from the rest of the letterhead.
    const text = paragraph.join('\n').trim();
    paragraph = [];
    if (text !== '') blocks.push({ page, kind: 'paragraph', text, method });
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (line.trim() === '') { flush(); i += 1; continue; }

    if (TABLE_ROW.test(line) || TABLE_DIVIDER.test(line)) {
      flush();
      const { table, text, next } = readTable(lines, i);
      if (table.rowCount > 0) {
        blocks.push({ page, kind: 'table', text, table, method });
        i = next;
        continue;
      }
      i += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const level = (heading[1] ?? '#').length;
      const text = (heading[2] ?? '').trim();
      if (text !== '') {
        blocks.push({ page, kind: level === 1 ? 'title' : 'heading', text, level, method });
      }
      i += 1;
      continue;
    }

    // A bare line that IS a known section name — "EXPERIENCE", "التعليم" — is a
    // heading even without Markdown syntax, which is how a plain-text or
    // pdf-derived CV carries its sections. Matched on equality only, so a
    // sentence mentioning education is never promoted.
    const bare = line.trim();
    if (bare.length <= 40 && canonicalSectionFor(bare) !== 'other') {
      flush();
      blocks.push({ page, kind: 'heading', text: bare, level: 2, method });
      i += 1;
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      flush();
      const text = (item[1] ?? '').trim();
      if (text !== '') blocks.push({ page, kind: 'list-item', text, method });
      i += 1;
      continue;
    }

    paragraph.push(line.trim());
    i += 1;
  }
  flush();
  return blocks;
};

/* --------------------------------- assembly -------------------------------- */

export interface StructureInput {
  readonly blocks: readonly RawBlock[];
  readonly provenance: StructuredDocument['provenance'];
  /** Per-page OCR outcome, keyed by 1-based page number. */
  readonly pageStatus?: ReadonlyMap<number, {
    readonly ocrStatus: DocumentPage['ocrStatus'];
    readonly reason?: string;
  }>;
}

/** Reading order within a page when the parser reported geometry: top, then left. */
const byPosition = (a: RawBlock, b: RawBlock): number => {
  if (a.box === undefined || b.box === undefined) return 0;
  // A row band, so two columns' first lines are not interleaved by sub-point
  // jitter. Blocks within one band sort left-to-right, which is what recovers
  // a two-column CV's reading order.
  const band = 0.02;
  if (Math.abs(a.box.y - b.box.y) > band) return a.box.y - b.box.y;
  return a.box.x - b.box.x;
};

/**
 * Assemble ids, global reading order, sections and pages.
 *
 * Sections are built by walking blocks in reading order and opening a new
 * section at every heading, nesting by level. A block before the first heading
 * belongs to no section, which is correct: a name at the top of a CV is not
 * "in" the Experience section, and pretending otherwise is how a heading ends
 * up proposed as a person's name.
 */
export const buildStructuredDocument = (input: StructureInput): StructuredDocument => {
  const pages = [...new Set(input.blocks.map((b) => b.page))].sort((a, b) => a - b);

  const ordered: DocumentBlock[] = [];
  let sequence = 0;
  for (const page of pages) {
    const pageBlocks = input.blocks.filter((b) => b.page === page);
    const hasGeometry = pageBlocks.every((b) => b.box !== undefined);
    // Only re-sort when every block has geometry. A partial sort would move
    // positioned blocks around unpositioned ones and scramble the order the
    // parser already got right.
    const sorted = hasGeometry ? [...pageBlocks].sort(byPosition) : pageBlocks;
    for (const block of sorted) {
      sequence += 1;
      ordered.push({
        id: `b${sequence}`,
        page,
        readingOrder: sequence,
        kind: block.kind ?? 'unknown',
        text: block.text,
        method: block.method ?? 'native',
        ...(block.level !== undefined ? { level: block.level } : {}),
        ...(block.box !== undefined ? { box: block.box } : {}),
        ...(block.table !== undefined ? { table: block.table } : {}),
        ...(block.confidence !== undefined ? { confidence: block.confidence } : {}),
      });
    }
  }

  /* sections */
  const sections: DocumentSection[] = [];
  const blockSection = new Map<string, string>();
  /** Open headings, outermost first. Popped when a shallower heading arrives. */
  const stack: Array<{ id: string; level: number; blockIds: string[] }> = [];
  let sectionSeq = 0;

  for (const block of ordered) {
    if (block.kind === 'heading' || block.kind === 'title') {
      const level = block.level ?? 1;
      while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
      sectionSeq += 1;
      const id = `s${sectionSeq}`;
      const parent = stack[stack.length - 1];
      const canonical = canonicalSectionFor(block.text);
      sections.push({
        id,
        title: block.text,
        level,
        blockIds: [],
        ...(canonical !== 'other' ? { canonical } : {}),
        ...(parent !== undefined ? { parentId: parent.id } : {}),
      });
      stack.push({ id, level, blockIds: [] });
      blockSection.set(block.id, id);
      continue;
    }
    const open = stack[stack.length - 1];
    if (open !== undefined) {
      open.blockIds.push(block.id);
      blockSection.set(block.id, open.id);
    }
  }

  // Re-emit sections with their body blocks. The heading block itself is
  // excluded: a section's content is what follows the heading, and including
  // the heading is how "EDUCATION" gets read as an education value.
  const withBlocks: DocumentSection[] = sections.map((section) => ({
    ...section,
    blockIds: ordered
      .filter((b) => blockSection.get(b.id) === section.id
        && b.kind !== 'heading' && b.kind !== 'title')
      .map((b) => b.id),
  }));

  const blocksWithSection: DocumentBlock[] = ordered.map((block) => {
    const sectionId = blockSection.get(block.id);
    return sectionId === undefined ? block : { ...block, sectionId };
  });

  /* pages */
  const degraded: number[] = [];
  const documentPages: DocumentPage[] = pages.map((page) => {
    const pageBlocks = blocksWithSection.filter((b) => b.page === page);
    const status = input.pageStatus?.get(page);
    const ocrStatus = status?.ocrStatus ?? 'not-needed';
    if (ocrStatus === 'unavailable' || ocrStatus === 'failed') degraded.push(page);
    const methods = new Set(pageBlocks.map((b) => b.method));
    const method: ExtractionMethod = methods.size > 1
      ? 'reconciled'
      : ([...methods][0] ?? 'native');
    return {
      number: page,
      blockIds: pageBlocks.map((b) => b.id),
      text: pageBlocks.map((b) => b.text).join('\n'),
      method,
      ocrStatus,
      ...(status?.reason !== undefined ? { ocrReason: status.reason } : {}),
    };
  });

  return {
    blocks: blocksWithSection,
    sections: withBlocks,
    pages: documentPages,
    provenance: input.provenance,
    ocrApplied: blocksWithSection.some((b) => b.method === 'ocr' || b.method === 'reconciled'),
    degradedPages: degraded,
  };
};

/**
 * The structure a parser reported, or one recovered from what it did report.
 *
 * ONE definition of "how do I get blocks out of a ParsedDocument", used by both
 * the pipeline and the extraction stage. A parser that returns real blocks with
 * geometry is always preferred; Markdown headings, lists and tables are the
 * next best thing; per-page plain text is the floor. None of these is a second
 * document model — they are three fidelities of the same one.
 */
export const structureOf = (document: {
  readonly text: string;
  readonly pages: readonly string[];
  readonly pageCount: number;
  readonly markdown?: string;
  readonly structure?: StructuredDocument;
}, parser = 'unknown-parser', parserVersion = 'unversioned'): StructuredDocument => {
  if (document.structure !== undefined) return document.structure;

  const blocks: RawBlock[] = [];
  if (document.markdown !== undefined && document.markdown.trim() !== '') {
    // A single Markdown blob has no page boundaries. Page 1 is the honest
    // answer: inventing page breaks would put a false page number into every
    // piece of evidence.
    blocks.push(...blocksFromMarkdown(document.markdown, 1));
  } else {
    document.pages.forEach((pageText, index) => {
      blocks.push(...blocksFromMarkdown(pageText, index + 1));
    });
  }

  if (blocks.length === 0 && document.text.trim() !== '') {
    blocks.push({ page: 1, kind: 'paragraph', text: document.text.trim(), method: 'native' });
  }

  // A parser that returned pages but no blocks still has pages, and they must
  // exist in the structure or the quality gate cannot flag them.
  if (blocks.length === 0) {
    const count = Math.max(1, document.pageCount);
    for (let page = 1; page <= count; page += 1) {
      blocks.push({ page, kind: 'unknown', text: '', method: 'native' });
    }
  }

  return buildStructuredDocument({
    blocks,
    provenance: { parser, parserVersion, convertedAt: new Date() },
  });
};

/** The flat text view, in reading order. Derived — never a second source. */
export const flattenStructure = (structure: StructuredDocument): string => structure.pages
  .map((page) => page.text)
  .join('\n\n')
  .trim();
