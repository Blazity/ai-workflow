import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { Area } from "./areas.ts";
import type { ShortVersionParagraph } from "./notes.ts";

/**
 * The prose around the bullets: the short version (two to four bold-area
 * paragraphs) and one italic sentence per area. A model writes it, prompted
 * with the tone rule from changelog/README.md. It never blocks a release: a
 * missing key, a failed call or an answer that does not fit the shape all
 * fall back to a plain generated line per area, and the reason is logged.
 */

/** A cheap, capable model; the release notes are a short summarising task. */
export const SUMMARY_MODEL = "claude-sonnet-5";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const CALL_TIMEOUT_MS = 90_000;

export interface AreaGroup {
  area: Area;
  bullets: string[];
}

export interface Summaries {
  shortVersion: ShortVersionParagraph[];
  areaSummaries: Map<Area, string>;
  generatedBy: "model" | "fallback";
  /** Why the fallback was used. */
  reason?: string;
}

export interface ModelRequest {
  system: string;
  user: string;
  schema: Record<string, unknown>;
}

/** Returns the model's text answer or throws. */
export type ModelClient = (request: ModelRequest) => Promise<string>;

const RESPONSE_SCHEMA = {
  additionalProperties: false,
  properties: {
    areaSummaries: {
      items: {
        additionalProperties: false,
        properties: { area: { type: "string" }, summary: { type: "string" } },
        required: ["area", "summary"],
        type: "object",
      },
      type: "array",
    },
    shortVersion: {
      items: {
        additionalProperties: false,
        properties: { area: { type: "string" }, text: { type: "string" } },
        required: ["area", "text"],
        type: "object",
      },
      type: "array",
    },
  },
  required: ["shortVersion", "areaSummaries"],
  type: "object",
} as const;

/** The "## Tone rule" section of changelog/README.md, its one home. */
export async function readToneRule(root: string): Promise<string> {
  const readme = await readFile(resolve(root, "changelog/README.md"), "utf8");
  const start = readme.indexOf("## Tone rule");
  if (start === -1) throw new Error("changelog/README.md has no \"## Tone rule\" section");
  const next = readme.indexOf("\n## ", start + 1);
  return readme.slice(start, next === -1 ? undefined : next).trim();
}

export function buildRequest(groups: readonly AreaGroup[], toneRule: string): ModelRequest {
  const system = [
    "You write the prose around the release notes of AI Workflow, a product that turns engineering events into agent runs.",
    "The readers are the people using the product. Follow this tone rule exactly:",
    "",
    toneRule,
    "",
    "Also: plain words, short sentences, no marketing, no thanks, no emoji, no em dash or en dash characters.",
    "Say only what the bullets say; add no claim of your own.",
  ].join("\n");
  const areaNames = groups.map((group) => group.area).join(", ");
  const minimum = Math.min(2, groups.length);
  const user = [
    "These are the bullets of one release, grouped by area:",
    "",
    ...groups.flatMap((group) => [`### ${group.area}`, ...group.bullets.map((bullet) => `- ${bullet}`), ""]),
    `Write shortVersion: ${minimum} to 4 paragraphs, each for one area from this list: ${areaNames}.`,
    "Each paragraph is two or three sentences on what a reader can do now in that area, most important areas first; skip minor areas.",
    `Write areaSummaries: exactly one entry for each of ${areaNames}, a single sentence of at most 20 words.`,
  ].join("\n");
  return { schema: RESPONSE_SCHEMA, system, user };
}

