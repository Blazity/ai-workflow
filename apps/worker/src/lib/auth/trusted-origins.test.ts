import { describe, expect, it } from "vitest";
import { buildTrustedOrigins } from "./trusted-origins.js";

describe("buildTrustedOrigins", () => {
  it("returns just the canonical origin when there are no additional origins", () => {
    expect(buildTrustedOrigins("https://dashboard.example.com", [])).toEqual([
      "https://dashboard.example.com",
    ]);
  });

  it("keeps the canonical origin first, then the additional origins", () => {
    expect(
      buildTrustedOrigins("https://dashboard.example.com", [
        "https://preview-abc.vercel.app",
        "http://localhost:3001",
      ]),
    ).toEqual([
      "https://dashboard.example.com",
      "https://preview-abc.vercel.app",
      "http://localhost:3001",
    ]);
  });

  it("de-duplicates so the canonical origin is never repeated", () => {
    expect(
      buildTrustedOrigins("https://dashboard.example.com", [
        "https://dashboard.example.com",
        "https://preview-abc.vercel.app",
        "https://preview-abc.vercel.app",
      ]),
    ).toEqual(["https://dashboard.example.com", "https://preview-abc.vercel.app"]);
  });
});
