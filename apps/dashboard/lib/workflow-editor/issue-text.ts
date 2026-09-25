/**
 * A validator's sentence as the person who named the blocks reads it.
 *
 * The worker names blocks by id (`Block "clean-copy" is not reachable from a
 * trigger.`), because an id is what an API caller or an agent acts on. The
 * editor shows every block by the name its author gave it, so an id is a word
 * the canvas never shows. Wherever the editor prints an issue, the block it is
 * about is already named beside it (the refused Deploy's prefix, the heading of
 * the block's group), so that block becomes "this block"; any other block the
 * sentence mentions gets its name. An id with no block behind it, such as an
 * unknown reference, stays as it is: that id is the only thing to go on.
 */
export function issueTextForPeople(
  message: string,
  nodeId: string | null,
  nodeNames: Readonly<Record<string, string>>,
): string {
  return message.replace(
    /\b(Block|block|trigger) "([^"]+)"/g,
    (whole, word: string, id: string) => {
      if (id === nodeId && (word === "Block" || word === "block")) {
        return word === "Block" ? "This block" : "this block";
      }
      const name = Object.hasOwn(nodeNames, id) ? nodeNames[id] : undefined;
      return name === undefined ? whole : `${word} "${name}"`;
    },
  );
}
