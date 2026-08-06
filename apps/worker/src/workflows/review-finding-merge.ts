import type { ReviewResultFinding } from "@shared/contracts";

/**
 * Collapses the findings of several review agents into one finding per defect.
 *
 * Three reviewers with different prompts routinely report one defect three
 * times, which is the "a lot of noise for very low signal" complaint this
 * review flow exists to answer. Merging happens here, at publication, and
 * nowhere else: the raw per-reviewer results still reach `fix_agent` verbatim
 * and still key the publication content hash, so neither may be rewritten.
 *
 * FINDINGS ONLY. Reviewer feedback PROSE is never deduplicated, anywhere. Two
 * attempts are worth not repeating: a similarity gate cannot separate "the same
 * defect restated" from "a different defect in the same code", because the two
 * score distributions measurably overlap (0.13 to 0.21 for one production
 * duplicate set against 0.13 to 0.21 for unique remarks beside it), and there is
 * no unit to gate on either, because one blank-line-separated chunk of model
 * prose routinely carries several unrelated findings as a bullet list, so
 * suppressing a chunk on the strength of its first item silently deleted three
 * real defects. Prose is published verbatim behind a disclosure instead, which
 * costs a reader one click and cannot lose a sentence. A finding is a structured
 * object with a file, a line and a severity, which is why merging is safe here
 * and only here.
 *
 * THREE DELIBERATE ABSENCES, each of which looks like an oversight:
 *
 * 1. No merge when one finding has a line and the other does not. A file-level
 *    remark and a line-level one are different claims, and guessing that they
 *    are the same would hide the specific one behind the vague one.
 * 2. No model call. The merge must be a pure function of its input because
 *    GitLab identifies a published comment by its index in the comment array,
 *    so a re-publication that reorders comments re-keys every one of them.
 * 3. No configurable thresholds. Same reason: a value read from the
 *    environment would make comment identity depend on deployment config.
 */

/** Where a finding sits on the reviewed diff. Null when it cannot be placed. */
export interface ReviewFindingAnchor {
  path: string;
  startLine: number;
  endLine: number;
  startOldLine: number | null;
  endOldLine: number | null;
}

export interface ReviewFindingCandidate {
  /** Index in reviewResults, i.e. the reference list's declaration order. */
  reviewerIndex: number;
  /** Index within that reviewer's own findings. */
  findingIndex: number;
  finding: ReviewResultFinding;
  /** Provider-normalized path when one resolved, else the raw file. */
  groupKey: string;
  anchor: ReviewFindingAnchor | null;
}

/**
 * One defect. Extends the finding shape so the existing summary rendering keeps
 * working on it unchanged.
 */
export interface MergedReviewFinding extends ReviewResultFinding {
  /** Every candidate that reported this defect, in declaration order. */
  sources: ReviewFindingCandidate[];
  anchor: ReviewFindingAnchor | null;
}

/**
 * Frozen on purpose. These numbers decide which comments a reader sees, so they
 * belong to the code that is reviewed and tested, not to a deployment.
 */
export const REVIEW_FINDING_MERGE = Object.freeze({
  /** Lines each range grows by before testing for overlap. */
  lineWindow: 2,
  /** Wording agreement required when the line matches but the severity differs. */
  sameLineDifferentSeverity: 0.25,
  /** Wording agreement required when only the ranges are close. */
  nearbyLine: 0.4,
  /** Wording agreement required when neither finding carries a line. */
  noLine: 0.5,
});

/**
 * The cap on inline comments for the whole review rather than per reviewer.
 * A reader experiences one review, so that is the number that has to be bounded.
 * Mirrors MAX_REVIEW_FINDINGS in sandbox/agents/types.ts, restated rather than
 * imported so this module never pulls the sandbox agent bundle into the
 * workflow graph.
 */
export const MAX_PUBLISHED_INLINE_REVIEW_COMMENTS = 10;

const SEVERITY_RANK: Record<ReviewResultFinding["severity"], number> = {
  Blocker: 4,
  High: 3,
  Medium: 2,
  Nit: 1,
};

/** Words carried by almost every finding, so they say nothing about identity. */
const STOPWORDS = new Set([
  "the", "and", "for", "that", "this", "with", "from", "into", "when", "then",
  "there", "which", "while", "would", "should", "could", "will", "not", "but",
  "any", "all", "its", "has", "have", "are", "was", "were", "can", "may",
  "line", "lines", "code", "file", "function", "method", "value", "values",
  "instead", "because", "means", "makes", "make", "used", "uses", "use",
]);

function descriptionTokens(value: string): Set<string> {
  const spaced = value
    // Split camelCase so `parseFloat` also contributes `parse` and `float`.
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
  const tokens = new Set<string>();
  for (const token of spaced.split(" ")) {
    if (token.length < 3 || STOPWORDS.has(token)) continue;
    tokens.add(token);
  }
  return tokens;
}

