import { describe, it } from "node:test";
import { expect } from "./test-expect.js";
import { parseRequestBody, settingsPatchRequestSchema } from "@shared/contracts";

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
      parse({ settings: { AGENT_KIND: "codex", MAX_CONCURRENT_AGENTS: 3 }, reason: "raise the cap" }),
    ).toEqual({
      ok: true,
      value: { settings: { AGENT_KIND: "codex", MAX_CONCURRENT_AGENTS: 3 }, reason: "raise the cap" },
    });
  });

  it("refuses a settings field that is absent or not a map", () => {
    for (const settings of [undefined, null, 5, "AGENT_KIND"]) {
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
