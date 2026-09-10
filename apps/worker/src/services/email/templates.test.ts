import { describe, expect, it } from "vitest";
import {
  inviteEmailTemplate,
  resetPasswordEmailTemplate,
} from "./templates.js";

describe("email templates", () => {
  it("renders an invite email with subject, html, and text bodies", () => {
    const email = inviteEmailTemplate({
      organizationName: "Acme",
      inviterName: "Dana",
      inviteUrl: "https://dashboard.example.com/invite/abc",
    });

    expect(email.subject).toBe("You're invited to Acme");
    expect(email.html).toContain("Dana invited you to join Acme");
    expect(email.html).toContain("https://dashboard.example.com/invite/abc");
    expect(email.text).toContain("Dana invited you to join Acme");
    expect(email.text).toContain("https://dashboard.example.com/invite/abc");
  });

  it("escapes interpolated invite HTML values", () => {
    const email = inviteEmailTemplate({
      organizationName: "<Acme & Co>",
      inviterName: "<Dana>",
      inviteUrl: "https://dashboard.example.com/invite?token=a&next=/",
    });

    expect(email.html).toContain("&lt;Dana&gt; invited you to join &lt;Acme &amp; Co&gt;");
    expect(email.html).toContain("https://dashboard.example.com/invite?token=a&amp;next=/");
  });

  it("renders a reset password email without delivery tracking fields", () => {
    const email = resetPasswordEmailTemplate({
      resetUrl: "https://dashboard.example.com/reset/abc",
    });

    expect(email.subject).toBe("Reset your AI Workflow password");
    expect(email.html).toContain("https://dashboard.example.com/reset/abc");
    expect(email.text).toContain("https://dashboard.example.com/reset/abc");
    expect(Object.keys(email).sort()).toEqual(["html", "subject", "text"]);
  });
});
