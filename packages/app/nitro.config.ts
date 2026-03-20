import { defineNitroConfig } from "nitro/config";

export default defineNitroConfig({
  preset: "vercel",
  modules: ["workflow/nitro"],
  compatibilityDate: "2025-01-01",

  // Scan src/ for routes/, plugins/, middleware/
  serverDir: "src",

  runtimeConfig: {
    workflowTargetWorld: "@workflow/world-postgres",
  },

});
