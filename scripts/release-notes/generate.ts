import { z } from "zod";

import type { ReleaseCollection, ReleaseDraft } from "./types.js";

const itemSchema = z.object({
  text: z.string().trim().min(1).max(300),
  sources: z.array(z.number().int().positive()).min(1),
});
const modelDraftSchema = z.object({
  highlights: z.string().trim().min(1).max(600),
  features: z.array(itemSchema),
  improvementsAndFixes: z.array(itemSchema),
  requiredAction: z.string().trim().min(1).max(600),
  knownLimitations: z.string().trim().min(1).max(600),
});

export type ModelClient = (prompt: string) => Promise<string>;

function buildPrompt(collection: ReleaseCollection): string {
  const facts = collection.included.map((pr) => ({
    number: pr.number,
    title: pr.title,
    body: pr.body,
    labels: pr.labels,
    userImpact: pr.fields.userImpact,
    requiredAction: pr.fields.requiredAction,
    releaseNote: pr.fields.releaseNote,
    category: pr.category,
  }));
  return `Write concise, non-technical English release notes for Artur.
Use only the supplied pull request facts. Every bullet must cite one or more supplied PR numbers.
Do not mention internal ticket keys or implementation details.
Return JSON with: highlights, features[{text,sources}], improvementsAndFixes[{text,sources}], requiredAction, knownLimitations.

PULL REQUEST FACTS:
${JSON.stringify(facts, null, 2)}`;
}

async function anthropicClient(prompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.RELEASE_NOTES_MODEL || "claude-sonnet-4-6",
      max_tokens: 2_000,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Release-note model returned HTTP ${response.status}`);
  const payload = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
  const text = payload.content?.find((part) => part.type === "text")?.text;
  if (!text) throw new Error("Release-note model returned no text");
  return text;
}

function fallbackDraft(collection: ReleaseCollection): ReleaseDraft {
  const features = collection.included
    .filter((pr) => pr.category === "feature")
    .map((pr) => ({
      text: pr.fields.releaseNote || pr.fields.userImpact || pr.title,
      sources: [pr.number],
    }));
  const improvementsAndFixes = collection.included
    .filter((pr) => pr.category !== "feature")
    .map((pr) => ({
      text: pr.fields.releaseNote || pr.fields.userImpact || pr.title,
      sources: [pr.number],
    }));
  const requiredActions = [
    ...new Set(
      collection.included
        .map((pr) => pr.fields.requiredAction.trim())
        .filter((value) => value && !/^(none|no action is required)\.?$/i.test(value)),
    ),
  ];
  const highlights =
    features.length > 0 && improvementsAndFixes.length > 0
      ? "This release adds new capabilities and includes improvements and fixes."
      : features.length > 0
        ? "This release adds new capabilities to AI Workflow."
        : "This release includes improvements and fixes for AI Workflow.";
  return {
    highlights,
    features,
    improvementsAndFixes,
    requiredAction: requiredActions.join(" ") || "No action is required.",
    knownLimitations: "No known user-facing limitations.",
    generatedBy: "fallback",
  };
}

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return JSON.parse((fenced?.[1] ?? text).trim());
}

export async function generateReleaseDraft(
  collection: ReleaseCollection,
  modelClient: ModelClient = anthropicClient,
): Promise<ReleaseDraft> {
  let text: string;
  try {
    text = await modelClient(buildPrompt(collection));
  } catch {
    return fallbackDraft(collection);
  }

  let parsed: z.infer<typeof modelDraftSchema>;
  try {
    parsed = modelDraftSchema.parse(extractJson(text));
    const known = new Set(collection.included.map((pr) => pr.number));
    for (const item of [...parsed.features, ...parsed.improvementsAndFixes]) {
      for (const source of item.sources) {
        if (!known.has(source)) {
          throw new Error(`Generated release note references unknown PR #${source}`);
        }
      }
    }
  } catch {
    return fallbackDraft(collection);
  }
  return { ...parsed, generatedBy: "ai" };
}
