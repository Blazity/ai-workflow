import { defineNitroConfig } from "nitropack/config";

export default defineNitroConfig({
  preset: "vercel",
  modules: ["workflow/nitro"],
  compatibilityDate: "2025-01-01",
  srcDir: "src",
  // Tests are co-located with source; exclude them from route scanning so a
  // file like `slack.post.test.ts` doesn't get matched as a POST route by the
  // file-based router.
  ignore: ["**/*.test.ts"],
});
