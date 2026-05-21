import { describe, it, expect } from "vitest";
import {
  severityAtLeast,
  maxSeverity,
  mapFindingsToConclusion,
  conclusionForError,
} from "./result.js";
import type { Finding } from "./types.js";

function makeFinding(severity: Finding["severity"]): Finding {
  return { severity, message: "test", fingerprint: "fp" };
}

describe("severityAtLeast", () => {
  it("info >= info", () => expect(severityAtLeast("info", "info")).toBe(true));
  it("info < warning", () => expect(severityAtLeast("info", "warning")).toBe(false));
  it("info < critical", () => expect(severityAtLeast("info", "critical")).toBe(false));
  it("warning >= info", () => expect(severityAtLeast("warning", "info")).toBe(true));
  it("warning >= warning", () => expect(severityAtLeast("warning", "warning")).toBe(true));
  it("warning < critical", () => expect(severityAtLeast("warning", "critical")).toBe(false));
  it("critical >= info", () => expect(severityAtLeast("critical", "info")).toBe(true));
  it("critical >= warning", () => expect(severityAtLeast("critical", "warning")).toBe(true));
  it("critical >= critical", () => expect(severityAtLeast("critical", "critical")).toBe(true));
});

describe("maxSeverity", () => {
  it("returns null for empty array", () => {
    expect(maxSeverity([])).toBe(null);
  });

  it("returns the sole severity for a single finding", () => {
    expect(maxSeverity([makeFinding("warning")])).toBe("warning");
  });

  it("returns highest severity from mixed findings", () => {
    const findings = [
      makeFinding("info"),
      makeFinding("critical"),
      makeFinding("warning"),
    ];
    expect(maxSeverity(findings)).toBe("critical");
  });

  it("returns warning when no critical present", () => {
    const findings = [makeFinding("info"), makeFinding("warning")];
    expect(maxSeverity(findings)).toBe("warning");
  });

  it("returns info when all findings are info", () => {
    const findings = [makeFinding("info"), makeFinding("info")];
    expect(maxSeverity(findings)).toBe("info");
  });
});

describe("mapFindingsToConclusion", () => {
  it("no findings -> success regardless of blocking/fail_on", () => {
    expect(mapFindingsToConclusion([], { blocking: true, fail_on: "info" })).toBe("success");
    expect(mapFindingsToConclusion([], { blocking: false, fail_on: "critical" })).toBe("success");
  });

  it("findings below fail_on -> neutral (blocking=true)", () => {
    const findings = [makeFinding("info")];
    expect(mapFindingsToConclusion(findings, { blocking: true, fail_on: "warning" })).toBe("neutral");
  });

  it("findings below fail_on -> neutral (blocking=false)", () => {
    const findings = [makeFinding("warning")];
    expect(mapFindingsToConclusion(findings, { blocking: false, fail_on: "critical" })).toBe("neutral");
  });

  it("findings at fail_on, blocking=false -> neutral", () => {
    const findings = [makeFinding("warning")];
    expect(mapFindingsToConclusion(findings, { blocking: false, fail_on: "warning" })).toBe("neutral");
  });

  it("findings at fail_on, blocking=true -> failure", () => {
    const findings = [makeFinding("warning")];
    expect(mapFindingsToConclusion(findings, { blocking: true, fail_on: "warning" })).toBe("failure");
  });

  it("findings above fail_on, blocking=false -> neutral", () => {
    const findings = [makeFinding("critical")];
    expect(mapFindingsToConclusion(findings, { blocking: false, fail_on: "warning" })).toBe("neutral");
  });

  it("findings above fail_on, blocking=true -> failure", () => {
    const findings = [makeFinding("critical")];
    expect(mapFindingsToConclusion(findings, { blocking: true, fail_on: "warning" })).toBe("failure");
  });

  it("mixed findings, highest meets fail_on, blocking=true -> failure", () => {
    const findings = [makeFinding("info"), makeFinding("critical")];
    expect(mapFindingsToConclusion(findings, { blocking: true, fail_on: "warning" })).toBe("failure");
  });
});

describe("conclusionForError", () => {
  it("blocking=true -> failure", () => {
    expect(conclusionForError(true)).toBe("failure");
  });

  it("blocking=false -> neutral", () => {
    expect(conclusionForError(false)).toBe("neutral");
  });
});
