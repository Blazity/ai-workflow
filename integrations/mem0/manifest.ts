/**
 * What core may know about the Mem0 integration without running any of its
 * code. Plain data: the editor, the dashboard, the health page and the
 * Workflow DevKit's flow bundle all read it.
 */
import { defineIntegration } from "@integrations/sdk";

export const manifest = defineIntegration({
  id: "mem0",
  name: "Mem0",
  description:
    "Keeps what runs learn in your Mem0 project instead of the built-in memory, which stays as it was: nothing is copied either way.",
  docsUrl: "https://docs.mem0.ai/platform/quickstart",
  connection: {
    fields: [
      {
        key: "apiKey",
        label: "API key",
        description:
          "A key from app.mem0.ai, Settings, API Keys, made for the one Mem0 project this deployment should write into. The key decides the organization and project; Test names both.",
        env: "AIW_MEM0_API_KEY",
        secret: true,
      },
    ],
  },
  capabilities: ["memory"],
  blocks: [],
  pages: [],
  health: [
    {
      id: "api",
      label: "API access",
      description: "Mem0 accepts the API key.",
      critical: true,
    },
  ],
});
