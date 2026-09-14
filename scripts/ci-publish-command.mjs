const ASSIGNMENT = /^\w+=/;
const BASENAME = /^.*\//;
const COMMAND_SEPARATOR = /[\n;&|]/u;
const CONTINUATION = /\\\r?\n[\t ]*/g;
const NPM_PUBLISH = /^pub(?:l(?:i(?:s(?:h)?)?)?)?$/;
const PNPM_PUBLISH = /^publish$/;
const WHITESPACE = /\s/u;

function quotedPart(text, index, quote) {
  const character = text[index];
  if (character === quote) {
    return { index, quote: undefined, value: "" };
  }
  if (character === "\\" && quote === '"' && index + 1 < text.length) {
    return { index: index + 1, quote, value: text[index + 1] };
  }
  return { index, quote, value: character };
}

function shellCommands(source) {
  const commands = [];
  let tokens = [];
  let word = "";
  let wordStarted = false;
  let quote;

  const finishWord = () => {
    if (wordStarted) {
      tokens.push(word);
    }
    word = "";
    wordStarted = false;
  };
  const finishCommand = () => {
    finishWord();
    if (tokens.length > 0) {
      commands.push(tokens);
    }
    tokens = [];
  };

  const text = source.replace(CONTINUATION, "");
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote !== undefined) {
      const part = quotedPart(text, index, quote);
      index = part.index;
      quote = part.quote;
      word += part.value;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      wordStarted = true;
    } else if (character === "\\" && index + 1 < text.length) {
      word += text[++index];
      wordStarted = true;
    } else if (character === "#" && !wordStarted) {
      index = text.indexOf("\n", index);
      if (index < 0) {
        break;
      }
      finishCommand();
    } else if (COMMAND_SEPARATOR.test(character)) {
      finishCommand();
    } else if (WHITESPACE.test(character)) {
      finishWord();
    } else {
      word += character;
      wordStarted = true;
    }
  }
  finishCommand();
  return commands;
}

function packageCommand(tokens, executableName, commandPattern) {
  const executable = tokens.findIndex((token) => !ASSIGNMENT.test(token));
  if (tokens[executable]?.replace(BASENAME, "") !== executableName) {
    return false;
  }
  const command = tokens.findIndex(
    (token, index) => index > executable && commandPattern.test(token)
  );
  if (command < 0) {
    return false;
  }
  return tokens
    .slice(executable + 1, command)
    .every(
      (token, index) =>
        token.startsWith("-") || tokens[executable + index]?.startsWith("-")
    );
}

export function containsPublishCommand(source) {
  return shellCommands(source).some(
    (tokens) =>
      packageCommand(tokens, "npm", NPM_PUBLISH) ||
      packageCommand(tokens, "pnpm", PNPM_PUBLISH) ||
      tokens.join(" ") === "pnpm tegami ci"
  );
}
