/**
 * Where an unbound block input takes its value from: a closed set of fields of
 * the run's subject, which is the ticket the run is about (or the ticket-shaped
 * snapshot a pull request, webhook or schedule run is given in its place).
 *
 * A block that reads untrusted text needs a value even in a graph whose author
 * never bound one, and the value it needs is the text the run was started
 * with. Naming the fields, rather than letting a block reach into the run, is
 * what keeps the set small enough for the editor to say where the value comes
 * from and for the validator to count the input as satisfied.
 *
 * Pure data and pure functions: the worker resolves a default with
 * `subjectDefaultText`, and the editor and every refusal describe it with
 * `describeSubjectDefault`, so the two can never name a default differently.
 */

export const WORKFLOW_SUBJECT_FIELDS = ["title", "description", "comments"] as const;

export type WorkflowSubjectField = (typeof WORKFLOW_SUBJECT_FIELDS)[number];

/** The part of a run's ticket a default can read. */
export interface WorkflowSubjectSnapshot {
  readonly title: string;
  readonly description: string;
  readonly comments: ReadonlyArray<{ readonly author: string; readonly body: string }>;
}

/**
 * The text an unbound input receives: the declared fields in the declared
 * order, each comment as `author: body`, empty parts dropped, joined by a
 * blank line. Empty when the ticket holds none of them, which a caller reads as
 * "nothing to give" and refuses on, rather than handing a block an empty string
 * it would have to guess about.
 */
export function subjectDefaultText(
  fields: readonly WorkflowSubjectField[],
  subject: WorkflowSubjectSnapshot,
): string {
  const parts: string[] = [];
  for (const field of fields) {
    if (field === "comments") {
      for (const comment of subject.comments) parts.push(`${comment.author}: ${comment.body}`);
    } else {
      parts.push(subject[field]);
    }
  }
  return parts.filter(Boolean).join("\n\n");
}

/** "the ticket's description and comments", in the order declared. */
export function describeSubjectDefault(fields: readonly WorkflowSubjectField[]): string {
  const names = [...fields];
  const last = names.pop();
  const list = names.length === 0 ? (last ?? "") : `${names.join(", ")} and ${last}`;
  return `the ticket's ${list}`;
}
