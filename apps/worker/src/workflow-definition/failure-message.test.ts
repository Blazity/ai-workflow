import { describe, it, expect } from "vitest";
import {
  clampBothEnds,
  classifyProviderFailure,
  deriveFailureMessage,
  operatorFailureDetail,
  sanitizeDetail,
  sanitizeFailureMessage,
} from "./failure-message.js";

/**
 * The exact failure family that cost a production diagnosis on 2026-07-30:
 * `summarize()` in trusted-workspace-publisher prefixes the repository, git
 * prints its progress noise first and its verdict last. A head slice therefore
 * keeps "Cloning into '<path>'..." and throws the verdict away every time.
 */
const GIT_CLONE_403_DETAIL =
  "github:Blazity/ai-workflow-prod: canonical clone failed: " +
  "Cloning into '/vercel/sandbox/publisher/0'...\n" +
  "fatal: unable to access 'https://github.com/Blazity/ai-workflow-prod.git/': " +
  "The requested URL returned error: 403";
const GIT_CLONE_403_VERDICT = "The requested URL returned error: 403";
const PROD_DIAGNOSTIC_ID =
  "AIW-DIAG-wrun_01KYSFRC85YWWMD6WH2FQG0C30-open-pr-finalize-1";

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
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out).not.toContain("\n");
    expect(out).not.toMatch(/\s{2,}/);
  });

  it("keeps the git verdict a head slice threw away (the production case)", () => {
    const collapsed = GIT_CLONE_403_DETAIL.replace(/\s+/g, " ").trim();
    // Guard: this test is worthless unless the old head slice would fail it.
    // The detail is over the cap and its verdict starts past the cap.
    expect(collapsed.length).toBeGreaterThan(160);
    expect(collapsed.slice(0, 160)).not.toContain(GIT_CLONE_403_VERDICT);

    const out = sanitizeDetail(GIT_CLONE_403_DETAIL);
    expect(out).toContain(GIT_CLONE_403_VERDICT);
    // The head still says which repository and which operation failed.
    expect(out).toContain("github:Blazity/ai-workflow-prod");
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out).not.toContain("\n");
    expect(out).toContain("[...]");
  });

  it("redacts a secret that lands in the newly preserved tail", () => {
    const token = "ghp_abcdefghij1234567890ABCDEFGH";
    const detail =
      "github:Blazity/ai-workflow-prod: canonical clone failed: " +
      "Cloning into '/vercel/sandbox/publisher/0'...\n" +
      "fatal: Authentication failed for " +
      `'https://github.com/Blazity/ai-workflow-prod.git/' using token ${token}`;
    const collapsed = detail.replace(/\s+/g, " ").trim();
    // The secret sits in the tail the new truncation preserves, not in the
    // head the old one kept, so this covers the newly exposed surface.
    expect(collapsed.slice(0, 160)).not.toContain(token);

    const out = sanitizeDetail(detail);
    expect(out).not.toContain(token);
    // The tail survived (that is the new behaviour) with the secret in it gone.
    expect(out).toContain("using token [redacted]");
  });

  it("keeps the surviving tail bounded for an unbounded detail", () => {
    const out = sanitizeDetail(`${"noise ".repeat(4_000)}fatal: the real cause`);
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out).toContain("fatal: the real cause");
  });

  it("returns an empty string for empty or whitespace-only detail", () => {
    expect(sanitizeDetail("")).toBe("");
    expect(sanitizeDetail("   \n\t  ")).toBe("");
  });
});

