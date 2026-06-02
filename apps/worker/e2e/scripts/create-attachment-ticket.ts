import { createTestTicket, addAttachment, moveTicketToColumn } from "../helpers/jira.js";
import { e2eEnv } from "../env.js";

async function main() {
  const ticket = await createTestTicket({
    summary: "[E2E] Create user profile card component",
    description:
      "Build a profile card component matching the attached mockup and specs.",
  });
  console.log("Created ticket:", ticket.ticketKey);

  // Ensure ticket stays in Backlog (not dispatched)
  await moveTicketToColumn(ticket.ticketKey, e2eEnv.COLUMN_BACKLOG);
  console.log("Moved to Backlog");

  await addAttachment(ticket.ticketKey, "profile-mockup.png", Buffer.alloc(1024, 0x89));
  await addAttachment(ticket.ticketKey, "design-tokens.json", Buffer.from(JSON.stringify({ primary: "#FF6B35", spacing: "16px" })));
  await addAttachment(ticket.ticketKey, "wireframe.pdf", Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n"));
  await addAttachment(ticket.ticketKey, "sizing-notes.txt", Buffer.from("Profile card should be 320px wide with 16px padding on all sides.\n"));
  await addAttachment(ticket.ticketKey, "spec.md", Buffer.from("# Profile Card Spec\n\n## Requirements\n- Avatar: 64x64 circle\n- Name: 18px bold\n- Role: 14px muted\n"));

  console.log("Uploaded 5 attachments to", ticket.ticketKey);
  console.log("Ticket will NOT be deleted — check it in Jira.");
}

main().catch(console.error);
