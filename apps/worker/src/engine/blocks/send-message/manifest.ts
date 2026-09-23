import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

/**
 * Send a message about this run to wherever this deployment's people are.
 *
 * Runs on the `messaging` capability, so which chat product carries it is the
 * deployment's answer and not this block's. It was `send_slack_message` until
 * S9 of the integrations plan; the parameters, the ports and the status
 * variants are exactly what they were, so a graph published against the old
 * type keeps its bindings and its branches.
 */
const paramsSchema = z
  .object({
    message: z.string().trim().max(2000).optional(),
    sendOn: z.enum(["pr_ready", "always"]).optional(),
  })
  .strict();


export const manifest = {
  type: "send_message",
  paramsSchema,
  contract: {
    category: "action",
    ports: ["out"],
    allowsFailurePort: true,
  },
  ui: {
    group: "utility",
    label: "Send message",
    description:
      "Tells the connected messaging integration about a milestone of this run: the pull requests it published, or a message you write.",
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
