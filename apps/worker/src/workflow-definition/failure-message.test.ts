import { describe, it, expect } from "vitest";
import {
  classifyProviderFailure,
  deriveFailureMessage,
  sanitizeDetail,
} from "./failure-message.js";

describe("classifyProviderFailure", () => {
  it("maps the credit/billing cause, including the real Anthropic wording", () => {
    const billing =
      "The AI provider rejected the request: the account credit or billing balance is too low.";
    expect(classifyProviderFailure("Credit balance is too low")).toBe(billing);
    expect(
      classifyProviderFailure("Your account has insufficient credits remaining"),
    ).toBe(billing);
    expect(classifyProviderFailure("billing account is past due")).toBe(billing);
  });

  it("maps rate-limit causes", () => {
    const msg = "The AI provider rate-limited the request. Please retry shortly.";
    expect(classifyProviderFailure("429 Too Many Requests")).toBe(msg);
    expect(classifyProviderFailure("rate limit exceeded")).toBe(msg);
    expect(classifyProviderFailure("rate_limit_error")).toBe(msg);
  });

  it("maps auth causes", () => {
    const msg =
      "The AI provider rejected the credentials (authentication failed). Check the API key.";
    expect(classifyProviderFailure("401 Unauthorized")).toBe(msg);
    expect(classifyProviderFailure("authentication_error")).toBe(msg);
    expect(classifyProviderFailure("invalid x-api-key header")).toBe(msg);
    expect(classifyProviderFailure("permission denied")).toBe(msg);
  });

  it("maps model access/not-found causes", () => {
    const msg = "The requested AI model is unavailable or access is denied.";
    expect(classifyProviderFailure("model not found")).toBe(msg);
    expect(classifyProviderFailure("the model does not exist")).toBe(msg);
    expect(classifyProviderFailure("model access is not allowed")).toBe(msg);
  });

  it("maps overloaded causes", () => {
    const msg = "The AI provider is overloaded. Please retry shortly.";
    expect(classifyProviderFailure("529 overloaded_error")).toBe(msg);
    expect(classifyProviderFailure("Overloaded")).toBe(msg);
  });

  it("returns undefined when nothing matches", () => {
    expect(classifyProviderFailure("the socket hung up")).toBeUndefined();
  });

  it("does not match status codes embedded in larger numbers or 'rate-limiter'", () => {
    expect(classifyProviderFailure("processed 4013 items")).toBeUndefined();
    expect(classifyProviderFailure("processed 14290 tokens")).toBeUndefined();
    expect(classifyProviderFailure("elapsed 5290 ms")).toBeUndefined();
    expect(classifyProviderFailure("our rate-limiter dropped it")).toBeUndefined();
  });
});

describe("sanitizeDetail", () => {
  it("redacts Anthropic and OpenAI style keys", () => {
    const out = sanitizeDetail(
      "auth failed with sk-ant-api03-abcDEF1234567890_-token and sk-abcdefghijklmnopqrstuvwxyz0123456789",
    );
    expect(out).not.toMatch(/sk-ant-api03/);
    expect(out).not.toMatch(/abcdefghijklmnopqrstuvwxyz0123456789/);
    expect(out).toContain("[redacted]");
  });

  it("redacts GitLab, GitHub and Google secret prefixes", () => {
    expect(sanitizeDetail("token glpat-notarealtoken")).not.toContain(
      "glpat-notarealtoken",
    );
    expect(sanitizeDetail("token ghp_abcdefghij1234567890ABCDEFGH")).not.toContain(
      "ghp_abcdefghij1234567890ABCDEFGH",
    );
    expect(sanitizeDetail("client GOCSPX-abcd1234efgh5678")).not.toContain(
      "GOCSPX-abcd1234efgh5678",
    );
  });

  it("redacts Bearer tokens while keeping the label", () => {
    const out = sanitizeDetail("Authorization: Bearer abcdef.ghijkl-mnop_qrstuv");
    expect(out).toContain("Bearer [redacted]");
    expect(out).not.toContain("abcdef.ghijkl-mnop_qrstuv");
  });

  it("strips a leading generic error-class prefix", () => {
    expect(sanitizeDetail("TypeError: cannot read x of undefined")).toBe(
      "cannot read x of undefined",
    );
    expect(sanitizeDetail("Error: boom")).toBe("boom");
  });

  it("redacts credentials in URLs but keeps the host", () => {
    const out = sanitizeDetail(
      "clone failed: https://admin:s3cr3tPassw0rd@internal.example.com/repo.git",
    );
    expect(out).not.toContain("s3cr3tPassw0rd");
    expect(out).not.toContain("admin:");
    expect(out).toContain("[redacted]@internal.example.com");
  });

  it("redacts email addresses", () => {
    const out = sanitizeDetail("notified ops.team@blazity.com about the failure");
    expect(out).not.toContain("ops.team@blazity.com");
    expect(out).toContain("[redacted]");
  });

  it("redacts long hex and base64-ish runs", () => {
    const hex = "a".repeat(40);
    const token = "Ab9_".repeat(12); // 48 base64url-ish chars
    expect(sanitizeDetail(`digest ${hex}`)).not.toContain(hex);
    expect(sanitizeDetail(`token ${token}`)).not.toContain(token);
  });

  it("strips stack-trace frames", () => {
    const detail =
      "Error: boom\n    at Object.<anonymous> (/Users/x/app/file.ts:12:5)\n    at run (/Users/x/app/run.ts:3:1)";
    expect(sanitizeDetail(detail)).toBe("boom");
  });

  it("collapses whitespace and truncates to the cap", () => {
    const long = "word ".repeat(60); // 300 chars before trim
    const out = sanitizeDetail(long);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out).not.toContain("\n");
    expect(out).not.toMatch(/\s{2,}/);
  });

  it("returns an empty string for empty or whitespace-only detail", () => {
    expect(sanitizeDetail("")).toBe("");
    expect(sanitizeDetail("   \n\t  ")).toBe("");
  });
});

describe("deriveFailureMessage", () => {
  const providerGeneric = "An external service could not complete this block.";

  it("uses the curated message for a known provider cause", () => {
    expect(
      deriveFailureMessage({
        category: "provider",
        detail: "Credit balance is too low",
        genericMessage: providerGeneric,
      }),
    ).toBe(
      "The AI provider rejected the request: the account credit or billing balance is too low.",
    );
  });

  it("appends a sanitized snippet for an unknown provider cause", () => {
    expect(
      deriveFailureMessage({
        category: "provider",
        detail: "the upstream socket hung up",
        genericMessage: providerGeneric,
      }),
    ).toBe(`${providerGeneric} (the upstream socket hung up)`);
  });

  it("appends a sanitized snippet for non-provider categories (no curated match)", () => {
    expect(
      deriveFailureMessage({
        category: "checks",
        detail: "lint broke on 3 files",
        genericMessage: "The checks could not be started.",
      }),
    ).toBe("The checks could not be started. (lint broke on 3 files)");
  });

  it("does not apply curated provider matches to other categories", () => {
    // "401" would be a provider auth cause, but for a binding failure it must
    // fall through to the sanitized snippet, not the auth message.
    const generic = "A block input could not be resolved.";
    expect(
      deriveFailureMessage({
        category: "binding",
        detail: "returned 401 rows",
        genericMessage: generic,
      }),
    ).toBe(`${generic} (returned 401 rows)`);
  });

  it("returns just the generic text (no dangling parens) when detail is empty", () => {
    expect(
      deriveFailureMessage({
        category: "provider",
        detail: "   ",
        genericMessage: providerGeneric,
      }),
    ).toBe(providerGeneric);
  });
});
