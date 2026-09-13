/**
 * Runtime request schemas for the dashboard administration HTTP surface.
 *
 * One schema per JSON body the worker accepts. Each mirrors exactly what its
 * handler used to check by hand, including the message it answered with, so
 * moving the check here changes where the refusal is decided and not what a
 * client sees.
 */
import { z } from "zod";
import { objectOrEmpty } from "./request-parsing";

/**
 * Body of POST /api/v1/invites.
 *
 * `role` is deliberately `unknown` rather than a string: the handler only
 * refused a truthy role that was not "member", so a missing, null or empty role
 * has always been accepted and still is.
 *
 * `email` is the one deliberate behaviour change of this stage. The handler
 * refused only a falsy email and then handed whatever it got to the invite
 * store, so a truthy non-string (a number, an object) travelled on as an
 * address; that audited gap is closed here with its own sentence, and the
 * falsy cases keep answering the sentence they always answered.
 */
export const dashboardInviteCreateRequestSchema = objectOrEmpty(
  z.object({
    email: z.preprocess(
      // Every falsy value failed the handler's `!body?.email` check and got one
      // sentence, so they are folded into the absent case rather than reported
      // as a type.
      (value) => (value ? value : undefined),
      z
        .unknown()
        .superRefine((value, ctx) => {
          if (value === undefined) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Missing email" });
          } else if (typeof value !== "string") {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid email" });
          }
        })
        .transform((value) => value as string),
    ),
    role: z.unknown().refine((role) => !role || role === "member", {
      message: "Invites can only create members",
    }),
  }),
);
export type DashboardInviteCreateRequest = z.infer<
  typeof dashboardInviteCreateRequestSchema
>;

/** Body of PATCH /api/v1/users/[userId]/role. */
export const dashboardUserRoleUpdateRequestSchema = objectOrEmpty(
  z.object({
    role: z.union([z.literal("admin"), z.literal("member")], {
      message: "Invalid role",
      errorMap: () => ({ message: "Invalid role" }),
    }),
  }),
);
export type DashboardUserRoleUpdateRequest = z.infer<
  typeof dashboardUserRoleUpdateRequestSchema
>;
