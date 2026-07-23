import { z } from "zod";
import type { PRComment } from "../adapters/vcs/types.js";

export const REVIEW_FEEDBACK_INPUT_NAME = "reviewFeedback";

export const reviewFeedbackSchema = z
  .object({
    state: z.enum(["changes_requested", "commented"]),
    author: z.string(),
    body: z.string(),
  })
  .strict();

export type ReviewFeedback = z.infer<typeof reviewFeedbackSchema>;

export type ReviewFeedbackResolution =
  | {
      ok: true;
      value: ReviewFeedback | undefined;
      source: "binding" | "ambient" | null;
    }
  | {
      ok: false;
      message: string;
    };

/**
 * Resolve the optional typed binding without leaking malformed input details.
 * Legacy callers may opt into their existing ambient trigger fallback; v2
 * callers leave that disabled so all data flow remains explicit.
 */
export function resolveReviewFeedbackInput(
  resolvedInputs: Readonly<Record<string, unknown>>,
  options: {
    ambient?: unknown;
    allowAmbientFallback?: boolean;
  } = {},
): ReviewFeedbackResolution {
  if (Object.prototype.hasOwnProperty.call(resolvedInputs, REVIEW_FEEDBACK_INPUT_NAME)) {
    const parsed = reviewFeedbackSchema.safeParse(
      resolvedInputs[REVIEW_FEEDBACK_INPUT_NAME],
    );
    return parsed.success
      ? { ok: true, value: parsed.data, source: "binding" }
      : {
          ok: false,
          message:
            "The review feedback input must contain a valid state, author, and body.",
        };
  }

  if (!options.allowAmbientFallback || options.ambient === undefined) {
    return { ok: true, value: undefined, source: null };
  }
  const parsed = reviewFeedbackSchema.safeParse(options.ambient);
  return parsed.success
    ? { ok: true, value: parsed.data, source: "ambient" }
    : {
        ok: false,
        message: "The review feedback trigger data is invalid.",
      };
}

function sameFeedback(existing: PRComment, feedback: ReviewFeedback): boolean {
  if (existing.author.trim().toLowerCase() !== feedback.author.trim().toLowerCase()) {
    return false;
  }
  const existingBody = existing.body.trim();
  const feedbackBody = feedback.body.trim();
  if (existingBody === feedbackBody) return true;
  if (feedbackBody === "") return false;
  return existingBody.endsWith(feedbackBody);
}

/** Add the event feedback once even when provider context already contains it. */
export function appendReviewFeedbackComment(
  comments: readonly PRComment[],
  feedback: ReviewFeedback | undefined,
): PRComment[] {
  if (!feedback || comments.some((comment) => sameFeedback(comment, feedback))) {
    return [...comments];
  }
  return [
    ...comments,
    {
      author: feedback.author,
      body: feedback.body,
      liked: false,
    },
  ];
}
