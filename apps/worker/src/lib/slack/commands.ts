const TICKET_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;

export type ParsedCommand =
  | { kind: "list" }
  | { kind: "status"; ticketKey: string }
  | { kind: "cancel"; ticketKey: string }
  | { kind: "inspect"; ticketKey: string }
  | { kind: "summary" }
  | { kind: "reset"; ticketKey: string }
  | { kind: "help" }
  | { kind: "unknown"; raw: string };

export function parseCommand(text: string): ParsedCommand {
  const trimmed = text.trim();
  if (trimmed === "") return { kind: "help" };

  const tokens = trimmed.split(/\s+/);
  const verb = tokens[0]!.toLowerCase();

  if (verb === "help") return { kind: "help" };
  if (verb === "list") return { kind: "list" };

  if (verb === "status" || verb === "cancel") {
    const arg = tokens[1]?.toUpperCase();
    if (arg && TICKET_KEY_RE.test(arg)) {
      return { kind: verb, ticketKey: arg };
    }
    return { kind: "unknown", raw: trimmed };
  }

  if (verb === "redis") {
    const sub = tokens[1]?.toLowerCase();
    const arg = tokens[2]?.toUpperCase();

    if (sub === "summary") {
      if (tokens.length === 2) return { kind: "summary" };
      return { kind: "unknown", raw: trimmed };
    }

    if (sub === "inspect" || sub === "reset") {
      if (arg && TICKET_KEY_RE.test(arg)) {
        return { kind: sub, ticketKey: arg };
      }
      return { kind: "unknown", raw: trimmed };
    }

    return { kind: "unknown", raw: trimmed };
  }

  return { kind: "unknown", raw: trimmed };
}
