/**
 * Why a block's ports are refused, or null when they are the one port an
 * integration block may have.
 *
 * Its own module, importing nothing, because two readers ask it: conformance,
 * over the manifest a package exports, and the registry generator, earlier,
 * over the manifest's source. The generator runs where the rest of the SDK does
 * not compile, and the two have to say the same sentence.
 */
export function integrationBlockPortsIssue(type: string, ports: readonly string[]): string | null {
  if (ports.length === 1 && ports[0] === "out") return null;
  return (
    `Block "${type}" declares ${JSON.stringify(ports)}; an integration block has exactly one port named "out". ` +
    "The workflow graph reads ports from core's generated catalog, which holds no integration block, so it resolves every one of them to a single port named \"out\": a second port is offered in the editor, refused at publish as an unknown port, and propagates to nothing at run time. " +
    "Until the graph learns a manifest's ports (ADR-010), branch downstream on the block's status output."
  );
}
