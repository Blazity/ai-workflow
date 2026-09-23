import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which automation account a provider's own comments and pushes are recognised
 * by, and the one rule that spans providers: `VCS_BOT_LOGIN` applies only when
 * this deployment has exactly one version control provider.
 *
 * The rule is why this reads every connected provider and not just the one
 * being asked about. Getting it wrong is silent in both directions: too wide
 * and the workflow answers its own review, too narrow and a deployment that
 * configured only the legacy variable stops recognising itself.
 */
const state = vi.hoisted(() => ({
  integrations: [] as Array<{
    manifest: { id: string; capabilities: string[] };
    ctx: { connection: { botLogin?: string; legacyBotLogin?: string } };
  }>,
  integrationStates: new Map<string, { configuredFields: string[] }>(),
}));

vi.mock("../integrations/usable.js", () => ({
  resolveUsableIntegrations: async () => ({
    readable: true,
    usable: state.integrations,
    states: state.integrationStates,
  }),
}));

const { readVcsBotLogin } = await import("./vcs-bot-login.js");

/** The login when the settings could be read, which every case here is about. */
async function loginOf(provider: string): Promise<string | undefined> {
  const reading = await readVcsBotLogin(provider);
  if (!reading.readable) throw new Error(`unexpectedly unreadable: ${reading.reason}`);
  return reading.login;
}

function connect(
  id: string,
  connection: { botLogin?: string; legacyBotLogin?: string },
): void {
  state.integrations.push({
    manifest: { id, capabilities: ["vcs"] },
    ctx: { connection },
  });
  state.integrationStates.set(id, {
    configuredFields: Object.keys(connection),
  });
}

describe("readVcsBotLogin", () => {
  beforeEach(() => {
    state.integrations = [];
    state.integrationStates = new Map();
  });

  it("uses the provider's own account whatever else is connected", async () => {
    connect("github", { botLogin: "AI-Workflow[bot]" });
    connect("gitlab", { botLogin: "ai-workflow-gitlab" });

    // Lowercased and with the `[bot]` suffix off, which is the form every
    // comparison against a delivery's author uses: GitHub writes an App's own
    // actions as `<slug>[bot]` while an admin types the slug, and a value that
    // kept the suffix would only ever match one of the two.
    await expect(loginOf("github")).resolves.toBe("ai-workflow");
    await expect(loginOf("gitlab")).resolves.toBe("ai-workflow-gitlab");
  });

  it("applies the legacy login to the sole connected provider", async () => {
    connect("github", { legacyBotLogin: "legacy-bot" });

    await expect(loginOf("github")).resolves.toBe("legacy-bot");
  });

  it("drops the legacy login the moment a second provider is connected", async () => {
    // It cannot mean two accounts, so it is applied to neither. A deployment
    // that adds a provider and keeps the variable must configure the
    // per-provider one instead, rather than have this quietly attribute one
    // provider's automation account to the other.
    connect("github", { legacyBotLogin: "legacy-bot" });
    connect("gitlab", { botLogin: "ai-workflow-gitlab" });

    await expect(loginOf("github")).resolves.toBeUndefined();
    await expect(loginOf("gitlab")).resolves.toBe("ai-workflow-gitlab");
  });

  it("prefers the provider's own account over the legacy one", async () => {
    connect("github", { botLogin: "ai-workflow[bot]", legacyBotLogin: "legacy-bot" });

    await expect(loginOf("github")).resolves.toBe("ai-workflow");
  });

  it("answers nothing for a provider that is not connected", async () => {
    connect("gitlab", { botLogin: "ai-workflow-gitlab" });

    await expect(loginOf("github")).resolves.toBeUndefined();
  });

  it("ignores a value the connection holds but does not use", async () => {
    // A stored connection carries the fields an admin filled in; one it did not
    // is absent from `configuredFields` even when a value lingers in the row.
    state.integrations.push({
      manifest: { id: "github", capabilities: ["vcs"] },
      ctx: { connection: { botLogin: "stale-value" } },
    });
    state.integrationStates.set("github", { configuredFields: [] });

    await expect(loginOf("github")).resolves.toBeUndefined();
  });
});
