import { describe, expect, it } from "vitest";
import {
  dashboardInviteCreateRequestSchema,
  dashboardUserRoleUpdateRequestSchema,
  parseRequestBody,
} from "@shared/contracts";

describe("dashboardInviteCreateRequestSchema", () => {
  it("accepts an email with no role", () => {
    const parsed = parseRequestBody(dashboardInviteCreateRequestSchema, {
      email: "new.user@example.com",
    });
    expect(parsed).toMatchObject({ ok: true, value: { email: "new.user@example.com" } });
  });

  it("refuses a missing email with the message the handler answered", () => {
    expect(parseRequestBody(dashboardInviteCreateRequestSchema, {})).toEqual({
      ok: false,
      message: "Missing email",
    });
  });

  it("refuses an email that is present but not a string", () => {
    // The deliberate change: the handler passed a truthy non-string straight to
    // the invite store, so this case gets its own sentence rather than the one
    // an absent email answers.
    expect(
      parseRequestBody(dashboardInviteCreateRequestSchema, { email: 42 }),
    ).toEqual({ ok: false, message: "Invalid email" });
  });

  it("still calls a falsy email missing, as the handler's one check did", () => {
    for (const email of [null, "", 0, false]) {
      expect(
        parseRequestBody(dashboardInviteCreateRequestSchema, { email }),
      ).toEqual({ ok: false, message: "Missing email" });
    }
  });

  it("refuses any role other than member", () => {
    expect(
      parseRequestBody(dashboardInviteCreateRequestSchema, {
        email: "a@example.com",
        role: "admin",
      }),
    ).toEqual({ ok: false, message: "Invites can only create members" });
  });

  it("drops an unknown field rather than refusing it", () => {
    const parsed = parseRequestBody(dashboardInviteCreateRequestSchema, {
      email: "a@example.com",
      unexpected: true,
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value).not.toHaveProperty("unexpected");
  });
});

describe("dashboardUserRoleUpdateRequestSchema", () => {
  it("accepts admin and member", () => {
    for (const role of ["admin", "member"] as const) {
      expect(parseRequestBody(dashboardUserRoleUpdateRequestSchema, { role })).toEqual({
        ok: true,
        value: { role },
      });
    }
  });

  it("refuses a missing role", () => {
    expect(parseRequestBody(dashboardUserRoleUpdateRequestSchema, {})).toEqual({
      ok: false,
      message: "Invalid role",
    });
  });

  it("refuses a role of the wrong type", () => {
    expect(
      parseRequestBody(dashboardUserRoleUpdateRequestSchema, { role: 7 }),
    ).toEqual({ ok: false, message: "Invalid role" });
  });

  it("refuses owner, which no request may grant", () => {
    expect(
      parseRequestBody(dashboardUserRoleUpdateRequestSchema, { role: "owner" }),
    ).toEqual({ ok: false, message: "Invalid role" });
  });

  it("drops an unknown field rather than refusing it", () => {
    const parsed = parseRequestBody(dashboardUserRoleUpdateRequestSchema, {
      role: "member",
      unexpected: true,
    });
    expect(parsed).toEqual({ ok: true, value: { role: "member" } });
  });
});
