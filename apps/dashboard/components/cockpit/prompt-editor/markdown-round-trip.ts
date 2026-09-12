import type { AnyExtension } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";

/** Shown when a stored document opened raw because the visual editor would not
 *  give it back. The toggle stays available: the note says what is at stake,
 *  it does not lock the surface. */
export const RAW_MARKDOWN_FALLBACK_NOTE =
  "This text uses markdown the visual editor cannot represent; edit it as raw " +
  "markdown to keep it intact.";

/**
 * Exactly what the editor's serializer backslash-escapes in plain text
 * (`MarkdownManager.escapeMarkdownSyntax`). Spelled once because two things
 * here depend on knowing it: the repair below, which must undo this and
 * nothing else, and the comparison after it, which must not read an escape as
 * damage.
 */
const SERIALIZER_ESCAPE = /\\([\\`*_[\]~])/g;

/**
 * The serializer's escapes undone inside `{{...}}` spans, and nowhere else.
 *
 * The serializer escapes every `_ * [ ] ~ \` and backtick in plain text, which
 * is correct for prose and wrong for a variable: `{{repo_path}}` comes back as
 * `{{repo\_path}}`, and the runtime's `{{name}}` pattern
 * (`substitutePromptVariables`) never matches it again, so the token reaches
 * the model as literal braces. Every v1 surface documents the opposite, that a
 * `{{name}}` survives the visual editor, so this restores the contract at the
 * one point a document leaves the editor.
 *
 * Braces only, and one line only: a backslash the author typed in their own
 * prose is theirs, and the escape that keeps it literal has to stay.
 */
export function restoreVariableTokens(markdown: string): string {
  return markdown.replace(/\{\{[^{}\n]*\}\}/g, (token) =>
    token.replace(SERIALIZER_ESCAPE, "$1"),
  );
}

/**
 * What is left of a document once the two round trips can legitimately differ
 * on are removed: the serializer's own backslash escapes, and the choice of
 * marker (`*` or `-` for a bullet, setext or ATX for a heading, how deep a
 * nested list is indented).
 *
 * Those are re-spellings of the same document. What this keeps is the text, so
 * a comparison of two signatures answers the only question worth asking: did
 * anything the author wrote fail to come back? A markdown table has no node in
 * this schema, so it comes back as nothing at all, and that is a loss no
 * re-spelling explains.
 */
function contentSignature(markdown: string): string {
  return markdown
    .replace(SERIALIZER_ESCAPE, "$1")
    .replace(/[*_~`>#|=+-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Would the visual editor give this markdown back?
 *
 * Asked before mounting, against the editor's own parser and serializer rather
 * than a list of syntax we think is risky: the schema decides what survives,
 * and the schema is the extension list passed in. A document that fails this
 * opens raw, because the alternative is an editor that silently eats a table
 * the first time the author fixes a typo three paragraphs above it.
 *
 * A manager is built per call. That is one parse of one document when a field
 * mounts, which is the same work the editor is about to do anyway.
 */
export function visualEditorKeepsMarkdown(
  markdown: string,
  extensions: AnyExtension[],
): boolean {
  if (markdown.trim().length === 0) return true;
  try {
    const manager = new MarkdownManager({ extensions });
    const round = manager.serialize(manager.parse(markdown));
    return contentSignature(round) === contentSignature(markdown);
  } catch {
    // A parser that throws is not a verdict about the document. Opening raw is
    // the answer that cannot lose text, so a failure here reads as "cannot
    // represent" rather than as "fine".
    return false;
  }
}
