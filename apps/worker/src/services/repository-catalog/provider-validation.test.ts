import { describe, expect, it, vi } from "vitest";

// A build that ships no version control integration at all. Nothing an admin
// connects can change that, so the refusal must not send them to connect one.
vi.mock("@integrations/registry", () => ({ integrationsProviding: () => [] }));

const { assertVcsProviderShipped } = await import("./provider-validation.js");

describe("assertVcsProviderShipped", () => {
  it("says the build ships no provider, not that nothing is connected", () => {
    expect(() => assertVcsProviderShipped("github", "import")).toThrow(
      'Cannot import provider "github": this build ships no version control integration.',
    );
  });
});
