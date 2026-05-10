// stripThinkBlocks lives in its own file so providers can use it without
// importing from client.ts (which would create a cycle once client.ts
// imports from each provider).

export function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}
