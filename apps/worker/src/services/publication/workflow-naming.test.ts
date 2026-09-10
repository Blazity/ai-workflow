import { describe, expect, it } from "vitest";
import {
  BRANCH_PREFIX,
  GATE_CHECK_NAME_PREFIX,
  LEGACY_BRANCH_PREFIX,
  LEGACY_GATE_CHECK_NAME_PREFIX,
  branchForTicket,
  gateCheckName,
  gateCheckNameAliases,
  isManagedBranch,
  isManagedGateCheckName,
  ticketKeyFromBranch,
} from "./workflow-naming.js";

describe("workflow naming", () => {
  it("produces new branch names in the AI Workflow namespace", () => {
    expect(BRANCH_PREFIX).toBe("ai-workflow/");
    expect(branchForTicket("AIW-139")).toBe("ai-workflow/aiw-139");
  });

  it("recognizes both current and legacy managed branches", () => {
    expect(LEGACY_BRANCH_PREFIX).toBe("blazebot/");
    expect(isManagedBranch("ai-workflow/aiw-139")).toBe(true);
    expect(isManagedBranch("blazebot/aiw-139")).toBe(true);
    expect(isManagedBranch("ai-workflow/")).toBe(false);
    expect(isManagedBranch("feature/aiw-139")).toBe(false);
    expect(ticketKeyFromBranch("ai-workflow/aiw-139")).toBe("AIW-139");
    expect(ticketKeyFromBranch("blazebot/aiw-139")).toBe("AIW-139");
    expect(ticketKeyFromBranch("ai-workflow/")).toBeNull();
    expect(ticketKeyFromBranch("feature/aiw-139")).toBeNull();
  });

  it("produces current check names and recognizes both aliases", () => {
    expect(GATE_CHECK_NAME_PREFIX).toBe("AI Workflow / ");
    expect(LEGACY_GATE_CHECK_NAME_PREFIX).toBe("blazebot / ");
    expect(gateCheckName("code-hygiene")).toBe(
      "AI Workflow / code-hygiene",
    );
    expect(gateCheckNameAliases("code-hygiene")).toEqual([
      "AI Workflow / code-hygiene",
      "blazebot / code-hygiene",
    ]);
    expect(gateCheckName("blazebot / code-hygiene")).toBe(
      "AI Workflow / code-hygiene",
    );
    expect(gateCheckNameAliases("AI Workflow / code-hygiene")).toEqual([
      "AI Workflow / code-hygiene",
      "blazebot / code-hygiene",
    ]);
    expect(isManagedGateCheckName("AI Workflow / code-hygiene")).toBe(true);
    expect(isManagedGateCheckName("blazebot / code-hygiene")).toBe(true);
    expect(isManagedGateCheckName("AI Workflow / ")).toBe(false);
    expect(isManagedGateCheckName("ci / build")).toBe(false);
  });
});
