import type { IssueTrackerQueryRule } from "@integrations/sdk";

/**
 * Why Jira's adapter would not run an authored JQL fragment, or `null` when it
 * would.
 *
 * The adapter wraps the fragment in parentheses and ANDs the configured
 * project in front of it, which is what keeps a search inside that project.
 * So the fragment has to stay inside its parentheses, and this reads it the
 * way Jira's lexer does, as far as a parenthesis can be hidden: a value is a
 * string in single OR double quotation marks, closed only by the quote that
 * opened it, and a backslash inside one escapes the next character. Outside a
 * value a backslash is refused rather than interpreted, because there it
 * escapes a character in Jira's lexer (`\'` is a literal quote, not the start
 * of a string) and any disagreement about one character is where a `)` hides.
 * Every string must close, and every parenthesis must close one the fragment
 * opened.
 *
 * A fragment with a problem is dropped rather than repaired: the whole query
 * would otherwise fail at Jira, which reads to the person who wrote it as
 * "there was no evidence" rather than "your query does not parse". The same
 * answer is what core asks when a definition is saved, so that person hears
 * it there instead.
 */
export function jqlFragmentProblem(fragment: string): string | null {
  let depth = 0;
  let quote: { char: "'" | '"'; at: number } | null = null;
  for (let index = 0; index < fragment.length; index += 1) {
    const char = fragment[index];
    if (quote !== null) {
      if (char === "\\") index += 1;
      else if (char === quote.char) quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = { char, at: index };
    else if (char === "\\") {
      return `It has a backslash outside a quoted value (character ${index + 1}). Jira reads one there as an escape, which is where a closing parenthesis can hide, so put the value in quotes.`;
    } else if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth < 0) {
        return `It closes a parenthesis it never opened (character ${index + 1}), which would end the clause that keeps the search inside the connected project.`;
      }
    }
  }
  if (quote !== null) {
    return `The value opened with ${quote.char} at character ${quote.at + 1} is never closed.`;
  }
  if (depth > 0) return "A parenthesis it opens is never closed.";
  return null;
}

/** The rule core asks when a definition is saved: the adapter's own. */
export const jqlQueryRule: IssueTrackerQueryRule = { problem: jqlFragmentProblem };
