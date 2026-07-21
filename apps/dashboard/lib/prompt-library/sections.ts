export interface PromptSection {
  title: string;
  level: number;
  start: number;
  end: number;
  body: string;
}

// Markdown headings (#, ##, ###) anchored to the start of a line.
const headingRe = /^(#{1,3})[ \t]+(.*)$/;
// Fenced code block markers (``` or ~~~) anchored to the start of a line. An
// opener may carry an info string (e.g. ```markdown), which this still matches
// because we only anchor on the leading run of fence characters.
const fenceRe = /^(```|~~~)/;

/** Split a prompt body into sections by markdown headings. Any text before the
 *  first heading (or a body with no headings at all) becomes an "Introduction"
 *  section. Each section's body spans its heading line up to the next heading,
 *  so concatenating every section's body reconstructs the original string.
 *  Headings inside fenced code blocks are ignored, so a `# ...` line within a
 *  ```markdown fence does not spuriously start a new section. */
export function splitSections(body: string): PromptSection[] {
  const heads: { start: number; level: number; title: string }[] = [];
  // Walk line by line, tracking the byte offset of each line's start (so a
  // heading's `start` matches the old regex m.index) and the fence marker that
  // opened the current fenced block, if any. A fence is closed only by a line
  // whose marker matches the opener, so a ~~~ line inside a ``` block is inert.
  const lines = body.split("\n");
  let offset = 0;
  let fence: string | null = null;
  for (const line of lines) {
    const fenceMatch = fenceRe.exec(line);
    if (fence === null) {
      if (fenceMatch) {
        fence = fenceMatch[1];
      } else {
        const m = headingRe.exec(line);
        if (m) heads.push({ start: offset, level: m[1].length, title: m[2].trim() });
      }
    } else if (fenceMatch && fenceMatch[1] === fence) {
      fence = null;
    }
    // + 1 restores the "\n" that split() removed between lines.
    offset += line.length + 1;
  }

  if (heads.length === 0) {
    return [{ title: "Introduction", level: 0, start: 0, end: body.length, body }];
  }

  const sections: PromptSection[] = [];
  if (heads[0].start > 0) {
    sections.push({
      title: "Introduction",
      level: 0,
      start: 0,
      end: heads[0].start,
      body: body.slice(0, heads[0].start),
    });
  }
  for (let i = 0; i < heads.length; i++) {
    const start = heads[i].start;
    const end = i + 1 < heads.length ? heads[i + 1].start : body.length;
    sections.push({
      title: heads[i].title,
      level: heads[i].level,
      start,
      end,
      body: body.slice(start, end),
    });
  }
  return sections;
}
