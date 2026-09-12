/**
 * What a coding-agent CLI reported when a phase failed: redacted, serializable
 * and never rendered to a user on its own.
 *
 * It lives here because two tiers name it. The sandbox adapters produce it
 * (`apps/worker/src/sandbox/agents/protocol.ts`), and the block execution error
 * the scheduler carries in `@shared/workflow-graph` has a field for it. The
 * package may not reach into the worker, and this is plain data with no
 * behaviour, so contracts is its cheapest home.
 */

/** Why a phase stopped, at the granularity the adapter could distinguish. */
export type AgentProtocolFailureKind =
  | "install_failed"
  | "setup_failed"
  | "version_unreadable"
  | "version_mismatch"
  | "missing_exit_code"
  | "cli_exit"
  | "provider_error"
  | "missing_result"
  | "invalid_json"
  | "schema_mismatch"
  | "protocol_mismatch";

/** The coding agent CLIs this repository drives. */
export type AgentProtocolProvider = "claude" | "codex";

export interface AgentProtocolDiagnostic {
  provider: AgentProtocolProvider;
  packageName: string;
  cliVersion: string;
  protocol: string;
  phase: string;
  failureKind: AgentProtocolFailureKind;
  exitCode: number | null;
  event?: {
    type?: string;
    subtype?: string;
    isError?: boolean;
    itemType?: string;
  };
  artifacts?: {
    stdoutBytes: number;
    stderrBytes: number;
    structuredOutputBytes: number;
    stdoutSha256: string;
    stderrSha256: string;
    structuredOutputSha256: string | null;
  };
  schema?: {
    identity: string;
    sha256: string;
    issues: Array<{ path: string; code: string; message: string }>;
  };
  stdoutTail?: string;
  stderrTail?: string;
  /**
   * Redacted error text the provider itself reported in its structured result
   * (a Claude error envelope's message, a Codex `error`/`turn.failed` event).
   * The highest-signal evidence a failed phase carries: it is the provider's own
   * one-line reason, already isolated from the surrounding stream.
   */
  providerError?: string;
  detail?: string;
}
