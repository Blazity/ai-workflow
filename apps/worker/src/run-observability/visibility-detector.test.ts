import {
  buildAgentBriefing,
  pageSectionText,
  type AgentBriefingBuildInput,
  type VisibilitySanitizer,
} from "@shared/agent-visibility";
import { describe, expect, it } from "vitest";
import { sanitizeMcpData } from "../mcp/sanitize-result.js";
import { sanitizeReplayValue } from "./sanitizer.js";
import { environmentSecretValues } from "./configured-secrets.js";
import {
  BRIEFING_REDACTS_PERSONAL_DATA,
  createVisibilityDetector,
  redactForStorage,
} from "./visibility-detector.js";

const SECRET = "cfg-secret-7Qx9";
/** A secret with the characters a JSON string and a URL escape. */
const ESCAPED_SECRET = 'p"a\\s/s w&rd=9';
const SECRETS = [SECRET, ESCAPED_SECRET];
const TOKEN_40 = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0";

/** What MCP does to a string it serves, with the same secrets. */
function served(text: string): { text: string; redactions: number } {
  const envelope = sanitizeMcpData(
    { text },
    { requestId: "r", traceId: "t", trust: "external_untrusted", maxBytes: 16 * 1024 * 1024, secrets: SECRETS },
  );
  return { text: envelope.data.text, redactions: envelope.meta.redactions };
}

/** Text with every shape MCP's serve-time sanitizer rewrites, in the forms a
 *  prompt really carries them. */
const MCP_CORPUS = [
  "ticket: the checkout button does nothing on mobile.",
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
  "curl -H 'Authorization: Bearer abc.def-ghi' https://api.example.com",
  "authorization: bearer lower-case-value",
  "Authorization:\nBearer\nvalue-on-its-own-line",
  `token ghp_${TOKEN_40} in a log`,
  `glued xghp_${TOKEN_40}`,
  `long ghs_${"a".repeat(300)} run`,
  `configured ${SECRET} inline`,
  `json {"note":${JSON.stringify(`use ${ESCAPED_SECRET}`)}}`,
  `url https://example.com/?q=${encodeURIComponent(ESCAPED_SECRET)}`,
  "colors \u001B[31mred\u001B[0m and a title \u001B]0;window\u0007 done",
  "hyperlink \u001B]8;;https://ci.example/run/7\u0007the failing job\u001B]8;;\u0007 and the tests after it",
  "nul\u0000byte and bell\u0007 and delete\u007F",
  `rejoined gh\u0000p_${TOKEN_40}`,
  `split cfg-secret\u001B[0m-7Qx9 by an escape`,
  "lone \uD800 surrogate",
  "dates 2026-09-19 12:34, cost 0.0512345, model claude-sonnet-4-5-20250929",
  "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nthe rest of this section is gone",
].join("\n\n");

function briefingInput(text: string): AgentBriefingBuildInput {
  return {
    identity: {
      runId: "wrun_detector",
      nodeId: "planning",
      attempt: 1,
      activationScopeId: "root",
      sequence: 1,
      kind: "agent",
      blockType: "planning_agent",
      capturedAt: "2026-09-19T10:15:00.000Z",
    },
    harness: { provider: "claude", model: "claude-sonnet-4-5-20250929" },
    sections: [{ kind: "runtime", title: "Runtime data", text }],
    repositoryContext: null,
  };
}

async function storedText(text: string, detect: VisibilitySanitizer): Promise<string> {
  const { index, texts } = await buildAgentBriefing(briefingInput(text), { sanitize: detect });
  const sha = index.sections[0]!.storedSha256;
  return texts.find((entry) => entry.sha256 === sha)!.text;
}

