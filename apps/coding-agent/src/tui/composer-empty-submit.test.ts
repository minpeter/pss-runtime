import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import {
  type AutocompleteProvider,
  CombinedAutocompleteProvider,
  ProcessTerminal,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentTUI } from "./agent";
import { createAliasAwareAutocompleteProvider } from "./autocomplete";
import { ComposerEditor } from "./composer-editor";
import { TuiSessionMachine } from "./session-state";

const theme = {
  borderColor: (s: string) => s,
  selectList: {
    selectedText: (s: string) => s,
    selectedPrefix: (s: string) => s,
    description: (s: string) => s,
    scrollInfo: (s: string) => s,
    noMatch: (s: string) => s,
  },
};
const edits = [
  { name: "last backspace", keys: ["\x7f", "\x7f"] },
  { name: "forward delete", keys: ["\x01", "\x1b[3~", "\x1b[3~"] },
  { name: "Ctrl+K", keys: ["\x01", "\x0b"] },
  { name: "Ctrl+W", keys: ["\x17", "\x17"] },
  { name: "Alt+D", keys: ["\x01", "\x1bd", "\x1bd"] },
  { name: "undo", keys: ["\x1f"] },
  { name: "Ctrl+U", keys: ["\x15"] },
  { name: "Ctrl+U leaving whitespace", suffix: "  ", keys: ["\x15"] },
];
// Observe the dependency's serialized completion boundary without timing delays.
const requestTask = "autocompleteRequestTask";
function completionTask(editor: ComposerEditor): Promise<void> {
  const task: unknown = editor[requestTask];
  if (!(task instanceof Promise)) {
    throw new Error("pi-tui serialized autocomplete task is missing");
  }
  return task;
}
function gate<T = void>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Missing editor event")),
          2000
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function fixture(provider: AutocompleteProvider) {
  const screen = new TuiMainScreen(new ProcessTerminal());
  const editor = new ComposerEditor(screen, theme);
  editor.setAutocompleteProvider(provider);
  const submitted = vi.fn();
  editor.onSubmit = submitted;
  const shown = gate();
  vi.spyOn(screen, "requestRender").mockImplementation(() => {
    if (editor.isShowingAutocomplete()) {
      shown.resolve();
    }
  });
  return { editor, submitted, shown: bounded(shown.promise) };
}
function slashProvider() {
  return createAliasAwareAutocompleteProvider({
    commands: [{ name: "new", description: "New session", execute: vi.fn() }],
  });
}
afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "routes cleared input through normal TUI continuation eligibility=%s",
  async (eligible) => {
    const idle = () => {
      const ready = gate();
      const original = TuiSessionMachine.prototype.awaitInput;
      const spy = vi
        .spyOn(TuiSessionMachine.prototype, "awaitInput")
        .mockImplementation(function (this: TuiSessionMachine, resolve) {
          original.call(this, resolve);
          spy.mockRestore();
          ready.resolve();
        });
      return bounded(ready.promise);
    };
    let input = (_data: string): void => undefined;
    vi.spyOn(ProcessTerminal.prototype, "start").mockImplementation(
      (onInput) => {
        input = onInput;
      }
    );
    vi.spyOn(ProcessTerminal.prototype, "stop").mockImplementation(
      () => undefined
    );
    vi.spyOn(ProcessTerminal.prototype, "write").mockImplementation(
      () => undefined
    );
    const shown = gate();
    const render = TuiMainScreen.prototype.requestRender;
    vi.spyOn(TuiMainScreen.prototype, "requestRender").mockImplementation(
      function (this: TuiMainScreen, force) {
        render.call(this, force);
        if (
          this.children
            .at(-1)
            ?.render(80)
            .some((row) => row.includes("new"))
        ) {
          shown.resolve();
        }
      }
    );
    const subscribed = vi.fn();
    const run = {
      events() {
        subscribed();
        return {
          [Symbol.asyncIterator]() {
            return this;
          },
          next: () =>
            Promise.resolve({ done: true as const, value: undefined }),
        };
      },
    };
    const send = vi.fn(async () => run);
    const steer = vi.fn(async () => run);
    const resume = vi.fn(async () => (eligible ? run : undefined));
    const execute = vi.fn(() => ({ success: true }));
    const ready = idle();
    const app = createAgentTUI({
      commands: [{ name: "new", description: "New session", execute }],
      thread: { send, steer, continue: resume, interrupt: () => undefined },
    });
    try {
      await ready;
      input("/");
      await bounded(shown.promise);
      const settled = idle();
      input("\x7f");
      input("\r");
      await settled;
      expect(send).not.toHaveBeenCalled();
      expect(steer).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(resume).toHaveBeenCalledOnce();
      expect(subscribed).toHaveBeenCalledTimes(eligible ? 1 : 0);
    } finally {
      process.emit("SIGINT", "SIGINT");
      process.emit("SIGINT", "SIGINT");
      await bounded(app);
    }
  }
);

