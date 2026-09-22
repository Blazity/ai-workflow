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

/**
 * The SDK's problems, plus the two only a header has, which `ctx.http` finds
 * when a value is sent: a line break, and a character above U+00FF. A setting
 * may hold either until it ends up in a header.
 */
export type ValueProblem = ConnectionValueProblem | "header_line_break" | "header_character";

export function valueProblemSentence(
  field: Pick<ConnectionField, "label" | "env">,
  problem: ValueProblem,
  source?: IntegrationSource,
): string {
  const what = {
    line_break: `The ${field.label} has a line break inside it, and it has to be a single line`,
    not_a_url: `The ${field.label} is not a web address a request can go to; it has to start with https:// (or http://)`,
    not_an_integer: `The ${field.label} has to be a whole number`,
    header_line_break: `The ${field.label} has a line break in it, which no request header can carry`,
    header_character: `The ${field.label} has a character in it that no request header can carry, usually a curly quote or an invisible character pasted from a document`,
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
  const problem = connectionValueProblem(value, field);
  return problem === null
    ? null
    : { reason: "value_malformed", message: valueProblemSentence(field, problem, source) };
}
