import { describe, it } from "node:test";
import { expect } from "./test-expect.js";
import {
  dashboardInviteAcceptRequestSchema,
  dashboardSsoHandoffConsumeRequestSchema,
  parseRequestBody,
} from "@shared/contracts";

describe("dashboardInviteAcceptRequestSchema", () => {
  it("accepts an invite id, a name and a password", () => {
    const parsed = parseRequestBody(dashboardInviteAcceptRequestSchema, {
      inviteId: "inv_1",
      name: "Ada",
      password: "correct horse battery",
    });
    expect(parsed).toEqual({
      ok: true,
      value: { inviteId: "inv_1", name: "Ada", password: "correct horse battery" },
    });
  });

  it("accepts a body without a name", () => {
    const parsed = parseRequestBody(dashboardInviteAcceptRequestSchema, {
      inviteId: "inv_1",
      password: "correct horse battery",
    });
    expect(parsed).toEqual({
      ok: true,
      value: { inviteId: "inv_1", password: "correct horse battery" },
    });
  });

  it("refuses a missing invite id", () => {
    expect(
      parseRequestBody(dashboardInviteAcceptRequestSchema, { password: "secret" }),
    ).toEqual({ ok: false, message: "Missing invite id" });
  });

  it("refuses a missing password", () => {
    expect(
      parseRequestBody(dashboardInviteAcceptRequestSchema, { inviteId: "inv_1" }),
    ).toEqual({ ok: false, message: "Missing password" });
  });

  it("refuses a field of the wrong type before it asks what is missing", () => {
    expect(
      parseRequestBody(dashboardInviteAcceptRequestSchema, { inviteId: 7 }),
    ).toEqual({ ok: false, message: "Invalid request body" });
  });

  it("refuses a body that is not an object", () => {
    expect(parseRequestBody(dashboardInviteAcceptRequestSchema, null)).toEqual({
      ok: false,
      message: "Invalid request body",
    });
  });

  it("drops an unknown field rather than refusing it", () => {
    expect(
      parseRequestBody(dashboardInviteAcceptRequestSchema, {
        inviteId: "inv_1",
        password: "secret",
        role: "admin",
      }),
    ).toEqual({ ok: true, value: { inviteId: "inv_1", password: "secret" } });
  });
});

describe("dashboardSsoHandoffConsumeRequestSchema", () => {
  it("accepts a token and trims it", () => {
    expect(
      parseRequestBody(dashboardSsoHandoffConsumeRequestSchema, { token: " abc " }),
    ).toEqual({ ok: true, value: { token: "abc" } });
  });

  it("refuses a missing token", () => {
    expect(parseRequestBody(dashboardSsoHandoffConsumeRequestSchema, {})).toEqual({
      ok: false,
      message: "Missing SSO handoff token",
    });
  });

  it("refuses a token of the wrong type", () => {
    expect(
      parseRequestBody(dashboardSsoHandoffConsumeRequestSchema, { token: 12 }),
    ).toEqual({ ok: false, message: "Missing SSO handoff token" });
  });

  it("refuses a whitespace only token", () => {
    expect(
      parseRequestBody(dashboardSsoHandoffConsumeRequestSchema, { token: "   " }),
    ).toEqual({ ok: false, message: "Missing SSO handoff token" });
  });

  it("drops an unknown field rather than refusing it", () => {
    expect(
      parseRequestBody(dashboardSsoHandoffConsumeRequestSchema, {
        token: "abc",
        extra: true,
      }),
    ).toEqual({ ok: true, value: { token: "abc" } });
  });
});
