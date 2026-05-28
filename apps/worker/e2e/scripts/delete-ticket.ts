import { deleteTicket } from "../helpers/jira.js";

const ticketKey = process.argv[2];
if (!ticketKey) {
  console.error("Usage: npx tsx --env-file=.env.e2e e2e/scripts/delete-ticket.ts <TICKET-KEY>");
  process.exit(1);
}

await deleteTicket(ticketKey);
console.log(`Deleted ${ticketKey}`);
