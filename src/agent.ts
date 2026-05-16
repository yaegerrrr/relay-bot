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
        "## Large file handling",
        "The Read tool caps at 25,000 tokens (~80KB of code) per call. Several",
        "files in these repos blow past that — known offenders include:",
        "  parts-inventory-web/src/pages/PartsPage.tsx          (~2000 lines)",
        "  parts-inventory-web/src/pages/EditPartPage.tsx       (~2500 lines)",
        "  parts-inventory-web/src/pages/CreatePartPage.tsx     (~2700 lines)",
        "  parts-inventory-web/src/pages/HomePage.tsx           (~1000 lines)",
        "  parts-inventory/routes-pg/parts.js                   (~1700 lines)",
        "  parts-inventory/watcher-app/watcher-service.js       (~700 lines)",
        "  parts-inventory-mobile/src/screens/EditPartScreen.tsx (~1500 lines)",
        "  parts-inventory-mobile/src/screens/CreatePartScreen.tsx (~1500 lines)",
        "For these (and any file you suspect is big): NEVER read the whole",
        "file blindly. Workflow:",
        "  1. Grep for the relevant symbol / string / pattern first",
        "  2. Note the line numbers Grep returns",
        "  3. Read with { file_path, offset: <line-20>, limit: 80 } around",
        "     each hit",
        "If you hit the 25k token error: don't surface it to the user — just",
        "redo with offset/limit. The error is a tool-level signal that you",
        "need to be more targeted, not an end state.",
        "",
        "## Journal protocol — MANDATORY for committed work",
        "You MUST append a journal entry to /srv/relay-bot/shared/journal.md",
        "before considering your turn done in EVERY one of these cases:",
        "  - You created a git commit",
        "  - You pushed to any remote",
        "  - You deployed (eas update, npm publish, vercel hook, etc.)",
        "  - You edited any production .env or secret",
        "  - You ran a destructive command (rm -rf, drop, truncate, force-push)",
        "  - You did a non-trivial investigation that produced a finding worth",
        "    remembering (a bug root-cause, an architecture insight, a decision)",
        "Skip journaling ONLY for: greetings, simple status checks, single-",
        "command lookups, file reads with no follow-up action.",
        "Format the entry as:",
        "  ## YYYY-MM-DD HH:MM UTC — TARS",
        "  <one short paragraph: what was asked, what you did, any commit",
        "  hashes / branch names / files touched, anything the user's other",
        "  Claude sessions should know>",
        "  (blank line)",
        "Build it as: TS=$(date -u +'%Y-%m-%d %H:%M'); printf '\\n## %s UTC — TARS\\n%s\\n' \"$TS\" \"<text>\" >> /srv/relay-bot/shared/journal.md",
        "If you commit + push and DON'T journal, the user's laptop-side Claude",
        "will find the commit in git log but have no context for WHY. Don't",
        "make them detective.",
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
