import { describe, expect, it } from "vitest";
import {
  canApproveWorkflowPlans,
  canChangeRole,
  canInvite,
  normalizeDashboardRole,
} from "./roles.js";

describe("dashboard role policy", () => {
  it("allows owner to promote and demote member/admin roles", () => {
    expect(canChangeRole({ actor: "owner", target: "member", next: "admin" })).toBe(true);
    expect(canChangeRole({ actor: "owner", target: "admin", next: "member" })).toBe(true);
  });

  it("does not allow owner transition or self-demotion through role changes", () => {
    expect(canChangeRole({ actor: "owner", target: "owner", next: "admin" })).toBe(false);
    expect(canChangeRole({ actor: "owner", target: "member", next: "owner" })).toBe(false);
  });

  it("allows admins to invite but not change roles", () => {
    expect(canInvite("admin")).toBe(true);
    expect(canChangeRole({ actor: "admin", target: "member", next: "admin" })).toBe(false);
  });

  it("does not allow members to invite or change roles", () => {
    expect(canInvite("member")).toBe(false);
    expect(canChangeRole({ actor: "member", target: "member", next: "admin" })).toBe(false);
  });

  it("lets owners and admins approve workflow plans but not members", () => {
    expect(canApproveWorkflowPlans("owner")).toBe(true);
    expect(canApproveWorkflowPlans("admin")).toBe(true);
    expect(canApproveWorkflowPlans("member")).toBe(false);
  });

  it("normalizes stored Better Auth role strings to dashboard roles", () => {
    expect(normalizeDashboardRole("owner")).toBe("owner");
    expect(normalizeDashboardRole("admin,member")).toBe("admin");
    expect(normalizeDashboardRole("member")).toBe("member");
    expect(normalizeDashboardRole("unknown")).toBeNull();
  });
});
