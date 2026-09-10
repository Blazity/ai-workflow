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

const paramsSchema = z.object({}).strict();


export const manifest = {
  type: "review_agent",
  paramsSchema,
  contract: {
    category: "action",
    ports: ["out"],
    allowsFailurePort: true,
  },
  ui: {
    group: "agents",
    label: "Review agent",
    description: "Reviews the current workspace diff before publication.",
    glyph: "☰",
    color: "#7C3AED",
    softColor: "#F2EBFD",
  },
  defaults: {},
  inputs: {
    reviewFeedback: { required: false, schema: reviewFeedbackSchema },
  },
  execution: "inline",
} satisfies BlockManifest;
