import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

const paramsSchema = z
  .object({ body: z.string().trim().max(8000).optional() })
  .strict();


export const manifest = {
  type: "post_ticket_comment",
  paramsSchema,
  contract: {
    category: "action",
    ports: ["out"],
    allowsFailurePort: true,
  },
  ui: {
    group: "ticket",
    label: "Post ticket comment",
    description: "Posts questions, plans, or status updates to the ticket.",
    glyph: "❝",
    color: "#2563EB",
    softColor: "#E9EFFD",
  },
  defaults: { body: "" },
  inputs: {
    body: { required: false, schema: { type: "string" } },
  },
  execution: "map",
} satisfies BlockManifest;
