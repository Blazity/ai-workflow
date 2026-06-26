import type {
  CreateEmailOptions,
  CreateEmailRequestOptions,
  CreateEmailResponse,
} from "resend";

export type SendEmailInput = CreateEmailOptions;

export interface SendEmailClient {
  emails: {
    send(
      input: CreateEmailOptions,
      options?: CreateEmailRequestOptions,
    ): Promise<CreateEmailResponse>;
  };
}

export async function sendEmail(
  client: SendEmailClient,
  input: SendEmailInput,
): Promise<{ providerMessageId: string }> {
  const result = await client.emails.send(input);

  if (result.error) {
    throw new Error(`Resend send failed: ${result.error.message}`);
  }

  if (!result.data?.id) {
    throw new Error("Resend accepted email without returning an id");
  }

  return { providerMessageId: result.data.id };
}
