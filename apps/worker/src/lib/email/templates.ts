export interface EmailTemplate {
  subject: string;
  html: string;
  text: string;
}

export interface InviteEmailTemplateInput {
  organizationName: string;
  inviteUrl: string;
  inviterName?: string;
}

export interface ResetPasswordEmailTemplateInput {
  resetUrl: string;
}

export function inviteEmailTemplate(input: InviteEmailTemplateInput): EmailTemplate {
  const inviter = input.inviterName?.trim() || "An administrator";
  const subject = `You're invited to ${input.organizationName}`;
  const htmlInviteUrl = escapeHtml(input.inviteUrl);
  const htmlOrganizationName = escapeHtml(input.organizationName);
  const htmlInviter = escapeHtml(inviter);
  const intro = `${inviter} invited you to join ${input.organizationName}`;

  return {
    subject,
    html: renderEmailHtml({
      title: "Join your team in AI Workflow",
      body: `${htmlInviter} invited you to join ${htmlOrganizationName}.`,
      actionHref: htmlInviteUrl,
      actionLabel: "Accept invite",
      fallbackUrl: htmlInviteUrl,
    }),
    text: `${intro}.\n\nAccept your invite:\n${input.inviteUrl}\n\nIf you were not expecting this invitation, you can ignore this email.`,
  };
}

export function resetPasswordEmailTemplate(
  input: ResetPasswordEmailTemplateInput,
): EmailTemplate {
  const htmlResetUrl = escapeHtml(input.resetUrl);

  return {
    subject: "Reset your AI Workflow password",
    html: renderEmailHtml({
      title: "Reset your password",
      body: "Use the link below to reset your AI Workflow password.",
      actionHref: htmlResetUrl,
      actionLabel: "Reset password",
      fallbackUrl: htmlResetUrl,
    }),
    text: `Use this link to reset your AI Workflow password:\n${input.resetUrl}\n\nIf you did not request a password reset, you can ignore this email.`,
  };
}

function renderEmailHtml(input: {
  title: string;
  body: string;
  actionHref: string;
  actionLabel: string;
  fallbackUrl: string;
}): string {
  return `<!doctype html>
<html>
  <body style="font-family: Arial, sans-serif; color: #111827; line-height: 1.5;">
    <h1 style="font-size: 20px; margin: 0 0 16px;">${input.title}</h1>
    <p style="margin: 0 0 20px;">${input.body}</p>
    <p style="margin: 0 0 20px;">
      <a href="${input.actionHref}" style="display: inline-block; background: #111827; color: #ffffff; padding: 10px 14px; text-decoration: none; border-radius: 6px;">${input.actionLabel}</a>
    </p>
    <p style="margin: 0; color: #4b5563; font-size: 14px;">If the button does not work, paste this link into your browser:</p>
    <p style="margin: 8px 0 0; color: #4b5563; font-size: 14px;">${input.fallbackUrl}</p>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
