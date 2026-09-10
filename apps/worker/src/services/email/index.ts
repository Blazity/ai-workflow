/**
 * Outbound email: the provider client, invite delivery and message templates.
 *
 * The declared interface of this cluster. Cross-cluster imports must target
 * this file; the deep imports that predate the rule are listed in
 * scripts/gates/cluster-deep-imports.json and that list only shrinks.
 */
export {
  applyInviteEmailDeliveryEvent,
  createInviteEmailDelivery,
  updateInviteEmailDeliveryById,
} from "./invite-delivery.js";
export type {
  InviteEmailDeliveryStatus,
  ResendEmailDeliveryEvent,
} from "./invite-delivery.js";
export {
  sendEmail,
} from "./send-email.js";
export {
  inviteEmailTemplate,
  resetPasswordEmailTemplate,
} from "./templates.js";
