/**
 * The worker half of the Arthur Engine integration: the connection test, the
 * tracer it hands to every agent sandbox, the per-run task those traces land
 * in, the prompt-injection screen, its health probe and what its Evals page
 * reads.
 *
 * No step directive belongs here. Core runs the block in its own generic
 * integration step, which is what keeps a moved or renamed integration from
 * stranding a suspended run.
 */
import {
  AGENT_TRACING_DIR_TOKEN,
  type AgentTracingAdapter,
  type AgentTracingSetup,
  type IntegrationBlockOutputValue,
  type IntegrationContext,
  type IntegrationRuntimeDefinition,
  defineIntegrationRuntime,
} from "@integrations/sdk";
import { ArthurClient, engineBaseUrl, type PromptValidationFinding } from "./client";
import { detectBlatantInjection } from "./injection-markers";
import { injectionCheckBlock, manifest } from "./manifest";
import { ARTHUR_TRACER_PY_BASE64 } from "./tracer.generated";

type ArthurManifest = typeof manifest;
type ArthurContext = IntegrationContext<ArthurManifest>;

/** The window the Evals page reports, fixed rather than chosen by a reader. */
const EVAL_WINDOW_HOURS = 24;
const HOUR_MS = 3_600_000;
/** The file the tracer is written as inside this integration's own directory. */
const TRACER_FILE = "claude_code_tracer.py";

/**
 * What the tracer needs in the sandbox.
 *
 * It is a Python hook the harness calls at each moment of a session, and it
 * reads its own configuration from the environment before anything else, so
 * the whole of the wiring is: install what it imports, write it down, tell it
 * which engine and which task, and ask for the five moments. Which hook a
 * harness actually has is core's business; a harness without a failure hook
 * gets the other four.
 *
 * Everything the tracer reads goes to `hookEnvironment`, which only the hook
 * commands load. The agent works on customer code and runs whatever that code
 * runs; before this was an integration the key sat in a file only the tracer
 * read, and the agent's own environment is not a place for it now either.
 */
function arthurTracing(ctx: ArthurContext): AgentTracingAdapter {
  return {
    setup: (invocation): AgentTracingSetup | null => {
      const taskId = invocation.state?.taskId;
      // No task means nowhere to put the traces. Core logs that the run is not
      // being traced; it never fails the run over it.
      if (typeof taskId !== "string" || taskId.length === 0) return null;
      const tracer = `python3 "${AGENT_TRACING_DIR_TOKEN}/${TRACER_FILE}"`;
      return {
        packages: [
          { ecosystem: "python", name: "opentelemetry-sdk", minVersion: "1.20.0" },
          {
            ecosystem: "python",
            name: "opentelemetry-exporter-otlp-proto-http",
            minVersion: "1.20.0",
          },
        ],
        files: [{ path: TRACER_FILE, contentBase64: ARTHUR_TRACER_PY_BASE64, executable: true }],
        hookEnvironment: {
          GENAI_ENGINE_API_KEY: ctx.connection.apiKey,
          GENAI_ENGINE_TASK_ID: taskId,
          GENAI_ENGINE_TRACE_ENDPOINT: ctx.connection.traceEndpoint,
          // Not read by the tracer; there so a person looking at a sandbox, or
          // at the engine's task, can find the run it belongs to.
          AIW_RUN_ID: invocation.run.runId,
          ...(invocation.invocation
            ? {
                AIW_NODE_ID: invocation.invocation.nodeId,
                AIW_ATTEMPT: String(invocation.invocation.attempt),
              }
            : {}),
        },
        hooks: [
          { event: "prompt_submitted", command: `${tracer} user_prompt_submit` },
          { event: "tool_started", command: `${tracer} pre_tool` },
          { event: "tool_finished", command: `${tracer} post_tool` },
          { event: "tool_failed", command: `${tracer} post_tool_failure` },
          { event: "session_ended", command: `${tracer} stop` },
        ],
      };
    },
  };
}

/**
 * One verdict, built in one place so each branch below says only what it
 * decided. `reason` is left out rather than set to undefined: the output
 * travels into a workflow's bindings, where an absent field and a field
 * holding nothing are not the same thing.
 */
function verdict(
  status: "ok" | "flagged",
  backend: string,
  findings: readonly PromptValidationFinding[],
  reason?: string,
): IntegrationBlockOutputValue<typeof injectionCheckBlock> {
  return {
    status,
    backend,
    findings: findings.map((finding) => ({ ...finding })),
    ...(reason === undefined ? {} : { reason }),
  };
}

