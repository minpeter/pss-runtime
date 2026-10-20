const textEncoder = new TextEncoder();

/** Splits serialized JSON into UTF-8-bounded chunks without splitting surrogate pairs. */
export function chunkSerializedPayload(
  serialized: string,
  maxPayloadBytes: number
): string[] {
  const chunkMaxBytes = Math.max(1, maxPayloadBytes);
  const totalBytes = textEncoder.encode(serialized).byteLength;
  if (totalBytes <= chunkMaxBytes) {
    return [serialized];
  }
  if (totalBytes === serialized.length) {
    const chunks: string[] = [];
    for (let index = 0; index < serialized.length; index += chunkMaxBytes) {
      chunks.push(serialized.slice(index, index + chunkMaxBytes));
    }
    return chunks;
  }

  const chunks: string[] = [];
  let currentStart = 0;
  while (currentStart < serialized.length) {
    const firstEnd = nextCodePointEnd(serialized, currentStart);
    let low = firstEnd;
    let high = Math.max(
      firstEnd,
      Math.min(serialized.length, currentStart + chunkMaxBytes)
    );
    let best = firstEnd;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const end = avoidTrailingHighSurrogate(serialized, middle);
      if (end <= currentStart) {
        break;
      }
      const byteLength = textEncoder.encode(
        serialized.slice(currentStart, end)
      ).byteLength;
      if (byteLength <= chunkMaxBytes) {
        best = end;
        // Advance past the probe, not the pair-adjusted end: a surrogate pair
        // straddling the probe would otherwise repeat it forever.
        low = middle + 1;
      } else {
        high = end - 1;
      }
    }
    chunks.push(serialized.slice(currentStart, best));
    currentStart = best;
  }
  return chunks;
}

function avoidTrailingHighSurrogate(value: string, index: number): number {
  if (index <= 0 || index >= value.length) {
    return index;
  }
  const previous = value.charCodeAt(index - 1);
  return previous >= 0xd8_00 && previous <= 0xdb_ff ? index - 1 : index;
}

function nextCodePointEnd(value: string, index: number): number {
  if (index >= value.length) {
    return index;
  }
  const first = value.charCodeAt(index);
  const second = value.charCodeAt(index + 1);
  return first >= 0xd8_00 &&
    first <= 0xdb_ff &&
    second >= 0xdc_00 &&
    second <= 0xdf_ff
    ? index + 2
    : index + 1;
}
