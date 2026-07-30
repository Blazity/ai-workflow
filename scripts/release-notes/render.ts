import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { parseVersion } from "./classify.js";
import type {
  DraftItem,
  ReleaseCollection,
  ReleaseDraft,
  ReleaseFileMetadata,
} from "./types.js";

const metadataSchema = z.object({
  version: z.string(),
  previousCommit: z.string().regex(/^[0-9a-f]{40}$/),
  targetCommit: z.string().regex(/^[0-9a-f]{40}$/),
  repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
});

function renderItems(items: DraftItem[], empty: string): string {
  if (items.length === 0) return `${empty}\n`;
  return `${items
    .map((item) => `- ${item.text}\n  <!-- sources: ${[...new Set(item.sources)].sort((a, b) => a - b).join(",")} -->`)
    .join("\n")}\n`;
}

export function renderReleaseNotes(
  collection: ReleaseCollection,
  draft: ReleaseDraft,
  version: string,
): string {
  parseVersion(version);
  const exactScope = [...collection.included, ...collection.internal]
    .sort((a, b) => a.number - b.number)
    .map((pr) => `- [#${pr.number}](${pr.url}) — ${pr.category}: ${pr.title}`)
    .join("\n");
  return `---
version: ${version}
previousCommit: ${collection.previousCommit}
targetCommit: ${collection.targetCommit}
repository: ${collection.repository}
---

<!-- shareable:start -->
# AI Workflow — ${version}

## Highlights

${draft.highlights}

## What's new

${renderItems(draft.features, "No new user-facing capabilities in this release.")}
## Improvements and fixes

${renderItems(draft.improvementsAndFixes, "No additional user-facing improvements in this release.")}
## Do you need to do anything?

${draft.requiredAction}

## Known limitations

${draft.knownLimitations}
<!-- shareable:end -->

## Exact release scope

${exactScope || "No included pull requests."}
`;
}

export function parseReleaseNotes(markdown: string): {
  metadata: ReleaseFileMetadata;
  shareable: string;
} {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  if (!match) throw new Error("Release notes are missing YAML frontmatter");
  const metadata = metadataSchema.parse(parseYaml(match[1]));
  parseVersion(metadata.version);
  return { metadata, shareable: extractShareableNotes(markdown) };
}

export function extractShareableNotes(markdown: string): string {
  const match = /<!-- shareable:start -->\n([\s\S]*?)\n<!-- shareable:end -->/.exec(markdown);
  if (!match) throw new Error("Release notes are missing shareable markers");
  return `${match[1].trim()}\n`;
}

export function validateReleaseNotes(
  markdown: string,
  expectedVersion: string,
): {
  metadata: ReleaseFileMetadata;
  sources: number[];
  customerFacingSources: number[];
  scopeSources: number[];
  scopeEntries: Array<{ number: number; category: "feature" | "improvement" | "fix" | "internal" }>;
} {
  const parsed = parseReleaseNotes(markdown);
  if (parsed.metadata.version !== parseVersion(expectedVersion)) {
    throw new Error(`Release note version ${parsed.metadata.version} does not match ${expectedVersion}`);
  }
  const headings = parsed.shareable
    .split("\n")
    .filter((line) => /^#{1,2} /.test(line));
  const expectedHeadings = [
    `# AI Workflow — ${expectedVersion}`,
    "## Highlights",
    "## What's new",
    "## Improvements and fixes",
    "## Do you need to do anything?",
    "## Known limitations",
  ];
  if (headings.length !== expectedHeadings.length || headings.some((line, index) => line !== expectedHeadings[index])) {
    throw new Error("Release notes do not contain the canonical sections in the required order");
  }
  const scopeMarker = "## Exact release scope\n\n";
  const scopeParts = markdown.split(scopeMarker);
  if (scopeParts.length !== 2) throw new Error("Release notes must contain exactly one exact release scope");
  const scope = scopeParts[1];
  const escapedRepository = parsed.metadata.repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const scopeLine = new RegExp(
    `^- \\[#(\\d+)\\]\\(https://github\\.com/${escapedRepository}/pull/(\\d+)\\) — (feature|improvement|fix|internal): `,
  );
  const scopeSources = new Set<number>();
  const customerFacingSources = new Set<number>();
  const scopeEntries: Array<{
    number: number;
    category: "feature" | "improvement" | "fix" | "internal";
  }> = [];
  for (const line of scope.trim().split("\n")) {
    if (!line.startsWith("- ")) continue;
    const match = scopeLine.exec(line);
    if (!match || match[1] !== match[2]) {
      throw new Error(`Malformed exact release scope entry: ${line}`);
    }
    const source = Number(match[1]);
    if (scopeSources.has(source)) throw new Error(`Duplicate PR #${source} in exact release scope`);
    scopeSources.add(source);
    const category = match[3] as "feature" | "improvement" | "fix" | "internal";
    scopeEntries.push({ number: source, category });
    if (category !== "internal") customerFacingSources.add(source);
  }

  const lines = parsed.shareable.split("\n");
  const sources = new Set<number>();
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith("- ")) continue;
    const source = /^\s*<!-- sources: ([\d,]+) -->$/.exec(lines[index + 1] ?? "");
    if (!source) throw new Error(`Customer bullet is missing a source comment: ${lines[index]}`);
    for (const value of source[1].split(",")) {
      const number = Number(value);
      if (!customerFacingSources.has(number)) {
        throw new Error(`Source PR #${number} is absent from the customer-facing release scope`);
      }
      sources.add(number);
    }
  }
  for (const source of customerFacingSources) {
    if (!sources.has(source)) throw new Error(`Customer-facing PR #${source} is not covered by a release note`);
  }
  return {
    metadata: parsed.metadata,
    sources: [...sources].sort((a, b) => a - b),
    customerFacingSources: [...customerFacingSources].sort((a, b) => a - b),
    scopeSources: [...scopeSources].sort((a, b) => a - b),
    scopeEntries: scopeEntries.sort((a, b) => a.number - b.number),
  };
}
