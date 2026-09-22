/**
 * The webhook slot: what an integration does with a request a provider sent
 * to `/webhooks/<id>`, and what core does with the answer.
 *
 * The split is the point. The integration owns the transport: it verifies the
 * signature over the exact bytes, reads the provider's own encoding, decides
 * who is allowed to speak, and renders and delivers whatever core answers.
 * Core owns the decision: which runs are live, which one to cancel, what a
 * reset cleared. Otherwise the next messaging provider re-implements run
 * control, and the one after that implements it differently.
 *
 * Two constraints come from the providers themselves and are in the shape:
 *
 * - **The bytes, raw.** Every provider worth verifying signs the body it sent,
 *   not a re-encoding of it. `rawBody` is the string the route read before
 *   anything parsed it; a route that parsed JSON first would break every
 *   form-encoded slash command.
 * - **Answer first, work afterwards.** A slash command has about three seconds
 *   to be acknowledged. `receive` returns the acknowledgement; core then runs
 *   the command and calls `deliver` with the outcome, which the integration
 *   sends back the way its provider expects (a callback URL, a second API
 *   call). That is also why `deliver` is told about a failure: without it a
 *   handler that threw would leave the person reading "Working on ..." for
 *   ever.
 */
import type {
  JsonValue,
  PostPrGateWorkflowInput,
  RunControlCommand,
  RunControlOutcome,
  TrackerTicketEvent,
  TriggerEvent,
} from "@shared/contracts";
import type { IntegrationContext } from "./context";
import type { IntegrationManifest } from "./manifest";

export type { PrTriggerPayload, TrackerTicketEvent, TriggerEvent } from "@shared/contracts";

/** One request, as the route captured it. */
export interface IntegrationWebhookRequest {
  readonly method: string;
  /** Exactly the bytes the provider signed, before anything parsed them. */
  readonly rawBody: string;
  /** Header names lowercased, as HTTP says they compare. */
  readonly headers: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
}

/**
 * What the provider gets back within its own deadline. A string body is sent
 * as text; anything else as JSON.
 */
export interface IntegrationWebhookResponse {
  readonly status: number;
  readonly body?: JsonValue | string;
}

export type IntegrationWebhookReception =
  /**
   * Verified and understood, and there is nothing for core to decide: help
   * text, an unknown command, a person who may not use this. The integration
   * has already said everything there is to say.
   */
  | { readonly kind: "answered"; readonly response: IntegrationWebhookResponse }
  /**
   * Verified: core runs `command` and hands the outcome to `deliver`, with
   * `deliverTo` exactly as it was returned. `response` is what the provider
   * receives meanwhile.
   */
  | {
      readonly kind: "run_control";
      readonly command: RunControlCommand;
      readonly response: IntegrationWebhookResponse;
      /**
       * Where the outcome goes. Opaque to core, JSON, and it travels no
       * further than back into this integration, so it may hold a one-shot
       * callback URL and must hold no secret of the connection.
       */
      readonly deliverTo: JsonValue;
    }
  /**
   * Verified provider events. The integration owns provider vocabulary and
   * returns only the normalized trigger contract that core dispatches.
   */
  | {
      readonly kind: "trigger_events";
      readonly events: readonly TriggerEvent[];
      readonly response: IntegrationWebhookResponse;
      readonly legacyGate?: {
        /**
         * The provider's own word for what happened, which the gate compares
         * against `"reopened"` and otherwise only records. Core must not read
         * anything else out of it: see `headMoved`.
         */
        readonly action: string;
        /**
         * Whether this delivery moved the head of a pull request that already
         * existed. Core asks its ownership record whether that head is one of
         * ours before it starts the gate, and only a push can be. It is a flag
         * rather than a comparison on `action` because that word is the
         * provider's: matching one provider's spelling of a push silently
         * leaves every other provider's push unchecked.
         */
        readonly headMoved?: boolean;
        /**
         * Who pushed, when `headMoved` is true. NOT the pull request's author:
         * on a pull request this product opened, the author is always our own
         * automation account, so core deciding "was this push ours" from
         * `workflowInput.author` answers yes to every human push and skips the
         * gate on exactly the changes it exists to check.
         *
         * REQUIRED, because a default here is a wrong answer that nothing
         * notices. An integration that genuinely cannot say who pushed sends
         * an empty string, and core then runs the gate rather than suppressing
         * a push it cannot attribute: the safe direction is checking a change
         * twice, never skipping the check on a human's change.
         */
        readonly pusher: string;
        readonly workflowInput: PostPrGateWorkflowInput;
      };
    }
  /**
   * Verified ticket events from an issue tracker. The integration read the
   * provider's encoding and said who acted; what a ticket moving means for a
   * run is core's, because dispatch, cancellation, clarification and plan
   * approval are the product rather than the tracker.
   *
   * `ignored` is not the absence of an event. It is the integration saying it
   * understood the delivery and there is nothing here for this deployment: a
   * keepalive with no ticket in it, a ticket in a project this connection does
   * not watch. Core records it as an accepted delivery with that reason, so a
   * delivery log shows why a well formed request did nothing.
   */
  | {
      readonly kind: "ticket_events";
      readonly events: readonly TrackerTicketEvent[];
      readonly response: IntegrationWebhookResponse;
      readonly ignored?: { readonly reason: string; readonly ticketKey?: string };
    }
  /**
   * Refused. `status` is the provider's language for it: a bad or stale
   * signature is 401, a configuration that is missing is 503. The route
   * answers with `reason` as the status message, so it reaches the sender:
   * keep it to what you would tell them.
   */
  | { readonly kind: "refused"; readonly status: number; readonly reason: string };

export interface IntegrationWebhook<M extends IntegrationManifest> {
  /**
   * Verify the request and say what it is. Runs on the provider's clock, so it
   * does the least it can: a signature, a parse, an allowlist.
   */
  readonly receive: (
    request: IntegrationWebhookRequest,
    ctx: IntegrationContext<M>,
  ) => Promise<IntegrationWebhookReception>;
  /**
   * Render and send core's outcome, after the acknowledgement. Required in
   * practice by any integration whose `receive` returns `run_control`: core
   * runs the command either way, because that is what the person asked for,
   * and logs that the answer could not be delivered.
   *
   * Failures are the integration's own to swallow. Core does not retry.
   */
  readonly deliver?: (
    delivery: { readonly to: JsonValue; readonly outcome: RunControlOutcome },
    ctx: IntegrationContext<M>,
  ) => Promise<void>;
}
