const base64Alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const base64UrlAlphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function bytesToBase64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes, base64UrlAlphabet, false);
}

export function base64UrlToBytes(value: string): Uint8Array {
  return decodeBase64(value, true);
}

export function base64ToBytes(value: string): Uint8Array {
  return decodeBase64(value, false);
}

function encodeBase64(
  bytes: Uint8Array,
  alphabet: string,
  padded: boolean
): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const chunk = first * 65_536 + second * 256 + third;
    output += alphabet[Math.floor(chunk / 262_144) % 64] ?? "";
    output += alphabet[Math.floor(chunk / 4096) % 64] ?? "";
    output +=
      index + 1 < bytes.length
        ? (alphabet[Math.floor(chunk / 64) % 64] ?? "")
        : "";
    output += index + 2 < bytes.length ? (alphabet[chunk % 64] ?? "") : "";
  }

  if (!padded) {
    return output;
  }

  const padding = (3 - (bytes.length % 3)) % 3;
  return `${output}${"=".repeat(padding)}`;
}

function decodeBase64(value: string, urlSafe: boolean): Uint8Array {
  const normalized = normalizeBase64(value, urlSafe);
  const bytes: number[] = [];

  for (let index = 0; index < normalized.length; index += 4) {
    const first = base64Value(normalized[index]);
    const second = base64Value(normalized[index + 1]);
    const third = base64Value(normalized[index + 2]);
    const fourth = base64Value(normalized[index + 3]);
    const chunk = first * 262_144 + second * 4096 + third * 64 + fourth;

    bytes.push(Math.floor(chunk / 65_536) % 256);
    if (normalized[index + 2] !== "=") {
      bytes.push(Math.floor(chunk / 256) % 256);
    }
    if (normalized[index + 3] !== "=") {
      bytes.push(chunk % 256);
    }
  }

  return new Uint8Array(bytes);
}

function normalizeBase64(value: string, urlSafe: boolean): string {
  const compact = value.replace(/\s/g, "");
  const standard = urlSafe
    ? compact.replace(/-/g, "+").replace(/_/g, "/")
    : compact;
  const padding = (4 - (standard.length % 4)) % 4;
  return `${standard}${"=".repeat(padding)}`;
}

function base64Value(value: string | undefined): number {
  if (value === undefined || value === "=") {
    return 0;
  }

  const index = base64Alphabet.indexOf(value);
  if (index === -1) {
    throw new Error("Invalid base64 payload.");
  }
  return index;
}
