export async function getPrompt(name: string): Promise<string> {
  const content = await useStorage("assets:prompts").getItem<string>(name);
  if (!content) throw new Error(`Missing prompt asset: ${name}`);
  return content;
}
