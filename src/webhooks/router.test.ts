import { describe, it, expect, vi, beforeEach } from "vitest";

describe("routeTicketTransition", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("JIRA_WEBHOOK_SECRET", "test-secret");
  });

  const makeEvent = (from: string, to: string) => ({
    source: "jira" as const,
    externalTicketId: "PROJ-42",
    fromColumn: from,
    toColumn: to,
    actor: "Mia",
  });

  it("logs start new work when ticket moves to AI column", async () => {
    const { routeTicketTransition } = await import("./router.js");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    routeTicketTransition(makeEvent("To Do", "AI"));

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("TODO: start new work"),
    );
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("PROJ-42"),
    );
    spy.mockRestore();
  });

  it("logs review fix when ticket moves from AI Review to AI In Progress", async () => {
    const { routeTicketTransition } = await import("./router.js");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    routeTicketTransition(makeEvent("AI Review", "AI In Progress"));

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("TODO: pick up review comments"),
    );
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("PROJ-42"),
    );
    spy.mockRestore();
  });

  it("logs clarification resume when ticket moves from Backlog to AI In Progress", async () => {
    const { routeTicketTransition } = await import("./router.js");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    routeTicketTransition(makeEvent("Backlog", "AI In Progress"));

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("TODO: getting ticket"),
    );
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("PROJ-42"),
    );
    spy.mockRestore();
  });

  it("logs cancel when ticket leaves AI In Progress to an unrecognized column", async () => {
    const { routeTicketTransition } = await import("./router.js");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    routeTicketTransition(makeEvent("AI In Progress", "Done"));

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("TODO: cancel active agent run"),
    );
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("PROJ-42"),
    );
    spy.mockRestore();
  });

  it("does not log for irrelevant transitions", async () => {
    const { routeTicketTransition } = await import("./router.js");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    routeTicketTransition(makeEvent("To Do", "In Progress"));

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("matches column names case-insensitively", async () => {
    const { routeTicketTransition } = await import("./router.js");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    routeTicketTransition(makeEvent("To Do", "ai"));

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("TODO: start new work"),
    );
    spy.mockRestore();
  });

  it("trims whitespace from column names", async () => {
    const { routeTicketTransition } = await import("./router.js");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    routeTicketTransition(makeEvent("To Do", "  AI  "));

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("TODO: start new work"),
    );
    spy.mockRestore();
  });

  it("uses custom column names from env", async () => {
    vi.stubEnv("COLUMN_AI", "Custom AI");
    const { routeTicketTransition } = await import("./router.js");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    routeTicketTransition(makeEvent("To Do", "Custom AI"));

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("TODO: start new work"),
    );
    spy.mockRestore();
  });
});
