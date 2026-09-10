import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

const paramsSchema = z.object({}).strict();


export const manifest = {
  type: "prepare_workspace",
  paramsSchema,
  contract: {
    category: "action",
    ports: ["out"],
    allowsFailurePort: true,
  },
  ui: {
    group: "workspace",
    label: "Prepare workspace",
    description: "Selects repositories and creates or reuses a managed code workspace.",
    glyph: "⊞",
    color: "#0f7f8b",
    softColor: "#E7F2F3",
  },
  defaults: {},
  inputs: {},
  execution: "inline",
} satisfies BlockManifest;
