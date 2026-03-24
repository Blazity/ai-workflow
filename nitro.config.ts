import { defineNitroConfig } from "nitropack/config";

export default defineNitroConfig({
  preset: "vercel",
  modules: ["workflow/nitro"],
  compatibilityDate: "2025-01-01",
  srcDir: "src",
  serverAssets: [
    {
      baseName: "prompts",
      dir: "./blazebot/prompts",
    },
  ],
});
