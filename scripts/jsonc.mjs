// Minimal JSONC reader for the repository's biome config files: strips line
// and block comments plus trailing commas without touching string contents
// (e.g. URLs containing `//`).

const WHITESPACE_CHAR = /\s/;

// [start, end] inclusive ranges of double-quoted string literals, so the
// comment/comma strippers never touch string contents.
function stringRanges(text) {
  const ranges = [];
  let start = -1;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (start === -1) {
      if (char === '"') {
        start = index;
      }
      continue;
    }
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === '"') {
      ranges.push([start, index]);
      start = -1;
    }
  }
  return ranges;
}

// Cursor over a text plus its string ranges, telling callers whether an
// offset sits inside a string literal.
function rangeCursor(ranges) {
  let position = 0;
  return {
    advance(index) {
      while (position < ranges.length && index > ranges[position][1]) {
        position += 1;
      }
    },
    contains(index) {
      return (
        position < ranges.length &&
        index >= ranges[position][0] &&
        index <= ranges[position][1]
      );
    },
  };
}

function stripComments(text) {
  const cursor = rangeCursor(stringRanges(text));
  let out = "";
  let index = 0;
  while (index < text.length) {
    cursor.advance(index);
    const char = text[index];
    const next = text[index + 1];
    if (!cursor.contains(index) && char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (!cursor.contains(index) && char === "/" && next === "*") {
      index += 2;
      while (
        index < text.length &&
        !(text[index] === "*" && text[index + 1] === "/")
      ) {
        index += 1;
      }
      index += 2;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

function stripTrailingCommas(text) {
  const cursor = rangeCursor(stringRanges(text));
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    cursor.advance(index);
    const char = text[index];
    if (cursor.contains(index) || char !== ",") {
      out += char;
      continue;
    }
    let lookahead = index + 1;
    while (WHITESPACE_CHAR.test(text[lookahead] ?? "")) {
      lookahead += 1;
    }
    if (text[lookahead] !== "}" && text[lookahead] !== "]") {
      out += char;
    }
  }
  return out;
}

export function parseJsonc(text) {
  return JSON.parse(stripTrailingCommas(stripComments(text)));
}
