import { invokedExecutable } from "./ci-command-prefixes.mjs";

const BASENAME = /^.*\//;
const COMMAND_SEPARATOR = /[\n;&|]/u;
const CONTINUATION = /\\\r?\n[\t ]*/g;
const ENV_OPTIONS_WITH_VALUE = new Set(["-C", "--chdir", "-u", "--unset"]);
const EXEC = /^exec$/;
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

function shellCommands(source, commandSeparator = COMMAND_SEPARATOR) {
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
    } else if (commandSeparator?.test(character)) {
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

function packageSubcommand(tokens, executableName, commandPattern) {
  const executable = invokedExecutable(tokens);
  if (tokens[executable]?.replace(BASENAME, "") !== executableName) {
    return -1;
  }
  const command = tokens.findIndex(
    (token, index) => index > executable && commandPattern.test(token)
  );
  if (command < 0) {
    return -1;
  }
  return tokens
    .slice(executable + 1, command)
    .every(
      (token, index) =>
        token.startsWith("-") || tokens[executable + index]?.startsWith("-")
    )
    ? command
    : -1;
}

function packageCommand(tokens, executableName, commandPattern) {
  return packageSubcommand(tokens, executableName, commandPattern) >= 0;
}

function packageExecTokens(tokens, executableName) {
  const command = packageSubcommand(tokens, executableName, EXEC);
  if (command < 0) {
    return;
  }
  const nested = tokens[command + 1] === "--" ? command + 2 : command + 1;
  return tokens.slice(nested);
}

function envSplitTokens(tokens) {
  const env = tokens.findIndex(
    (token, index) =>
      token.replace(BASENAME, "") === "env" &&
      invokedExecutable([...tokens.slice(0, index), "__probe__"]) === index
  );
  if (env < 0) {
    return;
  }
  let option = env + 1;
  while (option < tokens.length) {
    const candidate = tokens[option];
    if (
      candidate === "-S" ||
      candidate === "--split-string" ||
      candidate.startsWith("-S") ||
      candidate.startsWith("--split-string=")
    ) {
      break;
    }
    if (!candidate.startsWith("-") || candidate === "--") {
      return;
    }
    option += ENV_OPTIONS_WITH_VALUE.has(candidate) ? 2 : 1;
  }
  if (option >= tokens.length) {
    return;
  }
  const token = tokens[option];
  const attached = token !== "-S" && token !== "--split-string";
  let value = tokens[option + 1];
  if (token.startsWith("--split-string=")) {
    value = token.slice("--split-string=".length);
  } else if (attached) {
    value = token.slice(2);
  }
  const words = shellCommands(value ?? "", null)[0] ?? [];
  return [...words, ...tokens.slice(option + (attached ? 1 : 2))];
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

function containsPublishTokens(tokens) {
  if (tokens.length === 0) {
    return false;
  }
  const splitEnv = envSplitTokens(tokens);
  if (splitEnv !== undefined) {
    return containsPublishTokens(splitEnv);
  }
  return (
    containsPublishCommand(delegatedCommand(tokens) ?? "") ||
    containsPublishTokens(packageExecTokens(tokens, "npm") ?? []) ||
    containsPublishTokens(packageExecTokens(tokens, "pnpm") ?? []) ||
    packageCommand(tokens, "npm", NPM_PUBLISH) ||
    packageCommand(tokens, "pnpm", PNPM_PUBLISH) ||
    tokens.join(" ") === "pnpm tegami ci"
  );
}

export function containsPublishCommand(source) {
  return (
    substitutionBodies(source).some(containsPublishCommand) ||
    shellCommands(source).some(containsPublishTokens)
  );
}