describe("sanitizeFailureMessage", () => {
  const composed = `${deriveFailureMessage({
    category: "provider",
    detail: GIT_CLONE_403_DETAIL,
    genericMessage: "An external service could not complete this block.",
  })} Diagnostic ID: ${PROD_DIAGNOSTIC_ID}`;

  it("does not cut an already-composed message a second time", () => {
    // The response boundary re-sanitizes a whole composed message. At the
    // snippet bound that second pass would eat the cause the snippet preserved.
    expect(sanitizeDetail(composed)).not.toContain(GIT_CLONE_403_VERDICT);

    const out = sanitizeFailureMessage(composed);
    expect(out).toContain(GIT_CLONE_403_VERDICT);
    expect(out).toContain("An external service could not complete this block.");
    expect(out).toContain(PROD_DIAGNOSTIC_ID);
  });

  it("keeps a whole well-formed diagnostic ID out of the long-token redaction", () => {
    expect(sanitizeFailureMessage(`Run failed. Diagnostic ID: ${PROD_DIAGNOSTIC_ID}`)).toBe(
      `Run failed. Diagnostic ID: ${PROD_DIAGNOSTIC_ID}`,
    );
  });

  it("still redacts a same-shaped token that is not a diagnostic ID", () => {
    expect(sanitizeFailureMessage("leaked Zk9_thisIsALongOpaqueTokenValue-0123456789")).toBe(
      "leaked [redacted]",
    );
  });

  it("redacts a secret glued behind the diagnostic prefix", () => {
    // The exemption must match a WHOLE well-formed ID. A prefix test would let
    // anything beginning with "AIW-DIAG-" ride the exemption out to Slack, the
    // GitLab commit status and the dashboard, all of which take this same path.
    const secret = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIj";
    for (const smuggled of [
      `AIW-DIAG-${secret}`,
      `AIW-DIAG-${secret}-notanattempt`,
      `AIW-DIAG-${secret}.9`,
      // One 46-character segment, so the per-segment bound rejects it even
      // though it does end in "-<digits>".
      `AIW-DIAG-${secret}-1`,
    ]) {
      const out = sanitizeFailureMessage(`provider echoed key=${smuggled} here`);
      expect(out, smuggled).not.toContain(secret);
      expect(out, smuggled).toContain("[redacted]");
    }
  });

  it("spares an ingestion diagnostic ID, the other producer's shape", () => {
    // recordIngestionFailure emits prefix + "ingest-" + a v4 UUID, which is 52
    // token characters and was being redacted by the catch-all.
    const ingestId = "AIW-DIAG-ingest-550e8400-e29b-41d4-a716-446655440000";
    expect(sanitizeFailureMessage(`Ingestion failed. Diagnostic ID: ${ingestId}`)).toBe(
      `Ingestion failed. Diagnostic ID: ${ingestId}`,
    );
    // The hex-only UUID shape cannot be used to smuggle a base64 secret.
    expect(
      sanitizeFailureMessage(
        "AIW-DIAG-ingest-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIj",
      ),
    ).toBe("[redacted]");
  });

  it("redacts Basic credentials and whole JWTs, not just their signature", () => {
    const basic = sanitizeFailureMessage(
      "clone failed: Authorization: Basic eHVzZXI6c2VjcmV0dmFsdWU=",
    );
    expect(basic).not.toContain("eHVzZXI6c2VjcmV0dmFsdWU");
    expect(basic).toContain("Basic [redacted]");

    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.Zm9vYmFyc2ln";
    const out = sanitizeFailureMessage(`token ${jwt} rejected`);
    expect(out).not.toContain("eyJzdWIiOiJhZG1pbiJ9");
    expect(out).toBe("token [redacted] rejected");
  });

  it("still bounds, redacts and single-lines an over-long message", () => {
    const out = sanitizeFailureMessage(
      `${"pad ".repeat(500)}\nsecret sk-ant-api03-abcDEF1234567890_-token trailer`,
    );
    expect(out.length).toBeLessThanOrEqual(400);
    expect(out).not.toContain("sk-ant-api03");
    expect(out).not.toContain("\n");
  });
});

describe("clampBothEnds", () => {
  it("keeps the verdict and the whole diagnostic ID at GitLab's 255 limit", () => {
    // Pinned arithmetic for the production shape a pr_trigger run posts as a
    // GitLab commit-status description: generic 50 + " (" + snippet 160 + ")"
    // + " Diagnostic ID: " + a 59-character ID = 288, over GitLab's 255.
    const generic = "An external service could not complete this block.";
    const snippet = sanitizeDetail(GIT_CLONE_403_DETAIL);
    const summary = `${generic} (${snippet}) Diagnostic ID: ${PROD_DIAGNOSTIC_ID}`;
    expect(generic.length).toBe(50);
    expect(snippet.length).toBe(160);
    expect(PROD_DIAGNOSTIC_ID.length).toBe(59);
    expect(summary.length).toBe(288);

    // The head slice this replaced cut 33 characters, taking the verdict and the
    // end of the ID with them, leaving an ID that still parses but matches no run.
    const sliced = summary.slice(0, 255);
    expect(sliced).not.toContain(PROD_DIAGNOSTIC_ID);
    expect(sliced).toContain("Diagnostic ID: AIW-DIAG-");

    const out = clampBothEnds(summary, 255);
    expect(out.length).toBeLessThanOrEqual(255);
    expect(out).toContain(GIT_CLONE_403_VERDICT);
    expect(out).toContain(PROD_DIAGNOSTIC_ID);
  });

  it("is a no-op below the limit", () => {
    expect(clampBothEnds("short summary", 255)).toBe("short summary");
  });
});

describe("operatorFailureDetail", () => {
  it("keeps the whole cause an operator needs, not just the customer snippet", () => {
    const out = operatorFailureDetail(GIT_CLONE_403_DETAIL);
    expect(out).toContain("Cloning into '/vercel/sandbox/publisher/0'...");
    expect(out).toContain("fatal: unable to access");
    expect(out).toContain(GIT_CLONE_403_VERDICT);
    expect(out).not.toContain("\n");
  });

  it("applies the same redaction as the customer-facing snippet", () => {
    const out = operatorFailureDetail(
      "clone failed for ops.team@blazity.com with token ghp_abcdefghij1234567890ABCDEFGH",
    );
    expect(out).not.toContain("ops.team@blazity.com");
    expect(out).not.toContain("ghp_abcdefghij1234567890ABCDEFGH");
    expect(out).toContain("[redacted]");
  });

  it("strips stack frames and stays bounded for a long stack", () => {
    const frames = Array.from(
      { length: 200 },
      (_, index) => `    at step${index} (/vercel/path0/apps/worker/src/file.ts:${index}:1)`,
    ).join("\n");
    const out = operatorFailureDetail(`Error: boom\n${frames}`);
    expect(out).toBe("boom");
    expect(out).not.toContain("/vercel/path0");
  });

  it("bounds a detail with no frames to trim", () => {
    const out = operatorFailureDetail(`${"noise ".repeat(4_000)}fatal: the real cause`);
    expect(out.length).toBeLessThanOrEqual(1_000);
    expect(out).toContain("fatal: the real cause");
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
