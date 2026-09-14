const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const BASENAME = /^.*\//;
const ENV_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "--chdir",
  "-S",
  "--split-string",
  "-u",
  "--unset",
]);
const SUDO_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "--close-from",
  "-D",
  "--chdir",
  "-g",
  "--group",
  "-h",
  "--host",
  "-p",
  "--prompt",
  "-u",
  "--user",
]);
const TIME_OPTIONS_WITH_VALUE = new Set(["-f", "--format", "-o", "--output"]);

function skipAssignments(tokens, start) {
  let index = start;
  while (ASSIGNMENT.test(tokens[index] ?? "")) {
    index += 1;
  }
  return index;
}

function afterCommandPrefix(tokens, start) {
  if (["-v", "-V"].includes(tokens[start])) {
    return -1;
  }
  let index = start;
  while (["-p", "--"].includes(tokens[index])) {
    index += 1;
  }
  return index;
}

function afterExecPrefix(tokens, start) {
  let index = start;
  while (["-c", "-l", "--"].includes(tokens[index])) {
    index += 1;
  }
  return tokens[index] === "-a" ? index + 2 : index;
}

function afterOptions(tokens, start, optionsWithValue) {
  let index = start;
  while (tokens[index]?.startsWith("-")) {
    const option = tokens[index++];
    if (optionsWithValue.has(option)) {
      index += 1;
    }
  }
  return index;
}

function afterEnvPrefix(tokens, start) {
  return skipAssignments(
    tokens,
    afterOptions(tokens, start, ENV_OPTIONS_WITH_VALUE)
  );
}

function afterSudoPrefix(tokens, start) {
  return skipAssignments(
    tokens,
    afterOptions(tokens, start, SUDO_OPTIONS_WITH_VALUE)
  );
}

const PREFIX_UNWRAPPERS = new Map([
  ["!", (_tokens, start) => start],
  ["command", afterCommandPrefix],
  ["env", afterEnvPrefix],
  ["exec", afterExecPrefix],
  ["sudo", afterSudoPrefix],
  [
    "time",
    (tokens, start) => afterOptions(tokens, start, TIME_OPTIONS_WITH_VALUE),
  ],
]);

export function invokedExecutable(tokens) {
  let index = skipAssignments(tokens, 0);
  while (index < tokens.length) {
    const executable = tokens[index]?.replace(BASENAME, "");
    const unwrap = PREFIX_UNWRAPPERS.get(executable);
    if (unwrap === undefined) {
      return index;
    }
    index = unwrap(tokens, index + 1);
  }
  return -1;
}
