import { describe, it, expect, afterAll } from "vitest";
import {
  createTestTicket,
  addAttachment,
  deleteTicket,
} from "../helpers/jira.js";
import { e2eEnv } from "../env.js";

/**
 * US-2: Ticket with attachments — real fetch + write pipeline
 *
 * Creates a ticket in Backlog with various attachment types (PNG, JSON, PDF,
 * TXT, MD), then uses the production JiraAdapter + fetchAttachmentsWithRetry
 * + sandbox writeFiles pipeline to verify the full attachment flow end-to-end.
 */
describe("US-02: Ticket with attachments (real pipeline)", () => {
  let ticketKey: string;
  let sandbox: { stop: () => Promise<unknown> } | undefined;

  afterAll(async () => {
    if (sandbox) await sandbox.stop().catch(() => {});
    if (ticketKey) await deleteTicket(ticketKey);
  });

  it("fetches attachments via JiraAdapter and writes them to a sandbox", async () => {
    // 1. Create a ticket (stays in Backlog — no workflow triggered)
    const ticket = await createTestTicket({
      summary: "[E2E] Create user profile card component",
      description:
        "Build a profile card component matching the attached mockup and specs.",
    });
    ticketKey = ticket.ticketKey;

    // 2. Upload test attachments of various types to Jira
    const mockupContent = Buffer.alloc(1024, 0x89); // 1 KB binary placeholder
    const tokensContent = Buffer.from(
      JSON.stringify({ primary: "#FF6B35", spacing: "16px" }),
    );
    const pdfContent = Buffer.from(
      "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n",
    );
    const txtContent = Buffer.from(
      "Profile card should be 320px wide with 16px padding on all sides.\n",
    );
    const mdContent = Buffer.from(
      [
        "# Profile Card Spec",
        "",
        "## Requirements",
        "- Avatar: 64x64 circle",
        "- Name: 18px bold",
        "- Role: 14px muted",
        "",
      ].join("\n"),
    );

    await addAttachment(ticketKey, "profile-mockup.png", mockupContent);
    await addAttachment(ticketKey, "design-tokens.json", tokensContent);
    await addAttachment(ticketKey, "wireframe.pdf", pdfContent);
    await addAttachment(ticketKey, "sizing-notes.txt", txtContent);
    await addAttachment(ticketKey, "spec.md", mdContent);

    // 3. Use the real JiraAdapter to fetch the ticket (like the workflow does)
    const { JiraAdapter } = await import(
      "../../src/adapters/issue-tracker/jira.js"
    );
    const jira = new JiraAdapter({
      baseUrl: e2eEnv.JIRA_BASE_URL,
      email: e2eEnv.JIRA_EMAIL,
      apiToken: e2eEnv.JIRA_API_TOKEN,
      projectKey: e2eEnv.JIRA_PROJECT_KEY,
    });

    const ticketData = await jira.fetchTicket(ticketKey);
    expect(ticketData.attachments).toHaveLength(5);

    // 4. Use the real fetchAttachmentsWithRetry to download (like the workflow does)
    const { fetchAttachmentsWithRetry } = await import(
      "../../src/sandbox/attachments.js"
    );
    const log = {
      info: () => {},
      warn: () => {},
    };

    const downloaded = await fetchAttachmentsWithRetry(
      jira,
      ticketData.attachments,
      {
        maxFileSizeBytes: 10 * 1024 * 1024,
        maxTotalSizeBytes: 50 * 1024 * 1024,
        maxCount: 20,
        downloadTimeoutMs: 30_000,
      },
      log,
    );

    // All 5 attachments downloaded successfully
    const succeeded = downloaded.filter((a) => !a.failed);
    expect(succeeded).toHaveLength(5);
    for (const a of succeeded) {
      expect(a.content).toBeDefined();
      expect(a.content!.length).toBeGreaterThan(0);
    }

    // 5. Create a sandbox and write files using the same pattern as the workflow
    const { Sandbox } = await import("@vercel/sandbox");
    const { getSandboxCredentials } = await import(
      "../../src/sandbox/credentials.js"
    );
    const sbx = await Sandbox.create({
      ...getSandboxCredentials(),
      source: {
        type: "git",
        url: `https://github.com/${e2eEnv.E2E_GITHUB_OWNER}/${e2eEnv.E2E_GITHUB_REPO}.git`,
        username: "x-access-token",
        password: e2eEnv.E2E_GITHUB_TOKEN,
        revision: "main",
        depth: 1,
      },
      runtime: "node24",
      timeout: 120_000,
    });
    sandbox = sbx;

    // Write files the same way the real writeAttachments step does
    const toWrite = succeeded.filter((a) => a.content);
    await sbx.runCommand("mkdir", ["-p", "/tmp/attachments"]);
    await sbx.writeFiles(
      toWrite.map((a) => ({
        path: `/tmp/attachments/${a.filename}`,
        content: Buffer.isBuffer(a.content)
          ? a.content
          : Buffer.from(a.content as unknown as Uint8Array),
      })),
    );

    // 6. Verify: all files exist at expected paths
    for (const a of toWrite) {
      const result = await sbx.runCommand("test", [
        "-f",
        `/tmp/attachments/${a.filename}`,
      ]);
      expect(result.exitCode).toBe(0);
    }

    // 7. Verify: binary file (PNG) preserved exact size
    const pngFile = toWrite.find((a) => a.originalFilename === "profile-mockup.png")!;
    const pngStat = await sbx.runCommand("wc", [
      "-c",
      `/tmp/attachments/${pngFile.filename}`,
    ]);
    const pngSize = parseInt(
      (await pngStat.stdout()).trim().split(/\s+/)[0],
      10,
    );
    expect(pngSize).toBe(mockupContent.length);

    // 8. Verify: JSON file is valid and has correct content
    const jsonFile = toWrite.find((a) => a.originalFilename === "design-tokens.json")!;
    const jsonResult = await sbx.runCommand("cat", [
      `/tmp/attachments/${jsonFile.filename}`,
    ]);
    const jsonContent = (await jsonResult.stdout()).trim();
    expect(() => JSON.parse(jsonContent)).not.toThrow();
    expect(JSON.parse(jsonContent).primary).toBe("#FF6B35");

    // 9. Verify: PDF file starts with PDF header
    const pdfFile = toWrite.find((a) => a.originalFilename === "wireframe.pdf")!;
    const pdfResult = await sbx.runCommand("head", [
      "-c",
      "5",
      `/tmp/attachments/${pdfFile.filename}`,
    ]);
    expect((await pdfResult.stdout()).trim()).toBe("%PDF-");

    // 10. Verify: TXT file content matches
    const txtFile = toWrite.find((a) => a.originalFilename === "sizing-notes.txt")!;
    const txtResult = await sbx.runCommand("cat", [
      `/tmp/attachments/${txtFile.filename}`,
    ]);
    expect((await txtResult.stdout()).trim()).toContain("320px wide");

    // 11. Verify: MD file content matches
    const mdFile = toWrite.find((a) => a.originalFilename === "spec.md")!;
    const mdResult = await sbx.runCommand("cat", [
      `/tmp/attachments/${mdFile.filename}`,
    ]);
    const mdOutput = (await mdResult.stdout()).trim();
    expect(mdOutput).toContain("# Profile Card Spec");
    expect(mdOutput).toContain("64x64 circle");
  });
});
