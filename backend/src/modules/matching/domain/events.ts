export const MATCHING_EVENTS = {
  MATCH_SUGGESTED: 'CandidateMatchSuggested',
  MATCH_DISMISSED: 'CandidateMatchDismissed',
  MATCH_LINKED: 'CandidateMatchLinked',
} as const;

export type MatchingEventType = (typeof MATCHING_EVENTS)[keyof typeof MATCHING_EVENTS];
