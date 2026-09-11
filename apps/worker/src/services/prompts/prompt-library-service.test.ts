import { describe, expect, it } from "vitest";

import { requirePromptLibraryEditRole } from "./prompt-library-service.js";

describe("requirePromptLibraryEditRole", () => {
  it("keeps the prompt-write refusal at the service boundary", () => {
    expect(() => requirePromptLibraryEditRole("member")).toThrow(
      expect.objectContaining({ statusCode: 403 }),
    );
  });
});
