// Formal event catalogue for the Offer context.

export const OFFER_EVENTS = {
  OFFER_DRAFTED: 'OfferDrafted',
  OFFER_STATUS_CHANGED: 'OfferStatusChanged',
  OFFER_SUBMITTED: 'OfferSubmitted',
  OFFER_APPROVED: 'OfferApproved',
  OFFER_SENT: 'OfferSent',
  OFFER_ACCEPTED: 'OfferAccepted',
  OFFER_DECLINED: 'OfferDeclined',
  OFFER_EXPIRED: 'OfferExpired',
  OFFER_WITHDRAWN: 'OfferWithdrawn',
  COMPENSATION_CHANGED: 'OfferCompensationChanged',
} as const;

export type OfferEventType = (typeof OFFER_EVENTS)[keyof typeof OFFER_EVENTS];

export const OFFER_EVENT_TYPES: readonly OfferEventType[] = Object.values(OFFER_EVENTS);

export function isOfferEventType(type: string): type is OfferEventType {
  return (OFFER_EVENT_TYPES as readonly string[]).includes(type);
}
