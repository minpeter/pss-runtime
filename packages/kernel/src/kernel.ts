import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
} from "quickjs-emscripten-core";
import wasmModule from "../node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm";

export class KernelExecutionError extends Error {
  readonly code: string;
  override readonly message: string;
  override readonly name = "KernelExecutionError";

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.message = message;
  }
}

type Helpers = Readonly<{
  stringify: QuickJSHandle;
  parse: QuickJSHandle;
  promise: QuickJSHandle;
  errorText: QuickJSHandle;
}>;

type Invoke = (
  name: string,
  args: unknown,
  signal: AbortSignal
) => Promise<unknown>;
interface Bridge {
  complete?: ((success: boolean, value: unknown) => void) | undefined;
  deferred?: QuickJSDeferredPromise | undefined;
}
interface Completion {
  bridge: Bridge;
  success: boolean;
  value: unknown;
}
interface Execution {
  abort: AbortController;
  acceptingCalls: boolean;
  bridges: Set<Bridge>;
  calls: number;
  checks: number;
  completions: Completion[];
  failure: KernelExecutionError | undefined;
  invoke: Invoke;
  jobs: number;
  notify: (() => void) | undefined;
}

const MAX_CHECKS = 10_000;
const MAX_JOBS = 10_000;
const MAX_CALLS = 64;
const TIMEOUT_MS = 10_000;
const MAX_JSON_BYTES = 64 * 1024;

function checkJsonSize(json: string): void {
  if (new TextEncoder().encode(json).byteLength > MAX_JSON_BYTES) {
    throw new KernelExecutionError(
      "JSON_SIZE_LIMIT",
      "Serialized JSON exceeds 64 KiB"
    );
  }
}

// Native promises retain only this small, detachable bridge after cancellation.
function observe(operation: Promise<unknown>, bridge: Bridge): void {
  operation.then(
    (value) => bridge.complete?.(true, value),
    (error: unknown) => bridge.complete?.(false, error)
  );
}

export class QuickJsKernel {
  private readonly runtime: QuickJSRuntime;
  private readonly context: QuickJSContext;
  private active: Execution | undefined;
  private retired = false;
  private disposed = false;
  private readonly handles: QuickJSHandle[] = [];
  private helpers: Helpers | undefined;

  private get initializedHelpers(): Helpers {
    if (!this.helpers) {
      throw new KernelExecutionError(
        "INTERNAL_ERROR",
        "Kernel helpers are not initialized"
      );
    }
    return this.helpers;
  }

  private constructor(runtime: QuickJSRuntime, context: QuickJSContext) {
    this.runtime = runtime;
    this.context = context;
  }

  static async create(): Promise<QuickJsKernel> {
    // No module instance or initialization promise is shared between requests/DOs.
    const module = await newQuickJSWASMModuleFromVariant(
      newVariant(RELEASE_SYNC, { wasmModule })
    );
    const runtime = module.newRuntime();
    runtime.setMemoryLimit(16 * 1024 * 1024);
    runtime.setMaxStackSize(256 * 1024);
    let kernel: QuickJsKernel | undefined;
    try {
      kernel = new QuickJsKernel(runtime, runtime.newContext());
      kernel.initialize();
      return kernel;
    } catch (error) {
      if (kernel) {
        kernel.dispose();
      } else {
        runtime.dispose();
      }
      throw error;
    }
  }

  private initialize(): void {
    const vm = this.context;
    const tools = vm.newObject();
    try {
      for (const [namespace, methods] of [
        ["catalog", ["search"]],
        ["pricing", ["quote"]],
        ["notes", ["save", "get"]],
      ] as const) {
        const group = vm.newObject();
        try {
          for (const method of methods) {
            const name = `${namespace}.${method}`;
            const fn = vm.newFunction(name, (args) =>
              this.callTool(name, args ?? vm.undefined)
            );
            try {
              vm.setProp(group, method, fn);
            } finally {
              fn.dispose();
            }
          }
          vm.setProp(tools, namespace, group);
        } finally {
          group.dispose();
        }
      }
      vm.defineProp(vm.global, "tools", {
        value: tools,
        enumerable: true,
        configurable: false,
      });
    } finally {
      tools.dispose();
    }

    const helpers = this.take(
      vm.evalCode(
        `(() => {
      const stringify = JSON.stringify;
      const parse = JSON.parse;
      const resolve = Promise.resolve.bind(Promise);
      const TypeError_ = TypeError;
      const String_ = String;
      Object.freeze(tools.catalog);
      Object.freeze(tools.pricing);
      Object.freeze(tools.notes);
      Object.freeze(tools);
      return {
        stringify(value) {
          return stringify(value === undefined ? null : value, (_key, item) => {
            if (typeof item === "bigint" || typeof item === "function" || typeof item === "symbol") {
              throw new TypeError_("Value is not JSON serializable");
            }
            return item;
          });
        },
        parse,
        promise: value => resolve(value),
        errorText: error => {
          try { return String_(error && error.message !== undefined ? error.message : error); }
          catch { return "Guest execution failed"; }
        }
      };
    })()`,
        "kernel-init.js",
        { type: "global" }
      )
    );
    try {
      this.helpers = {
        stringify: this.keep(vm.getProp(helpers, "stringify")),
        parse: this.keep(vm.getProp(helpers, "parse")),
        promise: this.keep(vm.getProp(helpers, "promise")),
        errorText: this.keep(vm.getProp(helpers, "errorText")),
      };
    } finally {
      helpers.dispose();
    }

    this.runtime.setInterruptHandler(() => {
      const execution = this.active;
      if (!execution) {
        return this.retired;
      }
      if (++execution.checks > MAX_CHECKS) {
        execution.failure ??= new KernelExecutionError(
          "INSTRUCTION_LIMIT",
          "Guest interrupt-check budget exceeded"
        );
      }
      return execution.failure !== undefined;
    });
  }

