import { describe, expect, it, vi } from "vitest";
import { sendEmail, type SendEmailClient } from "./send-email.js";

const message = {
  from: "AI Workflow <noreply@example.com>",
  to: "user@example.com",
  subject: "Welcome",
  html: "<p>Hello</p>",
  text: "Hello",
};

describe("sendEmail", () => {
  it("returns the provider message id when Resend accepts the email", async () => {
    const client: SendEmailClient = {
      emails: {
        send: vi.fn().mockResolvedValue({
          data: { id: "email_123" },
          error: null,
          headers: null,
        }),
      },
    };

    await expect(sendEmail(client, message)).resolves.toEqual({
      providerMessageId: "email_123",
    });
    expect(client.emails.send).toHaveBeenCalledWith(message);
  });

  it("throws when Resend returns a synchronous provider error", async () => {
    const client: SendEmailClient = {
      emails: {
        send: vi.fn().mockResolvedValue({
          data: null,
          error: {
            name: "validation_error",
            message: "Invalid recipient",
            statusCode: 422,
          },
          headers: null,
        }),
      },
    };

    await expect(sendEmail(client, message)).rejects.toThrow(
      "Resend send failed: Invalid recipient",
    );
  });

  it("throws when Resend accepts without returning a message id", async () => {
    const client: SendEmailClient = {
      emails: {
        send: vi.fn().mockResolvedValue({
          data: {},
          error: null,
          headers: null,
        }),
      },
    };

    await expect(sendEmail(client, message)).rejects.toThrow(
      "Resend accepted email without returning an id",
    );
  });
});
