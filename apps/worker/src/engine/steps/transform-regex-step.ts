export async function replaceTextRegexStep(
  source: string,
  pattern: string,
  replacement: string,
  ignoreCase: boolean,
): Promise<string> {
  "use step";
  // re2-wasm loads its .wasm binary from disk at module scope. A static import
  // pulls that load into the workflow bundle for every step invocation, and
  // the serverless bundle does not ship the .wasm asset, so any run crashes
  // before its first step. Load it lazily so only regex transforms pay for it.
  const { RE2 } = await import("re2-wasm");
  const regex = new RE2(pattern, ignoreCase ? "giu" : "gu");
  return source.replace(regex, () => replacement);
}
