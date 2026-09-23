/**
 * How core applies what a tracing provider asked for to a sandbox.
 *
 * An integration describes what a harness needs (packages, files, variables,
 * hooks) and knows nothing about how a harness is wired. This file is the
 * other half: it owns the directory each provider gets, the order the pieces
 * land in, and the map from the moments the contract names to the hook each
 * harness actually has.
 *
 * Nothing here fails a run. Tracing watches the work; it is not the work, so a
 * package that will not install or a file that will not land leaves the run
 * untraced and says so in the log. Two things it must never do: put a value a
 * provider marked as a connection secret on a command line (a command is
 * recorded with the sandbox and read back on a screen, a file written through
 * `writeFiles` is not), and put a provider's hook variables in the agent's own
 * environment, where the agent and everything it starts could read them. Those
 * go to a mode-600 file in the provider's directory that only its hook
 * commands source.
 */
import type { AgentTracingEvent } from "@integrations/sdk";
import { AGENT_TRACING_DIR_TOKEN } from "@integrations/sdk";
import { logger } from "../../infra/logger.js";
import type { AgentRuntimePaths, AgentTracingPlan, RunnableSandbox } from "./types.js";

/** The moments the contract names, mapped to what a harness calls them. */
export type HarnessHookEvents = Partial<Record<AgentTracingEvent, string>>;

/**
 * Where a provider's files live in the sandbox. One directory each, under a
 * name core owns: two providers shipping a `tracer.py` must not overwrite each
 * other, and neither may land inside a harness's own configuration directory.
 */
function tracingDirectory(integrationId: string): string {
  return `$HOME/.aiw-tracing/${integrationId}`;
}

/** The same directory, quoted for a shell line core writes itself. */
function quotedTracingDirectory(integrationId: string): string {
  return `"${tracingDirectory(integrationId)}"`;
}

/** The file holding a provider's hook variables, inside its own directory. */
const HOOK_ENV_FILE = "hook.env";

const VARIABLE_NAME = /^[A-Z][A-Z0-9_]*$/;

function exportLines(
  integrationId: string,
  variables: Readonly<Record<string, string>> | undefined,
): string[] {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(variables ?? {})) {
    if (!VARIABLE_NAME.test(name)) {
      logger.warn({ integration: integrationId, name }, "agent_tracing_env_name_refused");
      continue;
    }
    lines.push(`export ${name}=${shellQuote(value)}`);
  }
  return lines;
}

function hasHookEnvironment(plan: AgentTracingPlan): boolean {
  return Object.keys(plan.setup.hookEnvironment ?? {}).length > 0;
}

/**
 * The variables a provider asked the agent process itself to have, as shell
 * lines for the agent env file. They are written through `writeFiles` and the
 * file is `chmod 600`, which keeps them out of the sandbox's command record.
 * Hook variables are not here: see `installTracingPlans`.
 */
export function tracingEnvironmentLines(plans: readonly AgentTracingPlan[]): string[] {
  return plans.flatMap((plan) => exportLines(plan.integrationId, plan.setup.environment));
}

/**
 * The hooks to register, as `[harness event, command]`. A moment this harness
 * does not have is left out rather than refused: Codex has no failure hook,
 * and a provider that asked for one still gets the other four.
 */
export function tracingHookCommands(
  plans: readonly AgentTracingPlan[],
  events: HarnessHookEvents,
): Array<readonly [string, string]> {
  const commands: Array<readonly [string, string]> = [];
  for (const plan of plans) {
    const directory = tracingDirectory(plan.integrationId);
    // The hook loads its provider's variables itself, so they exist for the
    // hook and nowhere else. Guarded rather than sourced blindly: a shell that
    // cannot source a file exits, and a hook that exits 2 before a tool call
    // blocks the agent's tool instead of losing one trace.
    const envFile = `"${directory}/${HOOK_ENV_FILE}"`;
    const prefix = hasHookEnvironment(plan) ? `[ -r ${envFile} ] && . ${envFile}; ` : "";
    for (const hook of plan.setup.hooks ?? []) {
      const harnessEvent = events[hook.event];
      if (!harnessEvent) continue;
      commands.push([
        harnessEvent,
        `${prefix}${hook.command.split(AGENT_TRACING_DIR_TOKEN).join(directory)}`,
      ]);
    }
  }
  return commands;
}

