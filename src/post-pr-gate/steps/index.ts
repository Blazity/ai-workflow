import type { PostPrGateStepRegistry } from "../types.js";
import { prTitleFormat } from "./pr-title-format.js";

export const postPrGateStepRegistry = {
  "pr-title-format": prTitleFormat,
} satisfies PostPrGateStepRegistry;

export type PostPrGateStepId = keyof typeof postPrGateStepRegistry;
