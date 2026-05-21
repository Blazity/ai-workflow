import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { preSandboxStepRegistry, type PreSandboxStepId } from "./steps/index.js";
import type { PreSandboxConfig } from "./types.js";

const preSandboxConfigSchema = z
  .object({
    preSandbox: z
      .object({
        runOn: z
          .object({
            newTicket: z.boolean(),
            existingPr: z.boolean(),
            mergeConflict: z.boolean(),
          })
          .strict(),
        steps: z.array(
          z
            .object({
              uses: z.string().min(1),
              name: z.string().trim().min(1).optional(),
              timeoutMs: z.number().int().positive().optional(),
              onFailure: z.enum(["continue", "fail", "move_to_backlog"]),
              with: z.unknown().optional(),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();

export function defaultPreSandboxConfigPath(): string {
  return resolve(process.cwd(), "pre-sandbox.yaml");
}

export function loadPreSandboxConfig(
  configPath = defaultPreSandboxConfigPath(),
): PreSandboxConfig<PreSandboxStepId> {
  let parsedYaml: unknown;

  try {
    parsedYaml = parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    if (isNodeErrorWithCode(err, "ENOENT")) {
      throw new Error(`Missing pre-sandbox config at ${configPath}`);
    }

    throw new Error(`Failed to read pre-sandbox config at ${configPath}: ${errorMessage(err)}`);
  }

  return parsePreSandboxConfig(parsedYaml);
}

export function parsePreSandboxConfig(value: unknown): PreSandboxConfig<PreSandboxStepId> {
  const result = preSandboxConfigSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      "Invalid pre-sandbox config:\n" +
        result.error.issues.map((issue) => `  ${formatIssuePath(issue.path)}: ${issue.message}`).join("\n"),
    );
  }

  const unknownSteps = result.data.preSandbox.steps
    .map((step, index) => ({ index, uses: step.uses }))
    .filter((step) => !(step.uses in preSandboxStepRegistry));

  if (unknownSteps.length > 0) {
    throw new Error(
      "Invalid pre-sandbox config:\n" +
        unknownSteps
          .map((step) => `  preSandbox.steps.${step.index}.uses: unknown pre-sandbox step "${step.uses}"`)
          .join("\n"),
    );
  }

  return result.data as PreSandboxConfig<PreSandboxStepId>;
}

function formatIssuePath(path: Array<string | number>): string {
  return path.length > 0 ? path.join(".") : "root";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isNodeErrorWithCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}
