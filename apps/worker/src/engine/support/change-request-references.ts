/**
 * The provider-native naming on every pull request core hands a messaging
 * integration: its reference and its noun.
 *
 * An integration may import only `@integrations/sdk`, so it cannot ask the
 * registry how GitLab names a merge request. Core can, and does it here, once,
 * where the event leaves core: a GitLab team reads `MR ready (!12)` in the
 * channel, the same reference the run view shows, instead of `PR ready (#12)`,
 * where `#12` names an issue.
 */
import { changeRequestNaming } from "@integrations/registry";
import type { TicketEvent } from "@integrations/sdk";

export function withChangeRequestReferences(event: TicketEvent): TicketEvent {
  if (event.kind !== "pr_ready") return event;
  return {
    ...event,
    prs: event.prs.map((pr) => {
      const naming = changeRequestNaming(pr);
      return { ...pr, reference: naming.reference, noun: naming.noun };
    }),
  };
}
