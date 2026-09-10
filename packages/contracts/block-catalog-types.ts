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
  | "utility"
  | "arthur";

export interface WorkflowBlockInputContract {
  required: boolean;
  schema: WorkflowValueSchema;
}

/** A registry-owned family of additional named inputs. */
export interface WorkflowBlockAdditionalInputContract {
  keyPattern: string;
  schema: WorkflowValueSchema;
}
