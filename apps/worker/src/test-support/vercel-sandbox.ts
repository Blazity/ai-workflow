export const Sandbox = {
  get(): never {
    throw new Error(
      "Unexpected Sandbox.get in a worker unit test; install an explicit @vercel/sandbox mock",
    );
  },
};