describe("the capture detector: serving is the identity", () => {
  // Red when: any shape MCP rewrites survives capture (the bearer shape, a
  // GitHub token without a word boundary or past 255 characters, a key header
  // without END, a secret or token rejoined by removing a control character),
  // so MCP would serve different bytes than the dashboard shows.
  it("stores text that MCP serves unchanged, whole, page by page and cut anywhere", async () => {
    const detect = createVisibilityDetector({ secrets: SECRETS });
    const stored = await storedText(MCP_CORPUS, detect);

    expect(served(stored)).toEqual({ text: stored, redactions: 0 });

    let offset: number | null = 0;
    while (offset !== null) {
      const page = pageSectionText({ sectionIndex: 0, text: stored, offset, maxBytes: 1_024 });
      expect(served(page.text)).toEqual({ text: page.text, redactions: 0 });
      offset = page.nextOffset;
    }
    for (let cut = 0; cut <= stored.length; cut += 1) {
      for (const piece of [stored.slice(0, cut), stored.slice(cut)]) {
        expect(served(piece).redactions).toBe(0);
      }
    }
  });

  // Red when: the detector finds something in text it already cleaned, which
  // is a second pass changing stored bytes.
  it("finds nothing in the text it produced", async () => {
    const detect = createVisibilityDetector({ secrets: SECRETS, personalData: true });
    const stored = await storedText(`${MCP_CORPUS}\n\nmail anna@example.com or call +48 601 234 567`, detect);
    expect(detect(stored)).toEqual([]);
  });

  it("leaves ordinary prose, dates, costs and model names alone", () => {
    const detect = createVisibilityDetector({ secrets: SECRETS, personalData: true });
    const prose =
      "Released 2026-09-19 12:34 on 192.168.10.20; cost 0.0512345 for claude-sonnet-4-5-20250929 at 1726750000000.";
    expect(detect(prose)).toEqual([]);
  });
});

