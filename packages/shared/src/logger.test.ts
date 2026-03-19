import { describe, it, expect } from "vitest";
import { createLogger, createTicketLogger, createRunLogger } from "./logger.js";

describe("logger", () => {
  it("createLogger returns a pino-compatible logger", () => {
    const log = createLogger();
    expect(log).toBeDefined();
    expect(typeof log.info).toBe("function");
    expect(typeof log.error).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.child).toBe("function");
  });

  it("createTicketLogger returns a child logger with ticket context", () => {
    const log = createLogger();
    const ticketLog = createTicketLogger(log, "uuid-1", "PROJ-42");
    expect(ticketLog).toBeDefined();
    expect(typeof ticketLog.info).toBe("function");
  });

  it("createRunLogger returns a child logger with run context", () => {
    const log = createLogger();
    const ticketLog = createTicketLogger(log, "uuid-1", "PROJ-42");
    const runLog = createRunLogger(ticketLog, "run-uuid-1");
    expect(runLog).toBeDefined();
    expect(typeof runLog.info).toBe("function");
  });
});
