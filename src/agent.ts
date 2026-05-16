import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// Wraps the Claude Agent SDK to:
//   - run a prompt as part of a persistent session (resume token)
//   - bypass per-tool permission prompts (user said "let it do whatever
//     it wants" — Telegram allowlist is the security boundary)
//   - stream events out so the caller can pipe progress to Telegram
//
// One conversation per Telegram chat. The agent's working dir is set
// to WORKING_ROOT — typically the bot's `repos/` directory containing
// every project the agent might touch. The agent can cd between them
// via Bash freely.

export type AgentEvent =
  | { kind: "text"; text: string }
  | { kind: "tool_use"; name: string; input: unknown }
  | { kind: "tool_result"; isError: boolean; content: string }
  | { kind: "session"; sessionId: string }
  | { kind: "done"; sessionId: string; usage?: { input: number; output: number } }
  | { kind: "error"; message: string };

export type RunOptions = {
  prompt: string;
  workingRoot: string;
  resumeSessionId: string | null;
  model: string;
  // Optional. Extra text injected at the top of the system prompt for
  // this run — used to share memory + journal with the user's VS Code
  // Claude sessions so both have the same project context.
  sharedContext?: string;
};

// Pull out a printable string from a message content block.
function blockText(block: unknown): string {
  if (typeof block === "string") return block;
  if (block && typeof block === "object" && "text" in block && typeof (block as { text: unknown }).text === "string") {
    return (block as { text: string }).text;
  }
  return "";
}

export async function* runAgent(opts: RunOptions): AsyncGenerator<AgentEvent> {
  const sdkOptions: Options = {
    cwd: opts.workingRoot,
    // bypassPermissions = no per-tool approval prompts. Acceptable here
    // because the Telegram allowlist already gates who can drive the
    // agent, and the VPS is single-tenant (this user's projects only).
    permissionMode: "bypassPermissions",
    model: opts.model,
    // Load CLAUDE.md / settings files from the cwd. Without this the
    // SDK ignores them entirely and the agent has no idea what's in
    // the working dir — it'll reach for the GitHub CLI or web search
    // before considering `ls` + `cd`.
    settingSources: ["project"],
    // Plus a short directive in the system prompt so it ALWAYS knows
    // the layout even if CLAUDE.md fails to load for any reason.
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: [
        opts.sharedContext ?? "",
        "",
        "## Your environment",
        "You are TARS — a Claude agent running on a Linux VPS, driven by",
        "Telegram messages relayed from a single user. Your cwd is",
        "/srv/relay-bot/repos, which contains FIVE separate git repos as",
        "sibling subdirectories:",
        "  parts-inventory/             (server,     branch master, github.com/yaegerrrr/parts-inventory)",
        "  parts-inventory-web/         (web app,    branch main,   github.com/yaegerrrr/parts-inventory-web)",
        "  parts-inventory-mobile/      (mobile,     branch main,   github.com/yaegerrrr/parts-inventory-mobile)",
        "  parts-inventory-storefront/  (storefront, branch main,   github.com/yaegerrrr/parts-inventory-storefront)",
        "  relay-bot/                   (this bot,   branch main,   github.com/yaegerrrr/relay-bot)",
        "When the user references a repo by name (e.g. 'parts-inventory'),",
        "cd into that subdir before running git commands. There is NO umbrella",
        "repo at /srv/relay-bot/repos. The watcher Electron app lives at",
        "parts-inventory/watcher-app/. SSH key for github.com is configured —",
        "git pull/push work out of the box.",
        "",
        "## Journal protocol",
        "After completing any meaningful work (a fix, a deploy, a non-trivial",
        "investigation, a decision the user might forget), append one entry",
        "to /srv/relay-bot/shared/journal.md in this format:",
        "  ## YYYY-MM-DD HH:MM — TARS",
        "  <one short paragraph: what was asked, what you did, anything the",
        "  user's other Claude sessions should know>",
        "  (blank line)",
        "Use the Bash tool with: date -u +'%Y-%m-%d %H:%M' to get the timestamp.",
        "Append via: echo '...' >> /srv/relay-bot/shared/journal.md",
        "Don't journal every chat — only when something happened that would",
        "matter to a colleague catching up tomorrow. Skip greetings, single",
        "command lookups, simple status checks.",
      ].join("\n"),
    },
    ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {}),
  };

  let lastSessionId: string | null = opts.resumeSessionId;

  try {
    for await (const msg of query({ prompt: opts.prompt, options: sdkOptions }) as AsyncIterable<SDKMessage>) {
      const anyMsg = msg as unknown as Record<string, unknown>;

      // session_id surfaces on system/result messages. Track the latest
      // one we see so we can resume on the next user turn.
      if (typeof anyMsg.session_id === "string") {
        if (anyMsg.session_id !== lastSessionId) {
          lastSessionId = anyMsg.session_id;
          yield { kind: "session", sessionId: lastSessionId };
        }
      }

      const type = anyMsg.type as string | undefined;

      if (type === "assistant") {
        const message = anyMsg.message as { content?: unknown[] } | undefined;
        for (const block of message?.content ?? []) {
          const b = block as Record<string, unknown>;
          if (b.type === "text") {
            const text = blockText(b);
            if (text) yield { kind: "text", text };
          } else if (b.type === "tool_use") {
            yield { kind: "tool_use", name: String(b.name ?? "?"), input: b.input };
          }
        }
      } else if (type === "user") {
        // Tool results come back as user messages with tool_result blocks.
        const message = anyMsg.message as { content?: unknown[] } | undefined;
        for (const block of message?.content ?? []) {
          const b = block as Record<string, unknown>;
          if (b.type === "tool_result") {
            const content = Array.isArray(b.content)
              ? b.content.map(blockText).join("")
              : typeof b.content === "string"
                ? b.content
                : "";
            yield {
              kind: "tool_result",
              isError: Boolean(b.is_error),
              content,
            };
          }
        }
      } else if (type === "result") {
        const usage = anyMsg.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        yield {
          kind: "done",
          sessionId: lastSessionId ?? "",
          ...(usage
            ? { usage: { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0 } }
            : {}),
        };
      }
    }
  } catch (err) {
    yield {
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
