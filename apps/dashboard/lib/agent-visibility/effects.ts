/**
 * What the record did about a repository question, read from the Decision
 * Trail events the round carries.
 *
 * READ FIELD BY FIELD, NEVER WITH THE WRITE SCHEMA. `workScopeTrailEventSchema`
 * in `@shared/contracts` is strict and closed: parsing with it would blank a
 * whole round the day the worker adds a field or an event kind. Each field is
 * taken when it is there and left out when it is not, and an event kind this
 * build has no words for is shown as itself with what it carried.
 */
import type { ClarificationEffect } from "@shared/agent-visibility";

import { actorLabel, entryOriginLabel, entryStateLabel } from "./wording";

export interface EffectDescription {
  title: string;
  detail: string | null;
  /** Fields of an event this build has no words for, so nothing is hidden. */
  extra: string | null;
}

type Unknowns = Record<string, unknown>;

function record(value: unknown): Unknowns | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Unknowns) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function keys(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function actor(value: unknown): string | null {
  const holder = record(value);
  if (!holder || typeof holder.kind !== "string") return null;
  return actorLabel({
    kind: holder.kind,
    ...(text(holder.actorId) ? { actorId: text(holder.actorId)! } : {}),
    ...(text(holder.actorLabel) ? { actorLabel: text(holder.actorLabel)! } : {}),
    ...(text(holder.runId) ? { runId: text(holder.runId)! } : {}),
  });
}

function entrySentence(value: unknown): string | null {
  const entry = record(value);
  const key = entry ? text(entry.repositoryKey) : null;
  if (!entry || key === null) return null;
  const state = typeof entry.state === "string" ? entry.state : "";
  const stateLabel = entryStateLabel({
    state,
    ...(typeof entry.unavailableReason === "string" ? { unavailableReason: entry.unavailableReason } : {}),
  });
  const who = actor(entry.decidedBy);
  const origin = typeof entry.origin === "string" ? entryOriginLabel(entry.origin) : null;
  const rationale = text(entry.rationale);
  return [
    `${key} is ${stateLabel.toLowerCase()}`,
    who ? `by ${who}` : null,
    origin ? `(${origin})` : null,
    rationale ? `: ${rationale}` : null,
  ]
    .filter(Boolean)
    .join(" ")
    .replace(" :", ":");
}

function answerSentence(value: unknown): string {
  const answer = record(value);
  const kind = answer ? text(answer.kind) : null;
  const chosen = answer ? keys(answer.repositoryKeys) : [];
  switch (kind) {
    case "repositories":
      return `The person named ${chosen.join(", ")}`;
    case "none":
      return "The person named none of them";
    case "delegated":
      return chosen.length > 0
        ? `The person asked us to decide, and the workflow took ${chosen.join(", ")}`
        : "The person asked us to decide, and the workflow took nothing";
    case "unrecognised":
      return "The answer could not be understood";
    case "unattributed":
      return "The answer was several people's words, so it is nobody's decision to record";
    default:
      return kind === null ? "An answer this dashboard cannot read" : `The answer was read as "${kind}"`;
  }
}

/** Fields of an event beyond the ones a description used, as compact JSON. */
function remaining(event: Unknowns, used: readonly string[]): string | null {
  const rest = Object.entries(event).filter(([name]) => !used.includes(name) && name !== "kind" && name !== "clarificationId");
  return rest.length === 0 ? null : JSON.stringify(Object.fromEntries(rest));
}

export function describeEffect(effect: ClarificationEffect): EffectDescription {
  const event = effect.event as Unknowns & { kind: string };
  switch (event.kind) {
    case "entry_written": {
      const sentence = entrySentence(event.entry);
      const previous = text(event.previousState);
      return {
        title: "The record was written",
        detail: [sentence ?? "an entry this dashboard cannot read", previous ? `It was ${previous} before.` : null]
          .filter(Boolean)
          .join(". "),
        extra: remaining(event, ["entry", "previousState"]),
      };
    }
    case "entry_removed": {
      const sentence = entrySentence(event.entry);
      const who = actor(event.removedBy);
      return {
        title: "The entry was removed",
        detail: [sentence, who ? `Removed by ${who}.` : null].filter(Boolean).join(". "),
        extra: remaining(event, ["entry", "removedBy"]),
      };
    }
    case "question_answered":
      return {
        title: "The answer was taken",
        detail: `${answerSentence(event.answer)}${actor(event.answeredBy) ? `, answered by ${actor(event.answeredBy)}` : ""}.`,
        extra: remaining(event, ["answer", "answeredBy"]),
      };
    case "request_refused":
      return {
        title: "A request was refused",
        detail: `The run asked for ${text(event.repositoryKey) ?? "a repository"} and was refused: ${
          text(event.reason) ?? "no reason recorded"
        }.`,
        extra: remaining(event, ["repositoryKey", "reason"]),
      };
    case "map_shown":
      return {
        title: "The map was shown to the agent",
        detail: `${keys(event.repositoryKeys).length} repositories.`,
        extra: remaining(event, ["repositoryKeys", "text"]),
      };
    default:
      return {
        title: `The worker recorded "${event.kind}"`,
        detail: "This dashboard has no words for that event yet; everything it carried is below.",
        extra: remaining(event, []),
      };
  }
}
