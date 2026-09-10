/**
 * Runtime request schemas for the dashboard administration HTTP surface.
 *
 * One schema per JSON body the worker accepts. Each mirrors exactly what its
 * handler used to check by hand, including the message it answered with, so
 * moving the check here changes where the refusal is decided and not what a
 * client sees.
 */
import { z } from "zod";

/**
 * Body of POST /api/v1/invites.
 *
 * `role` is deliberately `unknown` rather than a string: the handler only
 * refused a truthy role that was not "member", so a missing, null or empty role
 * has always been accepted and still is.
 */
export const dashboardInviteCreateRequestSchema = z.object({
  email: z
    .string({ errorMap: () => ({ message: "Missing email" }) })
    .min(1),
  role: z.unknown().refine((role) => !role || role === "member", {
    message: "Invites can only create members",
  }),
});
export type DashboardInviteCreateRequest = z.infer<
  typeof dashboardInviteCreateRequestSchema
>;

/** Body of PATCH /api/v1/users/[userId]/role. */
export const dashboardUserRoleUpdateRequestSchema = z.object({
  role: z.union([z.literal("admin"), z.literal("member")], {
    errorMap: () => ({ message: "Invalid role" }),
  }),
});
export type DashboardUserRoleUpdateRequest = z.infer<
  typeof dashboardUserRoleUpdateRequestSchema
>;
