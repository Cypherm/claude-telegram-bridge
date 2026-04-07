# claude-tg-bridge

Talk to [Claude Code](https://docs.anthropic.com/en/docs/claude-code) from your phone via Telegram.

```bash
npx claude-tg-bridge --token YOUR_BOT_TOKEN --allow YOUR_USER_ID
```

One file, zero dependencies. Bridges Telegram Bot API to `claude -p` (pipe mode). Works with your existing Claude subscription — no API key needed.

## Why

Claude Code is a powerful CLI agent, but it only runs on your computer. This bridge lets you interact with it from anywhere through Telegram — from your phone, tablet, or another machine.

It also solves real pain points with running Claude Code as a long-lived bot:

- **Context accumulation** — Long sessions eventually hit context limits and crash (`exit 143`). The bridge auto-rotates sessions every N turns and carries a summary forward, so context is never silently lost.
- **Session lock conflicts** — Claude Code's `--session-id` locks the session file. If a process is killed uncleanly, the next message fails. The bridge serializes all messages and auto-retries with a fresh session on error.
- **Photo support** — Send images to Claude Code. Photos are downloaded, passed to Claude (which can read images natively), and cleaned up on session rotation.
- **Reply context** — Reply to any message and the quoted text is included, so Claude knows what you're referring to.
- **Markdown rendering** — Responses render bold, italic, and code formatting in Telegram, with automatic plain-text fallback for unsupported syntax.
- **Voice messages** — Voice notes are transcribed locally via whisper-cpp (no API key needed) and sent to Claude as text.
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
- **ffmpeg** and **whisper-cpp** (optional, for voice message transcription): `brew install ffmpeg whisper-cpp`
- **Telegram bot token** from [@BotFather](https://t.me/botfather)

## Setup

1. Create a Telegram bot via [@BotFather](https://t.me/botfather), copy the token
2. Find your Telegram user ID (message [@userinfobot](https://t.me/userinfobot))
3. Clone and configure:

```bash
git clone https://github.com/cypherm/claude-tg-bridge
cd claude-tg-bridge
cp .env.example .env
# Edit .env with your token and user ID
```

4. Run:

```bash
node bridge.js
```

Or with env vars inline:

```bash
TELEGRAM_BOT_TOKEN=xxx ALLOWED_TELEGRAM_IDS=123456 node bridge.js
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
| `WHISPER_MODEL` | No | `ggml-base.bin` | Whisper model file name or absolute path. Use `ggml-medium.bin` for better Chinese/multilingual support |

## Customizing Claude's Behavior

Put a `CLAUDE.md` file in your `WORK_DIR`. Claude Code reads it automatically on every session start. Use it to define a persona, set rules, or provide project context.

Example `CLAUDE.md`:

```markdown
You are a helpful coding assistant. Respond concisely.
Always use TypeScript for code examples.
```

## Migrating from OpenClaw

After Anthropic's April 2026 subscription ban on third-party tools, many OpenClaw users need a new way to run Claude via Telegram. This bridge uses `claude -p` (the official CLI), so it runs on your existing Claude subscription — no API key, no extra cost.

### Step 1: Skills

OpenClaw `SKILL.md` and Claude Code `skill.md` are format-compatible. Just copy and rename:

```bash
# Migrate all skills at once
for skill in ~/.openclaw/workspace*/skills/*/; do
  name=$(basename "$skill")
  dest="$HOME/.claude/skills/$name"
  [ -d "$dest" ] && continue
  mkdir -p "$dest"
  cp "$skill/SKILL.md" "$dest/skill.md" 2>/dev/null
  # Symlink data and references if they exist
  [ -d "$skill/data" ] && ln -s "$skill/data" "$dest/data"
  [ -d "$skill/references" ] && ln -s "$skill/references" "$dest/references"
  [ -d "$skill/scripts" ] && ln -s "$skill/scripts" "$dest/scripts"
  echo "✓ $name"
done
```

Skills are automatically available via `claude -p`. No code changes needed.

### Step 2: Agent persona

Your OpenClaw agent config (BOOTSTRAP.md, SOUL.md, AGENTS.md, etc.) maps to a single `CLAUDE.md` file in your `WORK_DIR`. Put your agent's personality, rules, and instructions there. Claude Code reads it on every session start.

### Step 3: Memory

If your OpenClaw agent has memory files (MEMORY.md, conversation logs), copy them to your `WORK_DIR`. Reference them in your `CLAUDE.md`:

```markdown
## Memory
- Read `MEMORY.md` on session start to restore context
- Important insights go to `memory/YYYY-MM-DD.md`
```

### Step 4: Bot token

You can reuse your existing Telegram bot token. **Important:** stop the OpenClaw gateway first, or the two will fight over `getUpdates` (409 conflict).

```bash
# Stop OpenClaw gateway if running
launchctl unload ~/Library/LaunchAgents/ai.openclaw.gateway.plist 2>/dev/null

# Kill any lingering OpenClaw Telegram consumers
pkill -f "bun server.ts" 2>/dev/null
```

If you keep getting 409 errors, revoke and regenerate your bot token via @BotFather.

### Step 5: Cron jobs

OpenClaw cron jobs (RSS scans, scheduled digests) can be replicated with system cron or Claude Code's `/schedule` command. Example for a daily RSS scan:

```bash
# System cron (crontab -e)
0 8 * * * cd /path/to/workdir && claude -p "run intel-digest skill" 2>&1 >> /tmp/intel.log
```

### Step 6: MCP servers

Any MCP servers configured in `~/.claude/settings.json` are automatically available in the bridge. No migration needed — `claude -p` loads them natively.

### What you keep

| OpenClaw | This bridge | Notes |
|---|---|---|
| Skills (SKILL.md) | ✅ Copy to `~/.claude/skills/` | Rename to `skill.md` |
| Agent persona | ✅ CLAUDE.md in WORK_DIR | Consolidate into one file |
| Memory/context | ✅ Files in WORK_DIR | Referenced via CLAUDE.md |
| Bot token | ✅ Same token | Stop OpenClaw first |
| MCP servers | ✅ Already works | Via Claude Code settings |
| Cron jobs | ⚠️ Needs reimplementation | System cron or `/schedule` |
| Telegram channels (multi-bot) | ⚠️ One bot per bridge | Run multiple bridge instances |
| OAuth subscription auth | ✅ Via `claude -p` | No API key needed |

## Running as a Service

### pm2

```bash
pm2 start bridge.js --name claude-tg
pm2 save
```

### tmux

```bash
tmux new-session -d -s claude-tg 'node bridge.js'
```

### systemd

```ini
[Unit]
Description=claude-tg-bridge

[Service]
ExecStart=/usr/bin/node /path/to/bridge.js
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
