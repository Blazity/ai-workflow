import type { PostPrGateStepRegistry } from "../types.js";
import { codeHygiene } from "./code-hygiene.js";
import { prTitleFormat } from "./pr-title-format.js";

export const postPrGateStepRegistry = {
  "pr-title-format": prTitleFormat,
  "code-hygiene": codeHygiene,
} satisfies PostPrGateStepRegistry;

export type PostPrGateStepId = keyof typeof postPrGateStepRegistry;
