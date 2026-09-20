/**
 * Free text this read model serves that never met the capture detector.
 *
 * A briefing's own text is a fixed point of MCP's serve-time sanitizer because
 * capture made it one. Three things a reader shows are NOT briefing text and
 * were never put through it:
 *
 * - a clarification's question, typed by a block author or composed from a
 *   ticket, which can quote a CI log with a colour code in it;
 * - the failure quoted beside "never sent", which is `workflow_runs.status_reason`;
 * - anything else a row carries verbatim into a round.
 *
 * MCP rewrites every string on the way out and the dashboard rewrites nothing,
 * so an un-normalized field would read differently on the two surfaces, which
 * is the one thing this stage exists to prevent. They go through the same
 * detector here, once, before either surface sees them.
 *
 * A text the detector cannot prove clean becomes a named marker rather than
 * failing the read: the rest of the round is still worth showing, and a person
 * who sees the marker knows the text exists and why it is not here.
 */
import { configuredVisibilityDetector, redactForStorage } from "../../run-observability/visibility-detector.js";
import type { VisibilitySanitizer } from "@shared/agent-visibility";

const UNSERVABLE_TEXT = "[REDACTED: this text could not be made safe to serve]";

/** The detector over this deployment's configured secrets, made once per read
 *  rather than per field: building it compiles every secret's forms. */
function serveSafeTextWith(detect: VisibilitySanitizer): (text: string) => string {
  return (text) => {
    if (text.length === 0) return text;
    try {
      return redactForStorage(text, detect);
    } catch {
      return UNSERVABLE_TEXT;
    }
  };
}

export function serveSafeText(): (text: string) => string {
  return serveSafeTextWith(configuredVisibilityDetector());
}
