import { describe, it, expect } from "vitest";
import {
  clampBothEnds,
  classifyProviderFailure,
  curatedProviderFailureOf,
  deriveFailureMessage,
  operatorFailureDetail,
  sanitizeDetail,
  sanitizeFailureMessage,
} from "@shared/workflow-graph";

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
      "The AI provider rejected the request: the account credit or billing balance is too low. An admin must top up the AI provider account; nothing is wrong with the ticket, and a rerun fails the same way until then.";
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
      "The AI provider rejected the credentials (authentication failed). An admin must check and replace the API key; nothing is wrong with the ticket, and a rerun fails the same way until then.";
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

  it("maps the enforced spend limit cause, including the real OpenAI wording", () => {
    // Captured verbatim from Arthur run wrun_01M0J7D367ZQW6Q487T467M0PV
    // (2026-08-21), the outage AIW-312 was filed on.
    const capture =
      "stream disconnected before completion: Your project has reached its configured enforced spend limit. Update your limit at https://platform.openai.com/settings/proj_test1234/limits.";
    const spendMessage =
      "The AI provider rejected the request: the account has reached its configured spend limit. An admin must raise or remove the spend limit in the provider's billing settings, or wait for it to reset; nothing is wrong with the ticket, and a rerun fails the same way until then.";
    expect(classifyProviderFailure(capture)).toBe(spendMessage);
    expect(classifyProviderFailure(capture, true)).toBe(spendMessage);
    expect(classifyProviderFailure("monthly spend limit reached")).toBe(spendMessage);
  });

  it("maps a bare stream disconnect to the connection message, but never ahead of a named cause", () => {
    expect(
      classifyProviderFailure("stream disconnected before completion: upstream reset"),
    ).toBe(
      "The AI provider connection dropped before the response completed. Please retry shortly.",
    );
    // The transport prefix must not shadow the named cause behind it: the
    // disconnect rule sits last in the table exactly for this.
    expect(
      classifyProviderFailure(
        "stream disconnected before completion: You have no credits remaining.",
      ),
    ).toBe(
      "The AI provider rejected the request: the account credit or billing balance is too low. An admin must top up the AI provider account; nothing is wrong with the ticket, and a rerun fails the same way until then.",
    );
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
    // The whole userinfo segment goes, "@" included (AIW-254): a surviving
    // "[redacted]@" still reads as a credentialed URL to the run trace's replay
    // sanitizer, which then replaces the URL whole and drops the host from that
    // one surface while Slack and the ticket comment keep it.
    expect(out).toBe("clone failed: https://internal.example.com/repo.git");
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

  it("leaves prose after the scheme word alone", () => {
    // The first of these is a real GitHub and GitLab HTTP error. A rule that
    // accepts any eight-or-more-letter run ate the diagnosis on exactly the git
    // auth failure this file exists to preserve, and rewrote the prose casing.
    // The 16-character floor is what keeps these green; measured against real
    // corpora the longest lowercase word following "basic" is 14 characters.
    for (const prose of [
      "remote: Basic authentication is not supported for Git operations.",
      "basic authentication failed for repository origin",
      "No bearer credentials were supplied by the caller.",
      "remote: Basic Authentication is not supported.",
      "Bearer Credentials were not supplied.",
    ]) {
      expect(sanitizeFailureMessage(prose), prose).toBe(prose);
    }
  });

  it("keeps the longest real prose word under the redaction floor", () => {
    // Pins the 2-character margin the floor relies on. If a longer word is ever
    // found following a scheme word in real error text, this is the assumption
    // that broke.
    for (const word of ["authentication", "implementation", "optimizations"]) {
      expect(word.length, word).toBeLessThan(16);
      expect(sanitizeFailureMessage(`Basic ${word} is not supported`)).toBe(
        `Basic ${word} is not supported`,
      );
    }
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

    // Signature-less JWT, and a Bearer-carried one.
    expect(
      sanitizeFailureMessage("cookie eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9 set"),
    ).toBe("cookie [redacted] set");
    expect(sanitizeFailureMessage(`authorization: bearer ${jwt}`)).toBe(
      "authorization: Bearer [redacted]",
    );
  });

  it("redacts an all-lowercase opaque token after either scheme word", () => {
    // A valid bearer token carries no guarantee of an uppercase letter or a
    // digit, and for base64 the guarantee is only probabilistic: a 16-character
    // run is all-lowercase roughly one time in 1.8 million. A composition check
    // therefore traded a certain under-redaction for a prose risk the
    // 16-character floor already covers, on the path that reaches Slack, the
    // GitLab commit status and the dashboard.
    expect(sanitizeFailureMessage("Authorization: Bearer abcdefghijklmnop")).toBe(
      "Authorization: Bearer [redacted]",
    );
    expect(sanitizeFailureMessage("Authorization: Basic abcdefghijklmnop")).toBe(
      "Authorization: Basic [redacted]",
    );
    // And in the composed shape a real failure message takes.
    expect(
      sanitizeDetail("push rejected: Authorization: bearer qwertyuiopasdfghjkl"),
    ).toBe("push rejected: Authorization: Bearer [redacted]");
  });

  it("still redacts an encoded value after the scheme word, either casing", () => {
    for (const [input, expected] of [
      [
        "clone failed: Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==",
        "clone failed: Authorization: Basic [redacted]",
      ],
      // Lowercase scheme, as HTTP/2 and curl -v print it.
      ["authorization: basic eHVzZXI6c2VjcmV0dmFsdWU=", "authorization: Basic [redacted]"],
      // Opaque all-lowercase token: kept covered by the separator evidence, so
      // the prose fix did not weaken this direction.
      ["Authorization: Bearer abcdef.ghijkl-mnop_qrstuv", "Authorization: Bearer [redacted]"],
      ["Bearer sk-ant-api03-abcDEF1234567890_-token", "Bearer [redacted]"],
    ] as const) {
      expect(sanitizeFailureMessage(input), input).toBe(expected);
    }
  });

  it("rejects a diagnostic ID longer than any real one", () => {
    // Repeating the segment group left the total length unbounded, so a bulk
    // payload chunked into cap-sized segments satisfied the shape. Segments are
    // deliberately non-hex so the earlier hex rule is not what redacts them.
    const segment = "Zx".repeat(16);
    const chunked = `AIW-DIAG-${segment}-${segment}-${segment}-${segment}-1`;
    expect(segment.length).toBe(32);
    expect(chunked.length).toBeGreaterThan(120);
    expect(sanitizeFailureMessage(`echoed ${chunked}`)).toBe("echoed [redacted]");
  });

  it("KNOWN LIMITATION: shape matching is defeatable by chunking a known secret", () => {
    // Recorded as an executable fact, not hidden in a comment. This is shape
    // matching, not authentication: a secret split across cap-sized segments
    // still satisfies the shape and survives verbatim. Exploiting it needs text
    // injection into a failure detail AND prior knowledge of the secret. The
    // real fix is to splice in the ID we know out of band instead of inspecting
    // shape, which means threading the run's own ID down to this boundary.
    // If a future change makes this expectation fail, the weakness is closed:
    // delete this test rather than restoring the behaviour.
    // The payload is deliberately not shaped like any real credential: an
    // earlier version used a Stripe-looking prefix and GitHub push protection
    // rejected the push. What the case needs is only that the run is opaque,
    // carries no recognised prefix, and is split into cap-sized segments.
    const chunked = "AIW-DIAG-notarealsecret_AAAAAAAAAAAAAAAAA-bbbbbbbbbbbbbbbbbbbbbbbbb-0";
    expect(chunked.length).toBeLessThanOrEqual(120);
    expect(sanitizeFailureMessage(chunked)).toBe(chunked);
  });

  it("still bounds, redacts and single-lines an over-long message", () => {
    const out = sanitizeFailureMessage(
      `${"pad ".repeat(500)}\nsecret sk-ant-api03-abcDEF1234567890_-token trailer`,
    );
    // 1_100, raised from 600 once the bound had to hold a whole repository
    // work-scope refusal as its lead (at 600 the longest one was elided through
    // its middle and reached the ticket as half a sentence). Before that it was
    // raised from 400 by AIW-254 to hold a lead sentence, a 160-character cause
    // snippet AND the reserved diagnostic suffix. The property is the same in
    // all three versions: no message this module composes is ever clamped here.
    // Slack and the ticket comment get the same string without this call, and a
    // clamp that fired only here would make the surfaces disagree.
    expect(out.length).toBeLessThanOrEqual(1_100);
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

  /** Every piece of the clamped text is a run of whole words of the original:
   *  the head ends where a word of the original ends, and the tail starts where
   *  one starts. */
  function cutBetweenWords(original: string, clamped: string): boolean {
    const [head, tail] = clamped.split(" [...] ");
    if (head === undefined || tail === undefined) return false;
    const headEndsAWord = original.startsWith(head) && /\s/.test(original[head.length] ?? " ");
    const tailStartsAWord =
      original.endsWith(tail) && /\s/.test(original[original.length - tail.length - 1] ?? " ");
    return headEndsAWord && tailStartsAWord;
  }

  /**
   * D5, D8 and D10 on production, 2026-09-18: the sentence the expansion loop
   * writes when it closes arrives as raw detail, longer than the snippet cap,
   * and the status reason and the ticket comment both read "the agent sti [...]
   * epository list".
   */
  const CLOSED_EXPANSION =
    "Repository expansion is closed for this run and the agent still needs github:Blazity/ai-workflow." +
    " Select it in this work's repository list, through the work scope API or the work_scope.edit tool," +
    " and start a new run.";

  it("never cuts a word in half, on the sentence production cut", () => {
    const out = deriveFailureMessage({
      category: "engine",
      detail: CLOSED_EXPANSION,
      genericMessage: "The workflow engine could not continue.",
    });
    const snippet = out.slice(out.indexOf("(") + 1, out.lastIndexOf(")"));

    expect(CLOSED_EXPANSION.length).toBeGreaterThan(160);
    expect(snippet.length).toBeLessThanOrEqual(160);
    expect(snippet).toContain("[...]");
    expect(snippet).not.toContain("sti [...]");
    expect(cutBetweenWords(CLOSED_EXPANSION, snippet)).toBe(true);
  });

  it("cuts between sentences where a sentence boundary keeps most of that end", () => {
    const text =
      "Cloning github:acme/api failed after the checkout step. " +
      "The runner printed a long stretch of progress output that says nothing about why, ".repeat(3) +
      "and then it stopped. The requested URL returned error: 403 while fetching github:acme/api.";
    const out = clampBothEnds(text, 160);

    expect(out.length).toBeLessThanOrEqual(160);
    // The tail starts at the sentence that carries the verdict, not a word into
    // the sentence before it, and the head ends where its sentence does.
    expect(out).toBe(
      "Cloning github:acme/api failed after the checkout step. [...] The requested URL returned error: 403 while fetching github:acme/api.",
    );
    expect(cutBetweenWords(text, out)).toBe(true);
  });

  it("still cuts through a single token too long to cut between words", () => {
    const token = `https://example.invalid/${"a".repeat(300)}`;
    const out = clampBothEnds(token, 160);

    expect(out.length).toBeLessThanOrEqual(160);
    expect(out).toContain(" [...] ");
    expect(out.startsWith("https://example.invalid/")).toBe(true);
  });

  it("does not stack its marker against one an earlier clamp left", () => {
    const summary =
      `An external service could not complete this block. (${sanitizeDetail(GIT_CLONE_403_DETAIL)})` +
      ` Diagnostic ID: ${PROD_DIAGNOSTIC_ID}`;
    const out = clampBothEnds(summary, 255);

    expect(out).not.toContain("[...] [...]");
    expect(out).toContain(GIT_CLONE_403_VERDICT);
    expect(out).toContain(PROD_DIAGNOSTIC_ID);
  });

  // The marker itself is " [...] ", 7 characters. Below and at that limit
  // there is no budget left for real text once the marker is paid for, so the
  // old arithmetic went negative and the result grew past maxLength instead
  // of shrinking to it (production shape: a limit this tight only ever comes
  // from a caller-supplied cap, but nothing stopped one from being this
  // small).
  const MARKER_LENGTH = 7;
  const LONG_TEXT = "The requested URL returned error: 403 while fetching github:acme/api.";

  it("cuts to a plain prefix with no marker when maxLength is 0", () => {
    const out = clampBothEnds(LONG_TEXT, 0);

    expect(out).toBe("");
    expect(out.length).toBeLessThanOrEqual(0);
  });

  it("cuts to a plain prefix with no marker when maxLength is 1", () => {
    const out = clampBothEnds(LONG_TEXT, 1);

    expect(out).toBe(LONG_TEXT.slice(0, 1));
    expect(out).not.toContain("[...]");
    expect(out.length).toBeLessThanOrEqual(1);
  });

  it("cuts to a plain prefix with no marker when maxLength equals the elision marker's length", () => {
    const out = clampBothEnds(LONG_TEXT, MARKER_LENGTH);

    expect(out).toBe(LONG_TEXT.slice(0, MARKER_LENGTH));
    expect(out).not.toContain("[...]");
    expect(out.length).toBeLessThanOrEqual(MARKER_LENGTH);
  });

  it("stays within maxLength one past the elision marker's length, where the marker returns", () => {
    const out = clampBothEnds(LONG_TEXT, MARKER_LENGTH + 1);

    expect(out.length).toBeLessThanOrEqual(MARKER_LENGTH + 1);
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
      "The AI provider rejected the request: the account credit or billing balance is too low. An admin must top up the AI provider account; nothing is wrong with the ticket, and a rerun fails the same way until then.",
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

  // AIW-254 flips this deliberately. It used to assert the generic sentence
  // alone, which is the exact output the ticket exists to remove: a failure
  // surface that states only its category explains nothing, and the operator's
  // next move was to read raw logs. With nothing to quote it now names the
  // candidate causes and where the raw session is instead.
  it("names candidate causes instead of the bare generic text when nothing was captured", () => {
    const out = deriveFailureMessage({
      category: "provider",
      detail: "   ",
      genericMessage: providerGeneric,
    });
    expect(out).not.toBe(providerGeneric);
    expect(out).toContain(providerGeneric);
    expect(out).toContain("Likely causes:");
    expect(out).toContain("LOGS tab");
    expect(out).not.toContain("()");
  });
});

describe("deriveFailureMessage with agent evidence (AIW-254)", () => {
  const providerGeneric = "An external service could not complete this block.";
  /** The agent adapters' per-category sentence. Every agent call site supplies
   *  it, and before AIW-254 it was the whole user-facing message. */
  const AGENT_LEAD = "The current agent phase could not be completed.";
  /** Captured verbatim from Arthur run wrun_01KZTDNAJS4CN5DHDV9TFGPKA2
   *  (2026-08-12), the outage this ticket was filed on. */
  const EXHAUSTED_CREDITS =
    "stream disconnected before completion: You have no credits remaining. " +
    "Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.";
  const BILLING_MESSAGE =
    "The AI provider rejected the request: the account credit or billing balance is too low. An admin must top up the AI provider account; nothing is wrong with the ticket, and a rerun fails the same way until then.";
  /** Captured verbatim from Arthur run wrun_01M0J7D367ZQW6Q487T467M0PV
   *  (2026-08-21), the outage AIW-312 was filed on; the proj_ id is replaced. */
  const SPEND_LIMIT =
    "stream disconnected before completion: Your project has reached its configured enforced spend limit. Update your limit at https://platform.openai.com/settings/proj_test1234/limits.";
  /** Codex prints this on every invocation whose codex_home sits under /tmp;
   *  it says nothing about any failure. */
  const PATH_ALIASES_WARNING =
    "WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir \"/tmp\" (codex_home: AbsolutePathBuf(\"/tmp/aiw-harness/hash/home/.codex\"))";

  it("classifies the spend limit out of the structured provider error ahead of the stderr warning", () => {
    expect(
      deriveFailureMessage({
        category: "provider",
        detail: "Codex emitted a provider error event.",
        genericMessage: providerGeneric,
        explicitMessage: AGENT_LEAD,
        evidence: {
          failureKind: "provider_error",
          exitCode: 1,
          providerError: SPEND_LIMIT,
          stderrTail: PATH_ALIASES_WARNING,
        },
      }),
    ).toBe(
      "The AI provider rejected the request: the account has reached its configured spend limit. An admin must raise or remove the spend limit in the provider's billing settings, or wait for it to reset; nothing is wrong with the ticket, and a rerun fails the same way until then.",
    );
  });

  it("classifies exhausted provider credits out of the captured stdout tail", () => {
    expect(
      deriveFailureMessage({
        category: "provider",
        detail: "The CLI exited with code 1.",
        genericMessage: providerGeneric,
        explicitMessage: AGENT_LEAD,
        evidence: {
          failureKind: "cli_exit",
          exitCode: 1,
          stdoutTail: `some earlier chatter\n${EXHAUSTED_CREDITS}`,
        },
      }),
    ).toBe(BILLING_MESSAGE);
  });

  it("classifies exhausted provider credits out of the captured stderr tail", () => {
    expect(
      deriveFailureMessage({
        category: "provider",
        detail: "The CLI exited with code 1.",
        genericMessage: providerGeneric,
        explicitMessage: AGENT_LEAD,
        evidence: {
          failureKind: "cli_exit",
          exitCode: 1,
          stderrTail: EXHAUSTED_CREDITS,
        },
      }),
    ).toBe(BILLING_MESSAGE);
  });

  it("classifies the credits phrasing without the trailing billing URL", () => {
    // The pre-AIW-254 rule only matched this capture through the word "billing"
    // inside that URL. A provider that drops or shortens the link must still be
    // classified, so the phrasing itself is a rule.
    expect(
      deriveFailureMessage({
        category: "provider",
        detail: "The CLI exited with code 1.",
        genericMessage: providerGeneric,
        explicitMessage: AGENT_LEAD,
        evidence: {
          failureKind: "cli_exit",
          exitCode: 1,
          stderrTail: "You have no credits remaining.",
        },
      }),
    ).toBe(BILLING_MESSAGE);
  });

  it("does not let an explicit call-site message suppress the cause", () => {
    const out = deriveFailureMessage({
      category: "provider",
      detail: "The CLI exited with code 1.",
      genericMessage: providerGeneric,
      explicitMessage: AGENT_LEAD,
      evidence: {
        failureKind: "cli_exit",
        exitCode: 1,
        stderrTail: "codex: the workspace sandbox refused a write to /etc/hosts",
      },
    });
    expect(out).toContain(AGENT_LEAD);
    expect(out).toContain("refused a write to /etc/hosts");
  });

  it("prefers the structured provider error over the raw tails", () => {
    const out = deriveFailureMessage({
      category: "parsing",
      detail: "Codex did not emit a turn.completed event.",
      genericMessage: "The block response could not be parsed.",
      explicitMessage: AGENT_LEAD,
      evidence: {
        failureKind: "provider_error",
        providerError: "upstream connection reset by the model gateway",
        stderrTail: "npm notice a new version of npm is available",
        stdoutTail: '{"type":"session.created"}',
      },
    });
    expect(out).toContain("upstream connection reset by the model gateway");
    expect(out).not.toContain("npm notice");
  });

  it("keeps a protocol detail ahead of the tails when the detail is the cause", () => {
    // schema_mismatch is not a shape-only kind: its detail names the protocol
    // problem, and 2 KB of agent JSONL would bury it.
    const out = deriveFailureMessage({
      category: "schema",
      detail: "The structured response did not satisfy the requested schema.",
      genericMessage: "The block returned an invalid result.",
      explicitMessage: "The current agent phase returned an invalid structured response.",
      evidence: {
        failureKind: "schema_mismatch",
        exitCode: 0,
        stdoutTail: '{"type":"item.completed","item":{"type":"agent_message"}}',
      },
    });
    expect(out).toContain("did not satisfy the requested schema");
  });

  it("falls back to candidate causes and the LOGS tab when only an exit code survives", () => {
    const out = deriveFailureMessage({
      category: "provider",
      detail: "   ",
      genericMessage: providerGeneric,
      explicitMessage: AGENT_LEAD,
      evidence: { failureKind: "cli_exit", exitCode: 137 },
    });
    expect(out).toContain(AGENT_LEAD);
    expect(out).toContain("exited with code 137");
    expect(out).toContain("exhausted provider credits");
    expect(out).toContain("revoked or expired API key");
    expect(out).toContain("LOGS tab");
  });

  it("shows a sanitized snippet plus no bare category line for an unclassified CLI failure", () => {
    const out = deriveFailureMessage({
      category: "provider",
      detail: "The CLI exited with code 1.",
      genericMessage: providerGeneric,
      explicitMessage: AGENT_LEAD,
      evidence: {
        failureKind: "cli_exit",
        exitCode: 1,
        stderrTail:
          "thread 'main' panicked at src/exec.rs:88: the sandbox seccomp filter rejected clone3",
      },
    });
    expect(out).toBe(
      `${AGENT_LEAD} (thread 'main' panicked at src/exec.rs:88: the sandbox seccomp filter rejected clone3)`,
    );
  });

  it("reads a tail from its last whole lines rather than a mid-stream byte cut", () => {
    // A 2 KB tail is cut at a byte offset, so its first line is a fragment. The
    // snippet has to start at a real line boundary or the operator reads noise.
    const out = deriveFailureMessage({
      category: "unknown",
      detail: "The CLI exited with code 1.",
      genericMessage: "The block could not be completed.",
      evidence: {
        failureKind: "cli_exit",
        exitCode: 1,
        stderrTail: `ing mid-sentence fragment of an earlier line\n${"filler line\n".repeat(20)}the real verdict: config.toml is malformed`,
      },
    });
    expect(out).toContain("the real verdict: config.toml is malformed");
    expect(out).not.toContain("ing mid-sentence fragment");
  });

  it("keeps a GitLab listing timeout in the message instead of eliding it", () => {
    // Reproduces run wrun_01KZTCKX34R5D0GHJKN4XMGN0V: the composed pre-sandbox
    // detail is long enough that clampBothEnds ate the middle, and the middle was
    // the only part naming what broke.
    const composed =
      "pre-sandbox: Select repositories failed: repository listing for gitlab is unavailable " +
      "(gitlab: GitLab projects list timed out after 15000ms), so the repository catalog was incomplete. " +
      "No deterministic repository signal resolved the selection, and choosing from a partial catalog could pick the wrong repository. " +
      "Retry once the provider recovers, or name the repository path in the ticket.";
    const withoutCause = deriveFailureMessage({
      category: "sandbox",
      detail: composed,
      genericMessage: "The workspace environment could not complete this block.",
    });
    // The defect, pinned: with no isolated cause the timeout is still elided.
    expect(withoutCause).not.toContain("timed out after 15000ms");

    const out = deriveFailureMessage({
      category: "sandbox",
      detail: composed,
      genericMessage: "The workspace environment could not complete this block.",
      evidence: { cause: "gitlab: GitLab projects list timed out after 15000ms" },
    });
    expect(out).toContain("GitLab projects list timed out after 15000ms");
  });

  it("redacts credentials that arrive inside captured output", () => {
    const out = deriveFailureMessage({
      category: "unknown",
      detail: "The CLI exited with code 1.",
      genericMessage: "The block could not be completed.",
      evidence: {
        failureKind: "cli_exit",
        exitCode: 1,
        stderrTail:
          "push rejected for https://ci:glpat-AbCdEfGhIjKlMnOpQr@gitlab.com/acme/app.git using sk-ant-api03-abcDEF1234567890_-tok",
      },
    });
    expect(out).not.toContain("glpat-AbCdEfGhIjKlMnOpQr");
    expect(out).not.toContain("sk-ant-api03");
    expect(out).toContain("[redacted]");
  });

  it("does not print the cause twice when the lead sentence already states it", () => {
    const described = "1 high-confidence secret match: aws_key in src/a.ts (AKIA****)";
    const out = deriveFailureMessage({
      category: "checks",
      detail: `leak_review blocked publication: ${described}`,
      genericMessage: "The checks could not be started.",
      explicitMessage:
        `Leak review blocked publication before the branch was pushed: ${described}. ` +
        "Remove the secret from the change and rerun.",
    });
    expect(out.match(/aws_key in src\/a\.ts/g)).toHaveLength(1);
  });

  it("still appends a short reason the lead does not already state", () => {
    const out = deriveFailureMessage({
      category: "sandbox",
      detail: "Repository instructions could not be loaded: ENOENT",
      genericMessage: "The workspace environment could not complete this block.",
      explicitMessage: "Repository instructions could not be loaded safely.",
    });
    expect(out).toContain("ENOENT");
  });

  it("does not read a local chmod failure as rejected API credentials", () => {
    // "permission denied" is a curated auth cause and stays one for a detail we
    // composed, but in a local command's stderr it is a chmod/exec failure. A
    // wrong curated sentence replaces the whole message, so it is worse than the
    // generic line it displaced.
    expect(classifyProviderFailure("provider said: permission denied")).toBe(
      "The AI provider rejected the credentials (authentication failed). An admin must check and replace the API key; nothing is wrong with the ticket, and a rerun fails the same way until then.",
    );
    expect(
      classifyProviderFailure("chmod: /vercel/sandbox/w.sh: permission denied", true),
    ).toBeUndefined();
    expect(
      deriveFailureMessage({
        category: "provider",
        detail: "The agent phase wrapper could not be made executable.",
        genericMessage: providerGeneric,
        explicitMessage: AGENT_LEAD,
        evidence: {
          failureKind: "setup_failed",
          exitCode: 1,
          stderrTail: "chmod: cannot access '/vercel/sandbox/w.sh': permission denied",
        },
      }),
    ).toBe(
      `${AGENT_LEAD} (chmod: cannot access '/vercel/sandbox/w.sh': permission denied)`,
    );
  });

  it("still classifies a real provider auth rejection out of a captured tail", () => {
    expect(
      deriveFailureMessage({
        category: "provider",
        detail: "The CLI exited with code 1.",
        genericMessage: providerGeneric,
        explicitMessage: AGENT_LEAD,
        evidence: {
          failureKind: "cli_exit",
          exitCode: 1,
          stderrTail: "request failed: 401 unauthorized",
        },
      }),
    ).toBe(
      "The AI provider rejected the credentials (authentication failed). An admin must check and replace the API key; nothing is wrong with the ticket, and a rerun fails the same way until then.",
    );
  });

  it("emits a message that crosses the response boundary unchanged", () => {
    // The cross-surface guarantee: the run header runs the composed message
    // through sanitizeFailureMessage while Slack and the ticket comment do not,
    // so derivation must produce text that boundary leaves alone. Padded with
    // prose, not a character run: a 40-character token run is a secret shape and
    // would be redacted by design, which is a different property.
    const longLead = `Leak review blocked publication before the branch was pushed: ${"redacted match here; ".repeat(12)}Remove the secret from the change and rerun.`;
    const message = deriveFailureMessage({
      category: "checks",
      detail: `the check runner refused the request ${"for one repository ".repeat(20)}`,
      genericMessage: "The checks could not be started.",
      explicitMessage: longLead,
    });
    const composed = `${message} Diagnostic ID: ${PROD_DIAGNOSTIC_ID}`;
    expect(composed.length).toBeLessThanOrEqual(600);
    expect(sanitizeFailureMessage(composed)).toBe(composed);
    // Both parts survive: the lead whole, because it is a sentence somebody
    // wrote for a person, and the cause behind it.
    expect(message).toContain(longLead);
    expect(message).toContain("the check runner refused the request");
  });
});

/**
 * The defect production found on 2026-09-18, on run
 * wrun_01M2SDKXF5QYNCXGCMRJJQ2HFF.
 *
 * A repository work-scope refusal is not a generic sentence with a cause
 * attached to it. It IS the message: one authored sentence per repository saying
 * which one was left out, why, and the way back. Composed as
 * `clampBothEnds(lead) (snippet)` it reached the person on the ticket as "This
 * deployment's confi [...] o continue." with all three facts in the elided
 * middle, and every surface agreed on that same half sentence, because the
 * refusal IS the run's status reason and the ticket comment.
 */
describe("an authored lead reaches the person whole", () => {
  const CONFIGURATION_GENERIC =
    "This deployment's configuration does not allow this run to continue.";
  const ELISION = "[...]";

  /**
   * The refusal from that run, rebuilt by driving the real builder
   * (`nothingLeftToStartFrom`, apps/worker/src/engine/repository-discovery/protocol.ts)
   * with one repository and a closed comment path. 416 characters, against a
   * 160-character snippet cap.
   */
  const PRODUCTION_REFUSAL =
    "Repository discovery was not confident about github:blazity/ai-workflow," +
    " and somebody on this work was already asked which repositories to start from" +
    " and did not name it. Not naming a repository is not choosing it," +
    " so this run has no repository to work on." +
    " Select the repositories this ticket should work on in this work's repository list," +
    " through the work scope API or the work_scope.edit tool, and start a new run.";

  it("delivers the production refusal whole, repository and way back included", () => {
    // The two facts the person needed and did not get: WHICH repository, and
    // what to do about it. Both sat in the elided middle.
    const out = deriveFailureMessage({
      category: "configuration",
      detail: PRODUCTION_REFUSAL,
      genericMessage: CONFIGURATION_GENERIC,
      explicitMessage: PRODUCTION_REFUSAL,
    });
    expect(out).not.toContain(ELISION);
    expect(out).toContain("github:blazity/ai-workflow");
    expect(out).toContain("start a new run");
    expect(out).toBe(PRODUCTION_REFUSAL);
  });

  it("answers the duplicate guard on the real detail, not on the clipped copy", () => {
    // The mechanism behind the defect, isolated. The guard compared the lead
    // against the ALREADY-CLAMPED snippet, and a clamp drops the middle, so a
    // lead that is word for word its own detail failed its own containment test
    // the moment it passed 160 characters. The person then read the sentence
    // followed by a middle-clipped copy of itself in parentheses.
    const out = deriveFailureMessage({
      category: "configuration",
      detail: PRODUCTION_REFUSAL,
      genericMessage: CONFIGURATION_GENERIC,
      explicitMessage: PRODUCTION_REFUSAL,
    });
    expect(PRODUCTION_REFUSAL.length).toBeGreaterThan(160);
    expect(out).not.toContain("(");
    expect(out.match(/Repository discovery was not confident/g)).toHaveLength(1);
  });

  it("never renders a lead cut through its middle, however long the evidence is", () => {
    // The general rule, not just the production shape: whatever the clause
    // costs, the sentence in front of it is the one the call site wrote. The old
    // composition gave the clause its budget first and clamped the lead with
    // what was left, which is what produced "This deployment's confi [...] o
    // continue.".
    const lead =
      `${CONFIGURATION_GENERIC} ` +
      "Every repository this run could have used had already been decided about by somebody on this work, " +
      "and this sentence is long enough that the old composition had to cut it. ".repeat(3);
    const out = deriveFailureMessage({
      category: "sandbox",
      detail: `unrelated raw provider output ${"that goes on and on ".repeat(40)}`,
      genericMessage: "The workspace environment could not complete this block.",
      explicitMessage: lead,
    });
    expect(out.startsWith(lead)).toBe(true);
    expect(out.slice(0, lead.length)).not.toContain(ELISION);
  });

  it("still clamps a raw provider snippet from both ends behind a short lead", () => {
    // AIW-254, which must not regress: for RAW output the middle is the least
    // informative part, git and HTTP write the verdict last, and the lead is
    // genuinely boilerplate. Nothing above changes that case.
    const detail =
      "github:Blazity/ai-workflow-prod: canonical clone failed: " +
      `Cloning into '/vercel/sandbox/publisher/0'... ${"progress noise ".repeat(20)}` +
      "fatal: unable to access 'https://github.com/Blazity/ai-workflow-prod.git/': " +
      "The requested URL returned error: 403";
    const out = deriveFailureMessage({
      category: "sandbox",
      detail,
      genericMessage: "The workspace environment could not complete this block.",
      explicitMessage: "The workspace could not be prepared.",
    });
    expect(out).toContain(ELISION);
    expect(out).toMatch(/\(.*\)$/);
    expect(out.startsWith("The workspace could not be prepared. (")).toBe(true);
    // Both ends of the raw text, which is the whole point of the both-ends clamp.
    expect(out).toContain("github:Blazity/ai-workflow-prod");
    expect(out).toContain("The requested URL returned error: 403");
  });

  it("redacts the lead, so the person's name reads the same on every surface", () => {
    // A work-scope refusal names whoever took the repository off the work, and
    // that name is a raw tracker display name: when the account has no display
    // name set it IS an email address. The lead used to skip redaction, on the
    // reading that a lead is a fixed operator sentence with no runtime text in
    // it, which stopped being true the day a refusal became the lead. Unredacted
    // it went to Slack and the ticket comment in clear while the API response
    // redacted it at its own boundary, so one sentence read two ways depending
    // on where you read it.
    const lead =
      "github:acme/api was excluded on this work by ada.lovelace@blazity.com on 2026-09-10." +
      " Excluding a repository is not final: this work's repository list can be changed.";
    const out = deriveFailureMessage({
      category: "configuration",
      detail: lead,
      genericMessage: CONFIGURATION_GENERIC,
      explicitMessage: lead,
    });
    expect(out).not.toContain("ada.lovelace@blazity.com");
    expect(out).toContain("[redacted]");
    // Redacted, not dropped: everything else in the sentence still arrives.
    expect(out).toContain("github:acme/api was excluded on this work by");
    expect(out).toContain("Excluding a repository is not final");
    expect(out).not.toContain(ELISION);
  });

  it("falls back to the generic sentence when a lead strips away to nothing", () => {
    // Reachable through stack frames, which are dropped WHOLE rather than
    // replaced: a caller that passed an error's frames as its lead would
    // otherwise leave the message with no leading sentence at all. A secret
    // cannot reach this branch, because redaction leaves its marker behind.
    const out = deriveFailureMessage({
      category: "configuration",
      detail: "the repository catalog refused",
      genericMessage: CONFIGURATION_GENERIC,
      explicitMessage: "    at prepare (/vercel/path/execute.js:12:3)\n    at run (/vercel/path/w.js:1:1)",
    });
    expect(out.startsWith(CONFIGURATION_GENERIC)).toBe(true);
    expect(out).not.toContain("/vercel/path");
    // Still not the bare category line: the cause it was given comes with it.
    expect(out).toContain("the repository catalog refused");
  });

  it("redacts a secret in the lead rather than dropping the sentence around it", () => {
    const out = deriveFailureMessage({
      category: "configuration",
      detail: "unrelated",
      genericMessage: CONFIGURATION_GENERIC,
      explicitMessage: "Refusing to prepare: the token sk-ant-api03-abcDEF1234567890_-tok was rejected.",
    });
    expect(out).not.toContain("sk-ant-api03");
    expect(out).toContain("Refusing to prepare: the token [redacted] was rejected.");
  });

  it("drops a clause too short to name anything rather than gluing on noise", () => {
    // The branch behind MIN_APPENDED_CLAUSE_LENGTH. With the lead whole and
    // almost the entire budget spent, the remainder cannot carry both ends of a
    // both-ends clamp: what fits is a dozen characters, the elision marker, and
    // a dozen more, which names nothing a person can act on. The lead is a
    // finished sentence, so it goes alone.
    const lead = `${CONFIGURATION_GENERIC} ${"Every repository was decided about already. ".repeat(20)}`.trim();
    const out = deriveFailureMessage({
      category: "configuration",
      detail: `the provider said ${"something long ".repeat(30)}`,
      genericMessage: CONFIGURATION_GENERIC,
      explicitMessage: lead,
    });
    expect(out).toBe(lead);
    expect(out).not.toContain("(");
    expect(out).not.toContain(ELISION);

    // THE OTHER SIDE OF THE SAME THRESHOLD, which is what makes the constant
    // load-bearing rather than arbitrary. The derived bound is 964 (the 1_100
    // message bound less the reserved diagnostic suffix), so padding the lead to
    // 918 leaves 45 characters: over the 40-character floor, so here the clause
    // IS kept, clamped into what is left. Move the floor past 45 and this goes
    // red; drop it toward zero and the case above goes red.
    const nearlyFull = `${CONFIGURATION_GENERIC} Every repository on this work was already decided about.`.padEnd(918, ".");
    expect(nearlyFull).toHaveLength(918);
    const withClause = deriveFailureMessage({
      category: "configuration",
      detail: `the provider said ${"something long ".repeat(30)}`,
      genericMessage: CONFIGURATION_GENERIC,
      explicitMessage: nearlyFull,
    });
    expect(withClause.startsWith(nearlyFull)).toBe(true);
    // A clause was appended, and it is clamped rather than whole: at 45
    // characters it keeps a little of each end of the raw output, which is
    // exactly what a both-ends clamp is for and what the floor above says is
    // still worth printing.
    const clause = withClause.slice(nearlyFull.length);
    expect(clause.startsWith(" (")).toBe(true);
    expect(clause.endsWith(")")).toBe(true);
    expect(clause).toContain(ELISION);
    expect(clause).toContain("the provider s");
    expect(withClause.length).toBeLessThanOrEqual(964);
  });

  it("keeps the provider verdicts of an incomplete catalog in the message", () => {
    // The opposite call site, and the reason the signal is carried explicitly
    // rather than guessed at from the text. `incompleteCatalogMessage`
    // (pre-sandbox/steps/repo-selection.ts) composes step name, then the
    // verdicts, then advice, so its reason IS in the middle and it passes no
    // lead: it gets the generic sentence plus its isolated cause in parentheses,
    // exactly as before.
    const composed =
      "Select repositories failed: repository listing for gitlab is unavailable " +
      "(gitlab: GitLab projects list timed out after 15000ms), so the repository catalog was incomplete. " +
      "No deterministic repository signal resolved the selection, and choosing from a partial catalog could pick the wrong repository. " +
      "Retry once the provider recovers, or name the repository path in the ticket.";
    const out = deriveFailureMessage({
      category: "sandbox",
      detail: `pre-sandbox: ${composed}`,
      genericMessage: "The workspace environment could not complete this block.",
      evidence: { cause: "gitlab: GitLab projects list timed out after 15000ms" },
    });
    expect(out.startsWith("The workspace environment could not complete this block."))
      .toBe(true);
    expect(out).toContain("GitLab projects list timed out after 15000ms");
  });
});

/**
 * A provider refusal that is about the ACCOUNT (no credit, a spend limit, a plan
 * limit, a rejected key) is not a bug and is not fixed by rerunning, and the
 * person reading the ticket cannot fix it either: an admin of that provider
 * account can. Production run wrun_01M3755BR7PYPCZ7VVSJ7RGM88 (2026-09-23) told
 * the ticket "The AI provider rejected the request", which names neither the
 * provider nor who acts. The harness says which provider it was, so the
 * sentence names it.
 *
 * Every refusal text below is a string the pinned CLIs or the provider APIs
 * really emit: "Credit balance is too low" was observed on that run; the other
 * Claude CLI strings are constants in the Claude Code binary; the Codex strings
 * are the `CodexErr` displays in codex-rs at rust-v0.144.6
 * (codex-rs/protocol/src/error.rs); the API sentences are from
 * platform.claude.com/docs/en/api/rate-limits and
 * developers.openai.com/api/docs/guides/error-codes.
 */
describe("provider account failures name the provider and who fixes them", () => {
  const providerGeneric = "An external service could not complete this block.";
  const AGENT_LEAD = "The current agent phase could not be completed.";
  const ADMIN_NOT_TICKET =
    "nothing is wrong with the ticket, and a rerun fails the same way until then.";

  function fromHarness(
    provider: "claude" | "codex",
    providerError: string,
  ): string {
    return deriveFailureMessage({
      category: "provider",
      detail: "The CLI exited with code 1.",
      genericMessage: providerGeneric,
      explicitMessage: AGENT_LEAD,
      evidence: { provider, failureKind: "provider_error", exitCode: 1, providerError },
    });
  }

  it.each([
    ["claude", "Credit balance is too low", "Anthropic"],
    [
      "claude",
      "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      "Anthropic",
    ],
    ["codex", "Quota exceeded. Check your plan and billing details.", "OpenAI"],
    ["codex", "Your workspace is out of credits. Add credits to continue.", "OpenAI"],
    [
      "codex",
      "stream disconnected before completion: You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.",
      "OpenAI",
    ],
    [
      "codex",
      "unexpected status 429 Too Many Requests: You exceeded your current quota, please check your plan and billing details.",
      "OpenAI",
    ],
    ["codex", "unexpected status 429 Too Many Requests: credit_balance_exhausted", "OpenAI"],
  ] as const)("reads %s's \"%s\" as the %s account out of credit", (provider, text, account) => {
    const message = fromHarness(provider, text);
    expect(message).toBe(
      `The ${account} account has no credit left, so ${account} refused the request. ` +
        `An admin must top up the ${account} account; ${ADMIN_NOT_TICKET}`,
    );
  });

  it.each([
    [
      "claude",
      'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"You have reached your API usage limits: your organization has crossed its monthly API usage threshold, set based on your organization\'s API tier. You will regain access on 2026-09-01 at 00:00 UTC."}}',
      "Anthropic",
    ],
    [
      "claude",
      "API Error: 400 You have reached your specified API usage limits. You will regain access on 2026-10-01 at 00:00 UTC.",
      "Anthropic",
    ],
    [
      "codex",
      "You hit your spend cap set in your workspace. Increase your spend cap to continue.",
      "OpenAI",
    ],
    ["codex", "unexpected status 429 Too Many Requests: project_spend_limit_exceeded", "OpenAI"],
  ] as const)("reads %s's spend limit \"%s\" as an admin action, never as a retry", (provider, text, account) => {
    const message = fromHarness(provider, text);
    expect(message).toMatch(new RegExp(`^The ${account} account has reached its spend limit`));
    expect(message).toContain(`An admin must raise or remove the spend limit in the ${account} billing settings`);
    expect(message).not.toMatch(/retry shortly/i);
  });

  it.each([
    ["claude", "Invalid API key · Fix external API key", "Anthropic"],
    ["claude", "OAuth token revoked · Please run /login", "Anthropic"],
    ["claude", "Login expired · Please run /login", "Anthropic"],
    [
      "claude",
      "Your ANTHROPIC_API_KEY belongs to a disabled organization · Update or unset the environment variable",
      "Anthropic",
    ],
    ["codex", "unexpected status 401 Unauthorized: Incorrect API key provided: sk-proj-****abcd", "OpenAI"],
  ] as const)("reads %s's \"%s\" as a credential an admin replaces", (provider, text, account) => {
    expect(fromHarness(provider, text)).toBe(
      `${account} rejected the credential AI Workflow uses for it (authentication failed). ` +
        `An admin must replace the ${account} API key or login; ${ADMIN_NOT_TICKET}`,
    );
  });

  it("reads a plan usage limit as waiting for the reset or a larger plan", () => {
    const message = fromHarness(
      "codex",
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:05 PM.",
    );
    expect(message).toMatch(/^The OpenAI plan this deployment signs in with has hit its usage limit/);
    expect(message).toContain("nothing is wrong with the ticket");
  });

  it("keeps a real rate limit a retry, and says whose", () => {
    expect(
      fromHarness(
        "claude",
        'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}',
      ),
    ).toBe("Anthropic rate-limited the request. Please retry shortly.");
    expect(fromHarness("codex", "exceeded retry limit, last status: 429 Too Many Requests")).toBe(
      "OpenAI rate-limited the request. Please retry shortly.",
    );
  });

  it("still says what to do when nothing says which provider it was", () => {
    const message = deriveFailureMessage({
      category: "provider",
      detail: "Credit balance is too low",
      genericMessage: providerGeneric,
    });
    // The first sentence is the one every earlier run recorded, so a diagnosis
    // of an old run and of a new one read the same lead.
    expect(message).toBe(
      "The AI provider rejected the request: the account credit or billing balance is too low. " +
        `An admin must top up the AI provider account; ${ADMIN_NOT_TICKET}`,
    );
  });

  it("recognises every curated lead, named or not, and the sentences old runs recorded", () => {
    expect(curatedProviderFailureOf(fromHarness("claude", "Credit balance is too low"))).toEqual({
      cause: "credit",
      account: "Anthropic",
    });
    expect(
      curatedProviderFailureOf(fromHarness("codex", "unexpected status 401 Unauthorized: bad key")),
    ).toEqual({ cause: "auth", account: "OpenAI" });
    // Recorded before this change, verbatim.
    expect(
      curatedProviderFailureOf(
        "The AI provider rejected the request: the account credit or billing balance is too low. Diagnostic ID: AIW-DIAG-wrun_x-implementation-1",
      ),
    ).toEqual({ cause: "credit", account: null });
    expect(
      curatedProviderFailureOf(
        "The AI provider rejected the request: the account has reached its configured spend limit. Raise or remove the spend limit in the provider's billing settings, then rerun.",
      ),
    ).toEqual({ cause: "spend_limit", account: null });
    expect(curatedProviderFailureOf("The AI provider is overloaded. Please retry shortly.")).toEqual({
      cause: "overloaded",
      account: null,
    });
    expect(curatedProviderFailureOf("The checks could not be started.")).toBeUndefined();
  });
});
