import { RE2 } from "re2-wasm";

export async function replaceTextRegexStep(
  source: string,
  pattern: string,
  replacement: string,
  ignoreCase: boolean,
): Promise<string> {
  "use step";
  const regex = new RE2(pattern, ignoreCase ? "giu" : "gu");
  return source.replace(regex, () => replacement);
}
