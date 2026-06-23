import type { Attributes, SpanOptions, SpanStatus } from "@opentelemetry/api";
import type { AgentEvent } from "../thread/protocol/events";
import type { TraceAgentTurnSpan, TraceAgentTurnTracer } from "./index";

export interface RecordedSpanEvent {
  readonly attributes: Attributes | undefined;
  readonly name: string;
}

export class RecordingSpan implements TraceAgentTurnSpan {
  readonly events: RecordedSpanEvent[] = [];
  readonly exceptions: Error[] = [];
  readonly name: string;
  readonly spanAttributes: Attributes | undefined;
  ended = false;
  status: SpanStatus | undefined;

  constructor(name: string, attributes?: Attributes) {
    this.name = name;
    this.spanAttributes = attributes;
  }

  addEvent(name: string, attributes?: Attributes): this {
    this.events.push({ attributes, name });
    return this;
  }

  end(): void {
    this.ended = true;
  }

  recordException(exception: Error): void {
    this.exceptions.push(exception);
  }

  setStatus(status: SpanStatus): this {
    this.status = status;
    return this;
  }
}

export class RecordingTracer implements TraceAgentTurnTracer {
  readonly spans: RecordingSpan[] = [];

  startSpan(name: string, options?: SpanOptions): RecordingSpan {
    const span = new RecordingSpan(name, options?.attributes);
    this.spans.push(span);
    return span;
  }
}

export async function collectEvents(events: AsyncIterable<AgentEvent>) {
  const collected: AgentEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

export function eventTypes(span: RecordingSpan) {
  return span.events
    .filter((event) => event.name === "pss.runtime.event")
    .map((event) => event.attributes?.["pss.event.type"]);
}

export function spanNamed(tracer: RecordingTracer, name: string) {
  const span = tracer.spans.find((candidate) => candidate.name === name);
  if (!span) {
    throw new Error(`Missing span ${name}`);
  }
  return span;
}
