import type { PreSandboxStepHandler } from "../types.js";

const MIN_TITLE_LENGTH = 5;

export const requireTitleLengthStep: PreSandboxStepHandler = async ({ context }) => {
  const title = context.ticket.title?.trim() ?? "";

  if (title.length <= MIN_TITLE_LENGTH) {
    return {
      status: "halt",
      outcome: "needs_clarification",
      message: `Ticket title is too short (must be longer than ${MIN_TITLE_LENGTH} characters).`,
      questions: ["Can you expand the ticket title to describe the change?"],
    };
  }

  return {
    status: "continue",
    promptAdditions: [
      {
        target: ["research", "implementation"],
        title: "Ticket Title",
        content: title,
      },
    ],
  };
};
