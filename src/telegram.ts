import { Bot, type Context } from "grammy";

// Thin wrappers around grammy that handle three Telegram-specific
// quirks for us:
//
//   1. 4096-char message limit — split a long reply into chunks
//   2. Edits are rate-limited (~1/sec/chat) — buffer streaming updates
//      and flush on a 1.5s interval
//   3. Markdown formatting can blow up on stray underscores/asterisks —
//      we send plain text, never Markdown, to avoid that whole class
//      of error

const MAX_LEN = 4000; // 4096 minus a small safety margin

export function chunkText(text: string): string[] {
  if (text.length <= MAX_LEN) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > MAX_LEN) {
    // Prefer to break on a newline near the limit; fall back to a hard
    // cut if there isn't one in range.
    let cut = remaining.lastIndexOf("\n", MAX_LEN);
    if (cut < MAX_LEN * 0.5) cut = MAX_LEN;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export function createBot(token: string, allowedUserIds: Set<number>): Bot {
  const bot = new Bot(token);

  // Allowlist middleware. Anyone whose user-ID isn't in the set has
  // their message dropped silently — they never know the bot exists.
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || !allowedUserIds.has(userId)) {
      console.warn(`[telegram] ignored message from unallowed user ${userId} (${ctx.from?.username ?? "?"})`);
      return;
    }
    await next();
  });

  return bot;
}

// Streaming-edit helper. The agent emits text chunks as they arrive;
// we batch them and edit a single Telegram message every ~1.5s so it
// looks live without smashing into Telegram's rate limits.
export class StreamingReply {
  private text = "";
  private messageId: number | null = null;
  private pendingFlush: NodeJS.Timeout | null = null;
  private lastFlush = 0;
  private readonly minIntervalMs = 1500;

  constructor(
    private ctx: Context,
    private chatId: number,
  ) {}

  async start(initialText = "💭 Thinking…"): Promise<void> {
    const sent = await this.ctx.api.sendMessage(this.chatId, initialText);
    this.messageId = sent.message_id;
    this.text = "";
  }

  append(chunk: string): void {
    this.text += chunk;
    this.scheduleFlush();
  }

  // Insert a tool-use indicator without polluting the main text buffer
  // (it goes as its own Telegram message so the user sees a clear
  // timeline of what the agent did).
  async note(message: string): Promise<void> {
    await this.flushNow();
    await this.ctx.api.sendMessage(this.chatId, message);
    // Next text chunks start a fresh message instead of editing the
    // pre-tool one.
    this.messageId = null;
    this.text = "";
  }

  private scheduleFlush(): void {
    if (this.pendingFlush) return;
    const elapsed = Date.now() - this.lastFlush;
    const wait = Math.max(0, this.minIntervalMs - elapsed);
    this.pendingFlush = setTimeout(() => {
      this.pendingFlush = null;
      void this.flushNow();
    }, wait);
  }

  async flushNow(): Promise<void> {
    if (this.pendingFlush) {
      clearTimeout(this.pendingFlush);
      this.pendingFlush = null;
    }
    if (!this.text) return;
    this.lastFlush = Date.now();

    // If we don't have a message to edit yet (first chunk OR after a
    // tool-note rotated us), send a fresh one. If we do, edit it.
    try {
      if (this.messageId === null) {
        const sent = await this.ctx.api.sendMessage(this.chatId, this.text);
        this.messageId = sent.message_id;
      } else {
        // If the text grew past the per-message limit, finalise this
        // one and start a new one for the overflow.
        if (this.text.length > MAX_LEN) {
          const chunks = chunkText(this.text);
          await this.ctx.api.editMessageText(this.chatId, this.messageId, chunks[0]);
          for (let i = 1; i < chunks.length; i++) {
            const sent = await this.ctx.api.sendMessage(this.chatId, chunks[i]);
            this.messageId = sent.message_id;
          }
          this.text = chunks[chunks.length - 1];
        } else {
          await this.ctx.api.editMessageText(this.chatId, this.messageId, this.text);
        }
      }
    } catch (err) {
      // Telegram throws on "message is not modified" — that's fine,
      // means our buffer hasn't actually changed since last flush.
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("message is not modified")) {
        console.warn(`[telegram] edit failed: ${msg}`);
      }
    }
  }
}
