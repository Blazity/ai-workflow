/**
 * Turning a stored clarification into the question a reading is made against,
 * and making that reading once, where the answer arrives.
 *
 * This is the clarification tier's half of the seam: it owns which questions
 * are repository questions at all, and what "the question as the person saw it"
 * means in terms of a stored row. The reading itself belongs to work-scope
 * (`services/work-scope/read-answer.ts`), which knows nothing about rows.
 */
import type { RepositoryKey, WorkScope, WorkScopeAnswerReading } from "@shared/contracts";
import type { HookClarificationRow } from "../../db/repositories/clarification-hooks.js";
import { formatAnswerUnreadableComment } from "../../engine/support/clarification-comment-format.js";
import { questionShowedKeptRepositories } from "../../engine/work-scope/context.js";
import { isHeldSelection } from "../../engine/work-scope/decide.js";
import {
  readRepositoryAnswerWithModel,
  type AnswerReadingDeps,
  type RepositoryQuestion,
} from "../work-scope/index.js";

/**
 * The question this row put, or null when it put no repository in front of
 * anybody.
 *
 * NULL IS A REAL ANSWER AND IT IS NOT A FAILURE. Two kinds of question reach
 * here and neither has a closed set to read an answer into: an ordinary
 * clarification that is not about repositories at all, and the narrowing
 * question that tells somebody how many repositories there are without naming
 * one. Those keep the path they have always had, and the reading column stays
 * null, which is exactly what it means.
 *
 * `named` is what decides, not the presence of an asked repository. A key
 * recorded against a question whose words never showed it is not a key the
 * person was offered, and offering a model a choice the person never saw is
 * how a decision gets made about something nobody mentioned.
 */
export async function repositoryQuestionOfRow(
  row: HookClarificationRow,
  readWorkScope: (subjectKey: string) => Promise<WorkScope | null>,
): Promise<RepositoryQuestion | null> {
  const asked = row.askedRepositories ?? [];
  const askedKeys = asked
    .filter((repository) => repository.named === true)
    .map((repository) => repository.repositoryKey);
  if (askedKeys.length === 0) return null;
  return {
    questions: row.questions,
    askedKeys,
    // A question offering exactly one repository is a question about that
    // repository, whatever the reason it was asked: "no" under it refuses that
    // one thing and nothing is left to guess. Under a list the same word says
    // which of several only if somebody guesses, which is the guess this whole
    // change removes.
    shape: askedKeys.length === 1 ? "one" : "list",
    heldKeys: await heldKeysOf(row, askedKeys, readWorkScope),
  };
}

/**
 * The repositories the question SHOWED as already part of this work.
 *
 * Read from the record rather than out of the question's words, and gated on
 * the question having actually shown them: repository discovery stamps
 * `selection` on its asks too and its question lists no kept repositories at
 * all, so keying on the reason alone would hand the reader repositories nobody
 * put in front of this person. One builder writes that sentence, so its
 * presence is the fact.
 *
 * The same rule `recordRepositoryAnswer` applies, deliberately: the reading and
 * the record must agree about what was on the person's screen, or the reading
 * chooses a repository the record then refuses to write.
 */
async function heldKeysOf(
  row: HookClarificationRow,
  askedKeys: RepositoryKey[],
  readWorkScope: (subjectKey: string) => Promise<WorkScope | null>,
): Promise<RepositoryKey[]> {
  const asked = row.askedRepositories ?? [];
  const showsKept =
    asked.length > 0 &&
    asked.every((repository) => repository.askedBecause === "selection") &&
    questionShowedKeptRepositories(row.questions);
  if (!showsKept) return [];
  const scope = await readWorkScope(row.subjectKey);
  return (scope?.entries ?? [])
    .filter(isHeldSelection)
    .map((entry) => entry.repositoryKey)
    .filter((key) => !askedKeys.includes(key));
}

/**
 * The reading for this answer, made once.
 *
 * ONE READING PER ANSWER. A delivery of the same words arriving again reads the
 * stored one back rather than paying a second model call that could disagree
 * with the first: a retry is one answer being delivered twice, not two answers.
 */
export async function readAnswerForRow(
  row: HookClarificationRow,
  answer: string,
  question: RepositoryQuestion,
  options: { isResumeRetry: boolean; deps?: AnswerReadingDeps },
): Promise<WorkScopeAnswerReading> {
  if (options.isResumeRetry && row.answerReading) return row.answerReading;
  return readRepositoryAnswerWithModel(answer, question, options.deps ?? {});
}

/**
 * The sentence a person reads when their answer could not be read.
 *
 * The words live with every other sentence this feature says to somebody
 * (`engine/support/clarification-comment-format.ts`), so a person who meets two
 * of them meets one voice. What this owns is the translation: which parts of a
 * reading are sayable at all, which is why only an `unclear` outcome has a
 * paraphrase to offer.
 */
export function answerReadingConfirmMessage(
  reading: WorkScopeAnswerReading,
  question: RepositoryQuestion,
  waiting?: { backlogColumnName: string; aiColumnName: string },
): string {
  const paraphrase =
    reading.outcome.kind === "unclear" && reading.outcome.paraphrase
      ? reading.outcome.paraphrase
      : undefined;
  return formatAnswerUnreadableComment({
    ...(paraphrase ? { paraphrase } : {}),
    shape: question.shape,
    askedKeys: question.askedKeys,
    ...(waiting ? { waiting } : {}),
  });
}
