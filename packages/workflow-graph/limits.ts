/**
 * The size bounds a workflow definition is parsed against.
 *
 * Sized far above any hand-drawn workflow (the built-in default is 8 blocks/7
 * connections) but low enough to bound the graph validation walk, whose
 * dominator fixpoint is O(N^2*E) and copies the node universe per node.
 *
 * They live in their own module so the two numbers have one home, but the
 * package publishes only `exports["."]`, so importing them still loads the
 * barrel: there is no cheap import path here, and a caller that needs one needs
 * a subpath export first. That is why the MCP tool catalog restates the numbers
 * rather than importing them. It is loaded on the transport path and must stay
 * out of the schema's module graph, and a restated number that drifted below
 * these would leave an agent able to read a graph it can never save back, so
 * `apps/worker/src/mcp/tool-catalog.test.ts` pins the restated pair against
 * this one.
 */
export const MAX_NODES = 200;
export const MAX_EDGES = 400;