  private keep(handle: QuickJSHandle): QuickJSHandle {
    this.handles.push(handle);
    return handle;
  }

  private take(result: {
    value?: QuickJSHandle | undefined;
    error?: QuickJSHandle | undefined;
  }): QuickJSHandle {
    if (result.error) {
      let message = "Guest execution failed";
      try {
        if (this.helpers && !this.active?.failure) {
          const text = this.context.callFunction(
            this.helpers.errorText,
            this.context.undefined,
            result.error
          );
          try {
            if (!text.error) {
              message = this.context.getString(text.value);
            }
          } finally {
            text.dispose();
          }
        }
      } finally {
        result.error.dispose();
      }
      throw (
        this.active?.failure ?? new KernelExecutionError("GUEST_ERROR", message)
      );
    }
    if (!result.value) {
      throw new KernelExecutionError(
        "INTERNAL_ERROR",
        "QuickJS returned neither a value nor an error"
      );
    }
    return result.value;
  }

  private toJson(value: QuickJSHandle): unknown {
    const result = this.context.callFunction(
      this.initializedHelpers.stringify,
      this.context.undefined,
      value
    );
    try {
      if (result.error || this.context.typeof(result.value) !== "string") {
        throw (
          this.active?.failure ??
          new KernelExecutionError(
            "INVALID_JSON",
            "Value is not JSON serializable"
          )
        );
      }
      const json = this.context.getString(result.value);
      checkJsonSize(json);
      return JSON.parse(json);
    } finally {
      result.dispose();
    }
  }

  private callTool(name: string, args: QuickJSHandle): QuickJSHandle {
    const execution = this.active;
    if (!execution?.acceptingCalls) {
      throw new KernelExecutionError(
        "INTERNAL_ERROR",
        "No active tool execution"
      );
    }
    if (++execution.calls > MAX_CALLS) {
      execution.failure = new KernelExecutionError(
        "CALL_LIMIT",
        "Host tool call limit exceeded"
      );
      throw execution.failure;
    }
    const decoded = this.toJson(args);
    const deferred = this.context.newPromise();
    const bridge: Bridge = { deferred };
    bridge.complete = (success, value) => {
      execution.completions.push({ bridge, success, value });
      execution.notify?.();
    };
    execution.bridges.add(bridge);
    try {
      observe(
        Promise.resolve(
          execution.invoke(name, decoded, execution.abort.signal)
        ),
        bridge
      );
    } catch (error) {
      bridge.complete(false, error);
    }
    return deferred.handle;
  }

  private settle(execution: Execution, completion: Completion): void {
    const { bridge, success, value } = completion;
    const deferred = bridge.deferred;
    if (!deferred) {
      return;
    }
    let handle: QuickJSHandle | undefined;
    try {
      if (success) {
        let json: string | undefined;
        try {
          json = JSON.stringify(value === undefined ? null : value);
        } catch {
          throw new KernelExecutionError(
            "INVALID_JSON",
            "Host result is not JSON serializable"
          );
        }
        if (json === undefined) {
          throw new KernelExecutionError("INVALID_JSON", "Invalid host result");
        }
        checkJsonSize(json);
        const text = this.context.newString(json);
        try {
          handle = this.take(
            this.context.callFunction(
              this.initializedHelpers.parse,
              this.context.undefined,
              text
            )
          );
        } finally {
          text.dispose();
        }
        deferred.resolve(handle);
      } else {
        handle = this.context.newError(
          value instanceof Error ? value.message : "Host tool failed"
        );
        deferred.reject(handle);
      }
    } finally {
      handle?.dispose();
      deferred.dispose();
      bridge.deferred = undefined;
      bridge.complete = undefined;
      execution.bridges.delete(bridge);
    }
  }

