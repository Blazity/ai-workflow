import type {
  WorkflowBlockContract,
  WorkflowBlockType,
  WorkflowParamValue,
} from "./domain";

/**
 * How a caller asks what one block's contract is.
 *
 * A contract is a function of the block's type and its own authored params: the
 * output schema, the binding schema and the availability all follow from
 * `params.providers`, `params.on` and a custom output schema. Availability also
 * depends on the deployment (which agent, VCS and messaging providers are
 * configured) and on the model catalog, neither of which a pure rule may read,
 * so the environment-aware half is bound once by the worker and the rules that
 * need a contract take this function instead of the environment.
 */
export type WorkflowBlockContractResolver = (
  type: WorkflowBlockType,
  params: Record<string, WorkflowParamValue>,
) => WorkflowBlockContract;
