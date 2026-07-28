import type { JsonSchema202012 } from "./domain.js";

export interface ReviewResultFinding {
  file: string;
  description: string;
  severity: "critical" | "suggestion";
  startLine?: number;
  endLine?: number;
}

export interface ReviewResult {
  decision: "approve" | "request_changes";
  findings: ReviewResultFinding[];
  feedback?: string;
}

/**
 * The code-owned structural contract shared by Review Agent outputs and every
 * consumer of review results. Additional fields are accepted so compatible
 * custom-agent envelopes can be projected onto this canonical shape.
 *
 * The cross-field line invariant (`endLine >= startLine`) is enforced by the
 * shared runtime normalizer because JSON Schema cannot compare sibling numeric
 * values without a non-standard extension.
 */
export const REVIEW_RESULT_JSON_SCHEMA: JsonSchema202012 = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    decision: {
      type: "string",
      enum: ["approve", "request_changes"],
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          description: { type: "string" },
          severity: {
            type: "string",
            enum: ["critical", "suggestion"],
          },
          startLine: { type: "number" },
          endLine: { type: "number" },
        },
        required: ["file", "description", "severity"],
        additionalProperties: true,
      },
    },
    feedback: { type: "string" },
  },
  required: ["decision", "findings"],
  additionalProperties: true,
};