describe("the capture detector: what it removes", () => {
  const detect = createVisibilityDetector({ secrets: SECRETS });
  const redact = (text: string) => redactForStorage(text, detect);

  // Red when: a private key header with no END line keeps the key body, which
  // MCP would remove at serve time to the end of whatever page it serves.
  it("removes a private key header without an END line to the end of the text", () => {
    expect(redact("before\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\nmore key")).toBe("before\n[REDACTED]");
    expect(redact("a\n-----BEGIN EC PRIVATE KEY-----\nxyz\n-----END EC PRIVATE KEY-----\nb")).toBe("a\n[REDACTED]\nb");
  });

  it.each([
    ["a JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop"],
    ["an OpenAI key", "sk-proj-abcdefghijklmnop1234"],
    ["an Anthropic key", "sk-ant-api03-abcdefghijklmnop"],
    ["a GitHub token", `ghp_${TOKEN_40}`],
    ["a GitHub installation token", `ghs_${TOKEN_40}`],
    ["a fine-grained GitHub token", "github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789"],
    ["a GitLab token", "glpat-abcdefghij0123456789"],
    ["a Slack token", "xoxb-1234567890-abcdefghij"],
  ])("removes %s", (_label, credential) => {
    expect(redact(`x ${credential} y`)).toBe("x [REDACTED] y");
  });

  // Red when: the whole header shape is removed, so a sentence about bearer
  // tokens loses the words a person wrote and the prompt reads as a hole.
  // The space goes with the value on purpose: `Bearer [REDACTED]` is what MCP
  // rewrites again on a page that cuts inside the marker.
  it.each([
    ["Authorization: Bearer abc.def-ghi", "Authorization: Bearer[REDACTED]"],
    ["authorization: bearer lower-case", "authorization: bearer[REDACTED]"],
    ["Authorization:\nBearer\nvalue", "Authorization:\nBearer[REDACTED]"],
    ["Authorization: Basic dXNlcjpwYXNz", "Authorization: Basic[REDACTED]"],
  ])("removes the value of %s and keeps the words", (header, expected) => {
    expect(redact(`before ${header} after`)).toBe(`before ${expected} after`);
  });

  it("keeps a sentence that only talks about bearer tokens", () => {
    const prose = "It broke where we set authorization: bearer tokens for the proxy, not in the client.";
    expect(redact(prose)).toBe(
      "It broke where we set authorization: bearer[REDACTED] for the proxy, not in the client.",
    );
    expect(served(redact(prose))).toEqual({ text: redact(prose), redactions: 0 });
  });

  it("removes the credential of a credential URL and keeps where it points", () => {
    expect(redact("git clone https://x-access-token:v1.abc123@github.com/acme/web.git")).toBe(
      "git clone https://[REDACTED]@github.com/acme/web.git",
    );
    expect(redact("postgres://app:pw@db.example/main")).toBe("postgres://[REDACTED]@db.example/main");
  });

  // Red when: a control character inside a secret or a token is removed after
  // the secret search, so the pieces join into a secret nobody removed.
  it("removes control characters first, so nothing they split can rejoin", () => {
    expect(redact(`a gh\u0000p_${TOKEN_40} b`)).toBe("a [REDACTED] b");
    expect(redact("a cfg-secret\u001B[0m-7Qx9 b")).toBe("a [REDACTED] b");
  });

  // Red when: an escape sequence is deleted whole. Everything between a title
  // sequence and its bell, or between two hyperlink sequences, is the log a
  // person came to read, and it would be gone with nothing marking the hole.
  it("removes the control characters and keeps the text around them", () => {
    expect(redact("plain \u001B[31mred\u001B[0m text\u0000")).toBe("plain [31mred[0m text");
    expect(redact("prefix \u001B]0;title then the whole rest of this CI log line \u0007 tail")).toBe(
      "prefix ]0;title then the whole rest of this CI log line  tail",
    );
    const hyperlink = "see \u001B]8;;https://ci.example/run/7\u0007the failing job\u001B]8;;\u0007 and the tests after it";
    const stored = redact(hyperlink);
    expect(stored).toContain("the failing job");
    expect(stored).toContain("and the tests after it");
    expect(stored).not.toContain("\u001B");
    expect(stored).not.toContain("\u0007");
    // And MCP still has nothing left to rewrite: its rule needs the escape.
    expect(served(stored)).toEqual({ text: stored, redactions: 0 });
  });

  // Red when: positions come from a chain of replacements rather than the
  // text the detector was given, so the package removes the wrong bytes.
  it("reports positions in the text it was given", () => {
    const text = `\u001B[1m\u0000 key ${SECRET} end`;
    const found = detect(text).filter((span) => span.kind === "configured_secret");
    expect(found.map((span) => text.slice(span.start, span.end))).toEqual([SECRET]);
  });

  // Red when: a configured secret is found only as written, while the replay
  // sanitizer finds it once the JSON or the URL is decoded.
  it("finds a configured secret escaped in JSON or encoded in a URL, where the replay sanitizer finds it", () => {
    const json = JSON.stringify({ note: `use ${ESCAPED_SECRET} here` });
    const url = `https://example.com/?q=${encodeURIComponent(ESCAPED_SECRET)}&page=2`;

    const replayJson = JSON.stringify(sanitizeReplayValue(JSON.parse(json), { secrets: SECRETS }).value);
    expect(replayJson).toContain("[REDACTED:configured_secret]");
    const replayUrl = sanitizeReplayValue(decodeURIComponent(url), { secrets: SECRETS }).value;
    expect(replayUrl).toContain("[REDACTED:configured_secret]");

    expect(redact(json)).toBe('{"note":"use [REDACTED] here"}');
    expect(redact(url)).toBe("https://example.com/?q=[REDACTED]&page=2");
  });

  it("reads the database connection string and the webhook trigger key as configured secrets", () => {
    const fromEnvironment = createVisibilityDetector({
      secrets: environmentSecretValues({
        DATABASE_URL: "postgres://app:neon-pw@ep-1.neon.tech/main",
        WEBHOOK_TRIGGER_ENCRYPTION_KEY: "whk-encryption-value",
      }),
    });
    expect(
      redactForStorage(
        "db postgres://app:neon-pw@ep-1.neon.tech/main key whk-encryption-value",
        fromEnvironment,
      ),
    ).toBe("db [REDACTED] key [REDACTED]");
  });

  // Red when: the replay sanitizer's presentation heuristics reach a prompt,
  // where they remove text an agent was really sent and no credential.
  it("does not apply the replay sanitizer's presentation heuristics", () => {
    const prose = [
      "Cookie: session handling is broken on Safari.",
      "Run it as -u admin to reproduce.",
      "Clone ssh://git@github.com/acme/web.git first.",
      '{"maxTokens": 200000, "token": "see the vault"}',
      "Bearer authentication is what the API expects.",
    ].join("\n");
    expect(redact(prose)).toBe(prose);
  });
});

describe("the capture detector: personal data", () => {
  const personal = "Mail anna@example.com or call +48 601 234 567, card 4242 4242 4242 4242, IBAN GB82 WEST 1234 5698 7654 32.";

  // Red when: the default flips without the owner deciding it.
  it("keeps personal data by default, pending the owner's decision", () => {
    expect(BRIEFING_REDACTS_PERSONAL_DATA).toBe(false);
    const detect = createVisibilityDetector({ secrets: [] });
    expect(redactForStorage(personal, detect)).toBe(personal);
  });

  // Red when: switching the flag on leaves an email, a phone number, a card
  // or an IBAN in stored text.
  it("removes emails, phone numbers, cards and IBANs when the flag is on", () => {
    const detect = createVisibilityDetector({ secrets: [], personalData: true });
    expect(redactForStorage(personal, detect)).toBe(
      "Mail [REDACTED] or call [REDACTED], card [REDACTED], IBAN [REDACTED].",
    );
  });
});
