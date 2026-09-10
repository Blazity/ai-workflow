export type GeneratedFiles = {
  catalog: string;
  params: string;
  executors: string;
};

export type GeneratorOptions = {
  root: string;
  blocksRoot?: string;
  outputPaths?: Partial<{
    catalog: string;
    params: string;
    executors: string;
  }>;
};

export type BlockCategory = "trigger" | "action" | "control";
type ExecutionKind = "map" | "inline" | "graph";

export type StaticValue =
  | null
  | boolean
  | number
  | string
  | StaticValue[]
  | { [key: string]: StaticValue };

export type ManifestRecord = {
  directory: string;
  manifestPath: string;
  type: string;
  category: BlockCategory;
  ports: string[];
  allowsFailurePort: boolean;
  ui: {
    group: string;
    label: string;
    description: string;
    glyph: string;
    color: string;
    softColor: string;
  };
  defaults: StaticValue;
  inputs: StaticValue;
  additionalInputs: StaticValue;
  execution: ExecutionKind;
  hasExecute: boolean;
};

export const DEFAULT_OUTPUT_PATHS = {
  catalog: "packages/contracts/block-catalog.generated.ts",
  params: "apps/worker/src/engine/definition/params.generated.ts",
  executors: "apps/worker/src/engine/blocks/executors.generated.ts",
} as const;

export const GENERATED_HEADER =
  "// THIS FILE IS GENERATED. DO NOT EDIT.\n// Run pnpm run gen:blocks to update.\n\n";

/** Compare Unicode code points without locale-dependent collation. */
export function compareCodePoints(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftCodePoint = leftPoints[index]!.codePointAt(0)!;
    const rightCodePoint = rightPoints[index]!.codePointAt(0)!;
    if (leftCodePoint !== rightCodePoint) return leftCodePoint - rightCodePoint;
  }
  return leftPoints.length - rightPoints.length;
}
