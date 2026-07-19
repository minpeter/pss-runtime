export function encodeKey(key: string): string {
  return Buffer.from(key).toString("base64url");
}

export { isNodeError, isPlainRecord as isRecord } from "../../../../internal/guards";
