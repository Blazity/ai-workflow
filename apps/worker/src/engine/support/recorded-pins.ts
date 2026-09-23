/**
 * THE ONE READING OF A RUN'S RECORDED PINS, for the provider a call is about to
 * use. Every runtime that hands a run a provider (version control, messaging,
 * memory, the issue tracker) asks this, so they cannot come to disagree about
 * the same run.
 *
 * A run pins the connection each provider it reaches had at its start
 * (`integrationPinsFor`), and a later use compares the pin recorded for that
 * provider against the provider as it is now: reconfigured, disabled or
 * disconnected stops the run there. What this decides is the other case, a
 * provider the run holds no pin for.
 *
 * - No pins at all (absent or empty): nothing holds the run, so the call
 *   proceeds against the provider as it is configured now.
 *   `RunIntegrationPins` in `vcs-runtime.ts` names who arrives that way.
 *
 * - Version control: not pinned either. A repository names its provider, and
 *   several providers serve version control side by side, so a provider the
 *   run did not record is a repository it did not reach at its start, never a
 *   switch of something it did. This is also what keeps a run suspended before
 *   a deploy working: pins are a recorded step result, replayed unchanged, so
 *   such a run comes back with the narrower set its build recorded (an agent
 *   plus send_message run pinned only its chat provider), and reading GitHub's
 *   absence from it as "moved" stopped the run at its next VCS call, telling a
 *   person the connection changed when nobody touched it.
 *
 * - A capability one provider serves at a time (messaging, memory, the issue
 *   tracker): the run recorded the providers it started with and this one was
 *   not among them, so it arrived after the run started, alone or in place of
 *   the one the run used. Serving it would move where the run posts or
 *   remembers, mid-run, with nobody told, which is the switch the pin exists
 *   to catch; it reads as `disconnected`, as it always has.
 */
import type { IntegrationConnectionPin } from "@shared/contracts";

/** How the capability picks its provider, which is what absence means. */
export type ProviderSelection = "per_repository" | "one_per_deployment";

export type RecordedPin =
  | { readonly kind: "pinned"; readonly pin: IntegrationConnectionPin }
  | { readonly kind: "not_pinned" }
  | { readonly kind: "arrived_after_start" };

export function recordedPinFor(
  pins: readonly IntegrationConnectionPin[] | undefined,
  integrationId: string,
  selection: ProviderSelection,
): RecordedPin {
  const pin = pins?.find((candidate) => candidate.integrationId === integrationId);
  if (pin) return { kind: "pinned", pin };
  if (!pins || pins.length === 0 || selection === "per_repository") return { kind: "not_pinned" };
  return { kind: "arrived_after_start" };
}
