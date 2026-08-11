# ADR-0007 — Cross-context reads go through gateway ports

**Status:** Accepted · **Context:** Hiring module, Phase 1

## Context

Closing a requisition must be refused while a candidate holds a sent, unresolved
offer (Document 2 §5). That fact lives in the Offer context, which does not exist
yet.

Three options: query the `offer` table directly from Hiring; wait for the Offer
module before implementing close; or define the dependency as an interface Hiring
owns.

## Decision

Hiring declares `OfferGateway` — an interface **it owns**, expressed in **its**
vocabulary:

```ts
interface OfferGateway {
  applicationsWithLiveOffers(requisitionId: number, ctx: AuthContext): Promise<readonly number[]>
}
```

The Offer module implements it when it arrives. Until then a stub returning
empty satisfies it.

This is an anti-corruption layer. Hiring never learns what an offer *is* — only
which applications currently block a close.

## Consequences

**Good**

- Hiring is buildable and testable before the Offer module exists.
- The coupling is one narrow, named method rather than a table dependency.
- Offer's internal model can change freely; only the adapter moves.
- It composes with the module boundary rule: modules meet at `index.ts` and at
  gateways, nowhere else.

**Accepted costs**

- A stub returning empty means the close-block is **unenforced until the Offer
  module lands**. That is a behavioural gap, and it is listed as a risk rather
  than hidden inside a passing test.
- Each cross-context need adds an interface. Acceptable while they stay few; if
  Hiring accumulates several gateways to one context, that is a signal the
  boundary is drawn in the wrong place and should be revisited.
