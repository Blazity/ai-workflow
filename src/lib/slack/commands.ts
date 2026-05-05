const TICKET_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;

export type ParsedCommand =
  | { kind: "list" }
  | { kind: "status"; ticketKey: string }
  | { kind: "cancel"; ticketKey: string }
  | { kind: "help" }
  | { kind: "unknown"; raw: string };

export function parseCommand(text: string): ParsedCommand {
  const trimmed = text.trim();
  if (trimmed === "") return { kind: "help" };

  const tokens = trimmed.split(/\s+/);
  const verb = tokens[0]!.toLowerCase();
  const arg = tokens[1]?.toUpperCase();

  if (verb === "help") return { kind: "help" };
  if (verb === "list") return { kind: "list" };

  if (verb === "status" || verb === "cancel") {
    if (arg && TICKET_KEY_RE.test(arg)) {
      return { kind: verb, ticketKey: arg };
    }
    return { kind: "unknown", raw: trimmed };
  }

  return { kind: "unknown", raw: trimmed };
}
