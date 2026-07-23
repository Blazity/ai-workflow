import { describe, expect, it } from "vitest";

import { parseReplayPageQuery } from "./replay-query.js";

describe("parseReplayPageQuery", () => {
  it.each([
    [{}, 100],
    [{ limit: "" }, 100],
    [{ limit: "not-a-number" }, 100],
    [{ limit: "0" }, 100],
    [{ limit: "-3" }, 100],
    [{ limit: "1" }, 1],
    [{ limit: "199.9" }, 199],
    [{ limit: "200" }, 200],
    [{ limit: "201" }, 200],
  ])("normalizes %j to limit %i", (query, expected) => {
    expect(parseReplayPageQuery(query).limit).toBe(expected);
  });

  it("preserves one opaque cursor", () => {
    expect(
      parseReplayPageQuery({
        limit: ["25", "50"],
        cursor: ["2026-07-23T10:00:00Z/42", "ignored"],
      }),
    ).toEqual({
      limit: 25,
      cursor: "2026-07-23T10:00:00Z/42",
    });
  });
});
