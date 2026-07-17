export interface PromptSection {
  title: string;
  level: number;
  start: number;
  end: number;
  body: string;
}

// Markdown headings (#, ##, ###) anchored to the start of a line.
const headingRe = (): RegExp => /^(#{1,3})[ \t]+(.*)$/gm;

/** Split a prompt body into sections by markdown headings. Any text before the
 *  first heading (or a body with no headings at all) becomes an "Introduction"
 *  section. Each section's body spans its heading line up to the next heading,
 *  so concatenating every section's body reconstructs the original string. */
export function splitSections(body: string): PromptSection[] {
  const re = headingRe();
  const heads: { start: number; level: number; title: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    heads.push({ start: m.index, level: m[1].length, title: m[2].trim() });
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
