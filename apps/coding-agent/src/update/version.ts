const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;
const NUMERIC_IDENTIFIER_PATTERN = /^\d+$/;

interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}

export function isValidVersion(version: string): boolean {
  return VERSION_PATTERN.test(version);
}

export function extractUpdateChannel(version: string): string {
  const match = VERSION_PATTERN.exec(version);
  const prerelease = match !== null && match.length > 4 ? match[4] : undefined;
  if (prerelease === undefined) {
    return "latest";
  }
  return prerelease.split(".")[0];
}

export function isSameMajorVersion(left: string, right: string): boolean {
  const a = parseVersion(left);
  const b = parseVersion(right);
  return a !== undefined && b !== undefined && a.major === b.major;
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === undefined || b === undefined) {
    throw new RangeError(
      `compareVersions expects valid versions, got "${left}" and "${right}"`
    );
  }

  if (a.major !== b.major) {
    return a.major - b.major;
  }
  if (a.minor !== b.minor) {
    return a.minor - b.minor;
  }
  if (a.patch !== b.patch) {
    return a.patch - b.patch;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

function parseVersion(version: string): ParsedVersion | undefined {
  const match = VERSION_PATTERN.exec(version);
  if (match === null) {
    return;
  }

  const prereleaseText = match.length > 4 ? match[4] : undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: prereleaseText === undefined ? [] : prereleaseText.split("."),
  };
}

function comparePrerelease(
  left: readonly string[],
  right: readonly string[]
): number {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }
  if (left.length === 0) {
    return 1;
  }
  if (right.length === 0) {
    return -1;
  }

  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === b) {
      continue;
    }

    const aNumeric = NUMERIC_IDENTIFIER_PATTERN.test(a);
    const bNumeric = NUMERIC_IDENTIFIER_PATTERN.test(b);
    if (aNumeric && bNumeric) {
      return Number(a) - Number(b);
    }
    if (aNumeric) {
      return -1;
    }
    if (bNumeric) {
      return 1;
    }
    return a < b ? -1 : 1;
  }

  return left.length - right.length;
}