/** Calls the Messages API over HTTP with structured JSON output. */
export function anthropicClient(apiKey: string | undefined, fetchImpl: typeof fetch = fetch): ModelClient {
  return async ({ schema, system, user }) => {
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    const response = await fetchImpl(ANTHROPIC_URL, {
      body: JSON.stringify({
        max_tokens: 4_000,
        messages: [{ content: user, role: "user" }],
        model: SUMMARY_MODEL,
        output_config: { format: { schema, type: "json_schema" } },
        system,
        thinking: { type: "disabled" },
      }),
      headers: {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      method: "POST",
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`the Anthropic API answered HTTP ${response.status}: ${detail}`);
    }
    const payload = (await response.json()) as {
      stop_reason?: string;
      content?: Array<{ type?: string; text?: string }>;
    };
    if (payload.stop_reason !== "end_turn") throw new Error(`the model stopped with ${payload.stop_reason}`);
    const text = payload.content?.find((block) => block.type === "text")?.text;
    if (!text) throw new Error("the model returned no text");
    return text;
  };
}

/** The dash rule binds generated text as much as written text. */
function withoutDashes(text: string): string {
  return text.replace(/\s*[\u2013\u2014]\s*/gu, ", ").trim();
}

function parseAnswer(text: string, groups: readonly AreaGroup[]): Omit<Summaries, "generatedBy"> {
  const answer = JSON.parse(text) as {
    shortVersion?: Array<{ area?: unknown; text?: unknown }>;
    areaSummaries?: Array<{ area?: unknown; summary?: unknown }>;
  };
  const known = new Set<string>(groups.map((group) => group.area));

  const areaSummaries = new Map<Area, string>();
  for (const item of answer.areaSummaries ?? []) {
    if (typeof item.area !== "string" || !known.has(item.area)) {
      throw new Error(`the model summarised an area the release does not have: ${String(item.area)}`);
    }
    if (typeof item.summary !== "string" || !item.summary.trim()) throw new Error(`empty summary for ${item.area}`);
    areaSummaries.set(item.area as Area, withoutDashes(item.summary));
  }
  const missing = groups.filter((group) => !areaSummaries.has(group.area)).map((group) => group.area);
  if (missing.length > 0) throw new Error(`the model left out a summary for ${missing.join(", ")}`);

  const shortVersion: ShortVersionParagraph[] = [];
  for (const item of answer.shortVersion ?? []) {
    if (typeof item.area !== "string" || !known.has(item.area)) {
      throw new Error(`the short version names an area the release does not have: ${String(item.area)}`);
    }
    if (typeof item.text !== "string" || !item.text.trim()) throw new Error(`empty short version paragraph for ${item.area}`);
    if (shortVersion.some((paragraph) => paragraph.area === item.area)) {
      throw new Error(`the short version names ${item.area} twice`);
    }
    shortVersion.push({ area: item.area as Area, text: withoutDashes(item.text) });
  }
  if (shortVersion.length < Math.min(2, groups.length) || shortVersion.length > 4) {
    throw new Error(`the short version has ${shortVersion.length} paragraphs`);
  }
  return { areaSummaries, shortVersion };
}

const COUNT_WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

/** A plain line that needs no model: how many changes the area carries. */
export function fallbackSummary(count: number): string {
  const number = COUNT_WORDS[count] ?? String(count);
  return `${number} ${count === 1 ? "change" : "changes"} in this area.`;
}

export function fallbackSummaries(groups: readonly AreaGroup[], reason: string): Summaries {
  return {
    areaSummaries: new Map(groups.map((group) => [group.area, fallbackSummary(group.bullets.length)])),
    generatedBy: "fallback",
    reason,
    shortVersion: [],
  };
}

export async function summarize(options: {
  groups: readonly AreaGroup[];
  toneRule: string;
  model: ModelClient;
  log: (message: string) => void;
}): Promise<Summaries> {
  if (options.groups.length === 0) return fallbackSummaries([], "no bullets");
  try {
    const text = await options.model(buildRequest(options.groups, options.toneRule));
    return { ...parseAnswer(text, options.groups), generatedBy: "model" };
  } catch (error) {
    const reason = (error as Error).message;
    options.log(`changelog: the release prose falls back to plain summaries: ${reason}`);
    return fallbackSummaries(options.groups, reason);
  }
}
