import type { WorkflowSubjectField } from "./subject-default";

/** JSON-shaped values used by the generated block catalog contracts. */
type BlockCatalogJsonValue =
  | string
  | number
  | boolean
  | null
  | BlockCatalogJsonValue[]
  | { [key: string]: BlockCatalogJsonValue };

export type WorkflowParamValue = string | number | boolean | string[];

export interface WorkflowValueSchemaMetadata {
  description?: string;
  enum?: BlockCatalogJsonValue[];
}

/** Small JSON-shaped type language used by block input and output contracts. */
export type WorkflowValueSchema =
  | ({ type: "string" } & WorkflowValueSchemaMetadata)
  | ({ type: "number" } & WorkflowValueSchemaMetadata)
  | ({ type: "boolean" } & WorkflowValueSchemaMetadata)
  | ({ type: "null" } & WorkflowValueSchemaMetadata)
  | ({ type: "unknown" } & WorkflowValueSchemaMetadata)
  | ({ type: "nullable"; value: WorkflowValueSchema } & WorkflowValueSchemaMetadata)
  | ({ type: "array"; items: WorkflowValueSchema } & WorkflowValueSchemaMetadata)
  | ({
      type: "object";
      properties: Record<string, WorkflowValueSchema>;
      required: string[];
      additionalProperties: boolean;
    } & WorkflowValueSchemaMetadata);

export type WorkflowBlockGroup =
  | "trigger"
  | "agents"
  | "workspace"
  | "control"
  | "ticket"
  | "vcs"
  | "human"
  | "utility";

export interface WorkflowBlockInputContract {
  required: boolean;
  schema: WorkflowValueSchema;
  /**
   * Where the input's value comes from when nothing is bound: these fields of
   * the run's ticket, joined by `subjectDefaultText`. A required input with a
   * default is satisfied without a binding, and the editor says where the
   * value comes from. Text inputs only.
   */
  defaultFromSubject?: readonly WorkflowSubjectField[];
}

/** A registry-owned family of additional named inputs. */
export interface WorkflowBlockAdditionalInputContract {
  keyPattern: string;
  schema: WorkflowValueSchema;
}