  /** Global scripts preserve lexical bindings. Use an async IIFE, not top-level await. */
  async execute(code: string, invoke: Invoke): Promise<unknown> {
    if (this.disposed || this.retired) {
      throw new KernelExecutionError("RETIRED", "Kernel is retired");
    }
    if (this.active) {
      throw new KernelExecutionError(
        "BUSY",
        "Kernel executions must be serialized"
      );
    }
    const execution: Execution = {
      invoke,
      abort: new AbortController(),
      bridges: new Set(),
      completions: [],
      notify: undefined,
      failure: undefined,
      calls: 0,
      checks: 0,
      jobs: 0,
      acceptingCalls: true,
    };
    this.active = execution;
    let root: QuickJSHandle | undefined;
    const timeout = setTimeout(() => {
      execution.failure = new KernelExecutionError(
        "HUNG_PROMISE",
        "Execution deadline exceeded"
      );
      execution.notify?.();
    }, TIMEOUT_MS);
    try {
      const evaluated = this.take(
        this.context.evalCode(code, "eval.js", { type: "global" })
      );
      try {
        root = this.take(
          this.context.callFunction(
            this.initializedHelpers.promise,
            this.context.undefined,
            evaluated
          )
        );
      } finally {
        evaluated.dispose();
      }
      for (;;) {
        // Subscribe before inspecting state; only host settlement/timeout wakes this promise.
        const changed = new Promise<void>((resolve) => {
          execution.notify = resolve;
        });
        this.pumpJobs(execution);
        const result = this.inspectPromise(execution, root);
        if (result.done) {
          return result.value;
        }
        if (this.runtime.hasPendingJob()) {
          continue;
        }
        if (execution.bridges.size === 0) {
          throw new KernelExecutionError(
            "HUNG_PROMISE",
            "Pending promise has no jobs or host calls"
          );
        }
        if (execution.completions.length === 0) {
          await changed;
        }
      }
    } catch (error) {
      this.retired = true;
      throw error;
    } finally {
      clearTimeout(timeout);
      execution.acceptingCalls = false;
      this.retireBridges(execution);
      root?.dispose();
      this.active = undefined;
      if (this.disposed) {
        this.release();
      }
    }
  }

  private inspectPromise(
    execution: Execution,
    root: QuickJSHandle
  ): { done: true; value: unknown } | { done: false } {
    const state = this.context.getPromiseState(root);
    switch (state.type) {
      case "rejected":
        this.take({ error: state.error });
        return { done: false };
      case "fulfilled":
        try {
          if (!this.runtime.hasPendingJob() && execution.bridges.size === 0) {
            execution.acceptingCalls = false;
            return { done: true, value: this.toJson(state.value) };
          }
          return { done: false };
        } finally {
          state.value.dispose();
        }
      case "pending":
        return { done: false };
      default: {
        const unexpected: never = state;
        throw new KernelExecutionError(
          "INTERNAL_ERROR",
          `Unexpected promise state: ${unexpected}`
        );
      }
    }
  }

  private pumpJobs(execution: Execution): void {
    if (execution.failure) {
      throw execution.failure;
    }
    for (const completion of execution.completions.splice(0)) {
      this.settle(execution, completion);
    }
    if (execution.failure) {
      throw execution.failure;
    }
    if (this.runtime.hasPendingJob()) {
      const jobs = this.runtime.executePendingJobs(128);
      if (jobs.error) {
        this.take({ error: jobs.error });
      } else {
        execution.jobs += jobs.value;
      }
      if (execution.jobs > MAX_JOBS) {
        throw new KernelExecutionError("JOB_LIMIT", "Guest job limit exceeded");
      }
    }
    if (execution.failure) {
      throw execution.failure;
    }
  }

  private retireBridges(execution: Execution): void {
    for (const bridge of execution.bridges) {
      bridge.complete = undefined;
      bridge.deferred?.dispose();
      bridge.deferred = undefined;
    }
    execution.bridges.clear();
    execution.completions.length = 0;
    execution.notify?.();
    execution.notify = undefined;
    execution.abort.abort();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.retired = true;
    if (this.active) {
      this.active.failure = new KernelExecutionError(
        "RETIRED",
        "Kernel was disposed"
      );
      this.retireBridges(this.active);
    } else {
      this.release();
    }
  }

  private release(): void {
    for (const handle of this.handles.splice(0)) {
      handle.dispose();
    }
    this.context.dispose();
    this.runtime.dispose();
  }
}
