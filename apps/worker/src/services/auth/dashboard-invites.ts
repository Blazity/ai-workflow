/**
 * Dashboard invites as the admin screen asks for them.
 *
 * The invite lifecycle below already decides who may invite whom and what an
 * invite becomes; this binds it to a connection, to the organization invites are
 * minted for, and to this deployment's email provider. The provider is built
 * before the lifecycle runs, deliberately: a deployment that cannot send mail
 * refuses the request rather than recording an invite nobody will ever receive.
 */
import { Resend } from "resend";
import { getDb } from "../../db/client.js";
import { sendEmail } from "../email/index.js";
import { dashboardOrganizationSettings, outboundEmailSettings } from "../settings/index.js";
import {
  cancelDashboardInvite,
  createDashboardInvite,
  listDashboardInvites,
  resendDashboardInvite,
  type DashboardInviteRow,
  type SendInviteEmail,
} from "./invites.js";
import { DashboardAuthError } from "@shared/contracts";
import type { DashboardActor } from "./users-read.js";

/** Every invite this actor is allowed to see. */
export function listInvitesForActor(
  actor: DashboardActor,
): Promise<DashboardInviteRow[]> {
  return listDashboardInvites(getDb(), {
    organizationSlug: dashboardOrganizationSettings().slug,
    actor,
  });
}

/** Mint one invite and send it. */
export function createInviteForActor(input: {
  actor: DashboardActor;
  email: string;
}): Promise<DashboardInviteRow> {
  const sendInviteEmail = inviteEmailSender();
  const organization = dashboardOrganizationSettings();
  return createDashboardInvite(getDb(), {
    organizationSlug: organization.slug,
    organizationName: organization.name,
    dashboardOrigin: organization.origin,
    actor: input.actor,
    email: input.email,
    sendInviteEmail,
  });
}

/** Send one pending invite again. */
export function resendInviteForActor(input: {
  actor: DashboardActor;
  inviteId: string;
}): Promise<DashboardInviteRow> {
  const sendInviteEmail = inviteEmailSender();
  const organization = dashboardOrganizationSettings();
  return resendDashboardInvite(getDb(), {
    organizationSlug: organization.slug,
    organizationName: organization.name,
    dashboardOrigin: organization.origin,
    actor: input.actor,
    inviteId: input.inviteId,
    sendInviteEmail,
  });
}

/** Withdraw one pending invite. */
export function cancelInviteForActor(input: {
  actor: DashboardActor;
  inviteId: string;
}): Promise<DashboardInviteRow> {
  return cancelDashboardInvite(getDb(), {
    organizationSlug: dashboardOrganizationSettings().slug,
    actor: input.actor,
    inviteId: input.inviteId,
  });
}

/**
 * A provider failure is reported as 502 rather than left to surface as a 500:
 * the invite row survives it, and the screen offers a resend.
 */
function inviteEmailSender(): SendInviteEmail {
  const { apiKey, from } = outboundEmailSettings();
  if (!apiKey || !from) {
    throw new DashboardAuthError(503, "Email is not configured");
  }

  const client = new Resend(apiKey);
  return async ({ to, subject, html, text, deliveryId }) => {
    try {
      return await sendEmail(client, {
        from,
        to,
        subject,
        html,
        text,
        tags: [{ name: "invite_delivery_id", value: deliveryId }],
      });
    } catch (error) {
      throw new DashboardAuthError(
        502,
        error instanceof Error ? error.message : "Email provider failed",
      );
    }
  };
}
