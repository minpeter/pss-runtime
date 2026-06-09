const chatAgentNamespace = "telegram-chat";

export function chatParentSessionNamespace(sessionKey: string): string {
  const sessionNamespace = `agent:${encodeURIComponent(chatAgentNamespace)}`;
  return `${sessionNamespace}:session:${encodeURIComponent(sessionKey)}:generation:0`;
}