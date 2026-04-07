# claude-telegram-bridge

Talk to [Claude Code](https://docs.anthropic.com/en/docs/claude-code) from your phone via Telegram.

One file, zero dependencies. Bridges Telegram Bot API to `claude -p` (pipe mode).

## Why

Claude Code is a powerful CLI agent, but it only runs on your computer. This bridge lets you interact with it from anywhere through Telegram — from your phone, tablet, or another machine.

It also solves real pain points with running Claude Code as a long-lived bot:

- **Context accumulation** — Long sessions eventually hit context limits and crash (`exit 143`). The bridge auto-rotates sessions every N turns and carries a summary forward, so context is never silently lost.
- **Session lock conflicts** — Claude Code's `--session-id` locks the session file. If a process is killed uncleanly, the next message fails. The bridge serializes all messages and auto-retries with a fresh session on error.
- **Photo support** — Send images to Claude Code. Photos are downloaded, passed to Claude (which can read images natively), and cleaned up on session rotation.
- **Reply context** — Reply to any message and the quoted text is included, so Claude knows what you're referring to.
- **Markdown rendering** — Responses render bold, italic, and code formatting in Telegram, with automatic plain-text fallback for unsupported syntax.
- **Sticker support** — Send stickers and Claude receives the underlying emoji.
- **Emoji reactions** — Claude can react to your messages with emoji (e.g., `[react: 💎]` in its output becomes a reaction on your message). Add instructions in your `CLAUDE.md` to tell Claude when to use reactions.
- **Telegram message limits** — Responses longer than 4096 characters are automatically split at newline boundaries.

## How It Works

```
Telegram message
  → poll getUpdates (short polling, no 409 conflicts)
  → serial message queue
  → claude -p --session-id / --resume
  → response split if needed
  → sendMessage back to Telegram
```

**Session lifecycle:**
- Turn 1 of each session: `--session-id UUID` (creates a new session)
- Turn 2+: `--resume UUID` (continues the session with full conversation history)
- Every N turns: Claude summarizes the conversation → saved to `session-summary.md` → injected into turn 1 of the next session
- On error: auto-rotate to a fresh session and retry once

## Prerequisites

- **Node.js 18+** (for native `fetch`)
- **Claude Code CLI** installed and authenticated — `claude` must be in your PATH
- **Telegram bot token** from [@BotFather](https://t.me/botfather)

## Setup

1. Create a Telegram bot via [@BotFather](https://t.me/botfather), copy the token
2. Find your Telegram user ID (message [@userinfobot](https://t.me/userinfobot))
3. Clone and configure:

```bash
git clone https://github.com/cypherm/claude-telegram-bridge
cd claude-telegram-bridge
cp .env.example .env
# Edit .env with your token and user ID
```

4. Run:

```bash
node bridge.mjs
```

Or with env vars inline:

```bash
TELEGRAM_BOT_TOKEN=xxx ALLOWED_TELEGRAM_IDS=123456 node bridge.mjs
```

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | — | Bot token from @BotFather |
| `ALLOWED_TELEGRAM_IDS` | No | *(allow all)* | Comma-separated user IDs |
| `WORK_DIR` | No | `cwd` | Directory Claude Code operates in |
| `COMPACT_INTERVAL` | No | `100` | Turns before auto-compaction |
| `CLAUDE_TIMEOUT` | No | `300000` | `claude -p` timeout in ms (5 min) |
| `POLL_INTERVAL` | No | `2000` | Telegram polling interval in ms |
| `COMPACT_PROMPT` | No | *(English summary)* | Custom prompt for session compaction |

## Customizing Claude's Behavior

Put a `CLAUDE.md` file in your `WORK_DIR`. Claude Code reads it automatically on every session start. Use it to define a persona, set rules, or provide project context.

Example `CLAUDE.md`:

```markdown
You are a helpful coding assistant. Respond concisely.
Always use TypeScript for code examples.
```

## Running as a Service

### pm2

```bash
pm2 start bridge.mjs --name claude-tg
pm2 save
```

### tmux

```bash
tmux new-session -d -s claude-tg 'node bridge.mjs'
```

### systemd

```ini
[Unit]
Description=claude-telegram-bridge

[Service]
ExecStart=/usr/bin/node /path/to/bridge.mjs
WorkingDirectory=/path/to/your/project
EnvironmentFile=/path/to/.env
Restart=always

[Install]
WantedBy=multi-user.target
```

## Permissions

Claude Code has a permission system that prompts for approval on file writes, bash commands, etc. When running headless via this bridge, you'll want to either:

- Set `permissions.allow` in `~/.claude/settings.json`:
  ```json
  { "permissions": { "allow": ["Write", "Edit", "Bash"] } }
  ```
- Or run with `--dangerously-skip-permissions` (not recommended for production)

## Troubleshooting

**409 Conflict errors on startup**
Another process is polling the same bot token. Kill any other instances, or wait ~10 seconds for the previous polling session to expire. If persistent, revoke and regenerate your bot token via @BotFather.

**`exit 143` / `exit 1` from Claude**
The session may be corrupted. The bridge auto-retries with a fresh session. If it keeps failing, check that `claude` CLI is working: `claude -p "hello"`.

**No messages received**
Make sure no other bot/service is using the same token (e.g., OpenClaw gateway, Claude Code Telegram plugin). Only one consumer can poll a bot at a time.

## License

MIT
