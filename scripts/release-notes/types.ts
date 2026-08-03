import { z } from "zod";

export const releaseVersionSchema = z
  .string()
  .regex(/^\d{4}\.(0[1-9]|1[0-2])\.(0|[1-9]\d*)$/, "Version must use YYYY.MM.PATCH");

export type ReleaseCategory = "feature" | "improvement" | "fix" | "internal" | "skip";

export interface ReleaseFields {
  userImpact: string;
  requiredAction: string;
  releaseNote: string;
}

export interface ReleasePullRequest {
  number: number;
  title: string;
  body: string;
  labels: string[];
  mergedAt: string;
  mergeCommitSha: string;
  url: string;
}

export interface ClassifiedPullRequest extends ReleasePullRequest {
  category: ReleaseCategory;
  customerFacing: boolean;
  included: boolean;
  fields: ReleaseFields;
  warnings: string[];
}

export interface ReleaseCollection {
  repository: string;
  previousCommit: string;
  targetCommit: string;
  included: ClassifiedPullRequest[];
  internal: ClassifiedPullRequest[];
  skipped: ClassifiedPullRequest[];
  warnings: string[];
}

export interface DraftItem {
  text: string;
  sources: number[];
}

export interface ReleaseDraft {
  highlights: string;
  features: DraftItem[];
  improvementsAndFixes: DraftItem[];
  requiredAction: string;
  knownLimitations: string;
  generatedBy: "ai" | "fallback";
}

export interface ReleaseFileMetadata {
  version: string;
  previousSourceCommit: string;
  targetSourceCommit: string;
  repository: string;
}

export interface ApprovedSourceRelease {
  version: string;
  previousSourceCommit: string;
  targetSourceCommit: string;
  notesPath: string;
  releaseNotesPullRequest: number;
  releaseNotesApprovedBy: string[];
}
