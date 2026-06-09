export function sessionKeyForThread(threadId: string, userId: string): string {
  return [
    "telegram",
    "thread",
    encodeURIComponent(threadId),
    "user",
    encodeURIComponent(userId),
  ].join(":");
}

export function storePrefixForThread(threadId: string, userId: string): string {
  return [
    "telegram-chat",
    "thread",
    encodeURIComponent(threadId),
    "user",
    encodeURIComponent(userId),
  ].join(":");
}
