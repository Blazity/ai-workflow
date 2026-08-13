// Runs the probe plan against a deployed /mcp endpoint and classifies what came
// back. Talks to the real network through the MCP SDK client, never through
// src/mcp/server.ts, for the same reason mcp-smoke.ts does not: importing the
// server would produce a check that stays green while the deployment is down.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

import { resolveMcpEndpoint } from "../mcp/smoke-client.js";
import { type Contract, type DogfoodFixtures, planProbes, type Probe, type ProbeKind } from "./plan.js";

export type ProbeStatus = "ok" | "refused" | "failed" | "withheld" | "auth_rejected";

export type ProbeResult = {
  tool: string;
  kind: ProbeKind;
  status: ProbeStatus;
  errorCode?: string;
  /** Always safe to print: never carries a token and never carries a raw body. */
  detail?: string;
  placeholders: string[];
};

export type DogfoodReport = {
  baseUrl: string;
  /** The token itself is never stored, printed, or returned. */
  tokenLength: number | null;
  outcome: "ok" | "auth_rejected" | "failure";
  contractHash: string;
  serverContractHash?: string;
  serverVersion?: string;
  protocolVersion?: string;
  contractTools: string[];
  serverTools?: string[];
  missingFromServer: string[];
  undeclaredOnServer: string[];
  notExercised: string[];
  results: ProbeResult[];
  rejection?: { status: number; wwwAuthenticate: string | null };
  error?: string;
};

type ToolCallResult = {
  isError?: boolean;
  content?: unknown;
  structuredContent?: unknown;
};

export function compareSurface(input: {
  contractHash: string;
  serverContractHash: string | undefined;
  contractTools: readonly string[];
  serverTools: readonly string[];
}): { matches: boolean; missingFromServer: string[]; undeclaredOnServer: string[] } {
  const missingFromServer = input.contractTools.filter((name) => !input.serverTools.includes(name));
  const undeclaredOnServer = input.serverTools.filter((name) => !input.contractTools.includes(name));
  return {
    matches:
      input.serverContractHash === input.contractHash &&
      missingFromServer.length === 0 &&
      undeclaredOnServer.length === 0,
    missingFromServer,
    undeclaredOnServer,
  };
}

/** Same trick mcp-smoke.ts uses: the SDK transport keeps the status and drops the header. */
function fetchCapturingRejection(rejection: { current: DogfoodReport["rejection"] | null }): FetchLike {
  return async (input, init) => {
    const response = await fetch(input, init);
    if (response.status === 401) {
      rejection.current = {
        status: response.status,
        wwwAuthenticate: response.headers.get("WWW-Authenticate"),
      };
    }
    return response;
  };
}

function safeMessage(error: unknown, token: string | undefined): string {
  const message = error instanceof Error ? error.message : String(error);
  const withoutToken = token ? message.split(token).join("[redacted]") : message;
  // Bounded because this lands in an operator's report, and an adapter failure
  // can carry a whole response body.
  return withoutToken.length > 300 ? `${withoutToken.slice(0, 300)}...` : withoutToken;
}

/**
 * The contract's error shape, pulled out of the text content. Errors carry no
 * structuredContent: the code travels in the JSON body of the first text block
 * because the SDK's own tool-error path forwards only `error.message`. Reading
 * it back here is the whole point of the negative probes, since a server that
 * regressed to bare prose still answers isError and would otherwise look fine.
 */
export function readErrorCode(result: ToolCallResult): string | null {
  const content = Array.isArray(result.content) ? result.content : [];
  const first = content[0] as { type?: string; text?: string } | undefined;
  if (typeof first?.text !== "string") return null;
  try {
    const parsed = JSON.parse(first.text) as { error?: { code?: unknown } };
    return typeof parsed.error?.code === "string" ? parsed.error.code : null;
  } catch {
    return null;
  }
}

export function classify(
  probe: Probe,
  result: ToolCallResult,
  contractErrorCodes: readonly string[],
): ProbeResult {
  const base = { tool: probe.tool, kind: probe.kind, placeholders: probe.placeholders };

  if (result.isError) {
    const code = readErrorCode(result);
    if (code === null) {
      return {
        ...base,
        status: "failed",
        detail: "refused without a contract error code, so a caller cannot tell why",
      };
    }
    if (!contractErrorCodes.includes(code)) {
      return { ...base, status: "failed", errorCode: code, detail: "error code is not in the contract" };
    }
    if (probe.acceptedErrorCodes.includes(code)) {
      return { ...base, status: "refused", errorCode: code };
    }
    return {
      ...base,
      status: "failed",
      errorCode: code,
      detail: `expected ${probe.acceptedErrorCodes.join(" or ")}`,
    };
  }

  // A negative probe that succeeded is a hole in validation, not a pass.
  if (probe.kind === "invented_argument") {
    return { ...base, status: "failed", detail: "accepted an argument the contract does not declare" };
  }

  const envelope = result.structuredContent as { data?: unknown; meta?: { contractHash?: string } } | undefined;
  if (!envelope?.meta) {
    return { ...base, status: "failed", detail: "answered without the contract envelope" };
  }
  return { ...base, status: "ok" };
}

