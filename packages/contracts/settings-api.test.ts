import { describe, it } from "node:test";
import { expect } from "./test-expect.js";
import {
  canResetSettings,
  parseRequestBody,
  settingsPatchRequestSchema,
  settingsResetRequestSchema,
} from "@shared/contracts";

const parse = (body: unknown) => parseRequestBody(settingsPatchRequestSchema, body);

describe("settingsPatchRequestSchema", () => {
  /**
   * The case the schema's own record has to survive: a patch that actually
   * carries a key. A `z.record` written with one argument parses every body
   * WITHOUT keys and throws on the first body with one, so a test that only
   * refuses bad bodies proves nothing about it.
   */
  it("keeps the submitted settings map verbatim, keys and all", () => {
    expect(
      parse({ settings: { COLUMN_AI: "Agent", MAX_CONCURRENT_AGENTS: 3 }, reason: "raise the cap" }),
    ).toEqual({
      ok: true,
      value: { settings: { COLUMN_AI: "Agent", MAX_CONCURRENT_AGENTS: 3 }, reason: "raise the cap" },
    });
  });

  it("refuses a settings field that is absent or not a map", () => {
    for (const settings of [undefined, null, 5, "COLUMN_AI"]) {
      expect(parse({ settings, reason: "why" })).toEqual({
        ok: false,
        message: "Invalid settings",
      });
    }
  });

  it("refuses a missing or blank reason", () => {
    for (const reason of [undefined, null, "   ", 7]) {
      expect(parse({ settings: {}, reason })).toEqual({
        ok: false,
        message: "Invalid reason",
      });
    }
  });
});

describe("settingsPatchRequestSchema expectedVersions", () => {
  // The version each key had when the person loaded the page: the id of its
  // newest history row, 0 when it had none. What a second tab sends so the
  // worker can tell a stale save from a fresh one.
  it("carries the version the person saw for each key", () => {
    expect(
      parse({
        settings: { COLUMN_AI: "Agent" },
        reason: "renamed",
        expectedVersions: { COLUMN_AI: 7, MAX_CONCURRENT_AGENTS: 0 },
      }),
    ).toEqual({
      ok: true,
      value: {
        settings: { COLUMN_AI: "Agent" },
        reason: "renamed",
        expectedVersions: { COLUMN_AI: 7, MAX_CONCURRENT_AGENTS: 0 },
      },
    });
  });

  it("stays optional, so a client written before it keeps today's last-write-wins", () => {
    expect(parse({ settings: { COLUMN_AI: "Agent" }, reason: "renamed" })).toEqual({
      ok: true,
      value: { settings: { COLUMN_AI: "Agent" }, reason: "renamed" },
    });
  });

  it("refuses a version that is not a whole, non-negative number", () => {
    for (const version of [-1, 1.5, "7", null]) {
      expect(
        parse({ settings: {}, reason: "why", expectedVersions: { COLUMN_AI: version } }),
      ).toEqual({ ok: false, message: "Invalid expectedVersions" });
    }
  });
});

describe("settingsResetRequestSchema", () => {
  const reset = (body: unknown) => parseRequestBody(settingsResetRequestSchema, body);

  it("takes the key, the reason and, optionally, the version the person saw", () => {
    expect(reset({ key: "COLUMN_AI", reason: "back to the default", expectedVersion: 3 })).toEqual({
      ok: true,
      value: { key: "COLUMN_AI", reason: "back to the default", expectedVersion: 3 },
    });
    expect(reset({ key: "COLUMN_AI", reason: "back to the default" })).toEqual({
      ok: true,
      value: { key: "COLUMN_AI", reason: "back to the default" },
    });
  });

  it("refuses a missing key and a blank reason, each with its own sentence", () => {
    expect(reset({ reason: "why" })).toEqual({ ok: false, message: "Invalid key" });
    expect(reset({ key: "COLUMN_AI", reason: "  " })).toEqual({
      ok: false,
      message: "Invalid reason",
    });
    expect(reset({ key: "COLUMN_AI", reason: "why", expectedVersion: -1 })).toEqual({
      ok: false,
      message: "Invalid expectedVersion",
    });
  });
});

describe("canResetSettings", () => {
  // The rule MCP settings.reset already enforced before the HTTP route existed.
  // Widening it is a decision for the owner of the deployment, not a side
  // effect of adding a button.
  it("admits the owner only", () => {
    expect(canResetSettings("owner")).toBe(true);
    expect(canResetSettings("admin")).toBe(false);
    expect(canResetSettings("member")).toBe(false);
  });
});
