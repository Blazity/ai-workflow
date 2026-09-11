/**
 * Runtime request schemas for the dashboard-auth HTTP surface.
 *
 * One schema per JSON body the worker accepts. Each mirrors exactly what its
 * handler used to check by hand, including the message it answered with, so
 * moving the check here changes where the refusal is decided and not what a
 * client sees.
 */
import { z } from "zod";

/**
 * An optional string field whose only refusal is "this is not a string".
 *
 * The invite handler type-checked every field before it asked whether any of
 * them was present, and answered the same "Invalid request body" for all three,
 * so the field messages here are deliberately identical and deliberately not
 * about which field it was.
 */
const optionalInviteString = z.string({ message: "Invalid request body" }).optional();

/**
 * Accepting an invite: the shape checks first, then presence, in that order.
 *
 * The presence checks sit in a refinement rather than on the fields because the
 * handler ran them only once every field had passed its type check, and because
 * an empty string counted as missing, which a required string would have
 * accepted.
 */
export const dashboardInviteAcceptRequestSchema = z
  .object(
    {
      inviteId: optionalInviteString,
      name: optionalInviteString,
      password: optionalInviteString,
    },
    { message: "Invalid request body" },
  )
  .superRefine((value, ctx) => {
    if (!value.inviteId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Missing invite id" });
      return;
    }
    if (!value.password) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Missing password" });
    }
  });
export type DashboardInviteAcceptRequest = z.infer<
  typeof dashboardInviteAcceptRequestSchema
>;

/**
 * Redeeming an SSO handoff token.
 *
 * One message for every refusal, including a body that is not an object at all,
 * because the handler read `body?.token` and answered the same way whether the
 * body was missing, the wrong type, absent a token or carrying only whitespace.
 * The trim is part of the contract: the handler redeemed the trimmed value.
 */
export const dashboardSsoHandoffConsumeRequestSchema = z.object(
  {
    token: z
      .string({ message: "Missing SSO handoff token" })
      .trim()
      .min(1, { message: "Missing SSO handoff token" }),
  },
  { message: "Missing SSO handoff token" },
);
export type DashboardSsoHandoffConsumeRequest = z.infer<
  typeof dashboardSsoHandoffConsumeRequestSchema
>;
