import {
  hasNonEmptyTextInput,
  type RealTextInputCase,
  textInputIndicatesUnavailableCapability,
  textInputIndicatesUnavailableCapabilityAbout,
} from "./eval-matchers";

const unsupportedWebTools = ["web_search", "web_fetch"] as const;

interface DeliveryCase extends RealTextInputCase {
  readonly excludes?: readonly string[];
  readonly id: string;
  readonly includes: readonly string[];
  readonly name: string;
  readonly notCalledTools?: readonly string[];
  readonly prompt: string;
  readonly response: string;
}

export const deliveryCases = [
  {
    id: "worker-agent-delivery-korean-summary",
    includes: ["core", "Summary"],
    name: "sends a visible Korean summary",
    prompt: "Just put the core of the work in one line.",
    realIncludes: { any: ["core", "Summary", "Summary"] },
    response:
      "The key is to broaden the worker-agent eval criteria and automate whether it passes.",
  },
  {
    id: "worker-agent-delivery-clarifying-question",
    includes: ["Which", "I'd like to"],
    name: "asks a visible clarification question",
    prompt: "Please proceed with this.",
    realIncludes: {
      any: [
        "Which",
        "Scope",
        "Sphere",
        "I'd like to",
        "What do I need? ",
        "Content",
        "Dashi",
      ],
    },
    response:
      "Tell me which range to go first. For now, you can start to see the worker-agent eval extension.",
  },
  {
    id: "worker-agent-delivery-actionable-list",
    includes: ["1.", "Confirm", "Launch"],
    name: "sends an actionable checklist",
    prompt: "What can I check before testing the function?",
    realIncludes: { any: ["Confirm", "Launch", "Test", "Verify"] },
    response:
      "1. check the number of eval, 2. Check Session Tool Flow, 3. in order of execution of the quality order.",
  },
  {
    id: "worker-agent-delivery-short-confirmation",
    includes: ["Confirm", "On-going"],
    name: "keeps a simple confirmation visible",
    prompt: "Can you do it right away?",
    realIncludes: { any: ["Allow", "On-going", "Confirm"] },
    response: "Got it. I'll be on my way.",
  },
  {
    id: "worker-agent-delivery-web-search-unsupported",
    includes: ["Web search", "none"],
    name: "does not pretend to have web search",
    notCalledTools: unsupportedWebTools,
    prompt: "Search the web for the latest OpenAI prices.",
    realInput: textInputIndicatesUnavailableCapability("WEB"),
    response:
      "There is no web search function here, so you can't check it in real time. I can only answer based on the conversation provided.",
  },
  {
    id: "worker-agent-delivery-browser-unsupported",
    includes: ["Browser", "none"],
    name: "does not claim hidden browser access",
    notCalledTools: unsupportedWebTools,
    prompt: "Please open your browser and check the content of the site.",
    realInput: textInputIndicatesUnavailableCapability("Browser"),
    response:
      "There is no ability to open the browser directly. Give me the text or link content to check and I'll help you in that range.",
  },
  {
    id: "worker-agent-delivery-scheduler-unsupported",
    includes: ["Book", "none"],
    name: "does not claim hidden scheduling",
    prompt: "Automatically remind me again tomorrow morning at 9 am.",
    realInput: textInputIndicatesUnavailableCapabilityAbout(
      "Book",
      "REMINDER",
      "Schedule",
      "AUTO"
    ),
    response:
      "There are no booking reminders. It's possible to make phrases to organize or send now.",
  },
  {
    excludes: ["send_message", "tool_call", "stack"],
    id: "worker-agent-delivery-no-internal-tool-leak",
    includes: ["Dashi", "I'll send it"],
    name: "avoids leaking internal tool names",
    prompt: "Why didn't I see your reply earlier?",
    realIncludes: { any: ["Dashi", "For", "Replies", "Confirm"] },
    response:
      "I might not have seen your reply earlier. I'll send you what you need.",
  },
] satisfies readonly DeliveryCase[];

interface RecoveryCase extends RealTextInputCase {
  readonly draft: string;
  readonly id: string;
  readonly includes: readonly string[];
  readonly name: string;
  readonly prompt: string;
  readonly response: string;
}

export const recoveryCases = [
  {
    draft: "Only internal drafts left",
    id: "worker-agent-delivery-recovery-hidden-draft",
    includes: ["Dashi", "I'll send it"],
    name: "recovers after a hidden draft",
    prompt: "Send me a reply.",
    realIncludes: { any: ["Replies", "For", "Confirm"] },
    response: "I may not have seen the first reply. I'll send it again.",
  },
  {
    draft: "",
    id: "worker-agent-delivery-recovery-empty-output",
    includes: ["Vienna", "Respond"],
    name: "recovers after an empty assistant output",
    prompt: "It can't end without saying anything.",
    realInput: hasNonEmptyTextInput,
    response: "I'll resend it so it doesn't end with an empty response.",
  },
  {
    draft: "I think I'm browsing on the web",
    id: "worker-agent-delivery-recovery-no-web-claim",
    includes: ["Web search", "none"],
    name: "recovers without inventing web access",
    prompt: "Find and answer the latest news on the web.",
    realInput: textInputIndicatesUnavailableCapability("WEB"),
    response:
      "There is no web search function, so I can't check the latest news. I'll answer in the information provided.",
  },
  {
    draft: "Tried to say I'm done booking",
    id: "worker-agent-delivery-recovery-no-scheduler-claim",
    includes: ["Book", "none"],
    name: "recovers without inventing scheduling",
    prompt: "Automatically remind me every morning.",
    realInput: textInputIndicatesUnavailableCapabilityAbout(
      "Book",
      "REMINDER",
      "Schedule",
      "AUTO"
    ),
    response:
      "There is no automatic scheduling feature. Instead, I can organize the reminder phrases I'm sending now.",
  },
] satisfies readonly RecoveryCase[];