/**
 * Token-set Jaccard overlap of two finding descriptions, 0 to 1. Zero when
 * either side carries no meaningful token, so an empty description never drags
 * an unrelated finding into a cluster.
 */
export function reviewDescriptionSimilarity(a: string, b: string): number {
  const left = descriptionTokens(a);
  const right = descriptionTokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  const union = left.size + right.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Reviewers that must independently report one High finding before it holds the
 * check back. A Blocker never needs a second opinion.
 */
const HIGH_FINDING_BLOCKING_AGREEMENT = 2;

/**
 * How many reviewers have to agree before a High blocks, in a graph running this
 * many of them.
 *
 * Math.min and never a bare 2: a graph with a single reviewer can never reach two
 * sources, so a bare 2 would stop High from blocking anything at all there. The
 * Arthur definition runs exactly one reviewer per pull request, and min(2, 1)
 * keeps its behaviour identical to what it has today.
 *
 * The threshold lives here rather than beside the publication gate that applies
 * it, because `mergedReviewFindingNote` PUBLISHES this number on a client pull
 * request. While the constant sat in the other module and the sentence spelled
 * its numeral out by hand, raising the constant printed a falsehood on every
 * non-blocking High and nothing failed.
 */
export function highFindingBlockingAgreement(reviewerCount: number): number {
  return Math.min(HIGH_FINDING_BLOCKING_AGREEMENT, reviewerCount);
}

function rangeOf(finding: ReviewResultFinding): { start: number; end: number } | null {
  if (typeof finding.startLine !== "number") return null;
  return { start: finding.startLine, end: finding.endLine ?? finding.startLine };
}

function locationMatches(
  primary: ReviewResultFinding,
  candidate: ReviewResultFinding,
): boolean {
  const a = rangeOf(primary);
  const b = rangeOf(candidate);

  // A file-level claim and a line-level claim stay separate: see absence 1.
  if ((a === null) !== (b === null)) return false;

  const similarity = reviewDescriptionSimilarity(
    primary.description,
    candidate.description,
  );

  if (a === null || b === null) {
    return similarity >= REVIEW_FINDING_MERGE.noLine;
  }

  if (a.start === b.start) {
    // No wording gate here, and that is the point of the whole change. Three
    // reviewers describe one defect in three unrelated vocabularies ("no
    // authentication" against "missing auth per AC-3" share no token), so a
    // similarity gate on an exact line match would reject precisely the
    // duplicates this exists to collapse.
    if (primary.severity === candidate.severity) return true;
    return similarity >= REVIEW_FINDING_MERGE.sameLineDifferentSeverity;
  }

  const window = REVIEW_FINDING_MERGE.lineWindow;
  const overlaps = a.start - window <= b.end && b.start - window <= a.end;
  if (!overlaps) return false;
  // A nearby line is weak evidence on its own: a real pair sat four lines
  // apart in one function and was two unrelated defects. The wording has to
  // agree as well.
  return similarity >= REVIEW_FINDING_MERGE.nearbyLine;
}

interface Cluster {
  sources: ReviewFindingCandidate[];
}

function mergeable(cluster: Cluster, candidate: ReviewFindingCandidate): boolean {
  const primary = cluster.sources[0]!;
  // Cross-reviewer only. One reviewer's own list is left alone, which removes
  // the failure mode where its Nit swallows its own Blocker on the same line.
  if (cluster.sources.some((s) => s.reviewerIndex === candidate.reviewerIndex)) {
    return false;
  }
  if (primary.groupKey !== candidate.groupKey) return false;
  return locationMatches(primary.finding, candidate.finding);
}

function resolveCluster(cluster: Cluster): MergedReviewFinding {
  // Highest severity leads, ties broken by declaration order, so the most
  // serious reading of a defect is the one a reader sees first.
  const lead = cluster.sources.reduce((best, source) =>
    SEVERITY_RANK[source.finding.severity] > SEVERITY_RANK[best.finding.severity]
      ? source
      : best,
  );
  const anchored = cluster.sources.find((source) => source.anchor !== null);
  return {
    file: lead.finding.file,
    description: lead.finding.description,
    severity: lead.finding.severity,
    ...(typeof lead.finding.startLine === "number"
      ? { startLine: lead.finding.startLine }
      : {}),
    ...(typeof lead.finding.endLine === "number"
      ? { endLine: lead.finding.endLine }
      : {}),
    sources: cluster.sources,
    // A cluster mixing an anchored and an unanchored report is published
    // inline: one reviewer managed to place it, so the reader gets it in place
    // rather than in the summary.
    anchor: anchored?.anchor ?? null,
  };
}

/**
 * Groups candidates into one entry per defect. Candidates must arrive in
 * declaration order; the result preserves it, which is what keeps the published
 * comment array stable for a given input.
 */
export function mergeReviewFindings(
  candidates: readonly ReviewFindingCandidate[],
): MergedReviewFinding[] {
  const clusters: Cluster[] = [];
  for (const candidate of candidates) {
    // Compared against the cluster's first member only. Comparing against every
    // member would chain 40 to 41 to 42 to 43 and swallow a whole file.
    const target = clusters.find((cluster) => mergeable(cluster, candidate));
    if (target) target.sources.push(candidate);
    else clusters.push({ sources: [candidate] });
  }
  return clusters.map(resolveCluster);
}

/**
 * What a finding says about who reported it, or "" when it says nothing.
 *
 * ONE note for every surface that shows the finding: the inline comment body
 * below, and the summary bullet in pr-external-resources. Those two used to word
 * the same fact differently, one as a lowercase parenthetical and one as a
 * sentence, which put two registers in one bulleted list of client-facing text
 * and let them drift apart.
 *
 * "It did not fail the check" was the first attempt at the High sentence and it
 * is false on the normal failing pull request: one Blocker plus a lone High turns
 * the check red while that sentence sits on the same review claiming otherwise.
 *
 * It also has to avoid reading as a confidence vote. The reviewers have disjoint
 * remits by construction, so "1 of 3" is the EXPECTED count for a real defect
 * that falls inside exactly one reviewer's remit, and a reader who learns to
 * discount lone Highs has learned the wrong lesson. Naming the severity and the
 * rule states why this one did not block without implying it is doubtful.
 *
 * The High branch is tested BEFORE the agreement branch, and the order matters
 * only if the threshold ever rises: today the two cannot both apply, because a
 * High stops blocking only while it has one source, but at an agreement of three
 * a two-source High would reach both, and why it did not block is the more
 * informative of the two facts.
 */
export function mergedReviewFindingNote(
  finding: MergedReviewFinding,
  reviewerCount: number,
  blocksTheCheck: boolean,
): string {
  // Agreement between independent reviewers is the strongest signal available
  // that a finding is real, so it is stated rather than discarded.
  const agreement = `Reported by ${finding.sources.length} of ${reviewerCount} reviewers.`;
  if (finding.severity === "High" && !blocksTheCheck) {
    // A High nobody else reported does not request changes on its own. Without
    // this line a reader sees a High and has to guess whether it is why the check
    // is red, and the note deliberately states the rule rather than this check's
    // colour, because a Blocker elsewhere in the same review can make it red.
    //
    // The threshold is read from the rule and never spelled out here. The plural
    // "reviewers" is safe at any threshold: a High reaches this branch only when
    // the effective agreement is at least two, or it would have blocked alone.
    return `${agreement} A High blocks only when ${highFindingBlockingAgreement(reviewerCount)} reviewers report it independently.`;
  }
  return finding.sources.length > 1 ? agreement : "";
}

/**
 * The published comment body.
 *
 * A single-source cluster renders byte for byte as it did before merging existed,
 * with one exception: a High that did not block says so. Single-reviewer
 * deployments still see the pre-merge bytes for every severity, because a lone
 * reviewer's High always blocks (see `reviewFindingBlocksPublication`).
 *
 * `blocksTheCheck` is passed in rather than derived here. The rule belongs to the
 * publication gate, and computing it twice would let the comment claim one thing
 * while the check reports another.
 */
export function mergedReviewFindingCommentBody(
  finding: MergedReviewFinding,
  reviewerCount: number,
  blocksTheCheck: boolean,
): string {
  const head = `**${finding.severity}**: ${finding.description}`;
  const note = mergedReviewFindingNote(finding, reviewerCount, blocksTheCheck);
  return note === "" ? head : `${head}\n\n${note}`;
}

/** Orders clusters for the inline slots: severity, then agreement, then order. */
export function compareMergedFindingsForPublication(
  a: MergedReviewFinding,
  b: MergedReviewFinding,
): number {
  const severity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (severity !== 0) return severity;
  const agreement = b.sources.length - a.sources.length;
  if (agreement !== 0) return agreement;
  const first = a.sources[0]!;
  const second = b.sources[0]!;
  if (first.reviewerIndex !== second.reviewerIndex) {
    return first.reviewerIndex - second.reviewerIndex;
  }
  return first.findingIndex - second.findingIndex;
}

/** Orders the chosen clusters for display: by file, then by line. */
export function compareMergedFindingsForDisplay(
  a: MergedReviewFinding,
  b: MergedReviewFinding,
): number {
  // Plain comparison, never localeCompare: the locale would make published
  // comment order, and therefore GitLab's comment identity, machine dependent.
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  const left = a.startLine ?? 0;
  const right = b.startLine ?? 0;
  if (left !== right) return left - right;
  return compareMergedFindingsForPublication(a, b);
}
