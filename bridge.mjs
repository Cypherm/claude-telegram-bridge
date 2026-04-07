#!/usr/bin/env node
/**
 * claude-telegram-bridge
 *
 * Talk to Claude Code from your phone via Telegram.
 * One file, zero dependencies. Node.js 18+.
 *
 * Telegram → poll getUpdates → queue → claude -p → response → sendMessage
 *
 * Features:
 * - Session continuity via shared session ID + --resume
 * - Auto-compaction: every N turns, Claude summarizes context for the next session
 * - Serial message queue prevents session lock conflicts
 * - Auto-retry with fresh session on any error
 * - Markdown rendering with plain-text fallback
 * - Photo support (downloads, sends to Claude, cleans up on session rotation)
 * - Reply quote context (includes quoted message text)
 * - Splits long replies for Telegram's 4096 char limit
 * - 409 conflict backoff for clean restarts
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

// ── Config ──────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_IDS = process.env.ALLOWED_TELEGRAM_IDS
  ? new Set(process.env.ALLOWED_TELEGRAM_IDS.split(",").map(Number))
  : new Set();
const WORK_DIR = resolve(process.env.WORK_DIR || process.cwd());
const COMPACT_INTERVAL = parseInt(process.env.COMPACT_INTERVAL || "100", 10);
const CLAUDE_TIMEOUT = parseInt(process.env.CLAUDE_TIMEOUT || "300000", 10);
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "2000", 10);
const COMPACT_PROMPT = process.env.COMPACT_PROMPT
  || "System: This session is ending. Write a concise summary that lets the next session continue seamlessly: what was being discussed, pending tasks, decisions made and why, the user's current focus. Keep what matters, drop what doesn't. Output only the summary.";

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const MAX_MSG_LEN = 4096;
const SUMMARY_FILE = resolve(WORK_DIR, "session-summary.md");

if (!BOT_TOKEN) {
  console.error("Error: TELEGRAM_BOT_TOKEN is required.");
  console.error("  Get one from @BotFather on Telegram.");
  console.error("  Usage: TELEGRAM_BOT_TOKEN=xxx node bridge.mjs");
  process.exit(1);
}

if (ALLOWED_IDS.size === 0) {
  console.warn("[warn] ALLOWED_TELEGRAM_IDS is empty — anyone can use this bot.");
}

// ── Telegram API ────────────────────────────────────────────────────────
async function tg(method, body = {}) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function sendTyping(chatId) {
  await tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
}

function mdToHtml(text) {
  // Escape HTML entities first
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return html
    // Code blocks (protect from other replacements)
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Bold: **text** or __text__
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/__(.+?)__/g, '<b>$1</b>')
    // Italic: *text* or _text_
    .replace(/(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, '<i>$1</i>')
    .replace(/(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)/g, '<i>$1</i>')
    // Strikethrough: ~~text~~
    .replace(/~~(.+?)~~/g, '<s>$1</s>');
}

async function sendMessage(chatId, text, replyTo) {
  const chunks = splitText(text, MAX_MSG_LEN);
  for (const chunk of chunks) {
    const base = { chat_id: chatId, text: chunk, ...(replyTo ? { reply_to_message_id: replyTo } : {}) };
    // Convert markdown to Telegram HTML, fall back to plain text on parse error
    const res = await tg("sendMessage", { ...base, text: mdToHtml(chunk), parse_mode: "HTML" });
    if (!res.ok) await tg("sendMessage", base);
  }
}

function splitText(text, limit) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > 0) {
    if (rest.length <= limit) { chunks.push(rest); break; }
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.3) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  return chunks;
}

// ── Claude Code ─────────────────────────────────────────────────────────
// Shared session ID for continuity. processQueue is serial (await), so
// only one claude process runs at a time — no lock conflicts.
let currentSessionId = randomUUID();
let turnCount = 0;
let sessionPhotos = [];

function spawnClaude(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("claude", args, {
      cwd: WORK_DIR,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: CLAUDE_TIMEOUT,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`exit ${code}: ${stderr.slice(0, 200)}`));
    });
    proc.on("error", reject);
  });
}

async function compactAndRotate() {
  try {
    console.log(`[compact] summarizing session ${currentSessionId.slice(0, 8)} (${turnCount} turns)...`);
    const summary = await spawnClaude([
      "-p",
      "--resume", currentSessionId,
      "--",
      COMPACT_PROMPT,
    ]);
    writeFileSync(SUMMARY_FILE, `# Previous session summary\n\n${summary}\n`);
    console.log(`[compact] saved (${summary.length} chars)`);
  } catch (err) {
    console.error(`[compact] failed (non-fatal): ${err.message}`);
  }
  // Clean up photos from this session
  for (const p of sessionPhotos) {
    try { (await import("node:fs/promises")).unlink(p); } catch {}
  }
  sessionPhotos = [];
  currentSessionId = randomUUID();
  turnCount = 0;
  console.log(`[session] rotated → ${currentSessionId.slice(0, 8)}...`);
}

async function runClaude(prompt) {
  if (turnCount >= COMPACT_INTERVAL) {
    await compactAndRotate();
  }

  turnCount++;

  // Inject summary only on first turn of a new session
  let fullPrompt = prompt;
  if (turnCount === 1 && existsSync(SUMMARY_FILE)) {
    const summary = readFileSync(SUMMARY_FILE, "utf-8");
    fullPrompt = `[Previous session summary for context — no need to reference it explicitly]\n${summary}\n\n---\n\n${prompt}`;
  }

  // turn 1: --session-id (create), turn 2+: --resume (continue)
  const sessionArg = turnCount === 1
    ? ["--session-id", currentSessionId]
    : ["--resume", currentSessionId];

  try {
    console.log(`[claude] session=${currentSessionId.slice(0, 8)} turn=${turnCount}: ${prompt.slice(0, 80)}...`);
    const result = await spawnClaude(["-p", ...sessionArg, "--", fullPrompt]);
    return result || "(no output)";
  } catch (err) {
    console.error(`[claude] error: ${err.message.slice(0, 200)}`);
    // Rotate to fresh session and retry once
    console.log("[claude] retrying with fresh session...");
    currentSessionId = randomUUID();
    turnCount = 1;
    try {
      const result = await spawnClaude([
        "-p", "--session-id", currentSessionId, "--", fullPrompt,
      ]);
      return result || "(no output)";
    } catch (retryErr) {
      throw retryErr;
    }
  }
}

// ── Message queue ───────────────────────────────────────────────────────
const queue = [];
let processing = false;

function enqueue(chatId, messageId, text, user, photoPath) {
  queue.push({ chatId, messageId, text, user, photoPath });
  if (!processing) processQueue();
}

async function processQueue() {
  processing = true;
  while (queue.length > 0) {
    const { chatId, messageId, text, user, photoPath } = queue.shift();
    try {
      const typing = setInterval(() => sendTyping(chatId), 4000);
      await sendTyping(chatId);

      const result = await runClaude(text);
      clearInterval(typing);

      await sendMessage(chatId, result, messageId);
      console.log(`[reply] ${result.slice(0, 80)}...`);
    } catch (err) {
      console.error("[error]", err.message);
      await sendMessage(chatId, `Error: ${err.message.slice(0, 200)}`, messageId);
    }
    // Track photo for cleanup on session rotation
    if (photoPath) sessionPhotos.push(photoPath);
    if (queue.length > 0) await new Promise(r => setTimeout(r, 1000));
  }
  processing = false;
}

// ── Polling ─────────────────────────────────────────────────────────────
let offset = 0;

async function poll() {
  try {
    const data = await tg("getUpdates", {
      offset,
      timeout: 0,
      allowed_updates: ["message"],
    });

    if (!data.ok) {
      if (data.error_code === 409) {
        console.error("[poll] 409 conflict — another bot instance may be running. Backing off 10s...");
        await new Promise(r => setTimeout(r, 10000));
      } else {
        console.error(`[poll] error: ${data.error_code} ${data.description}`);
      }
    }

    if (data.ok && data.result?.length > 0) {
      for (const update of data.result) {
        offset = update.update_id + 1;
        const msg = update.message;

        const userId = msg?.from?.id;
        const chatId = msg?.chat?.id;
        if (!chatId) continue;

        if (ALLOWED_IDS.size > 0 && !ALLOWED_IDS.has(userId)) {
          console.log(`[denied] user ${userId} (${msg.from.username})`);
          continue;
        }

        if (msg.text === "/start") {
          await sendMessage(chatId, "Bridge is running. Send a message.");
          continue;
        }

        // Build message text from text and/or photo caption
        let text = msg.text || msg.caption || "";
        const quoted = msg.reply_to_message?.text;
        if (quoted) {
          text = `[Quoted message: "${quoted}"]\n\n${text}`;
        }

        // Download photo if present
        let photoPath = null;
        if (msg.photo?.length > 0) {
          try {
            const fileId = msg.photo[msg.photo.length - 1].file_id; // largest size
            const fileInfo = await tg("getFile", { file_id: fileId });
            if (fileInfo.ok) {
              const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.result.file_path}`;
              const imgRes = await fetch(url);
              const buf = Buffer.from(await imgRes.arrayBuffer());
              photoPath = resolve(WORK_DIR, `.telegram-photo-${Date.now()}.jpg`);
              writeFileSync(photoPath, buf);
              text = text
                ? `${text}\n\n[Attached photo: ${photoPath}]`
                : `[Attached photo: ${photoPath}] Please look at this image and respond.`;
            }
          } catch (err) {
            console.error("[photo] download failed:", err.message);
          }
        }

        if (!text) continue;

        console.log(`[msg] ${msg.from.username}: ${text.slice(0, 80)}`);
        enqueue(chatId, msg.message_id, text, msg.from.username, photoPath);
      }
    }
  } catch (err) {
    console.error("[poll]", err.message);
    await new Promise(r => setTimeout(r, 3000));
  }

  setTimeout(poll, POLL_INTERVAL);
}

// ── Start ───────────────────────────────────────────────────────────────
console.log("=== claude-telegram-bridge ===");
console.log(`dir: ${WORK_DIR}`);
console.log(`compact: every ${COMPACT_INTERVAL} turns`);
if (ALLOWED_IDS.size > 0) console.log(`allowed: ${[...ALLOWED_IDS].join(", ")}`);

const me = await tg("getMe");
if (me.ok) {
  console.log(`bot: @${me.result.username}`);
} else {
  console.error("Bad token — check TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

await tg("deleteWebhook");
poll();
