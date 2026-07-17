export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (url.includes("/.nitro/workflow/") && url.endsWith(".mjs") && result.format === "module" && result.source) {
    const src = result.source.toString();
    if (src.includes("Dynamic require of") && !src.includes("__createRequireWDK")) {
      const shim = 'import { createRequire as __createRequireWDK } from "node:module";\nvar require = __createRequireWDK(import.meta.url);\n';
      return { ...result, source: shim + src };
    }
  }
  return result;
}
