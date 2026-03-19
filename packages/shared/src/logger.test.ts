import { describe, it, expect } from "vitest";
import { createLogger } from "./logger.js";

describe("logger", () => {
  it("createLogger returns a pino-compatible logger", () => {
    const log = createLogger();
    expect(log).toBeDefined();
    expect(typeof log.info).toBe("function");
    expect(typeof log.error).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.child).toBe("function");
  });
});
