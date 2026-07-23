import {
  Container,
  Editor,
  type EditorTheme,
  isKeyRelease,
  isKeyRepeat,
  Key,
  Markdown,
  type MarkdownTheme,
  matchesKey,
  ProcessTerminal,
  Spacer,
  Text,
  TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { AgentTurn, ModelUsage } from "@minpeter/pss-runtime";
import { agentEventStreamParts } from "./agent-event-stream";
import { createAliasAwareAutocompleteProvider } from "./autocomplete";
import {
  isCommand,
  parseCommand,
  type TuiCommand,
  type TuiCommandAction,
  type TuiCommandResult,
} from "./command";
import { buildTuiCommandSet } from "./command-set";
import { createSpinnerTicker, type SpinnerTicker } from "./pending-spinner";
import { createSpinnerOrchestrator } from "./spinner-orchestrator";
import {
  addChatComponent,
  createInfoMessage,
  IGNORE_PART_TYPES,
  isVisibleStreamPart,
  type PiTuiRenderFlags,
  type PiTuiStreamState,
  STREAM_HANDLERS,
  type ToolInputRenderState,
  type TuiStreamPart,
} from "./stream-handlers";
import { AssistantStreamView } from "./stream-views";
import { BaseToolCallView, type ToolRendererMap } from "./tool-call-view";

const ANSI_RESET = "\x1b[0m";
const ANSI_BLACK = "\x1b[30m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_DIM = "\x1b[2m";
const ANSI_BG_SOFT_LIGHT = "\x1b[48;5;249m";
const ANSI_BG_GRAY = "\x1b[100m";
const ANSI_CYAN = "\x1b[36m";
const ANSI_BRIGHT_CYAN = "\x1b[96m";
const ANSI_GRAY = "\x1b[90m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_RED = "\x1b[31m";
const CTRL_C_ETX = "\u0003";
const CTRL_C_EXIT_WINDOW_MS = 500;

const style = (prefix: string, text: string): string =>
  `${prefix}${text}${ANSI_RESET}`;

const truncatePlainToWidth = (text: string, maxWidth: number): string => {
  if (maxWidth <= 0) {
    return "";
  }

  if (visibleWidth(text) <= maxWidth) {
    return text;
  }

  if (maxWidth === 1) {
    return "…";
  }

  let result = "";
  for (const char of text) {
    const candidate = `${result}${char}`;
    if (visibleWidth(candidate) >= maxWidth) {
      break;
    }
    result = candidate;
  }

  return `${result}…`;
};

interface FooterStatusEntry {
  level?: "error" | "info" | "warning";
  message: string;
  state: "ready" | "running";
}

class FooterStatusBar extends Text {
  private readonly ticker: SpinnerTicker;
  private currentFrame = "";
  private entries: FooterStatusEntry[] = [];
  private foregroundMessage: string | null = null;
  private rightText: string | undefined;
  private readonly tui: TUI;

  constructor(tui: TUI) {
    super("", 1, 0);
    this.tui = tui;
    this.ticker = createSpinnerTicker((frame) => {
      this.currentFrame = frame;
      this.invalidate();
      this.tui.requestRender();
    });
  }

  setEntries(entries: FooterStatusEntry[]): void {
    this.entries = [...entries];
    this.invalidate();
    this.tui.requestRender();
  }

  setForegroundMessage(message: string | null): void {
    this.foregroundMessage = message;
    this.invalidate();
    this.tui.requestRender();
  }

  getForegroundMessage(): string | null {
    return this.foregroundMessage;
  }

  setRightText(text: string | undefined): void {
    this.rightText = text?.trim() || undefined;
    this.invalidate();
    this.tui.requestRender();
  }

  stop(): void {
    this.ticker.stop();
  }

  private resolveLeadingEntry(): FooterStatusEntry | undefined {
    if (this.foregroundMessage !== null) {
      return { message: this.foregroundMessage, state: "running" };
    }
    return this.entries[0];
  }

  render(width: number): string[] {
    if (
      this.entries.length === 0 &&
      this.foregroundMessage === null &&
      !this.rightText
    ) {
      return [];
    }

    const contentWidth = Math.max(1, width - 2);
    const lines: string[] = [];
    const rightTextPlain = this.rightText ?? "";
    const rightTextStyled = rightTextPlain
      ? style(ANSI_DIM, rightTextPlain)
      : "";

    const renderLeftEntry = (
      entry: FooterStatusEntry,
      maxWidth: number
    ): { plain: string; styled: string } => {
      const prefix = entry.state === "running" ? this.currentFrame : "";
      const prefixStyle =
        entry.state === "running" ? style(ANSI_CYAN, prefix) : "";
      const messageStylePrefix = this.resolveEntryStylePrefix(entry.level);
      const reservedPrefixWidth = prefix ? visibleWidth(prefix) + 1 : 0;
      const maxMessageWidth = Math.max(0, maxWidth - reservedPrefixWidth);
      const message = truncatePlainToWidth(entry.message, maxMessageWidth);

      return {
        plain: prefix ? `${prefix}${message ? ` ${message}` : ""}` : message,
        styled: prefix
          ? `${prefixStyle}${message ? ` ${style(messageStylePrefix, message)}` : ""}`
          : style(messageStylePrefix, message),
      };
    };

    const leadingEntry = this.resolveLeadingEntry();
    if (leadingEntry || rightTextStyled) {
      const maxLeftWidth = rightTextPlain
        ? Math.max(0, contentWidth - visibleWidth(rightTextPlain) - 1)
        : contentWidth;
      const left = leadingEntry
        ? renderLeftEntry(leadingEntry, maxLeftWidth)
        : null;
      const leftWidth = left ? visibleWidth(left.plain) : 0;
      const gap = rightTextPlain
        ? Math.max(1, contentWidth - leftWidth - visibleWidth(rightTextPlain))
        : 0;
      const line = `${" ".repeat(1)}${left?.styled ?? ""}${" ".repeat(gap)}${rightTextStyled}`;
      lines.push(line + " ".repeat(Math.max(0, width - visibleWidth(line))));
    }

    const remainingEntries =
      this.foregroundMessage === null ? this.entries.slice(1) : this.entries;
    for (const entry of remainingEntries) {
      const left = renderLeftEntry(entry, contentWidth);
      const line = `${" ".repeat(1)}${left.styled}`;
      lines.push(line + " ".repeat(Math.max(0, width - visibleWidth(line))));
    }

    return lines;
  }

  private resolveEntryStylePrefix(
    level: "error" | "info" | "warning" | undefined
  ): string {
    if (level === "error") {
      return ANSI_RED;
    }
    if (level === "warning") {
      return ANSI_YELLOW;
    }
    return ANSI_DIM;
  }
}

const createDefaultMarkdownTheme = (): MarkdownTheme => ({
  heading: (text) => style(`${ANSI_BOLD}${ANSI_BRIGHT_CYAN}`, text),
  link: (text) => style(`${ANSI_BOLD}${ANSI_CYAN}`, text),
  linkUrl: (text) => style(ANSI_GRAY, text),
  code: (text) => style(ANSI_CYAN, text),
  codeBlock: (text) => style(ANSI_CYAN, text),
  codeBlockBorder: (text) => style(ANSI_GRAY, text),
  quote: (text) => style(ANSI_GRAY, text),
  quoteBorder: (text) => style(ANSI_GRAY, text),
  hr: (text) => style(ANSI_GRAY, text),
  listBullet: (text) => style(ANSI_CYAN, text),
  bold: (text) => style(ANSI_BOLD, text),
  italic: (text) => style(ANSI_DIM, text),
  strikethrough: (text) => style(ANSI_DIM, text),
  underline: (text) => style(ANSI_BOLD, text),
  codeBlockIndent: "  ",
});

const createDefaultEditorTheme = (): EditorTheme => ({
  borderColor: (text: string) => style(ANSI_GRAY, text),
  selectList: {
    selectedPrefix: (text: string) => style(`${ANSI_BOLD}${ANSI_CYAN}`, text),
    selectedText: (text: string) => style(ANSI_CYAN, text),
    description: (text: string) => style(ANSI_GRAY, text),
    scrollInfo: (text: string) => style(ANSI_DIM, text),
    noMatch: (text: string) => style(ANSI_DIM, text),
  },
});

const addUserMessage = (
  chatContainer: Container,
  markdownTheme: MarkdownTheme,
  message: string
): void => {
  addChatComponent(
    chatContainer,
    new Markdown(message, 1, 1, markdownTheme, {
      bgColor: (text: string) =>
        style(`${ANSI_BG_SOFT_LIGHT}${ANSI_BLACK}`, text),
    })
  );
};

const addTranslatedMessage = (
  chatContainer: Container,
  markdownTheme: MarkdownTheme,
  message: string
): void => {
  chatContainer.addChild(new Spacer(1));
  chatContainer.addChild(
    new Markdown(message, 1, 1, markdownTheme, {
      bgColor: (text: string) => style(ANSI_BG_GRAY, text),
    })
  );
};

const addSystemMessage = (chatContainer: Container, message: string): void => {
  const cleaned = message.trimEnd();
  if (cleaned.length === 0) {
    return;
  }

  addChatComponent(chatContainer, new Text(style(ANSI_GRAY, cleaned), 1, 0));
};

const addNewSessionMessage = (chatContainer: Container): void => {
  addChatComponent(
    chatContainer,
    new Text(style(ANSI_BRIGHT_CYAN, "✓ New session started"), 1, 0)
  );
};

interface StreamViewFactories {
  activeToolInputs: Map<string, ToolInputRenderState>;
  ensureAssistantView: () => AssistantStreamView;
  ensureToolView: (toolCallId: string, toolName: string) => BaseToolCallView;
  pendingToolCallIds: Set<string>;
  resetAssistantView: (suppressLeadingSpacer?: boolean) => void;
  streamedToolCallIds: Set<string>;
  toolViews: Map<string, BaseToolCallView>;
}

const createStreamViewFactories = (options: {
  chatContainer: Container;
  flags: PiTuiRenderFlags;
  markdownTheme: MarkdownTheme;
  requestRender: () => void;
  toolRenderers?: ToolRendererMap;
}): StreamViewFactories => {
  const activeToolInputs = new Map<string, ToolInputRenderState>();
  const streamedToolCallIds = new Set<string>();
  const pendingToolCallIds = new Set<string>();
  const toolViews = new Map<string, BaseToolCallView>();
  let assistantView: AssistantStreamView | null = null;
  let suppressAssistantLeadingSpacer = false;

  const resetAssistantView = (suppressLeadingSpacer = false): void => {
    if (suppressLeadingSpacer) {
      suppressAssistantLeadingSpacer = true;
    }
    assistantView = null;
  };

  const ensureAssistantView = (): AssistantStreamView => {
    if (!assistantView) {
      assistantView = new AssistantStreamView(options.markdownTheme);
      addChatComponent(options.chatContainer, assistantView, {
        addLeadingSpacer: !suppressAssistantLeadingSpacer,
      });
      suppressAssistantLeadingSpacer = false;
    }

    return assistantView;
  };

  const ensureToolView = (
    toolCallId: string,
    toolName: string
  ): BaseToolCallView => {
    const existing = toolViews.get(toolCallId);
    if (existing) {
      existing.setToolName(toolName);
      return existing;
    }

    const view = new BaseToolCallView(
      toolCallId,
      toolName,
      options.markdownTheme,
      options.requestRender,
      options.flags.showRawToolIo,
      options.toolRenderers
    );
    toolViews.set(toolCallId, view);
    addChatComponent(options.chatContainer, view);
    return view;
  };

  return {
    activeToolInputs,
    streamedToolCallIds,
    pendingToolCallIds,
    toolViews,
    resetAssistantView,
    ensureAssistantView,
    ensureToolView,
  };
};

interface StreamPartTracker {
  finishReason: string | undefined;
  firstVisiblePartSeen: boolean;
}

const dispatchStreamPart = async (
  part: TuiStreamPart,
  context: {
    chatContainer: Container;
    flags: PiTuiRenderFlags;
    onFirstVisiblePart?: () => void;
    state: PiTuiStreamState;
    tracker: StreamPartTracker;
  }
): Promise<void> => {
  const { chatContainer, flags, onFirstVisiblePart, state, tracker } = context;

  if (part.type === "finish") {
    tracker.finishReason =
      typeof part.finishReason === "string" ? part.finishReason : undefined;
  }

  if (part.type === "error") {
    addSystemMessage(
      chatContainer,
      `Error: ${typeof part.error === "string" ? part.error : String(part.error)}`
    );
    return;
  }

  if (!tracker.firstVisiblePartSeen && isVisibleStreamPart(part, flags)) {
    tracker.firstVisiblePartSeen = true;
    onFirstVisiblePart?.();
  }

  const handler = STREAM_HANDLERS[part.type];
  if (handler) {
    await handler(part, state);
  } else if (!IGNORE_PART_TYPES.has(part.type)) {
    state.resetAssistantView();
    addChatComponent(
      state.chatContainer,
      createInfoMessage("[unknown part]", part)
    );
  }
};

export type PreprocessResult =
  | {
      success: true;
      message: string;
      translatedDisplay?: string;
    }
  | {
      success: false;
      error: string;
    };

export interface PreprocessHooks {
  clearStatus: () => void;
  showStatus: (text: string) => void;
}

export interface CommandPreprocessHooks {
  addInputListener: (
    listener: (data: string) => { consume: boolean; data?: string } | undefined
  ) => () => void;
  clearStatus: () => void;
  editorTheme: EditorTheme;
  handleCtrlCPress: () => void;
  isCtrlCInput: (data: string) => boolean;
  overlayContainer: Container;
  showMessage: (message: string) => void;
  tui: TUI;
  updateHeader: () => void;
}

/**
 * The slice of a pss-runtime `ThreadHandle` the interactive session drives.
 * `send` starts a turn and `interrupt` cancels the active one.
 */
export interface TuiThread {
  interrupt(): void;
  send(input: string): Promise<AgentTurn>;
}

export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AgentTUIConfig {
  commands?: TuiCommand[];
  footer?: { text?: string };
  header?: { title: string; subtitle?: string };
  onCommandAction?: (action: TuiCommandAction) => void | Promise<void>;
  onModelUsage?: (usage: ModelUsage) => void;
  onSetup?: () => void | Promise<void>;
  onStreamStart?: () => void | Promise<void>;
  onTurnComplete?: (
    usage: TurnUsage | undefined,
    finishReason?: string
  ) => Promise<void> | void;
  preprocessCommand?: (
    commandInput: string,
    hooks: CommandPreprocessHooks
  ) => Promise<string | null>;
  preprocessUserInput?: (
    input: string,
    hooks: PreprocessHooks
  ) => Promise<PreprocessResult | undefined>;
  setupMessages?: string[];
  showRawToolIo?: boolean;
  theme?: { markdownTheme?: MarkdownTheme; editorTheme?: EditorTheme };
  thread: TuiThread;
  toolRenderers?: ToolRendererMap;
}

export async function createAgentTUI(config: AgentTUIConfig): Promise<void> {
  const markdownTheme =
    config.theme?.markdownTheme ?? createDefaultMarkdownTheme();
  const editorTheme = config.theme?.editorTheme ?? createDefaultEditorTheme();
  const { commands, commandLookup, commandAliasLookup } = buildTuiCommandSet(
    config.commands
  );

  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);
  tui.setClearOnShrink(false);

  const headerContainer = new Container();
  const chatContainer = new Container();
  const overlayContainer = new Container();
  const editorContainer = new Container();
  const footerContainer = new Container();
  const footerStatusBar = new FooterStatusBar(tui);

  const title = new Text("", 1, 0);
  const help = new Text(
    style(
      ANSI_DIM,
      "Enter to submit, Shift+Enter for newline, /help for commands, Esc to interrupt, Ctrl+C to clear, Ctrl+C twice to exit"
    ),
    1,
    0
  );

  const updateHeader = (): void => {
    const headerTitle = config.header?.title ?? "Agent TUI";
    const subtitle = config.header?.subtitle;
    const footer = config.footer?.text?.trim();
    title.setText(
      subtitle
        ? `${style(`${ANSI_BOLD}${ANSI_BRIGHT_CYAN}`, headerTitle)}\n${style(ANSI_DIM, subtitle)}`
        : style(`${ANSI_BOLD}${ANSI_BRIGHT_CYAN}`, headerTitle)
    );
    footerStatusBar.setRightText(footer);
    tui.requestRender();
  };

  headerContainer.addChild(new Spacer(1));
  headerContainer.addChild(title);
  headerContainer.addChild(help);

  const editor = new Editor(tui, editorTheme, {
    paddingX: 1,
    autocompleteMaxVisible: 8,
  });
  editor.setAutocompleteProvider(
    createAliasAwareAutocompleteProvider({
      commands,
      basePath: process.cwd(),
    })
  );
  editorContainer.addChild(editor);
  footerContainer.addChild(footerStatusBar);

  tui.addChild(headerContainer);
  tui.addChild(chatContainer);
  tui.addChild(overlayContainer);
  tui.addChild(editorContainer);
  tui.addChild(footerContainer);
  tui.setFocus(editor);

  let shouldExit = false;
  let activeTurnInterrupted = false;
  let runActive = false;
  let inputResolver: null | ((value: string | null) => void) = null;
  let lastCtrlCPressAt = 0;
  let foregroundStatusMessage: string | null = null;
  let commandInputListenerActive = false;

  const clearStatus = (): void => {
    foregroundStatusMessage = null;
    footerStatusBar.setForegroundMessage(null);
  };

  const showLoader = (message: string): void => {
    foregroundStatusMessage = message;
    footerStatusBar.setForegroundMessage(message);
  };

  const clearPromptInput = (): void => {
    editor.setText("");
    tui.setFocus(editor);
    tui.requestRender();
  };

  const cancelActiveTurn = (): boolean => {
    if (!runActive) {
      return false;
    }

    activeTurnInterrupted = true;
    config.thread.interrupt();
    return true;
  };

  const requestExit = (): void => {
    shouldExit = true;
    cancelActiveTurn();
    clearStatus();
    if (inputResolver) {
      const resolve = inputResolver;
      inputResolver = null;
      resolve(null);
    }
  };

  const isCtrlCInput = (data: string): boolean => {
    if (isKeyRelease(data) || isKeyRepeat(data)) {
      return false;
    }

    return data === CTRL_C_ETX || matchesKey(data, Key.ctrl("c"));
  };

  const isEscapeInput = (data: string): boolean => {
    if (isKeyRelease(data) || isKeyRepeat(data)) {
      return false;
    }

    return matchesKey(data, Key.escape);
  };

  const handleCtrlCPress = (): void => {
    const now = Date.now();
    if (now - lastCtrlCPressAt < CTRL_C_EXIT_WINDOW_MS) {
      requestExit();
      return;
    }

    clearPromptInput();
    lastCtrlCPressAt = now;
  };

  const onTerminalResize = (): void => {
    tui.requestRender(true);
  };

  const removeInputListener = tui.addInputListener((data) => {
    if (isCtrlCInput(data) && !commandInputListenerActive) {
      handleCtrlCPress();
      return { consume: true };
    }
    if (isEscapeInput(data) && !commandInputListenerActive && runActive) {
      cancelActiveTurn();
      return { consume: true };
    }
    return;
  });

  const onSigInt = (): void => {
    handleCtrlCPress();
  };

  process.on("SIGINT", onSigInt);
  process.stdout.on("resize", onTerminalResize);

  editor.onSubmit = (text: string) => {
    if (!inputResolver) {
      return;
    }

    const trimmed = text.trim();
    if (trimmed.length > 0) {
      editor.addToHistory(trimmed);
    }

    const resolve = inputResolver;
    inputResolver = null;
    resolve(text);
  };

  const waitForInput = (): Promise<string | null> =>
    new Promise<string | null>((resolve) => {
      inputResolver = (value: string | null) => resolve(value);
      tui.setFocus(editor);
      tui.requestRender();
    });

  const addInterruptedMessage = (): void => {
    addChatComponent(
      chatContainer,
      new Text(
        style(
          ANSI_RED,
          "■ interrupted - tell the model what to do differently."
        ),
        1,
        0
      )
    );
    tui.requestRender();
  };

  const addAbnormalFinishReasonMessage = (finishReason: string): void => {
    if (finishReason === "stop") {
      return;
    }

    addChatComponent(
      chatContainer,
      new Text(
        style(
          ANSI_RED,
          `■ response ended abnormally (finish reason: ${finishReason})`
        ),
        1,
        0
      )
    );
    tui.requestRender();
  };

  const renderAgentStream = async (
    stream: AsyncIterable<TuiStreamPart>,
    flags: PiTuiRenderFlags,
    onFirstVisiblePart?: () => void,
    loaderMessage?: string
  ): Promise<{ finishReason: string | undefined }> => {
    const {
      activeToolInputs,
      streamedToolCallIds,
      pendingToolCallIds,
      toolViews,
      resetAssistantView,
      ensureAssistantView,
      ensureToolView,
    } = createStreamViewFactories({
      chatContainer,
      flags,
      markdownTheme,
      requestRender: () => tui.requestRender(),
      toolRenderers: config.toolRenderers,
    });
    const tracker: StreamPartTracker = {
      finishReason: undefined,
      firstVisiblePartSeen: false,
    };

    const baseLoaderMessage = loaderMessage ?? foregroundStatusMessage;
    const orchestrator = createSpinnerOrchestrator(
      {
        clearStatus,
        hasSpinner: () => foregroundStatusMessage !== null,
        setMessage: (message) => {
          foregroundStatusMessage = message;
          footerStatusBar.setForegroundMessage(message);
        },
        showLoader,
      },
      baseLoaderMessage
    );

    const state: PiTuiStreamState = {
      flags,
      activeToolInputs,
      streamedToolCallIds,
      pendingToolCallIds,
      resetAssistantView,
      ensureAssistantView,
      ensureToolView,
      getToolView: (toolCallId: string) => toolViews.get(toolCallId),
      chatContainer,
      onReasoningStart: orchestrator.onReasoningStart,
      onReasoningEnd: orchestrator.onReasoningEnd,
      onToolPendingStart: orchestrator.onToolPendingStart,
      onToolPendingEnd: orchestrator.onToolPendingEnd,
    };

    try {
      for await (const part of stream) {
        await dispatchStreamPart(part, {
          chatContainer,
          flags,
          onFirstVisiblePart,
          state,
          tracker,
        });
        tui.requestRender();
      }
    } finally {
      for (const view of toolViews.values()) {
        view.dispose();
      }
    }

    return { finishReason: tracker.finishReason };
  };

  const createStreamingLoaderClearer = (): (() => void) => {
    let hasClearedStreamingLoader = false;

    return () => {
      if (hasClearedStreamingLoader) {
        return;
      }
      hasClearedStreamingLoader = true;
      clearStatus();
    };
  };

  const accumulateUsage = (
    total: { inputTokens: number; outputTokens: number; totalTokens: number },
    usage: ModelUsage
  ): void => {
    total.inputTokens += usage.inputTokens ?? 0;
    total.outputTokens += usage.outputTokens ?? 0;
    total.totalTokens +=
      usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  };

  const runSingleTurn = async (run: AgentTurn): Promise<void> => {
    runActive = true;
    activeTurnInterrupted = false;

    const turnUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    let sawModelUsage = false;

    try {
      showLoader("Working...");
      try {
        await config.onStreamStart?.();
      } catch (hookError) {
        console.error("[tui] onStreamStart threw; continuing turn:", hookError);
      }

      const clearStreamingLoader = createStreamingLoaderClearer();

      const { finishReason } = await renderAgentStream(
        agentEventStreamParts(run.events(), {
          onModelUsage: (usage) => {
            sawModelUsage = true;
            accumulateUsage(turnUsage, usage);
            config.onModelUsage?.(usage);
            updateHeader();
          },
        }),
        {
          showReasoning: true,
          showSteps: false,
          showFinishReason: false,
          showRawToolIo: config.showRawToolIo ?? false,
          showToolResults: true,
          showSources: false,
          showFiles: false,
        },
        clearStreamingLoader,
        "Working..."
      );

      clearStreamingLoader();

      if (activeTurnInterrupted) {
        addInterruptedMessage();
        return;
      }

      Promise.resolve(
        config.onTurnComplete?.(
          sawModelUsage ? { ...turnUsage } : undefined,
          finishReason
        )
      ).catch((error) => {
        console.error("onTurnComplete callback failed in TUI:", error);
      });

      if (finishReason !== undefined) {
        addAbnormalFinishReasonMessage(finishReason);
      }
    } finally {
      runActive = false;
      activeTurnInterrupted = false;
      clearStatus();
    }
  };

  const executeLocalCommand = async (
    input: string
  ): Promise<TuiCommandResult | null> => {
    const parsed = parseCommand(input);
    if (!parsed) {
      return null;
    }

    const normalizedName = parsed.name.toLowerCase();
    const resolvedName =
      commandAliasLookup.get(normalizedName) ?? normalizedName;
    const command = commandLookup.get(resolvedName);
    if (!command) {
      return null;
    }

    return await command.execute({ args: parsed.args });
  };

  const preprocessCommandInput = async (
    input: string
  ): Promise<string | null> => {
    if (!config.preprocessCommand) {
      return input;
    }

    return await config.preprocessCommand(input, {
      addInputListener: (listener) => {
        commandInputListenerActive = true;
        const remove = tui.addInputListener(listener);
        return () => {
          remove();
          commandInputListenerActive = false;
        };
      },
      clearStatus,
      tui,
      overlayContainer,
      editorTheme,
      isCtrlCInput,
      handleCtrlCPress,
      showMessage: (message: string) =>
        addSystemMessage(chatContainer, message),
      updateHeader,
    });
  };

  const handleNewSessionAction = async (
    commandResult: TuiCommandResult
  ): Promise<void> => {
    if (!commandResult.action) {
      return;
    }

    clearStatus();
    chatContainer.clear();
    addNewSessionMessage(chatContainer);
    await config.onCommandAction?.(commandResult.action);
    updateHeader();

    if (commandResult.message) {
      addSystemMessage(chatContainer, commandResult.message);
    }
    tui.requestRender();
  };

  const handleCommandResult = async (
    commandResult: TuiCommandResult | null
  ): Promise<void> => {
    if (!(commandResult?.success && commandResult.action)) {
      if (commandResult?.message) {
        addSystemMessage(chatContainer, commandResult.message);
      } else if (commandResult === null) {
        addSystemMessage(chatContainer, "Unknown command. Try /help");
      }
      tui.requestRender();
      return;
    }

    if (commandResult.action.type === "new-session") {
      await handleNewSessionAction(commandResult);
      return;
    }

    if (commandResult.message) {
      addSystemMessage(chatContainer, commandResult.message);
    }
    tui.requestRender();
  };

  const processCommandInput = async (trimmed: string): Promise<boolean> => {
    const commandInput = await preprocessCommandInput(trimmed);
    if (commandInput === null) {
      tui.requestRender();
      return true;
    }

    const commandResult = await executeLocalCommand(commandInput);
    await handleCommandResult(commandResult);
    return true;
  };

  const processUserInputMessage = async (trimmed: string): Promise<void> => {
    let contentForModel = trimmed;

    if (config.preprocessUserInput) {
      addUserMessage(chatContainer, markdownTheme, trimmed);
      tui.requestRender();

      const result = await config.preprocessUserInput(trimmed, {
        showStatus: (text: string) => showLoader(text),
        clearStatus: () => clearStatus(),
      });

      if (result) {
        if (result.success) {
          contentForModel = result.message;

          if (result.translatedDisplay) {
            addTranslatedMessage(
              chatContainer,
              markdownTheme,
              result.translatedDisplay
            );
          }
        } else {
          addSystemMessage(chatContainer, result.error);
        }
      }
    } else {
      addUserMessage(chatContainer, markdownTheme, trimmed);
    }

    tui.requestRender();
    showLoader("Processing...");
    const run = await config.thread.send(contentForModel);
    await runSingleTurn(run);
  };

  const processInput = async (input: string): Promise<boolean> => {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      addSystemMessage(chatContainer, "메시지를 입력해주세요");
      tui.requestRender();
      return true;
    }

    try {
      editor.disableSubmit = true;
      editor.setText("");
      tui.requestRender();

      if (isCommand(trimmed)) {
        return await processCommandInput(trimmed);
      }

      await processUserInputMessage(trimmed);
      return true;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      addSystemMessage(chatContainer, `Error: ${errorMessage}`);
      tui.requestRender();
      return true;
    } finally {
      editor.disableSubmit = false;
      tui.setFocus(editor);
      tui.requestRender();
    }
  };

  updateHeader();
  tui.start();

  try {
    for (const message of config.setupMessages ?? []) {
      addSystemMessage(chatContainer, message);
    }
    await config.onSetup?.();
    updateHeader();

    while (!shouldExit) {
      const input = await waitForInput();
      if (input === null) {
        break;
      }

      const shouldContinue = await processInput(input);
      if (!shouldContinue) {
        break;
      }
    }
  } finally {
    clearStatus();
    footerStatusBar.stop();
    const pendingResolver: unknown = inputResolver;
    inputResolver = null;
    if (typeof pendingResolver === "function") {
      pendingResolver(null);
    }

    removeInputListener();
    process.stdout.off("resize", onTerminalResize);
    process.off("SIGINT", onSigInt);

    try {
      await terminal.drainInput();
    } finally {
      tui.stop();
    }
  }
}
