import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { invitation } from "./auth-schema.js";

export const inviteEmailDelivery = pgTable(
  "invite_email_delivery",
  {
    id: text("id").primaryKey(),
    invitationId: text("invitation_id")
      .notNull()
      .references(() => invitation.id, { onDelete: "cascade" }),
    resendEmailId: text("resend_email_id").unique(),
    status: text("status").notNull(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("invite_email_delivery_invitation_id_idx").on(t.invitationId)],
);
