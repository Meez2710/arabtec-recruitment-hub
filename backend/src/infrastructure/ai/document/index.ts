// The document-understanding layer's public surface.

export { DocumentUnderstandingPipeline } from './document-understanding-pipeline.js';
export type { PipelineOptions } from './document-understanding-pipeline.js';

export { assessDocumentQuality, DEFAULT_THRESHOLDS } from './quality-gate.js';
export type {
  DocumentQuality, PageQuality, QualityFinding, QualityThresholds,
} from './quality-gate.js';

export { blocksFromOcr, reconcilePage, reconcilePages, similarity } from './reconcile.js';
export type { PageReconciliation, ReconciliationReport } from './reconcile.js';

export { classifyDocument, SourceBytesPageImages } from './routing.js';
export type {
  DocumentFormat, DocumentRoute, PageImage, PageImageSource, ParserKind, RoutingInput,
} from './routing.js';

export {
  blocksFromMarkdown, buildStructuredDocument, canonicalSectionFor, flattenStructure,
} from './structure-builder.js';
export type { RawBlock, StructureInput } from './structure-builder.js';