/**
 * Everything the connected tracing providers asked for, applied to a sandbox:
 * the packages and files, then the hooks, registered through `registerHooks`,
 * which is the harness's own settings writer.
 *
 * THE ONE PLACE "TRACING NEVER FAILS A RUN" IS KEPT, which is why each harness
 * calls this rather than the pieces below. The harness's settings writer
 * throws on a non-zero exit, as it must for the commit guard it also writes,
 * so a tracing hook that could not be merged would otherwise fail the run it
 * was only meant to watch. Here it leaves the sandbox untraced and says so.
 */
export async function applyTracingPlans(input: {
  sandbox: RunnableSandbox;
  plans: readonly AgentTracingPlan[];
  harness: string;
  events: HarnessHookEvents;
  registerHooks: (hooks: Array<readonly [string, string]>) => Promise<void>;
  runtime?: AgentRuntimePaths;
}): Promise<void> {
  if (input.plans.length === 0) return;
  const ready = await installTracingPlans(input.sandbox, input.plans, input.harness, input.runtime);
  const hooks = tracingHookCommands(ready, input.events);
  if (hooks.length === 0) return;
  try {
    await input.registerHooks(hooks);
  } catch (error) {
    // The installed files, hook.env among them, stay where they are on
    // purpose: they sit in the provider's own 700 directory with no hook left
    // to read them, and removing them is one more sandbox command that can
    // fail on a path that exists to never fail. The sandbox dies with the run.
    logger.warn(
      {
        harness: input.harness,
        integrations: ready.map((plan) => plan.integrationId),
        reason: "hooks_failed",
        error: errorMessage(error),
      },
      "agent_tracing_off",
    );
  }
}

/**
 * Install the packages and write the files. Returns the plans that are ready,
 * so a provider whose install failed contributes no hooks either: a hook
 * calling a script that is not there fails on every tool call an agent makes.
 * Never throws: a provider whose install failed, however it failed, is left
 * out and the line logged for it says why.
 */
export async function installTracingPlans(
  sandbox: RunnableSandbox,
  plans: readonly AgentTracingPlan[],
  harness: string,
  runtime?: AgentRuntimePaths,
): Promise<AgentTracingPlan[]> {
  const ready: AgentTracingPlan[] = [];
  for (const plan of plans) {
    logger.info({ integration: plan.integrationId, harness }, "agent_tracing_install_started");
    if (await installOne(sandbox, plan, runtime)) {
      ready.push(plan);
      logger.info({ integration: plan.integrationId, harness }, "agent_tracing_install_complete");
    }
  }
  if (plans.length > 0 && ready.length === 0) {
    // One line per sandbox that set out to be traced and is not. The reason
    // for each provider is on the line logged just before this one.
    logger.warn(
      { harness, integrations: plans.map((plan) => plan.integrationId), reason: "install_failed" },
      "agent_tracing_off",
    );
  }
  return ready;
}

/** A file written to /tmp on its way into the provider's directory. */
type StagedFile = { path: string; target: string; mode: "600" | "700" };

/**
 * One provider's install, contained. The sandbox API can reject rather than
 * answer with an exit code (a write that did not land, a command the sandbox
 * could not start), and that is the same untraced run as a non-zero exit, not
 * a failed one. The staging copies are removed on that path too, because one
 * of them may hold the provider's key.
 */
async function installOne(
  sandbox: RunnableSandbox,
  plan: AgentTracingPlan,
  runtime?: AgentRuntimePaths,
): Promise<boolean> {
  const staged: StagedFile[] = [];
  const progress = { step: "packages" as "packages" | "files" };
  try {
    return await stageAndInstall(sandbox, plan, runtime, staged, progress);
  } catch (error) {
    logger.warn(
      { integration: plan.integrationId, error: errorMessage(error) },
      progress.step === "packages" ? "agent_tracing_packages_failed" : "agent_tracing_files_failed",
    );
    await discardStaged(sandbox, staged, runtime);
    return false;
  }
}

