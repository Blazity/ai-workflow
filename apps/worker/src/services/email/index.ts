/**
 * Outbound email: the provider client, invite delivery and message templates.
 *
 * The interface of this cluster: every module outside it consumes the cluster
 * through this file, and another services cluster may import nothing else here.
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
