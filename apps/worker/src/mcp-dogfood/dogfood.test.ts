import { describe, expect, it } from "vitest";

import { McpPublicError } from "../mcp/contracts.js";
import { mcpToolErrorResult } from "../mcp/tool-catalog.js";
import { loadContract, planProbes, sampleArguments, INVENTED_ARGUMENT } from "./plan.js";
import { renderReport, verdictFor } from "./report.js";
import {
  classify,
  compareSurface,
  dogfoodExitCode,
  readErrorCode,
  type DogfoodReport,
  type ProbeResult,
} from "./run.js";

const CONTRACT = loadContract();
const CODES = CONTRACT.errorCodes;

function probe(overrides: Partial<Parameters<typeof classify>[0]> = {}) {
  return {
    tool: "tickets.get",
    kind: "valid" as const,
    args: { ticketKey: "AIW-1" },
    acceptedErrorCodes: ["NOT_FOUND"],
    placeholders: [],
    ...overrides,
  };
}

function errorResult(code: string) {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: { code, message: "no", retryable: false } }) }],
  };
}

function okResult() {
  return { structuredContent: { data: {}, meta: { contractHash: CONTRACT.contractHash } } };
}

describe("the probe plan comes from the contract", () => {
  it("plans a real call and an invented argument for every tool in the contract", () => {
    const probes = planProbes(CONTRACT, {}, { allowDispatch: false });

    // Two probes per tool, so a tool added to the contract is covered by both
    // without anyone editing the harness. That is the property that keeps a
    // coverage claim honest as the surface grows.
    expect(probes).toHaveLength(CONTRACT.tools.length * 2);
    expect(new Set(probes.map((entry) => entry.tool))).toEqual(
      new Set(CONTRACT.tools.map((tool) => tool.name)),
    );
    for (const entry of probes.filter((candidate) => candidate.kind === "invented_argument")) {
      expect(entry.args).toHaveProperty(INVENTED_ARGUMENT);
      expect(entry.acceptedErrorCodes).toEqual(["VALIDATION_FAILED"]);
    }
  });

  it("builds arguments that satisfy each tool's own schema", () => {
    const dispatch = CONTRACT.tools.find((tool) => tool.name === "workflows.dispatch");
    expect(dispatch).toBeDefined();

    const { args } = sampleArguments(dispatch!, {});

    // Patterned and formatted fields have to be generated to match, or the
    // probe is refused by validation and proves nothing about the tool.
    expect(args.preflightDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(args.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(args.input).toMatchObject({ kind: "ticket" });
    expect(typeof args.definitionId).toBe("number");
  });

  it("prefers a supplied fixture over a placeholder and says which were guessed", () => {
    const tool = CONTRACT.tools.find((candidate) => candidate.name === "tickets.get")!;

    const withFixture = sampleArguments(tool, { ticketKey: "AIW-251" });
    const without = sampleArguments(tool, {});

    expect(withFixture.args.ticketKey).toBe("AIW-251");
    expect(withFixture.placeholders).toEqual([]);
    expect(without.placeholders).toContain("ticketKey");
  });

  it("withholds a mutating tool's real call unless it is asked for", () => {
    const guarded = planProbes(CONTRACT, {}, { allowDispatch: false });
    const allowed = planProbes(CONTRACT, {}, { allowDispatch: true });
    const find = (probes: typeof guarded) =>
      probes.find((entry) => entry.tool === "workflows.dispatch" && entry.kind === "valid")!;

    // Withheld, never dropped: it still has to appear so the report can admit
    // the gap instead of reading as a clean sweep.
    expect(find(guarded).skipped).toBeDefined();
    expect(find(guarded).args).toBeUndefined();
    expect(find(allowed).args).toBeDefined();
    // The negative probe is safe either way: validation runs before any effect.
    expect(
      guarded.find((entry) => entry.tool === "workflows.dispatch" && entry.kind === "invented_argument")!.args,
    ).toBeDefined();
  });
});

describe("classifying what a tool answered", () => {
  it("fails the surface gate for a missing hash or any tool drift", () => {
    expect(
      compareSurface({
        contractHash: "expected",
        serverContractHash: undefined,
        contractTools: ["tickets.get"],
        serverTools: ["tickets.get", "runs.get"],
      }),
    ).toEqual({
      matches: false,
      missingFromServer: [],
      undeclaredOnServer: ["runs.get"],
    });
  });

  it("reads the contract error code out of the text content", () => {
    expect(readErrorCode(errorResult("NOT_FOUND"))).toBe("NOT_FOUND");
    expect(readErrorCode({ isError: true, content: [{ type: "text", text: "Invalid arguments" }] })).toBeNull();
  });

  it("counts an expected refusal as refusing correctly, not as a failure", () => {
    expect(classify(probe(), errorResult("NOT_FOUND"), CODES)).toMatchObject({
      status: "refused",
      errorCode: "NOT_FOUND",
    });
  });

  it("fails a refusal that arrives without a contract error code", () => {
    // The regression the negative probes exist for: the SDK's own error path
    // forwards the message and drops the code, so a caller cannot tell whether
    // to retry, wait, or give up. isError alone must never read as a pass.
    const bare = { isError: true, content: [{ type: "text", text: "Invalid arguments for tool tickets.get" }] };

    expect(classify(probe(), bare, CODES)).toMatchObject({
      status: "failed",
      detail: "refused without a contract error code, so a caller cannot tell why",
    });
  });

  it("fails a refusal whose code is not the one this probe expects", () => {
    expect(classify(probe(), errorResult("INTERNAL_ERROR"), CODES)).toMatchObject({
      status: "failed",
      errorCode: "INTERNAL_ERROR",
    });
  });

  it("fails a code the contract never declared", () => {
    expect(classify(probe(), errorResult("TEAPOT"), CODES)).toMatchObject({
      status: "failed",
      detail: "error code is not in the contract",
    });
  });

  it("fails a success that arrived without the contract envelope", () => {
    expect(classify(probe(), { structuredContent: undefined }, CODES)).toMatchObject({
      status: "failed",
      detail: "answered without the contract envelope",
    });
  });

  it("fails an invented argument that was accepted instead of refused", () => {
    const negative = probe({ kind: "invented_argument", acceptedErrorCodes: ["VALIDATION_FAILED"] });

    expect(classify(negative, okResult(), CODES)).toMatchObject({
      status: "failed",
      detail: "accepted an argument the contract does not declare",
    });
  });

  it("passes a real call that answered with the envelope", () => {
    expect(classify(probe(), okResult(), CODES)).toMatchObject({ status: "ok" });
  });

  // The one place this harness is coupled to the server's internals: it parses
  // the error body the server actually builds. Feeding the real production
  // builder in means a change to that shape breaks here, in CI, rather than
  // silently turning every negative probe into a false FAILS during a release.
  it("parses the error body the server really builds", () => {
    const real = mcpToolErrorResult(
      new McpPublicError("VALIDATION_FAILED", "tickets.get: unrecognized key(s) 'x'", false),
    );

    expect(readErrorCode(real)).toBe("VALIDATION_FAILED");
    expect(
      classify(probe({ kind: "invented_argument", acceptedErrorCodes: ["VALIDATION_FAILED"] }), real, CODES),
    ).toMatchObject({ status: "refused", errorCode: "VALIDATION_FAILED" });
  });

  it("fails a bare SDK-shaped refusal, which is what a lost code looks like", () => {
    // Not the server's builder: an error that escaped the wrapper carries only
    // prose, and the harness has to call that a defect rather than a refusal.
    const unwrapped = { isError: true, content: [{ type: "text", text: "MCP error -32602: Invalid arguments" }] };

    expect(classify(probe({ kind: "invented_argument" }), unwrapped, CODES)).toMatchObject({ status: "failed" });
  });
});

describe("the operator report", () => {
  const result = (overrides: Partial<ProbeResult>): ProbeResult => ({
    tool: "tickets.get",
    kind: "valid",
    status: "ok",
    placeholders: [],
    ...overrides,
  });

  it("reduces a tool's probes to one verdict, worst first", () => {
    expect(verdictFor([result({ status: "ok" }), result({ status: "failed" })])).toBe("FAILS");
    expect(verdictFor([result({ status: "ok" }), result({ status: "refused" })])).toBe("works");
    expect(verdictFor([result({ status: "refused" }), result({ status: "refused" })])).toBe("refuses correctly");
    expect(verdictFor([result({ status: "withheld" })])).toBe("not exercised");
    expect(verdictFor([])).toBe("not exercised");
  });

  const base: DogfoodReport = {
    baseUrl: "https://example.invalid/mcp",
    tokenLength: null,
    outcome: "auth_rejected",
    contractHash: CONTRACT.contractHash,
    contractTools: CONTRACT.tools.map((tool) => tool.name),
    missingFromServer: [],
    undeclaredOnServer: [],
    notExercised: CONTRACT.tools.map((tool) => tool.name),
    results: [],
    rejection: { status: 401, wwwAuthenticate: 'Bearer realm="mcp"' },
  };

  it("says plainly that an auth-rejected run checked nothing behind the gate", () => {
    const text = renderReport(base);

    expect(text).toContain("AUTH_REJECTED");
    expect(text).toContain("not a defect");
    expect(text).toContain("NOT CALLED AT ALL");
  });

  it("fails when a supplied token is rejected, but accepts the anonymous auth probe", () => {
    expect(dogfoodExitCode(base)).toBe(0);

    const authenticated = { ...base, tokenLength: 64 };
    expect(dogfoodExitCode(authenticated)).toBe(1);
    expect(renderReport(authenticated)).toContain("supplied token was rejected");
  });

  it("names every uncalled tool rather than reporting a clean sweep", () => {
    const text = renderReport({
      ...base,
      outcome: "ok",
      notExercised: ["workflows.dispatch"],
      results: [result({ status: "withheld", detail: "mutating tool, needs --allow-dispatch", tool: "workflows.dispatch" })],
    });

    expect(text).toContain("NOT CALLED AT ALL (1): workflows.dispatch");
    expect(text).toContain("Withheld on purpose");
  });

  it("reports a tool whose happy path the contract cannot express as lost coverage", () => {
    // #256 adds prompts.get, which takes promptId OR slug with neither marked
    // required. Arguments built from that schema are refused however healthy
    // the tool is, so the verdict stays honest and Coverage carries the gap.
    const text = renderReport({
      ...base,
      outcome: "ok",
      notExercised: [],
      results: [
        result({ tool: "prompts.get", status: "refused", errorCode: "VALIDATION_FAILED" }),
        result({ tool: "prompts.get", kind: "invented_argument", status: "refused", errorCode: "VALIDATION_FAILED" }),
      ],
    });

    expect(text).toContain("Happy path NOT reached");
    expect(text).toContain("prompts.get");
    expect(text).not.toContain("FAILS");
  });

  it("never prints the token, only its length", () => {
    const text = renderReport({ ...base, tokenLength: 64 });

    expect(text).toContain("supplied, 64 chars");
    expect(text).not.toMatch(/Bearer [A-Za-z0-9._-]{10,}/);
  });
});
