import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

const paramsSchema = z
  .object({ target: z.string().trim().min(1).max(200) })
  .strict();


export const manifest = {
  type: "update_ticket_status",
  paramsSchema,
  contract: {
    category: "action",
    ports: ["out"],
    allowsFailurePort: true,
  },
  ui: {
    group: "ticket",
    label: "Update ticket status",
    description: "Moves the ticket to a configured provider status.",
    glyph: "▤",
    color: "#2563EB",
    softColor: "#E9EFFD",
  },
  defaults: { target: "ai_review" },
  inputs: {
    target: { required: false, schema: { type: "string" } },
  },
  execution: "inline",
} satisfies BlockManifest;
