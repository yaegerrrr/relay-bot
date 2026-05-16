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
