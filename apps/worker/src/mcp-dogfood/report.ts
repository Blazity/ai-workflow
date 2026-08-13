// Renders the run as something an operator can act on without knowing how any
// of this works. Kept apart from run.ts because the verdict wording is the
// deliverable here, not a detail of the transport.
import type { DogfoodReport, ProbeResult } from "./run.js";

export type ToolVerdict = "works" | "refuses correctly" | "FAILS" | "auth rejected" | "not exercised";

export function verdictFor(results: ProbeResult[]): ToolVerdict {
  if (results.length === 0) return "not exercised";
  if (results.some((result) => result.status === "failed")) return "FAILS";
  if (results.some((result) => result.status === "auth_rejected")) return "auth rejected";
  const sent = results.filter((result) => result.status !== "withheld");
  if (sent.length === 0) return "not exercised";
  // Every tool is probed with a real call and an invented argument. Working
  // means the real call answered; refusing correctly means it declined for a
  // reason the contract names, which is what a placeholder identifier earns.
  return sent.some((result) => result.status === "ok") ? "works" : "refuses correctly";
}

function line(label: string, value: string | number | undefined): string | null {
  return value === undefined || value === "" ? null : `  ${label.padEnd(18)} ${value}`;
}

export function renderReport(report: DogfoodReport): string {
  const out: string[] = [];
  const byTool = new Map<string, ProbeResult[]>();
  for (const name of report.contractTools) byTool.set(name, []);
  for (const result of report.results) {
    byTool.set(result.tool, [...(byTool.get(result.tool) ?? []), result]);
  }

  out.push("MCP dogfood report");
  out.push(
    ...[
      line("endpoint", report.baseUrl),
      line("outcome", report.outcome.toUpperCase()),
      line("token", report.tokenLength === null ? "none supplied" : `supplied, ${report.tokenLength} chars`),
      line("contract tools", report.contractTools.length),
      line("contract hash", report.contractHash.slice(0, 12)),
      line("server hash", report.serverContractHash?.slice(0, 12)),
      line("server version", report.serverVersion),
      line("protocol", report.protocolVersion),
    ].filter((entry): entry is string => entry !== null),
  );

  if (report.outcome === "auth_rejected") {
    out.push("");
    out.push("  Every call was refused by auth. That is the deployment behaving correctly,");
    out.push("  not a defect. Nothing behind the auth gate was reached, so no tool below");
    out.push("  has been checked. Re-run with a token to exercise the surface.");
    if (report.rejection) {
      out.push(`  HTTP ${report.rejection.status}, WWW-Authenticate: ${report.rejection.wwwAuthenticate ?? "absent"}`);
    }
  }
  if (report.error) {
    out.push("");
    out.push(`  Could not complete: ${report.error}`);
  }
  if (report.serverContractHash && report.serverContractHash !== report.contractHash) {
    out.push("");
    out.push("  The deployment answers with a different contract hash than the one in this");
    out.push("  checkout. The surface below was planned from the checkout, so treat any");
    out.push("  mismatch as this harness being out of date rather than the server.");
  }

  out.push("");
  out.push("Per tool");
  for (const [tool, results] of byTool) {
    const verdict = verdictFor(results);
    out.push(`  ${verdict.padEnd(17)} ${tool}`);
    for (const result of results) {
      if (result.status === "failed") {
        const code = result.errorCode ? ` (${result.errorCode})` : "";
        out.push(`      ${result.kind}: ${result.detail ?? "failed"}${code}`);
      }
      if (result.status === "withheld") {
        out.push(`      ${result.kind}: not sent, ${result.detail}`);
      }
    }
  }

  // A silent coverage hole reads as a clean sweep, so it gets its own section
  // even when it is empty.
  out.push("");
  out.push("Coverage");
  const notExercised = report.notExercised;
  out.push(
    notExercised.length === 0
      ? "  Every tool in the contract was called."
      : `  NOT CALLED AT ALL (${notExercised.length}): ${notExercised.join(", ")}`,
  );
  const withheld = report.results.filter((result) => result.status === "withheld");
  if (withheld.length > 0) {
    out.push(`  Withheld on purpose: ${withheld.map((result) => `${result.tool} (${result.kind})`).join(", ")}`);
  }
  if (report.missingFromServer.length > 0) {
    out.push(`  In the contract, not advertised by the deployment: ${report.missingFromServer.join(", ")}`);
  }
  if (report.undeclaredOnServer.length > 0) {
    out.push(`  Advertised by the deployment, not in the contract: ${report.undeclaredOnServer.join(", ")}`);
  }
  // Only probes that actually reached a tool. A run stopped at the auth gate
  // called nothing, and saying it called anything would be the same lie the
  // coverage section exists to prevent.
  const reached = new Set(["ok", "refused", "failed"]);
  const placeholders = report.results.filter(
    (result) => reached.has(result.status) && result.placeholders.length > 0,
  );
  if (placeholders.length > 0) {
    const tools = [...new Set(placeholders.map((result) => result.tool))];
    out.push(
      `  Called with placeholder identifiers, so a refusal proves reachability only: ${tools.join(", ")}`,
    );
    out.push("  Pass --ticket / --run / --definition / --trigger to exercise the real path.");
  }

  return out.join("\n");
}
