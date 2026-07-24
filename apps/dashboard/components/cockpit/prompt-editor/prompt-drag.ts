import { formatPromptReferenceToken } from "@shared/contracts";

export const PROMPT_DRAG_MIME = "application/x-ai-workflow-prompt-block";

export type PromptDragPayload =
  | {
      kind: "library-reference";
      slug: string;
      label: string;
      version?: "latest" | number;
    }
  | { kind: "library-section"; markdown: string; label: string }
  | { kind: "composer-block"; blockId: string; label: string };

export function markdownForDroppedPrompt(
  payload: PromptDragPayload,
): string | null {
  if (payload.kind === "library-section") return payload.markdown;
  if (payload.kind !== "library-reference") return null;
  return formatPromptReferenceToken({
    slug: payload.slug,
    version: payload.version ?? "latest",
  });
}

export function writePromptDrag(event: React.DragEvent, payload: PromptDragPayload): void {
  event.dataTransfer.effectAllowed = payload.kind === "composer-block" ? "move" : "copy";
  event.dataTransfer.setData(PROMPT_DRAG_MIME, JSON.stringify(payload));
  event.dataTransfer.setData("text/plain", payload.label);
}

export function readPromptDrag(event: React.DragEvent): PromptDragPayload | null {
  const raw = event.dataTransfer.getData(PROMPT_DRAG_MIME);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PromptDragPayload>;
    if (
      value.kind === "library-reference" &&
      typeof value.slug === "string" &&
      typeof value.label === "string" &&
      (value.version === undefined ||
        value.version === "latest" ||
        (typeof value.version === "number" && Number.isInteger(value.version) && value.version > 0))
    ) {
      return value as PromptDragPayload;
    }
    if (value.kind === "library-section" && typeof value.markdown === "string" && typeof value.label === "string") {
      return value as PromptDragPayload;
    }
    if (value.kind === "composer-block" && typeof value.blockId === "string" && typeof value.label === "string") {
      return value as PromptDragPayload;
    }
    return null;
  } catch {
    return null;
  }
}
