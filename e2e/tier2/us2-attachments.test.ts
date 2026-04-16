import { describe, it, expect, afterAll } from "vitest";
import {
  createTestTicket,
  addAttachment,
  getTicketAttachments,
  downloadJiraAttachment,
  deleteTicket,
} from "../helpers/jira.js";
import { e2eEnv } from "../env.js";

/**
 * US-2: Ticket with attachments (integration test: fetch + write phase)
 *
 * Tests that attachments on a Jira ticket can be downloaded and written
 * to a sandbox at the expected paths. NOT a full E2E workflow — tests
 * only the attachment fetch and write phases.
 */
describe("US-2: Ticket with attachments (fetch + write phase)", () => {
  let ticketKey: string;
  let sandbox: { stop: () => Promise<unknown> } | undefined;

  afterAll(async () => {
    if (sandbox) await sandbox.stop().catch(() => {});
    if (ticketKey) await deleteTicket(ticketKey);
  });

  it("downloads attachments from Jira and writes them to a sandbox", async () => {
    // 1. Create a ticket
    const ticket = await createTestTicket({
      summary: "[E2E] Create user profile card component",
      description:
        "Build a profile card component matching the attached mockup.",
    });
    ticketKey = ticket.ticketKey;

    // 2. Upload test attachments to Jira
    const mockupContent = Buffer.alloc(1024, 0x89); // 1 KB placeholder
    const tokensContent = Buffer.from(
      JSON.stringify({ primary: "#FF6B35", spacing: "16px" }),
    );

    await addAttachment(ticketKey, "profile-mockup.png", mockupContent);
    await addAttachment(ticketKey, "design-tokens.json", tokensContent);

    // 3. Fetch attachment metadata — verify count
    const attachments = await getTicketAttachments(ticketKey);
    expect(attachments).toHaveLength(2);

    // 4. Download each attachment — verify content is non-empty
    const downloaded = await Promise.all(
      attachments.map(async (att) => {
        const content = await downloadJiraAttachment(att.contentUrl);
        return { filename: att.filename, content, size: content.length };
      }),
    );
    for (const d of downloaded) {
      expect(d.size).toBeGreaterThan(0);
    }
    expect(downloaded.find((d) => d.filename === "profile-mockup.png")).toBeDefined();
    expect(downloaded.find((d) => d.filename === "design-tokens.json")).toBeDefined();

    // 5. Create a sandbox and write files to /tmp/attachments/
    const { Sandbox } = await import("@vercel/sandbox");
    const sbx = await Sandbox.create({
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

    await sbx.runCommand("mkdir", ["-p", "/tmp/attachments"]);
    await sbx.writeFiles(
      downloaded.map((d) => ({
        path: `/tmp/attachments/${d.filename}`,
        content: d.content,
      })),
    );

    // 6. Verify: files exist at expected paths inside the sandbox
    for (const d of downloaded) {
      const result = await sbx.runCommand("test", [
        "-f",
        `/tmp/attachments/${d.filename}`,
      ]);
      expect(result.exitCode).toBe(0);
    }

    // 7. Verify: file contents are valid (not corrupted)
    const pngStat = await sbx.runCommand("wc", [
      "-c",
      "/tmp/attachments/profile-mockup.png",
    ]);
    const pngSize = parseInt(
      (await pngStat.stdout()).trim().split(/\s+/)[0],
      10,
    );
    expect(pngSize).toBe(mockupContent.length);

    const jsonResult = await sbx.runCommand("cat", [
      "/tmp/attachments/design-tokens.json",
    ]);
    const jsonContent = (await jsonResult.stdout()).trim();
    expect(() => JSON.parse(jsonContent)).not.toThrow();
    expect(JSON.parse(jsonContent).primary).toBe("#FF6B35");
  });
});
