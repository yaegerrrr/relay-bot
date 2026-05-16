# relay-bot

Telegram → Claude Agent SDK bridge. Text a bot from your phone; it drives a Claude agent on a VPS that has full Bash / Read / Edit / Git tool access to your project repos. The agent does the work and replies. You never open a laptop.

## How it works

- **Inbound:** Telegram messages from your allow-listed user ID → bot's long-poll loop
- **Agent:** each chat = one persistent Claude Agent SDK conversation, resumed via session ID across messages
- **Tools:** Read / Write / Edit / Bash / Glob / Grep — all built-in to the SDK, running on the VPS in your `repos/` working tree
- **Outbound:** agent's text streamed back as live-editing Telegram messages, with tool-use indicators so you see what it's doing

Permission mode is `bypassPermissions` — the agent acts without asking mid-task. The security boundary is the Telegram allowlist: any message from a user ID not in `TELEGRAM_ALLOWED_USER_IDS` is dropped silently.

## Quick deploy on a fresh Ubuntu 24.04 VPS

```bash
ssh root@your-vps
curl -fsSL https://raw.githubusercontent.com/yaegerrrr/relay-bot/main/setup.sh | bash
```

That script installs Node 22 + Tailscale, creates a `relay` system user, clones this repo to `/srv/relay-bot`, sets up the systemd unit. Then finish three things manually (it prints reminders):

1. Fill in `/srv/relay-bot/.env` (tokens, API key, allowed user IDs)
2. `sudo tailscale up` (lets you SSH in later without exposing port 22)
3. Clone whichever project repos you want the bot to manage into `/srv/relay-bot/repos/`

Then start it:

```bash
sudo systemctl start relay-bot
sudo journalctl -u relay-bot -f
```

## Environment variables

| Var | Required | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | From `@BotFather` |
| `TELEGRAM_ALLOWED_USER_IDS` | Yes | Comma-separated; from `@userinfobot` |
| `ANTHROPIC_API_KEY` | Yes | From console.anthropic.com → API Keys |
| `WORKING_ROOT` | No | Default `./repos`. Agent's cwd. |
| `DATA_DIR` | No | Default `./data`. Per-chat session state. |
| `CLAUDE_MODEL` | No | Default `claude-sonnet-4-7`. Use `claude-opus-4-7` for deeper reasoning. |

## Telegram commands

- `/start` — greeting
- `/status` — show working dir + model + session
- `/reset` — drop session state, start a fresh conversation
- anything else — sent to the agent as a user turn

## Local dev

```bash
npm install
cp .env.example .env
# fill in tokens
npm run dev
```

`tsx --watch` restarts on file changes.

## Repo layout

- `src/bot.ts` — main loop, command handlers
- `src/agent.ts` — Claude Agent SDK wrapper, event stream
- `src/telegram.ts` — grammy setup, streaming-edit helper, allowlist
- `src/state.ts` — per-chat session persistence (JSON files)
- `setup.sh` — one-shot Ubuntu provisioning
- `relay-bot.service` — systemd unit
