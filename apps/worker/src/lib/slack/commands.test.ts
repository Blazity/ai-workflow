import { describe, it, expect } from "vitest";
import { parseCommand } from "./commands.js";

describe("parseCommand", () => {
  it("returns help for empty input", () => {
    expect(parseCommand("")).toEqual({ kind: "help" });
    expect(parseCommand("   ")).toEqual({ kind: "help" });
  });

  it("returns help for explicit help", () => {
    expect(parseCommand("help")).toEqual({ kind: "help" });
    expect(parseCommand("HELP")).toEqual({ kind: "help" });
  });

  it("parses list", () => {
    expect(parseCommand("list")).toEqual({ kind: "list" });
    expect(parseCommand("  LIST  ")).toEqual({ kind: "list" });
  });

  it("parses status with a valid ticket key", () => {
    expect(parseCommand("status AWT-42")).toEqual({
      kind: "status",
      ticketKey: "AWT-42",
    });
  });

  it("uppercases the ticket key on status", () => {
    expect(parseCommand("status awt-42")).toEqual({
      kind: "status",
      ticketKey: "AWT-42",
    });
  });

  it("parses cancel with a valid ticket key", () => {
    expect(parseCommand("cancel AWT-42")).toEqual({
      kind: "cancel",
      ticketKey: "AWT-42",
    });
  });

  it("returns unknown for status without a ticket key", () => {
    expect(parseCommand("status")).toEqual({ kind: "unknown", raw: "status" });
  });

  it("returns unknown for cancel without a ticket key", () => {
    expect(parseCommand("cancel")).toEqual({ kind: "unknown", raw: "cancel" });
  });

  it("returns unknown for malformed ticket keys", () => {
    expect(parseCommand("status abc")).toEqual({
      kind: "unknown",
      raw: "status abc",
    });
    expect(parseCommand("status AWT")).toEqual({
      kind: "unknown",
      raw: "status AWT",
    });
    expect(parseCommand("status AWT-")).toEqual({
      kind: "unknown",
      raw: "status AWT-",
    });
    expect(parseCommand("status 42-AWT")).toEqual({
      kind: "unknown",
      raw: "status 42-AWT",
    });
  });

  it("returns unknown for an unrecognised verb", () => {
    expect(parseCommand("delete AWT-42")).toEqual({
      kind: "unknown",
      raw: "delete AWT-42",
    });
  });

  it("ignores extra trailing whitespace and tokens after the ticket key", () => {
    expect(parseCommand("status AWT-42  ")).toEqual({
      kind: "status",
      ticketKey: "AWT-42",
    });
  });
});
