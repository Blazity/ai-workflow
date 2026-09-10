import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

const paramsSchema = z
  .object({
    message: z.string().trim().max(2000).optional(),
    sendOn: z.enum(["pr_ready", "always"]).optional(),
  })
  .strict();


export const manifest = {
  type: "send_slack_message",
  paramsSchema,
  contract: {
    category: "action",
    ports: ["out"],
    allowsFailurePort: true,
  },
  ui: {
    group: "utility",
    label: "Send Slack message",
    description: "Notifies the configured Slack channel about a workflow milestone.",
    glyph: "✉",
    color: "#64748B",
    softColor: "#EEF1F5",
  },
  defaults: { message: "", sendOn: "pr_ready" },
  inputs: {
    message: { required: false, schema: { type: "string" } },
  },
  execution: "inline",
} satisfies BlockManifest;
