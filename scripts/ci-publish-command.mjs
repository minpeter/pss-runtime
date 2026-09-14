import { invokedExecutable } from "./ci-command-prefixes.mjs";

const BASENAME = /^.*\//;
const COMMAND_SEPARATOR = /[\n;&|]/u;
const CONTINUATION = /\\\r?\n[\t ]*/g;
const NPM_PUBLISH = /^pub(?:l(?:i(?:s(?:h)?)?)?)?$/;
const PNPM_PUBLISH = /^publish$/;
const QUOTE = /["']/u;
const SHELL_COMMAND_OPTION = /^-[^-]*c/;
const SHELL_INTERPRETERS = new Set(["bash", "dash", "ksh", "sh", "zsh"]);
const WHITESPACE = /\s/u;
const isEscaped = (character, quote) => character === "\\" && quote !== "'";

function closingParenthesis(text, start) {
  let depth = 1;
  let quote;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else if (character === "\\" && quote === '"') {
        index += 1;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "\\") {
      index += 1;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")" && --depth === 0) {
      return index;
    }
  }
  return text.length;
}

function substitutionBodies(source) {
  const bodies = [];
  let quote;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (isEscaped(character, quote)) {
      index += 1;
    } else if (quote !== "'" && source.startsWith("$(", index)) {
      const end = closingParenthesis(source, index + 2);
      bodies.push(source.slice(index + 2, end));
      index = end;
    } else if (quote !== "'" && character === "`") {
      const end = source.indexOf("`", index + 1);
      bodies.push(source.slice(index + 1, end < 0 ? source.length : end));
      index = end < 0 ? source.length : end;
    } else if (character === quote) {
      quote = undefined;
    } else if (quote === undefined && QUOTE.test(character)) {
      quote = character;
    }
  }
  return bodies;
}

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
  const executable = invokedExecutable(tokens);
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

function delegatedCommand(tokens) {
  const executable = invokedExecutable(tokens);
  if (tokens[executable]?.replace(BASENAME, "") === "eval") {
    return tokens.slice(executable + 1).join(" ");
  }
  if (!SHELL_INTERPRETERS.has(tokens[executable]?.replace(BASENAME, ""))) {
    return;
  }
  const option = tokens.findIndex(
    (token, index) =>
      index > executable && SHELL_COMMAND_OPTION.test(token) && token !== "-O"
  );
  return option < 0 ? undefined : tokens[option + 1];
}

export function containsPublishCommand(source) {
  return (
    substitutionBodies(source).some(containsPublishCommand) ||
    shellCommands(source).some(
      (tokens) =>
        containsPublishCommand(delegatedCommand(tokens) ?? "") ||
        packageCommand(tokens, "npm", NPM_PUBLISH) ||
        packageCommand(tokens, "pnpm", PNPM_PUBLISH) ||
        tokens.join(" ") === "pnpm tegami ci"
    )
  );
}
