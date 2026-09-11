/**
 * Slack surface: signature verification, command parsing, handlers, formatting and message search.
 *
 * The declared interface of this cluster. Cross-cluster imports must target
 * this file; the deep imports that predate the rule are listed in
 * scripts/gates/cluster-deep-imports.json and that list only shrinks.
 */
export {
  parseCommand,
} from "./commands.js";
export type {
  ParsedCommand,
} from "./commands.js";
export {
  HELP_TEXT,
} from "./format.js";
export {
  handleCancel,
  handleInspect,
  handleList,
  handleReset,
  handleStatus,
  handleSummary,
} from "./handlers.js";
export {
  handleSlackSlashCommand,
} from "./handle-slash-command.js";
export type {
  SlackSlashCommandRequest,
  SlackSlashCommandResponse,
} from "./handle-slash-command.js";
export {
  postToResponseUrl,
} from "./respond.js";
export type {
  RetrievalFailureReason,
  SlackSearchResult,
} from "./slack-search.js";
export {
  verifySlackSignature,
} from "./verify.js";
