import {
  type ConnectionField,
  type ConnectionValueProblem,
  connectionValueProblem,
} from "@integrations/sdk";
import type { IntegrationFailure, IntegrationSource } from "@shared/contracts";

/**
 * What an admin reads about a connection value that cannot be what its field
 * is: the sentence for `value_malformed`.
 *
 * The rule is the SDK's (`connectionValueProblem`, which the conformance check
 * also applies to a manifest's defaults); the words are core's, and live here
 * so that the status a card shows, a connection test and `ctx.http` refusing
 * to send say the same thing about the same value. Each names the field, and
 * where the value came from when that is known, and never repeats the value:
 * it is often a secret, and a secret with a stray line break in it is still
 * the secret.
 */

/** The SDK's problems, plus the one only a header has: a character above
 *  U+00FF, which a text field may legitimately hold until it is sent. */
export type ValueProblem = ConnectionValueProblem | "not_header_safe";

export function valueProblemSentence(
  field: Pick<ConnectionField, "label" | "env">,
  problem: ValueProblem,
  source?: IntegrationSource,
): string {
  const what = {
    line_break: `The ${field.label} has a line break in it, which no request can carry`,
    not_a_url: `The ${field.label} is not a web address a request can go to; it has to start with https://`,
    not_an_integer: `The ${field.label} has to be a whole number`,
    not_header_safe: `The ${field.label} has a character in it that no request header can carry, usually a curly quote or an invisible character pasted from a document`,
  }[problem];
  const fix =
    source === "environment"
      ? `Set ${field.env} again on this deployment`
      : source === "stored"
        ? "Enter it again"
        : null;
  return fix === null ? `${what}.` : `${what}. ${fix}.`;
}

/** The failure a value that is not what its field is makes, or null. `value`
 *  is the normalized string, the one a request would be built from. */
export function malformedValueFailure(
  field: ConnectionField,
  value: string,
  source: IntegrationSource,
): IntegrationFailure | null {
  const problem = connectionValueProblem(value, field.format);
  return problem === null
    ? null
    : { reason: "value_malformed", message: valueProblemSentence(field, problem, source) };
}
