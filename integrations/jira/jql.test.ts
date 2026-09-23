import { describe, expect, it } from "vitest";
import { jqlFragmentProblem, jqlQueryRule } from "./jql";

/**
 * What an author may write in the investigate block's query template, read the
 * way Jira reads it. JQL takes a value in single or double quotation marks and
 * escapes a quote inside one with a backslash (Atlassian, "Advanced searching":
 * reserved characters "must be enclosed in single or double quote marks";
 * `summary ~ "\"full screen\""`). Each accepted case is valid JQL the adapter
 * sends; each refused one is text the adapter drops, so the author has to hear
 * about it when saving.
 */
describe("jqlFragmentProblem", () => {
  it.each([
    ["a quoted parenthesis in single quotes", "summary ~ 'fix)'"],
    ["a double quote inside single quotes", `summary ~ 'O"Brien'`],
    ["an escaped quote inside a double-quoted phrase", String.raw`summary ~ "\"full screen\""`],
    ["a reserved character in quotes", 'version = "[example]"'],
    ["parentheses the fragment opens and closes", "labels = support AND (priority = High OR priority = Highest)"],
    ["an escaped quote inside single quotes", String.raw`summary ~ 'it\'s (not) broken'`],
  ])("accepts %s", (_label, fragment) => {
    expect(jqlFragmentProblem(fragment)).toBeNull();
  });

  it.each([
    ["a value whose quote never closes", "labels = 'backend", /opened with ' at character 10 is never closed/u],
    ["a backslash outside a value", String.raw`summary ~ foo\-bar`, /backslash outside a quoted value \(character 14\)/u],
    ["a parenthesis closed before it opened", "labels = support) OR (project = OTHER", /closes a parenthesis it never opened \(character 17\)/u],
    ["a parenthesis never closed", "(labels = support", /never closed/u],
  ])("refuses %s, saying why", (_label, fragment, reason) => {
    expect(jqlFragmentProblem(fragment)).toMatch(reason);
  });

  it("is the rule the integration hands core", () => {
    expect(jqlQueryRule.problem("labels = 'backend")).toBe(jqlFragmentProblem("labels = 'backend"));
    expect(jqlQueryRule.problem("summary ~ 'fix)'")).toBeNull();
  });
});
