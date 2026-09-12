import { expect, it } from "vitest";
import { Sandbox } from "@vercel/sandbox";

it("fails closed instead of loading the real Vercel sandbox client", () => {
  expect(() => Sandbox.get({ sandboxId: "must-not-connect" })).toThrow(
    "Unexpected Sandbox.get in a worker unit test",
  );
});
