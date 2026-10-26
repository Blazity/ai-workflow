import { describe, expect, it } from "vitest";
import { linearQueryProblem, linearQueryRule } from "./query-rule";

describe("linearQueryProblem", () => {
  it("accepts empty queries", () => {
    expect(linearQueryProblem("")).toBeNull();
    expect(linearQueryProblem("   ")).toBeNull();
    expect(linearQueryProblem("\t\n")).toBeNull();
  });

  it("refuses non-empty queries with guidance", () => {
    const expected =
      "Linear does not have a text-based query language like JQL. " +
      "Leave the query empty so the search uses the ticket's keywords.";

    expect(linearQueryProblem("status:done")).toBe(expected);
    expect(linearQueryProblem("project = CUK")).toBe(expected);
  });

  it("is the rule the integration hands core", () => {
    expect(linearQueryRule.problem("status:done")).toBe(linearQueryProblem("status:done"));
    expect(linearQueryRule.problem("")).toBeNull();
  });
});
