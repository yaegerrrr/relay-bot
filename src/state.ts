import { promises as fs } from "node:fs";
import path from "node:path";

// Per-Telegram-chat state. Each chat is one persistent agent
// conversation — same SDK session ID across messages so the agent
// remembers context day-to-day. Stored as JSON so a service restart
// doesn't lose anyone's thread.

export type ChatState = {
  chatId: number;
  // Resume token from the Claude Agent SDK's last query. Passing this
  // back via `resume: sessionId` keeps the agent in the same logical
  // conversation across separate invocations.
  sessionId: string | null;
  // Last message ID the bot replied with — used so streaming edits
  // know which Telegram message to update.
  lastBotMessageId: number | null;
  createdAt: number;
  updatedAt: number;
};

export class StateStore {
  constructor(private dataDir: string) {}

  async init(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
  }

  private file(chatId: number): string {
    return path.join(this.dataDir, `${chatId}.json`);
  }

  async load(chatId: number): Promise<ChatState> {
    try {
      const raw = await fs.readFile(this.file(chatId), "utf8");
      return JSON.parse(raw) as ChatState;
    } catch {
      const now = Date.now();
      return {
        chatId,
        sessionId: null,
        lastBotMessageId: null,
        createdAt: now,
        updatedAt: now,
      };
    }
  }

  async save(state: ChatState): Promise<void> {
    state.updatedAt = Date.now();
    await fs.writeFile(this.file(state.chatId), JSON.stringify(state, null, 2));
  }

  async reset(chatId: number): Promise<void> {
    try {
      await fs.unlink(this.file(chatId));
    } catch {
      // already gone
    }
  }
}