const definition: IntegrationRuntimeDefinition<ArthurManifest> = {
  /**
   * The cheapest call the engine offers, read directly rather than through the
   * client so the two answers stay apart: a status the engine chose is a
   * refusal of the credential, and a request that never arrived is the network,
   * which core must not read as a bad key.
   */
  testConnection: async (ctx) => {
    const response = await ctx.http.fetch(
      `${engineBaseUrl(ctx.connection.traceEndpoint)}/api/v2/tasks?page_size=1`,
      {
        headers: {
          authorization: `Bearer ${ctx.connection.apiKey}`,
          "ngrok-skip-browser-warning": "true",
        },
        signal: ctx.signal,
        retries: 0,
      },
    );
    if (response.ok) return { ok: true };
    if (response.status >= 500) {
      throw new Error(`The engine answered ${response.status} at ${ctx.connection.traceEndpoint}.`);
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: "The engine refused this API key." };
    }
    return {
      ok: false,
      reason: `The engine answered ${response.status} for the task API. Check that the trace endpoint ends in /api/v1/traces.`,
    };
  },

  /**
   * One task per run, created at the run's first use of Arthur and carried
   * from there. The task API numbers a second task for a name that already
   * exists, so asking twice would scatter a run across two buckets; core
   * records what this returns with the run, which is what makes "once" true
   * across a suspend and a replay as well as within one invocation.
   */
  beginRun: async (start, ctx) => {
    const task = await new ArthurClient(ctx).ensureTaskForSubject(start.subjectKey);
    // The one line that maps an engine task back to the run that made it.
    ctx.log.info(
      { taskId: task.id, taskName: task.name, runId: start.runId, subjectKey: start.subjectKey },
      "arthur_task_created",
    );
    return { taskId: task.id, taskName: task.name };
  },

  capabilities: {
    agent_tracing: arthurTracing,
  },

  blocks: {
    /**
     * The prompt-injection screen, and it fails closed everywhere it can.
     *
     * A deterministic local floor runs first, so an unambiguous override
     * payload always flags whatever the engine's classifier makes of it. After
     * that the engine decides, and three things that are not a clean verdict
     * are refused rather than reported as one: nothing to screen, no task to
     * screen against, and a validation that evaluated no rule at all.
     */
    arthur_injection_check: async ({ inputs }, ctx) => {
      const content = typeof inputs.content === "string" ? inputs.content.trim() : "";
      if (content.length === 0) {
        return {
          kind: "failed",
          message:
            "Prompt injection check had nothing to screen: its content input is empty. Bind it to the text an agent will read, or leave it unbound to screen the ticket's description and comments.",
        };
      }

      const blatant = detectBlatantInjection(content);
      if (blatant.length > 0) {
        return { kind: "next", output: verdict("flagged", "local_prefilter", blatant) };
      }

      const taskId = ctx.run.state?.taskId;
      if (typeof taskId !== "string" || taskId.length === 0) {
        return {
          kind: "failed",
          message:
            "Prompt injection check could not open a task on the Arthur Engine, so nothing screened this content.",
        };
      }

      const client = new ArthurClient(ctx);
      // A task is created without rules, so it screens nothing until one is
      // attached. A failure to attach is not fatal by itself: the empty result
      // below is what refuses to call unscreened content clean.
      try {
        await client.addPromptInjectionRule(taskId);
      } catch (error) {
        ctx.log.warn(
          { err: error instanceof Error ? error.message : String(error), taskId },
          "arthur_prompt_injection_rule_add_failed",
        );
      }

      const { ok, findings } = await client.validatePrompt(taskId, content);
      // A validation that ran no rule screened nothing, and nothing screened is
      // not a clean bill of health.
      if (findings.length === 0) {
        return {
          kind: "next",
          output: verdict("flagged", "arthur_engine", [], "arthur_no_rules_evaluated"),
        };
      }
      return { kind: "next", output: verdict(ok ? "ok" : "flagged", "arthur_engine", findings) };
    },
  },

  health: {
    api: async (ctx) => {
      await new ArthurClient(ctx).ping();
      return { status: "live" };
    },
  },

  api: {
    /**
     * Fleet evaluation health over the fixed window. The engine has no
     * overview endpoint, so this counts traces by their grading status:
     * `spansGraded` is passed plus failed, `score` is the pass rate, and
     * `traceCount` is everything in the window, graded or not. Zero graded is
     * an answer, not an error, and the page says which it got.
     */
    evals: async (ctx) => {
      const client = new ArthurClient(ctx);
      const now = Date.now();
      const endTime = new Date(now).toISOString();
      const startTime = new Date(now - EVAL_WINDOW_HOURS * HOUR_MS).toISOString();
      const { tasks, truncated } = await client.listAllTasks();
      const ids = tasks.map((task) => task.id);
      const [passed, failed, traceCount] = await Promise.all([
        client.countTraces(ids, startTime, endTime, { continuous_eval_run_status: "passed" }),
        client.countTraces(ids, startTime, endTime, { continuous_eval_run_status: "failed" }),
        client.countTraces(ids, startTime, endTime),
      ]);
      const spansGraded = passed + failed;
      return {
        windowHours: EVAL_WINDOW_HOURS,
        spansGraded,
        spansFailed: failed,
        traceCount,
        score: spansGraded > 0 ? (passed / spansGraded) * 100 : 0,
        tasksRead: ids.length,
        // One page is all this engine reads reliably. Past it the counts miss
        // tasks, and "nothing graded" might only mean "not in the first page",
        // so the page says so rather than reporting a quiet engine.
        truncated,
      };
    },
  },
};

export const runtime = defineIntegrationRuntime(manifest, definition);
