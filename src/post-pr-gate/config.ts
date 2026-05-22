import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { postPrGateStepRegistry, type PostPrGateStepId } from "./steps/index.js";
import type { PostPrGateConfig } from "./types.js";

const postPrGateConfigSchema = z
  .object({
    postPrGate: z
      .object({
        runOn: z
          .object({
            botPrsOnly: z.boolean(),
            draftPrs: z.boolean(),
            baseBranches: z.array(z.string().min(1)),
          })
          .strict(),
        steps: z.array(
          z
            .object({
              uses: z.string().min(1),
              name: z.string().trim().min(1).optional(),
              timeoutMs: z.number().int().positive().optional(),
              onFailure: z.enum(["continue", "fail"]),
              with: z.unknown().optional(),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();

export function defaultPostPrGateConfigPath(): string {
  return resolve(process.cwd(), "post-pr-gate.yaml");
}

export function loadPostPrGateConfig(
  configPath = defaultPostPrGateConfigPath(),
): PostPrGateConfig<PostPrGateStepId> {
  let parsedYaml: unknown;
  try {
    parsedYaml = parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    if (isNodeErrorWithCode(err, "ENOENT")) {
      throw new Error(`Missing post-pr-gate config at ${configPath}`);
    }
    throw new Error(
      `Failed to read post-pr-gate config at ${configPath}: ${errorMessage(err)}`,
    );
  }
  return parsePostPrGateConfig(parsedYaml);
}

export function parsePostPrGateConfig(
  value: unknown,
): PostPrGateConfig<PostPrGateStepId> {
  const result = postPrGateConfigSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      "Invalid post-pr-gate config:\n" +
        result.error.issues
          .map((issue) => `  ${formatPath(issue.path)}: ${issue.message}`)
          .join("\n"),
    );
  }
  const unknown = result.data.postPrGate.steps
    .map((step, index) => ({ index, uses: step.uses }))
    .filter((s) => !(s.uses in postPrGateStepRegistry));
  if (unknown.length > 0) {
    throw new Error(
      "Invalid post-pr-gate config:\n" +
        unknown
          .map(
            (s) =>
              `  postPrGate.steps.${s.index}.uses: unknown post-pr-gate step "${s.uses}"`,
          )
          .join("\n"),
    );
  }
  return result.data as PostPrGateConfig<PostPrGateStepId>;
}

function formatPath(path: Array<string | number>): string {
  return path.length > 0 ? path.join(".") : "root";
}
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
function isNodeErrorWithCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}
