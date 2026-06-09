export function wrapUserMessage(text: string): string {
  return `<user>\n${text}\n</user>`;
}

export function wrapPokeMessage(text: string): string {
  return `<poke>\n${text}\n</poke>`;
}