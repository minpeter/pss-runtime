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
  "-R",
  "--chroot",
  "-r",
  "--role",
  "-T",
  "--command-timeout",
  "-t",
  "--type",
  "-u",
  "--user",
  "-U",
  "--other-user",
]);
const SUDO_OPTIONS = new Set([
  ...SUDO_OPTIONS_WITH_VALUE,
  "-A",
  "--askpass",
  "-b",
  "--background",
  "-B",
  "--bell",
  "-E",
  "--preserve-env",
  "-e",
  "--edit",
  "-H",
  "--set-home",
  "-i",
  "--login",
  "-K",
  "--remove-timestamp",
  "-k",
  "--reset-timestamp",
  "-l",
  "--list",
  "-N",
  "--no-update",
  "-n",
  "--non-interactive",
  "-P",
  "--preserve-groups",
  "-S",
  "--stdin",
  "-s",
  "--shell",
  "-V",
  "--version",
  "-v",
  "--validate",
]);
const NICE_OPTIONS_WITH_VALUE = new Set(["-n", "--adjustment"]);
const STDBUF_OPTIONS_WITH_VALUE = new Set([
  "-e",
  "--error",
  "-i",
  "--input",
  "-o",
  "--output",
]);
const TIME_OPTIONS_WITH_VALUE = new Set(["-f", "--format", "-o", "--output"]);
const TIMEOUT_OPTIONS_WITH_VALUE = new Set([
  "-k",
  "--kill-after",
  "-s",
  "--signal",
]);

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
  let index = start;
  while (tokens[index]?.startsWith("-")) {
    const option = tokens[index];
    if (option === "--") {
      index += 1;
      break;
    }
    const name = option.split("=", 1)[0];
    if (!SUDO_OPTIONS.has(name)) {
      return -2;
    }
    index += 1;
    if (SUDO_OPTIONS_WITH_VALUE.has(name) && !option.includes("=")) {
      index += 1;
    }
  }
  return skipAssignments(tokens, index);
}

function afterTimeoutPrefix(tokens, start) {
  const duration = afterOptions(tokens, start, TIMEOUT_OPTIONS_WITH_VALUE);
  return duration + 1;
}

const PREFIX_UNWRAPPERS = new Map([
  ["!", (_tokens, start) => start],
  ["command", afterCommandPrefix],
  ["env", afterEnvPrefix],
  ["exec", afterExecPrefix],
  [
    "nice",
    (tokens, start) => afterOptions(tokens, start, NICE_OPTIONS_WITH_VALUE),
  ],
  ["nohup", (tokens, start) => afterOptions(tokens, start, new Set())],
  [
    "stdbuf",
    (tokens, start) => afterOptions(tokens, start, STDBUF_OPTIONS_WITH_VALUE),
  ],
  ["sudo", afterSudoPrefix],
  [
    "time",
    (tokens, start) => afterOptions(tokens, start, TIME_OPTIONS_WITH_VALUE),
  ],
  ["timeout", afterTimeoutPrefix],
]);

export function invokedExecutable(tokens) {
  let index = skipAssignments(tokens, 0);
  while (index < tokens.length) {
    if (index < 0) {
      return index;
    }
    const executable = tokens[index]?.replace(BASENAME, "");
    const unwrap = PREFIX_UNWRAPPERS.get(executable);
    if (unwrap === undefined) {
      return index;
    }
    index = unwrap(tokens, index + 1);
  }
  return -1;
}
