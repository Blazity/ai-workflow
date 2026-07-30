import {
  releaseVersionSchema,
  type ClassifiedPullRequest,
  type ReleaseCategory,
  type ReleaseFields,
  type ReleasePullRequest,
} from "./types.js";

const RELEASE_LABELS = new Set([
  "release:feature",
  "release:improvement",
  "release:fix",
  "release:internal",
  "release:skip",
]);

export function parseVersion(value: string): string {
  return releaseVersionSchema.parse(value);
}

export function extractReleaseFields(body: string): ReleaseFields {
  const sections = new Map<string, string>();
  let heading = "";
  let lines: string[] = [];
  const flush = () => {
    if (heading) sections.set(heading, lines.join("\n").trim());
  };
  for (const line of body.split(/\r?\n/)) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match) {
      flush();
      heading = match[1].trim().toLowerCase();
      lines = [];
    } else if (heading) {
      lines.push(line);
    }
  }
  flush();
  return {
    userImpact: sections.get("user impact") ?? "",
    requiredAction: sections.get("required action") ?? "",
    releaseNote: sections.get("release note") ?? "",
  };
}

export function classifyPullRequest(pr: ReleasePullRequest): ClassifiedPullRequest {
  const releaseLabels = pr.labels.filter((label) => RELEASE_LABELS.has(label.toLowerCase()));
  if (releaseLabels.length > 1) {
    throw new Error(`PR #${pr.number} has multiple release labels: ${releaseLabels.join(", ")}`);
  }

  const fields = extractReleaseFields(pr.body);
  const warnings: string[] = [];
  let category: ReleaseCategory;

  if (releaseLabels.length === 1) {
    category = releaseLabels[0].toLowerCase().slice("release:".length) as ReleaseCategory;
  } else {
    warnings.push(`PR #${pr.number} is missing a release label`);
    if (/^feat(?:\(.+\))?[!:]/i.test(pr.title)) category = "feature";
    else if (/^fix(?:\(.+\))?[!:]/i.test(pr.title)) category = "fix";
    else if (fields.releaseNote && fields.releaseNote.toLowerCase() !== "internal") {
      category = "improvement";
    } else {
      category = "internal";
    }
  }

  if (!fields.userImpact && category !== "internal" && category !== "skip") {
    warnings.push(`PR #${pr.number} is missing User impact`);
  }
  if (!fields.releaseNote && category !== "internal" && category !== "skip") {
    warnings.push(`PR #${pr.number} is missing Release note`);
  }

  return {
    ...pr,
    category,
    customerFacing: category !== "internal" && category !== "skip",
    included: category !== "skip",
    fields,
    warnings,
  };
}
