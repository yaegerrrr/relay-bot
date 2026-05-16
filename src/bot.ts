import "dotenv/config";
import path from "node:path";
import { promises as fs } from "node:fs";
import { runAgent } from "./agent.js";
import { StateStore } from "./state.js";
import { createBot, StreamingReply } from "./telegram.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const TELEGRAM_BOT_TOKEN = required("TELEGRAM_BOT_TOKEN");
const ANTHROPIC_API_KEY = required("ANTHROPIC_API_KEY"); // SDK reads it from env; we just assert it's set
const TELEGRAM_ALLOWED_USER_IDS = required("TELEGRAM_ALLOWED_USER_IDS");
const WORKING_ROOT = path.resolve(process.env.WORKING_ROOT ?? "./repos");
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? "./data");
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? "claude-sonnet-4-7";

// Just touch ANTHROPIC_API_KEY so linters don't strip it. The SDK
// reads it directly from process.env.
void ANTHROPIC_API_KEY;

const allowedUsers = new Set(
  TELEGRAM_ALLOWED_USER_IDS.split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n)),
);

async function main(): Promise<void> {
  await fs.mkdir(WORKING_ROOT, { recursive: true });
  const store = new StateStore(DATA_DIR);
  await store.init();

  const bot = createBot(TELEGRAM_BOT_TOKEN, allowedUsers);

  // /start — greeting + a hint that they can just talk
  bot.command("start", async (ctx) => {
    await ctx.reply(
      "I'm wired up to Claude with full tool access in this VPS's working tree.\n\n" +
        "Just say what you want done — fix bugs, deploy, check status, anything.\n\n" +
        "Commands:\n" +
        "/reset — start a fresh conversation (forget context)\n" +
        "/status — show working dir + model in use",
    );
  });

  bot.command("reset", async (ctx) => {
    if (ctx.chat?.id !== undefined) {
      await store.reset(ctx.chat.id);
    }
    await ctx.reply("New conversation started. Previous context cleared.");
  });

  bot.command("status", async (ctx) => {
    const state = ctx.chat?.id !== undefined ? await store.load(ctx.chat.id) : null;
    await ctx.reply(
      [
        `Working tree: ${WORKING_ROOT}`,
        `Model: ${CLAUDE_MODEL}`,
        state?.sessionId
          ? `Session: ${state.sessionId.slice(0, 8)}…`
          : "Session: (new)",
      ].join("\n"),
    );
  });

  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    if (ctx.message.text.startsWith("/")) return; // commands handled above

    const state = await store.load(chatId);
    const reply = new StreamingReply(ctx, chatId);
    await reply.start();

    try {
      for await (const event of runAgent({
        prompt: ctx.message.text,
        workingRoot: WORKING_ROOT,
        resumeSessionId: state.sessionId,
        model: CLAUDE_MODEL,
      })) {
        switch (event.kind) {
          case "text":
            reply.append(event.text);
            break;
          case "tool_use":
            // Show the user what the agent is about to do. Keep it
            // short — the input can be verbose for large file edits.
            await reply.note(`🔧 ${event.name}${formatToolInput(event.input)}`);
            break;
          case "tool_result":
            // Tool results are usually verbose (file contents, command
            // output). Only surface errors so the user knows when
            // something failed; the agent's next text turn already
            // summarises successes in plain English.
            if (event.isError) {
              await reply.note(`⚠️ Tool error: ${event.content.slice(0, 500)}`);
            }
            break;
          case "session":
            state.sessionId = event.sessionId;
            await store.save(state);
            break;
          case "done":
            await reply.flushNow();
            if (event.usage) {
              console.log(
                `[${chatId}] turn done — in ${event.usage.input}t / out ${event.usage.output}t`,
              );
            }
            break;
          case "error":
            await reply.note(`❌ ${event.message}`);
            break;
        }
      }
    } catch (err) {
      console.error(`[${chatId}] unhandled error:`, err);
      await ctx.reply(`Unhandled error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  bot.catch((err) => {
    console.error("[telegram] bot error:", err);
  });

  console.log(
    `claude-bot starting (model=${CLAUDE_MODEL}, working_root=${WORKING_ROOT}, allowed_users=${[...allowedUsers].join(",")})`,
  );
  await bot.start();
}

// Compact tool-input formatter — shows the most useful bit for each
// common tool. Avoids dumping massive file contents into the chat.
function formatToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  if (typeof i.command === "string") return `: ${truncate(i.command, 200)}`;
  if (typeof i.file_path === "string") return `: ${i.file_path}`;
  if (typeof i.path === "string") return `: ${i.path}`;
  if (typeof i.pattern === "string") return `: ${truncate(i.pattern, 80)}`;
  return "";
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

void main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
