/**
 * Agent visibility: the record of what one send gave a model, and of every
 * answer a repository question received.
 *
 * The declared interface of this cluster. Cross-cluster imports must target
 * this file.
 *
 * The write half of a briefing is NOT here: capture runs inside a step, and
 * the engine may not import a service (ADR-001), so it lives beside the
 * detector in `run-observability/agent-briefings.ts` and is re-exported here
 * for service callers. The read half (stage 4) joins it.
 */
export {
  recordAnswerDelivery,
  type AnswerDeliveryRecord,
  type ClarificationDeliverySurface,
  type RecordAnswerDeliveryOptions,
  type RecordAnswerDeliveryOutcome,
} from "./deliveries.js";
export {
  recordAgentBriefing,
  type RecordAgentBriefingOptions,
  type RecordAgentBriefingOutcome,
} from "../../run-observability/agent-briefings.js";
export {
  BRIEFING_REDACTS_PERSONAL_DATA,
  configuredVisibilityDetector,
  createVisibilityDetector,
  redactForStorage,
} from "../../run-observability/visibility-detector.js";
