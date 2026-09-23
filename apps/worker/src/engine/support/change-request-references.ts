/**
 * The provider-native reference on every pull request core hands a messaging
 * integration.
 *
 * An integration may import only `@integrations/sdk`, so it cannot ask the
 * registry how GitLab names a merge request. Core can, and does it here, once,
 * where the event leaves core: a GitLab team reads `!12` in the channel, the
 * same reference the run view shows, instead of `#12`, which names an issue
 * there.
 */
import { changeRequestNaming } from "@integrations/registry";
import type { TicketEvent } from "@integrations/sdk";

export function withChangeRequestReferences(event: TicketEvent): TicketEvent {
  if (event.kind !== "pr_ready") return event;
  return {
    ...event,
    prs: event.prs.map((pr) => ({ ...pr, reference: changeRequestNaming(pr).reference })),
  };
}
