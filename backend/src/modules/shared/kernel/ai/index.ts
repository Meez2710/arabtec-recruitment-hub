// AI ports — the complete AI surface the business layer may see.
//
// No adapter exists yet and none is imported here. The Ollama/Qwen adapter will
// live in `infrastructure/ai/` and be wired only in the composition root.

export { AI_CAPABILITIES, AI_EVENTS, isProposal } from './contracts.js';
export type {
  AIAbstention, AICapability, AIEntityRef, AIEventType, AIOutcome, AIProposal,
  AIProvenance, AIResultEvent, AIResultEventPayload,
  AITaskDispatcher, AITaskHandle, AITaskRequest, AITaskState,
} from './contracts.js';

export { COMPETENCY_LEVELS } from './evidence.js';
export type {
  BlockKind, CanonicalSection, DocumentBlock, DocumentPage, DocumentProvenance,
  DocumentSection, DocumentTable, EvidenceMatch, ExtractionMethod, FieldEvidence,
  LayoutBox, OcrEngine, OcrLine, OcrPageOutcome, OcrPageRequest, OcrPageResult,
  OcrStatus, SourceLocation, StructuredDocument, TableCell,
} from './document.js';

export type {
  CandidateEvaluation, CompetencyAssessment, CompetencyLevel,
} from './evidence.js';

export type {
  AICapabilities, AnalyzedJobDescription, CandidateMatch, CandidateMatcher,
  CandidateRankingService, DocumentParser, EmbeddingVector, ExtractedEducation,
  ExtractedEmployment, ExtractedPeriod, ExtractedResume, JobDescriptionAnalyzer,
  MatchCriteria, MatchEvidence, NormalizedSkill, ParsedDocument, RankedCandidate,
  ResumeEmbeddingProvider, ResumeExtractor, SkillNormalizer, SourceDocument,
} from './capabilities.js';
