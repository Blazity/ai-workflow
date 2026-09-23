import type { IntegrationRunStart, IntegrationRunState } from "./run-state";

/**
 * `agent_tracing`: where an agent's work goes to be watched.
 *
 * A coding agent runs as a CLI inside a sandbox core provisions, so a tracing
 * provider cannot hold a client of its own in our process: whatever it needs
 * has to arrive in that sandbox before the agent starts. The port is therefore
 * a description of what a harness needs, not a stream of events. Core reads it
 * and applies it; the provider learns nothing about how a harness is wired,
 * and core learns nothing about the provider's protocol.
 *
 * What a tracing provider has ever needed is here: packages to install, files
 * to write, variables for the hooks, variables for the agent itself, and the
 * hook points where the harness should call something. A provider that needs
 * none of the machinery (an endpoint in the environment is enough for a
 * harness that exports OpenTelemetry itself) returns just `environment`.
 *
 * What is deliberately NOT here:
 *
 * - **No run handle.** A provider that needs one (a task, a session, a trace
 *   id created once per run) declares `runState` on its manifest and creates
 *   it in `beginRun`; a provider that does not, ignores `state`. Making a
 *   handle part of this port would have written the first provider's shape
 *   into the contract.
 * - **No harness names to match on.** `harness` is a string core passes
 *   through, so a provider may vary its setup by it, but a provider that
 *   returns the same setup for every harness is the normal case and needs no
 *   knowledge of ours.
 * - **No callback after the run.** Verdicts (evals, guardrail results) are
 *   read from the provider through its own pages and blocks, not pushed back
 *   into core, because core has nowhere to put a verdict it does not
 *   understand.
 */
export interface AgentTracingAdapter {
  /**
   * What this harness needs so its activity reaches this provider, or `null`
   * when this provider does not trace this harness. Called once per sandbox,
   * before the agent runs. It does no I/O: everything it needs is the
   * connection it was built with and the invocation it is handed.
   */
  setup(invocation: AgentTracingInvocation): AgentTracingSetup | null;
}

/** The one agent sandbox core is about to configure. */
export interface AgentTracingInvocation {
  /**
   * The harness core is about to configure, by the name core knows it under
   * (`claude`, `codex`). A provider may branch on it; most do not need to.
   */
  readonly harness: string;
  readonly run: IntegrationRunStart;
  /** What `beginRun` returned for this run; `null` when the manifest declares
   *  no run state, or when creating it failed and core carried on without it. */
  readonly state: IntegrationRunState | null;
  /**
   * Which node, and which attempt of it, this sandbox serves. A run can open
   * several sandboxes, and a provider that labels its traces with this keeps
   * them apart. Absent for a sandbox that belongs to the run rather than to
   * one node: the shared workspace, or one restored after a pause.
   */
  readonly invocation?: { readonly nodeId: string; readonly attempt: number };
}

/**
 * Everything core will do to the sandbox on this provider's behalf, in order:
 * install the packages, write the files, write the hook variables, export the
 * agent variables, register the hooks.
 *
 * Failing to install a package or write a file leaves the run without tracing
 * and says so in the run's log; it never fails the run. Tracing watches work,
 * it is not the work, and a provider that is down must not stop an agent.
 */
export interface AgentTracingSetup {
  readonly packages?: readonly AgentTracingPackage[];
  readonly files?: readonly AgentTracingFile[];
  /**
   * Variables only this provider's hook commands see. Core writes them to a
   * file in this provider's directory with mode 600 and each hook command
   * sources that file before it runs, so the agent process never has them in
   * its environment and neither does anything the agent starts.
   *
   * This is where a connection secret belongs. It is the one declared
   * exception to "a secret never leaves the server" (ADR-010, decision 7):
   * the key reaches the sandbox, as a written file rather than a command
   * line, and core redacts every declared secret from what it records.
   *
   * What this does not do: the sandbox has one user, so the file is readable
   * by the agent that runs as it. It keeps a secret out of everything that
   * inherits or prints an environment (a test that dumps it, a crash report,
   * a child process), not away from an agent that goes looking for it.
   */
  readonly hookEnvironment?: Readonly<Record<string, string>>;
  /**
   * Variables exported for the agent process itself and everything it starts:
   * its shell commands, the test runner, the code under test. Use it only for
   * what the harness itself must read (a harness that exports OpenTelemetry
   * reads its endpoint here) and never for a secret the agent does not need,
   * because anything here is readable by whatever the agent runs, and an
   * exporter endpoint here collects the telemetry of that code as well.
   */
  readonly environment?: Readonly<Record<string, string>>;
  readonly hooks?: readonly AgentTracingHook[];
}

/**
 * A package to install in the sandbox before the files land.
 *
 * `python` is what the sandboxes carry today. A second ecosystem is an
 * additive change made by the stage that needs it, rather than a guess now.
 */
export interface AgentTracingPackage {
  readonly ecosystem: "python";
  readonly name: string;
  /** Installed as `name>=minVersion` when given. */
  readonly minVersion?: string;
}

/**
 * A file written into this provider's own directory inside the sandbox.
 *
 * Base64 so that a tracer written in another language, or anything that is not
 * text, travels as plain data through a manifest-shaped contract.
 */
export interface AgentTracingFile {
  /** Relative to this provider's directory. `../` is refused. */
  readonly path: string;
  readonly contentBase64: string;
  readonly executable?: boolean;
}

/**
 * The moments a harness can tell somebody about, named for what happened
 * rather than for any one harness's word for it. Core maps each to the hook
 * the harness actually has, and silently leaves out the ones a harness does
 * not offer: Codex has no failure hook today, and a provider asking for one
 * gets the rest rather than an error about a harness it never heard of.
 */
export const AGENT_TRACING_EVENTS = [
  "prompt_submitted",
  "tool_started",
  "tool_finished",
  "tool_failed",
  "session_ended",
] as const;

export type AgentTracingEvent = (typeof AGENT_TRACING_EVENTS)[number];

export interface AgentTracingHook {
  readonly event: AgentTracingEvent;
  /**
   * A shell command the harness runs at that moment. `${TRACING_DIR}` is this
   * provider's own directory in the sandbox, which is where its files landed;
   * write it literally and core substitutes the path. Core runs it with
   * `hookEnvironment` already loaded.
   */
  readonly command: string;
}

/** The token a hook command writes for this provider's directory. */
export const AGENT_TRACING_DIR_TOKEN = "${TRACING_DIR}";
