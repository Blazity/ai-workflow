import { segmentTemplate } from "./variables";

/** Inline run of a block. `bold` marks emphasized text/variables; inline code is
 *  literal (no variable or bold parsing inside it). */
export type InlineNode =
  | { type: "text"; value: string; bold: boolean }
  | { type: "code"; value: string }
  | { type: "var"; name: string; known: boolean; bold: boolean };

export type MarkdownBlock =
  | { type: "heading"; level: 1 | 2 | 3; inline: InlineNode[] }
  | { type: "paragraph"; inline: InlineNode[] }
  | { type: "list"; ordered: boolean; items: InlineNode[][] }
  | { type: "code"; lang: string | null; value: string };

const HEADING_RE = /^(#{1,3})[ \t]+(.*)$/;
const LIST_RE = /^[ \t]*([-*+]|\d+\.)[ \t]+(.*)$/;
const FENCE_RE = /^(```|~~~)(.*)$/;
// Inline code span or **bold** run. Code is matched first so ** inside a code
// span stays literal.
const INLINE_RE = /(`[^`\n]+`)|\*\*([^*\n]+)\*\*/g;

// Push plain text (no code/bold) split into text + {{variable}} nodes, reusing
// the shared segmenter so known/unknown classification matches the rest of the UI.
function pushPlain(out: InlineNode[], text: string, bold: boolean): void {
  if (text === "") return;
  for (const seg of segmentTemplate(text)) {
    if (seg.kind === "text") {
      if (seg.text) out.push({ type: "text", value: seg.text, bold });
    } else {
      out.push({ type: "var", name: seg.name, known: seg.known, bold });
    }
  }
}

/** Parse a single line's (or paragraph's) inline markup: `code`, **bold**, and
 *  {{variable}} tokens, leaving everything else as text. */
export function parseInline(text: string): InlineNode[] {
  const out: InlineNode[] = [];
  const re = new RegExp(INLINE_RE.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) pushPlain(out, text.slice(last, m.index), false);
    if (m[1] !== undefined) {
      out.push({ type: "code", value: m[1].slice(1, -1) });
    } else {
      pushPlain(out, m[2], true);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) pushPlain(out, text.slice(last), false);
  return out;
}

/** Parse a prompt body into a small block model for rendering: headings (1-3),
 *  ordered/unordered lists, fenced code blocks, and paragraphs. Fence-aware, so
 *  markdown syntax inside a ``` block is left literal. Not a full CommonMark
 *  parser — just the subset prompts actually use. */
export function parseMarkdownBlocks(body: string): MarkdownBlock[] {
  const lines = body.split("\n");
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2].trim() || null;
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith(marker)) {
        buf.push(lines[i]);
        i++;
      }
      i++; // consume the closing fence (or the past-end index if unclosed)
      blocks.push({ type: "code", lang, value: buf.join("\n") });
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length as 1 | 2 | 3,
        inline: parseInline(heading[2].trim()),
      });
      i++;
      continue;
    }

    const firstItem = LIST_RE.exec(line);
    if (firstItem) {
      const ordered = /\d+\./.test(firstItem[1]);
      const items: InlineNode[][] = [];
      while (i < lines.length) {
        const li = LIST_RE.exec(lines[i]);
        if (!li) break;
        items.push(parseInline(li[2]));
        i++;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    // Paragraph: gather consecutive lines until a blank line or a block starter.
    // Soft line breaks are preserved (the renderer keeps whitespace) so a prompt's
    // deliberate line breaks survive.
    const buf: string[] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === "" || FENCE_RE.test(l) || HEADING_RE.test(l) || LIST_RE.test(l)) break;
      buf.push(l);
      i++;
    }
    blocks.push({ type: "paragraph", inline: parseInline(buf.join("\n")) });
  }

  return blocks;
}
