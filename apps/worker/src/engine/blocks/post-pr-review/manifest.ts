import { z } from "zod";
import type { BlockManifest, WorkflowValueSchema } from "@shared/contracts";

const reviewResultSchema = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["approve", "request_changes"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          description: { type: "string" },
          severity: { type: "string", enum: ["Blocker", "High", "Medium", "Nit"] },
          startLine: { type: "number" },
          endLine: { type: "number" },
          repo: { type: "string" },
        },
        required: ["file", "description", "severity"],
        additionalProperties: true,
      },
    },
    feedback: { type: "string" },
  },
  required: ["decision", "findings"],
  additionalProperties: true,
} satisfies WorkflowValueSchema;

const paramsSchema = z.object({}).strict();


export const manifest = {
  type: "post_pr_review",
  paramsSchema,
  contract: {
    category: "action",
    ports: ["out"],
    allowsFailurePort: false,
  },
  ui: {
    group: "vcs",
    label: "Post PR review",
    description: "Publishes compatible review findings against the exact reviewed commit.",
    glyph: "✎",
    color: "#3C43E7",
    softColor: "#ECECFD",
  },
  defaults: {},
  inputs: {
    reviewResults: {
      required: true,
      schema: { type: "array", items: reviewResultSchema },
    },
  },
  execution: "map",
} satisfies BlockManifest;
