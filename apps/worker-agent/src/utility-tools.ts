import { z } from "zod";

import type { WorkerAgentToolSet } from "./tools";

export const CALCULATE_TOOL_NAME = "calculate";
export const GET_CURRENT_TIME_TOOL_NAME = "get_current_time";

const CalculateInputSchema = z
  .object({
    expression: z
      .string()
      .min(1)
      .describe(
        "Arithmetic expression using numbers, + - * / % ^ ( ), and optional unary minus. Example: (12.5 + 3) * 2"
      ),
  })
  .strict();

const GetCurrentTimeInputSchema = z
  .object({
    timeZone: z
      .string()
      .min(1)
      .optional()
      .describe(
        "IANA time zone such as Asia/Seoul or America/New_York. Defaults to UTC."
      ),
  })
  .strict();

export interface CalculateToolResult {
  readonly expression: string;
  readonly result: number;
}

export interface GetCurrentTimeToolResult {
  readonly iso: string;
  readonly timeZone: string;
  readonly unixMs: number;
}

export class CalculateToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalculateToolError";
  }
}

export function createUtilityTools(): WorkerAgentToolSet {
  return {
    [CALCULATE_TOOL_NAME]: {
      description:
        "Evaluate a basic arithmetic expression / 계산 (add, subtract, multiply, divide, remainder, power). Use for math, percentages, unit arithmetic, or totals — not for weather, web, or chat replies.",
      execute: (input: unknown): Promise<CalculateToolResult> => {
        const parsed = CalculateInputSchema.parse(input);
        const expression = parsed.expression.trim();
        const result = evaluateArithmeticExpression(expression);
        return Promise.resolve({ expression, result });
      },
      inputSchema: CalculateInputSchema,
    },
    [GET_CURRENT_TIME_TOOL_NAME]: {
      description:
        "Get the current date and time / 지금 몇 시 / 시간 in ISO format for a time zone. Use for 'what time is it', today/now, schedules, or converting to a city time zone.",
      execute: (input: unknown): Promise<GetCurrentTimeToolResult> => {
        const parsed = GetCurrentTimeInputSchema.parse(input);
        const timeZone = parsed.timeZone?.trim() || "UTC";
        const now = new Date();
        let iso: string;
        try {
          iso = formatIsoInTimeZone(now, timeZone);
        } catch {
          throw new CalculateToolError(
            `Invalid time zone "${timeZone}". Use an IANA name like Asia/Seoul.`
          );
        }
        return Promise.resolve({
          iso,
          timeZone,
          unixMs: now.getTime(),
        });
      },
      inputSchema: GetCurrentTimeInputSchema,
    },
  };
}

/** Safe arithmetic evaluator — no identifiers, only numbers and operators. */
export function evaluateArithmeticExpression(expression: string): number {
  const tokens = tokenizeExpression(expression);
  if (tokens.length === 0) {
    throw new CalculateToolError("Expression is empty.");
  }
  const parser = new ExpressionParser(tokens);
  const value = parser.parseExpression();
  if (!parser.done()) {
    throw new CalculateToolError("Unexpected trailing tokens in expression.");
  }
  if (!Number.isFinite(value)) {
    throw new CalculateToolError(
      "Expression did not evaluate to a finite number."
    );
  }
  return value;
}

function formatIsoInTimeZone(date: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  const offset = (parts.timeZoneName ?? "GMT").replace("GMT", "UTC");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second} ${offset} (${timeZone})`;
}

type Token =
  | { readonly type: "number"; readonly value: number }
  | { readonly type: "op"; readonly value: string };

const NUMBER_PATTERN = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/u;
const WHITESPACE_PATTERN = /\s/u;

function tokenizeExpression(expression: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < expression.length) {
    const char = expression[index];
    if (char === undefined) {
      break;
    }
    if (WHITESPACE_PATTERN.test(char)) {
      index += 1;
      continue;
    }
    if ("+-*/%^()".includes(char)) {
      tokens.push({ type: "op", value: char });
      index += 1;
      continue;
    }
    const rest = expression.slice(index);
    const match = NUMBER_PATTERN.exec(rest);
    if (match) {
      tokens.push({ type: "number", value: Number(match[0]) });
      index += match[0].length;
      continue;
    }
    throw new CalculateToolError(
      `Invalid character in expression near "${expression.slice(index, index + 8)}".`
    );
  }
  return tokens;
}

class ExpressionParser {
  #index = 0;
  readonly #tokens: readonly Token[];

  constructor(tokens: readonly Token[]) {
    this.#tokens = tokens;
  }

  done(): boolean {
    return this.#index >= this.#tokens.length;
  }

  parseExpression(): number {
    return this.#parseAddSub();
  }

  #parseAddSub(): number {
    let left = this.#parseMulDiv();
    while (this.#matchOp("+") || this.#matchOp("-")) {
      const op = this.#previousOp();
      const right = this.#parseMulDiv();
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }

  #parseMulDiv(): number {
    let left = this.#parsePower();
    while (this.#matchOp("*") || this.#matchOp("/") || this.#matchOp("%")) {
      const op = this.#previousOp();
      const right = this.#parsePower();
      if (op === "*") {
        left *= right;
      } else if (op === "/") {
        left /= right;
      } else {
        left %= right;
      }
    }
    return left;
  }

  #parsePower(): number {
    const base = this.#parseUnary();
    if (this.#matchOp("^")) {
      const exp = this.#parsePower();
      return base ** exp;
    }
    return base;
  }

  #parseUnary(): number {
    if (this.#matchOp("+")) {
      return this.#parseUnary();
    }
    if (this.#matchOp("-")) {
      return -this.#parseUnary();
    }
    return this.#parsePrimary();
  }

  #parsePrimary(): number {
    const token = this.#tokens[this.#index];
    if (!token) {
      throw new CalculateToolError("Unexpected end of expression.");
    }
    if (token.type === "number") {
      this.#index += 1;
      return token.value;
    }
    if (token.type === "op" && token.value === "(") {
      this.#index += 1;
      const value = this.#parseAddSub();
      if (!this.#matchOp(")")) {
        throw new CalculateToolError("Missing closing parenthesis.");
      }
      return value;
    }
    throw new CalculateToolError("Expected a number or parenthesis.");
  }

  #matchOp(value: string): boolean {
    const token = this.#tokens[this.#index];
    if (token?.type === "op" && token.value === value) {
      this.#index += 1;
      return true;
    }
    return false;
  }

  #previousOp(): string {
    const token = this.#tokens[this.#index - 1];
    if (token?.type !== "op") {
      throw new CalculateToolError("Internal parser error.");
    }
    return token.value;
  }
}
