import { z } from "zod";
import type { BlockManifest, WorkflowValueSchema } from "@shared/contracts";

const reviewFeedbackSchema = {
  type: "object",
  properties: {
    state: { type: "string", enum: ["changes_requested", "commented"] },
    author: { type: "string" },
    body: { type: "string" },
  },
  required: ["state", "author", "body"],
  additionalProperties: false,
} satisfies WorkflowValueSchema;
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

const paramsSchema = z
  .object({
    provider: z.enum(["claude", "codex"]).optional(),
    model: z.string().trim().max(200).regex(/^[A-Za-z0-9._:/-]+$/u).optional(),
    instructions: z.string().trim().max(4000).optional(),
    maxMinutes: z.number().int().min(5).max(60).default(25),
  })
  .strict();


export const manifest = {
  type: "fix_agent",
  paramsSchema,
  contract: {
    category: "action",
    ports: ["out"],
    allowsFailurePort: true,
  },
  ui: {
    group: "agents",
    label: "Fix agent",
    description: "Applies review, CI, or conflict remediation in a managed workspace.",
    glyph: "✚",
    color: "#7C3AED",
    softColor: "#F2EBFD",
  },
  defaults: { maxMinutes: 25 },
  inputs: {
    reviewFeedback: { required: false, schema: reviewFeedbackSchema },
    reviewResults: {
      required: false,
      schema: { type: "array", items: reviewResultSchema },
    },
  },
  execution: "map",
} satisfies BlockManifest;