describe("cleared editor completion ownership", () => {
  it.each(edits)(
    "submits blank immediately after $name",
    async ({ keys, suffix }) => {
      // Given the installed command provider has a highlighted /new completion.
      const { editor, submitted, shown } = fixture(slashProvider());
      if (suffix) {
        editor.setText(suffix);
        editor.handleInput("\x01");
      }
      editor.handleInput("/");
      await shown;
      // When a destructive edit clears the command and Enter follows synchronously.
      for (const key of keys) {
        editor.handleInput(key);
      }
      expect(editor.getText().trim()).toBe("");
      editor.handleInput("\r");
      // Then no stale command can escape through onSubmit.
      expect(submitted.mock.calls).toEqual([[""]]);
      expect(editor.isShowingAutocomplete()).toBe(false);
    }
  );

  describe.each(["before", "after"])("Enter %s pending response", (order) => {
    it.each(edits)(
      "revokes pending completion after $name",
      async ({ keys, suffix }) => {
        const provider = slashProvider();
        const entered = gate<AbortSignal | undefined>();
        const release = gate();
        const original = provider.getSuggestions.bind(provider);
        let requests = 0;
        vi.spyOn(provider, "getSuggestions").mockImplementation(
          async (...args) => {
            const result = await original(...args);
            if (++requests === 2) {
              entered.resolve(args[3]?.signal);
              await release.promise;
            }
            return result;
          }
        );
        const { editor, submitted, shown } = fixture(provider);
        try {
          if (suffix) {
            editor.setText(suffix);
            editor.handleInput("\x01");
          }
          editor.handleInput("/");
          await shown;
          editor.handleInput("n");
          const signal = await bounded(entered.promise);
          for (const key of keys) {
            editor.handleInput(key);
          }
          expect(editor.getText().trim()).toBe("");
          if (order === "before") {
            editor.handleInput("\r");
          }
          release.resolve();
          // Await pi-tui's actual serialized request, not a guessed microtask count.
          await bounded(completionTask(editor));
          if (order === "after") {
            editor.handleInput("\r");
          }
          expect(signal?.aborted).toBe(true);
          expect(submitted.mock.calls).toEqual([[""]]);
          expect(editor.isShowingAutocomplete()).toBe(false);
        } finally {
          release.resolve();
          editor.setAutocompleteProvider(provider);
          await bounded(completionTask(editor));
        }
      }
    );
  });

  it("accepts and submits an unchanged slash completion", async () => {
    const { editor, submitted, shown } = fixture(slashProvider());
    editor.handleInput("/");
    await shown;
    editor.handleInput("\r");
    expect(submitted.mock.calls).toEqual([["/new"]]);
  });

  it.each([false, true])(
    "accepts only current argument completion, cleared=%s",
    async (cleared) => {
      const { editor, submitted, shown } = fixture(
        new CombinedAutocompleteProvider(
          [
            {
              name: "model",
              getArgumentCompletions: () => [
                { value: "local", label: "local" },
              ],
            },
          ],
          process.cwd()
        )
      );
      editor.setText("/model ");
      editor.handleInput("l");
      await shown;
      if (cleared) {
        editor.handleInput("\x15");
        editor.handleInput("\r");
        expect(submitted.mock.calls).toEqual([[""]]);
        return;
      }
      editor.handleInput("\r");
      expect(submitted).not.toHaveBeenCalled();
      expect(editor.getText()).toBe("/model local");
      editor.handleInput("\r");
      expect(submitted.mock.calls).toEqual([["/model local"]]);
    }
  );

  it.each([false, true])(
    "preserves blank Tab file completion unless edited and cleared=%s",
    async (cleared) => {
      const directory = await mkdtemp(join(tmpdir(), "composer-empty-"));
      try {
        await Promise.all(
          ["alpha.txt", "beta.txt"].map((name) =>
            writeFile(join(directory, name), "")
          )
        );
        const { editor, submitted, shown } = fixture(
          new CombinedAutocompleteProvider([], directory)
        );
        editor.handleInput("\t");
        await shown;
        if (cleared) {
          editor.handleInput("a");
          editor.handleInput("\x15");
          editor.handleInput("\r");
          expect(submitted.mock.calls).toEqual([[""]]);
          return;
        }
        editor.handleInput("\r");
        expect(submitted).not.toHaveBeenCalled();
        expect(editor.getText().trim()).toBe("alpha.txt");
        editor.handleInput("\r");
        expect(submitted.mock.calls).toEqual([["alpha.txt"]]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
});
