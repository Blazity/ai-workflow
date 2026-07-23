import { describe, expect, it } from "vitest";
import { configuredReplaySecrets } from "./configured-secrets.js";

describe("configuredReplaySecrets", () => {
  it("includes every non-empty secret-named value, including short values", () => {
    expect(
      configuredReplaySecrets({
        API_TOKEN: "abc",
        DATABASE_PASSWORD: "pw",
        OAUTH_SECRET: "x",
        EMPTY_SECRET: "",
        PUBLIC_URL: "https://example.com",
      }),
    ).toEqual(["abc", "pw", "x"]);
  });
});
