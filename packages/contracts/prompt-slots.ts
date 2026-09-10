import type {
  JsonSchema202012,
  JsonValue,
  WorkflowDataReferenceV2,
  WorkflowInputBindingV2,
} from "./domain";

/** A typed value a reusable prompt requires from the workflow that includes it. */
export interface PromptSlotDefinition {
  name: string;
  description: string;
  schema: JsonSchema202012;
  required: boolean;
  defaultValue?: JsonValue;
}

/** Slot values use the same canonical reference-or-literal contract as v2 inputs. */
export type PromptSlotBinding = WorkflowInputBindingV2;

export interface ParsedPromptSlotToken {
  raw: string;
  start: number;
  end: number;
  name: string;
}

export interface ParsedPromptDataToken {
  raw: string;
  start: number;
  end: number;
  reference: WorkflowDataReferenceV2;
}