export async function runDogfood(input: {
  baseUrl: string;
  token: string | undefined;
  contract: Contract;
  fixtures: DogfoodFixtures;
  allowDispatch: boolean;
}): Promise<DogfoodReport> {
  const tokenLength = input.token ? input.token.length : null;
  const contractTools = input.contract.tools.map((tool) => tool.name);
  const probes = planProbes(input.contract, input.fixtures, { allowDispatch: input.allowDispatch });
  const rejection: { current: DogfoodReport["rejection"] | null } = { current: null };

  const skeleton: DogfoodReport = {
    baseUrl: input.baseUrl,
    tokenLength,
    outcome: "failure",
    contractHash: input.contract.contractHash,
    contractTools,
    missingFromServer: [],
    undeclaredOnServer: [],
    notExercised: contractTools,
    results: [],
  };

  const transport = new StreamableHTTPClientTransport(resolveMcpEndpoint(input.baseUrl), {
    requestInit: input.token ? { headers: { Authorization: `Bearer ${input.token}` } } : undefined,
    fetch: fetchCapturingRejection(rejection),
  });
  const client = new Client({ name: "ai-workflow-mcp-dogfood", version: "0.1.0" });

  try {
    await client.connect(transport);
  } catch (error) {
    // A refusal here is the deployment enforcing auth, which is a pass. Every
    // tool is reported as unreached rather than silently dropped.
    if (rejection.current) {
      return {
        ...skeleton,
        outcome: "auth_rejected",
        rejection: rejection.current,
        results: probes.map((probe) => ({
          tool: probe.tool,
          kind: probe.kind,
          status: "auth_rejected" as const,
          placeholders: probe.placeholders,
        })),
      };
    }
    return { ...skeleton, error: safeMessage(error, input.token) };
  }

  try {
    const listed = await client.listTools();
    const serverTools = listed.tools.map((tool) => tool.name);
    const results: ProbeResult[] = [];
    let serverContractHash: string | undefined;
    let serverVersion: string | undefined;

    for (const probe of probes) {
      if (probe.skipped) {
        results.push({
          tool: probe.tool,
          kind: probe.kind,
          status: "withheld",
          detail: probe.skipped,
          placeholders: probe.placeholders,
        });
        continue;
      }
      // A tool in the contract the deployment never advertised cannot be
      // called; saying so beats a transport error the reader has to decode.
      if (!serverTools.includes(probe.tool)) {
        results.push({
          tool: probe.tool,
          kind: probe.kind,
          status: "failed",
          detail: "the deployment does not advertise this tool",
          placeholders: probe.placeholders,
        });
        continue;
      }
      try {
        const result = (await client.callTool({
          name: probe.tool,
          arguments: probe.args,
        })) as ToolCallResult;
        const envelope = result.structuredContent as
          | { meta?: { contractHash?: string; serverVersion?: string } }
          | undefined;
        serverContractHash ??= envelope?.meta?.contractHash;
        serverVersion ??= envelope?.meta?.serverVersion;
        results.push(classify(probe, result, input.contract.errorCodes));
      } catch (error) {
        if (rejection.current) {
          results.push({
            tool: probe.tool,
            kind: probe.kind,
            status: "auth_rejected",
            placeholders: probe.placeholders,
          });
          continue;
        }
        // The SDK throwing instead of answering means the contract's error
        // shape never reached the caller, which is the exact regression the
        // negative probes exist to catch.
        results.push({
          tool: probe.tool,
          kind: probe.kind,
          status: "failed",
          detail: `threw instead of answering: ${safeMessage(error, input.token)}`,
          placeholders: probe.placeholders,
        });
      }
    }

    const reached = new Set(
      results.filter((result) => result.status !== "withheld").map((result) => result.tool),
    );
    const authRejected = results.some((result) => result.status === "auth_rejected");
    const surface = compareSurface({
      contractHash: input.contract.contractHash,
      serverContractHash,
      contractTools,
      serverTools,
    });
    const failed = results.some((result) => result.status === "failed") || !surface.matches;

    return {
      ...skeleton,
      outcome: authRejected ? "auth_rejected" : failed ? "failure" : "ok",
      ...(serverContractHash === undefined ? {} : { serverContractHash }),
      ...(serverVersion === undefined ? {} : { serverVersion }),
      protocolVersion: transport.protocolVersion,
      serverTools,
      missingFromServer: surface.missingFromServer,
      undeclaredOnServer: surface.undeclaredOnServer,
      notExercised: contractTools.filter((name) => !reached.has(name)),
      results,
    };
  } catch (error) {
    if (rejection.current) {
      return { ...skeleton, outcome: "auth_rejected", rejection: rejection.current };
    }
    return { ...skeleton, error: safeMessage(error, input.token) };
  } finally {
    await client.close().catch(() => {});
  }
}

export function dogfoodExitCode(report: DogfoodReport): 0 | 1 {
  if (report.outcome === "failure") return 1;
  if (report.outcome === "auth_rejected" && report.tokenLength !== null) return 1;
  return 0;
}