async function stageAndInstall(
  sandbox: RunnableSandbox,
  plan: AgentTracingPlan,
  runtime: AgentRuntimePaths | undefined,
  staged: StagedFile[],
  progress: { step: "packages" | "files" },
): Promise<boolean> {
  const python = (plan.setup.packages ?? [])
    .filter((entry) => entry.ecosystem === "python")
    .map((entry) => shellQuote(entry.minVersion ? `${entry.name}>=${entry.minVersion}` : entry.name));
  if (python.length > 0) {
    const install = await sandbox.runCommand("bash", [
      "-c",
      withRuntimeHome(
        runtime,
        `python3 -m ensurepip --user && python3 -m pip install --user --quiet ${python.join(" ")}`,
      ),
    ]);
    if (install.exitCode !== 0) {
      logger.warn({ integration: plan.integrationId }, "agent_tracing_packages_failed");
      return false;
    }
  }

  progress.step = "files";
  // Every path judged before anything is written, so a refusal on the third
  // file cannot leave the first two staged in /tmp.
  const files = plan.setup.files ?? [];
  const refused = files.find((file) => !isSafeRelativePath(file.path));
  if (refused) {
    logger.warn(
      { integration: plan.integrationId, path: refused.path },
      "agent_tracing_file_path_refused",
    );
    return false;
  }

  const directory = quotedTracingDirectory(plan.integrationId);
  // Each copy is recorded before it is written, so a write that failed halfway
  // is still removed by the caller's cleanup.
  for (const [index, file] of files.entries()) {
    const staging = `/tmp/aiw-tracing-${plan.integrationId}-${index}`;
    // The provider chose this name; quoted, so a space or a `$(...)` in it is
    // a file name and nothing else.
    staged.push({
      path: staging,
      target: `${directory}/${shellQuote(file.path)}`,
      mode: file.executable ? "700" : "600",
    });
    await sandbox.writeFiles([
      { path: staging, content: Buffer.from(file.contentBase64, "base64") },
    ]);
  }
  const hookEnvironment = exportLines(plan.integrationId, plan.setup.hookEnvironment);
  if (hookEnvironment.length > 0) {
    const staging = `/tmp/aiw-tracing-${plan.integrationId}-${HOOK_ENV_FILE}`;
    staged.push({ path: staging, target: `${directory}/${HOOK_ENV_FILE}`, mode: "600" });
    await sandbox.writeFiles([
      { path: staging, content: Buffer.from(`${hookEnvironment.join("\n")}\n`) },
    ]);
  }
  if (staged.length === 0) return true;

  const script = [
    `mkdir -p ${directory}`,
    `chmod 700 ${directory}`,
    ...staged.flatMap(({ path, target, mode }) => [
      `mkdir -p "$(dirname ${target})"`,
      `mv ${path} ${target}`,
      `chmod ${mode} ${target}`,
    ]),
  ].join(" && ");
  // The staging copies go whatever happens to the moves. One of them holds the
  // provider's key, and a chain that stopped at the second file would
  // otherwise leave it world-readable in /tmp for the rest of the sandbox's
  // life. `rm -f` after a successful `mv` is a no-op, so the exit code the
  // caller reads is still the moves' own.
  const move = await sandbox.runCommand("bash", [
    "-c",
    withRuntimeHome(runtime, `{ ${script}; }; moved=$?; ${removeStagedCommand(staged)}; exit $moved`),
  ]);
  if (move.exitCode !== 0) {
    logger.warn({ integration: plan.integrationId }, "agent_tracing_files_failed");
    return false;
  }
  return true;
}

function removeStagedCommand(staged: readonly StagedFile[]): string {
  return `rm -f ${staged.map(({ path }) => path).join(" ")}`;
}

/** Best effort: the sandbox that just refused a call may refuse this one too,
 *  and the run goes on either way. */
async function discardStaged(
  sandbox: RunnableSandbox,
  staged: readonly StagedFile[],
  runtime: AgentRuntimePaths | undefined,
): Promise<void> {
  if (staged.length === 0) return;
  try {
    await sandbox.runCommand("bash", ["-c", withRuntimeHome(runtime, removeStagedCommand(staged))]);
  } catch {
    // Nothing more to do from here; the failure that brought us here is logged.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A provider writes inside its own directory, and only there. */
function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/")) return false;
  return !path.split("/").includes("..");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function withRuntimeHome(runtime: AgentRuntimePaths | undefined, command: string): string {
  return runtime ? `export HOME=${shellQuote(runtime.homeDir)}\n${command}` : command;
}
