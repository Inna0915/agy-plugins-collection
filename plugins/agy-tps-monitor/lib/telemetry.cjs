'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { analyzeRetries, retrySummary } = require('./retries.cjs');

const HOME_DIR = process.env.AGY_TPS_HOME || process.env.USERPROFILE || process.env.HOME || os.homedir();
const GEMINI_DIR = path.join(HOME_DIR, '.gemini');
const TPS_ROOT = path.join(GEMINI_DIR, 'tmp', 'tps');
const SESSIONS_DIR = path.join(TPS_ROOT, 'sessions');
const INDEX_FILE = path.join(TPS_ROOT, 'index.json');
const PREFS_FILE = path.join(TPS_ROOT, 'prefs.json');

const MAX_STEPS_KEPT = 30;
const MAX_INDEX_SESSIONS = 40;
// Candidates hydrated by listRecentSessions, and per-session caches sized above them so polling never thrashes.
const LIST_CANDIDATE_SESSIONS = MAX_INDEX_SESSIONS + 20;
const SESSION_CACHE_MAX = 120;
const CANCEL_MARKER_ASCII = Buffer.from('context canceled by user', 'utf8');

function ensureDirs() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function safeId(id) {
  return String(id || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function getSessionFile(conversationId) {
  return path.join(SESSIONS_DIR, `${safeId(conversationId)}.json`);
}

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw || !raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, data) {
  ensureDirs();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const json = JSON.stringify(data, null, 2);
  const tmpFile = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  );
  try {
    fs.writeFileSync(tmpFile, json, 'utf8');
    try {
      fs.renameSync(tmpFile, filePath);
    } catch {
      fs.writeFileSync(filePath, json, 'utf8');
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  } catch {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

/**
 * Zero-overhead OS process existence probe (`kill(pid, 0)`).
 * Returns false ONLY when OS confirms `ESRCH` (process no longer exists).
 */
function isPidAlive(pid) {
  const num = Number(pid || 0);
  if (!Number.isInteger(num) || num <= 0) return true;
  try {
    process.kill(num, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'EPERM') return true;
    return false;
  }
}

/**
 * Counts occurrences of `context canceled by user` in conversation `.db` + `.db-wal`
 * (reading at most the last 8MB of large DBs), cached by `mtime:size` so polling has near-zero I/O.
 */
const dbCancelCache = new Map();

function countMarkerInFileTail(filePath, maxBytes = 8 * 1024 * 1024) {
  try {
    if (!fs.existsSync(filePath)) return { size: 0, mtimeMs: 0, count: 0, tailHasCancel: false };
    const st = fs.statSync(filePath);
    if (st.size <= 0) return { size: 0, mtimeMs: st.mtimeMs, count: 0, tailHasCancel: false };

    const readLen = Math.min(st.size, maxBytes);
    const offset = st.size - readLen;
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(readLen);
    try {
      fs.readSync(fd, buf, 0, readLen, offset);
    } finally {
      fs.closeSync(fd);
    }

    let count = 0;
    let idx = 0;
    let lastMatchOffset = -1;
    while ((idx = buf.indexOf(CANCEL_MARKER_ASCII, idx)) !== -1) {
      count += 1;
      lastMatchOffset = idx;
      idx += CANCEL_MARKER_ASCII.length;
    }
    // Tail region = last 256KB of the file
    const tailThreshold = Math.max(0, readLen - 256 * 1024);
    const tailHasCancel = lastMatchOffset >= tailThreshold;
    return { size: st.size, mtimeMs: st.mtimeMs, count, tailHasCancel };
  } catch {
    return { size: 0, mtimeMs: 0, count: 0, tailHasCancel: false };
  }
}

function resolveConversationDbBase(conversationId, transcriptPath) {
  if (!conversationId) return '';
  const norm = String(transcriptPath || '').replace(/\\/g, '/');
  let preferredSurf = '';
  if (norm.includes('/antigravity-cli/')) preferredSurf = 'antigravity-cli';
  else if (norm.includes('/antigravity-ide/')) preferredSurf = 'antigravity-ide';
  else if (norm.includes('/antigravity/')) preferredSurf = 'antigravity';

  const order = preferredSurf
    ? [preferredSurf, 'antigravity', 'antigravity-ide', 'antigravity-cli']
    : ['antigravity', 'antigravity-ide', 'antigravity-cli'];

  for (const surf of new Set(order)) {
    const dbFile = path.join(GEMINI_DIR, surf, 'conversations', `${conversationId}.db`);
    if (fs.existsSync(dbFile)) return dbFile;
  }
  return '';
}

function inspectConversationDbCancel(conversationId, transcriptPath) {
  const dbFile = resolveConversationDbBase(conversationId, transcriptPath);
  if (!dbFile) {
    return { exists: false, maxMtimeMs: 0, cancelCount: 0, tailHasCancel: false };
  }
  const walFile = `${dbFile}-wal`;
  let dbStat = null;
  let walStat = null;
  try { dbStat = fs.statSync(dbFile); } catch {}
  try { if (fs.existsSync(walFile)) walStat = fs.statSync(walFile); } catch {}

  const sigKey = [
    dbFile,
    dbStat ? `${Math.round(dbStat.mtimeMs)}:${dbStat.size}` : '0',
    walStat ? `${Math.round(walStat.mtimeMs)}:${walStat.size}` : '0',
  ].join('|');

  const cached = dbCancelCache.get(conversationId);
  if (cached && cached.sigKey === sigKey) {
    return cached.result;
  }

  const dbRes = countMarkerInFileTail(dbFile);
  const walRes = walStat && walStat.size > 0
    ? countMarkerInFileTail(walFile)
    : { size: 0, mtimeMs: 0, count: 0, tailHasCancel: false };

  const result = {
    exists: true,
    maxMtimeMs: Math.max(dbRes.mtimeMs || 0, walRes.mtimeMs || 0),
    cancelCount: dbRes.count + walRes.count,
    tailHasCancel: Boolean(walRes.size > 0 ? (walRes.tailHasCancel || dbRes.tailHasCancel) : dbRes.tailHasCancel),
  };

  dbCancelCache.set(conversationId, { sigKey, result });
  if (dbCancelCache.size > 80) {
    dbCancelCache.delete(dbCancelCache.keys().next().value);
  }
  return result;
}

/*
 * Precise per-step timing from agy's own conversation DB (`conversations/<id>.db`, table `steps`).
 *
 * The step `metadata` column is a private protobuf. For planner responses on agy 1.5.x:
 *   1 = step created (request start), 6 = first streamed chunk received, 7 = step completed
 *     (each a Timestamp { 1: seconds, 2: nanos }, millisecond precision);
 *   9 = usage { 2: input, 3: output, 5: cache read, 9: thinking, 10: answer } with output = thinking + answer.
 * This lets us follow the mainstream definition of output speed (Artificial Analysis "Output Speed",
 * vLLM / GenAI-Perf TPOT): output tokens over the generation window after the first chunk, with time to
 * first token (queue + prefill) reported separately instead of diluting the speed.
 *
 * Requires `node:sqlite` (Node >= 22.13, e.g. the Node 24 bundled with Antigravity that runs the sidecar
 * and the VS Code extension host). Older runtimes (system Node 20 running hooks) get `null` and keep the
 * legacy end-to-end estimate. Any layout mismatch drops the step instead of guessing.
 */
const DECODE_MIN_OUTPUT_TOKENS = 300;
const DECODE_MIN_GEN_MS = 3000;
const PB_MIN_EPOCH_SEC = 1577836800; // 2020-01-01
const PB_MAX_EPOCH_SEC = 4102444800; // 2100-01-01

let sqliteModule; // undefined = not probed yet, null = unavailable
function loadSqlite() {
  if (sqliteModule === undefined) {
    try {
      sqliteModule = require('node:sqlite');
    } catch {
      sqliteModule = null;
    }
  }
  return sqliteModule && typeof sqliteModule.DatabaseSync === 'function' ? sqliteModule : null;
}

function readPbVarint(buf, pos) {
  let value = 0;
  let mul = 1;
  for (let i = 0; i < 10 && pos < buf.length; i++) {
    const b = buf[pos++];
    value += (b & 0x7f) * mul;
    if (b < 0x80) return [value, pos];
    mul *= 128;
  }
  return null;
}

/** Decodes one protobuf message level into [{ field, wire, value }], or null when malformed. */
function readPbFields(buf) {
  if (!buf || typeof buf.length !== 'number') return null;
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    const key = readPbVarint(buf, pos);
    if (!key) return null;
    pos = key[1];
    const field = Math.floor(key[0] / 8);
    const wire = key[0] % 8;
    if (field <= 0) return null;
    if (wire === 0) {
      const v = readPbVarint(buf, pos);
      if (!v) return null;
      out.push({ field, wire, value: v[0] });
      pos = v[1];
    } else if (wire === 2) {
      const len = readPbVarint(buf, pos);
      if (!len || len[1] + len[0] > buf.length) return null;
      out.push({ field, wire, value: buf.subarray(len[1], len[1] + len[0]) });
      pos = len[1] + len[0];
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 5) {
      pos += 4;
    } else {
      return null;
    }
    if (pos > buf.length) return null;
  }
  return out;
}

function pbTimestampMs(fields, fieldNo) {
  const entry = fields.find((x) => x.field === fieldNo && x.wire === 2);
  if (!entry) return 0;
  const sub = readPbFields(entry.value);
  if (!sub) return 0;
  const sec = sub.find((x) => x.field === 1 && x.wire === 0);
  const nanos = sub.find((x) => x.field === 2 && x.wire === 0);
  if (!sec || sec.value < PB_MIN_EPOCH_SEC || sec.value > PB_MAX_EPOCH_SEC) return 0;
  const ns = nanos ? nanos.value : 0;
  if (ns >= 1e9) return 0;
  return sec.value * 1000 + ns / 1e6;
}

/**
 * Parses a planner step's metadata blob. Returns null unless every field is present and self-consistent
 * (start <= first chunk <= end, output == thinking + answer).
 */
function parsePlannerStepMetadata(buf) {
  const fields = readPbFields(buf);
  if (!fields) return null;
  const usageEntry = fields.find((x) => x.field === 9 && x.wire === 2);
  if (!usageEntry) return null;
  const usage = readPbFields(usageEntry.value);
  if (!usage) return null;
  const num = (n) => {
    const e = usage.find((x) => x.field === n && x.wire === 0);
    return e ? e.value : 0;
  };
  const startMs = pbTimestampMs(fields, 1);
  const firstChunkMs = pbTimestampMs(fields, 6);
  const endMs = pbTimestampMs(fields, 7);
  const outputTokens = num(3);
  const thinkingTokens = num(9);
  const answerTokens = num(10);
  if (!startMs || !firstChunkMs || !endMs) return null;
  if (!(startMs <= firstChunkMs && firstChunkMs <= endMs)) return null;
  if (outputTokens <= 0 || outputTokens !== thinkingTokens + answerTokens) return null;
  return {
    startMs,
    firstChunkMs,
    endMs,
    outputTokens,
    thinkingTokens,
    answerTokens,
    inputTokens: num(2),
    cacheReadTokens: num(5),
  };
}

const dbStepTimingCache = new Map();

/** Change signature of the conversation DB (+ WAL); '' when node:sqlite or the DB is unavailable. */
function conversationDbSignature(conversationId, transcriptPath) {
  if (!loadSqlite() || !conversationId) return { dbFile: '', sigKey: '' };
  const dbFile = resolveConversationDbBase(conversationId, transcriptPath);
  if (!dbFile) return { dbFile: '', sigKey: '' };
  let sigKey = dbFile;
  try {
    const st = fs.statSync(dbFile);
    sigKey += `|${Math.round(st.mtimeMs)}:${st.size}`;
  } catch {
    return { dbFile: '', sigKey: '' };
  }
  try {
    const wst = fs.statSync(`${dbFile}-wal`);
    sigKey += `|${Math.round(wst.mtimeMs)}:${wst.size}`;
  } catch {}
  return { dbFile, sigKey };
}

/**
 * Reads validated per-step timings keyed by step index (same as transcript `step_index`).
 * Opens the DB read-only, closes it immediately, and caches by db / wal size + mtime.
 * Returns null when node:sqlite or the DB is unavailable.
 */
function readConversationDbStepTimings(conversationId, transcriptPath) {
  const sqlite = loadSqlite();
  if (!sqlite || !conversationId) return null;
  const { dbFile, sigKey } = conversationDbSignature(conversationId, transcriptPath);
  if (!dbFile) return null;

  const cached = dbStepTimingCache.get(conversationId);
  if (cached && cached.sigKey === sigKey) return cached.result;

  let result = null;
  let db = null;
  try {
    db = new sqlite.DatabaseSync(dbFile, { readOnly: true, timeout: 250 });
    const rows = db.prepare('SELECT idx, metadata FROM steps').all();
    result = new Map();
    for (const row of rows) {
      if (!row || row.metadata === null || row.metadata === undefined) continue;
      const timing = parsePlannerStepMetadata(row.metadata);
      if (timing) result.set(String(row.idx), timing);
    }
  } catch {
    result = null;
  } finally {
    try { if (db) db.close(); } catch {}
  }

  // Do not cache transient failures (e.g. SQLITE_BUSY) so the next poll retries.
  if (result) {
    dbStepTimingCache.set(conversationId, { sigKey, result });
    if (dbStepTimingCache.size > SESSION_CACHE_MAX) {
      dbStepTimingCache.delete(dbStepTimingCache.keys().next().value);
    }
  }
  return result;
}

function getPrefs() {
  const p = readJsonSafe(PREFS_FILE, null);
  const fmt = p && (p.tokenFormat === 'raw' || p.tokenFormat === 'M') ? p.tokenFormat : 'M';
  return { tokenFormat: fmt };
}

function setPrefs(patch = {}) {
  const cur = getPrefs();
  const next = {
    ...cur,
    ...(patch.tokenFormat === 'raw' || patch.tokenFormat === 'M'
      ? { tokenFormat: patch.tokenFormat }
      : {}),
  };
  writeJsonAtomic(PREFS_FILE, next);
  return next;
}

function toggleTokenFormat() {
  const cur = getPrefs();
  return setPrefs({ tokenFormat: cur.tokenFormat === 'M' ? 'raw' : 'M' });
}

function formatTokensByMode(n, mode = 'M') {
  const num = Math.max(0, Math.round(Number(n || 0)));
  if (mode === 'raw') return String(num);
  if (num === 0) return '0M';
  const m = num / 1000000;
  if (m >= 0.01) return `${m.toFixed(2)}M`;
  return `${m.toFixed(4)}M`;
}

function getDurationTier(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms)) || Number(ms) < 0) {
    return 'muted';
  }
  const val = Number(ms);
  if (val < 10000) return 'green';
  if (val <= 100000) return 'yellow';
  return 'red';
}

function formatDurationSpan(ms) {
  const totalSec = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatStartClock(tsMs, includeDateIfOld = true) {
  const n = Number(tsMs || 0);
  if (!n) return '--:--:--';
  const d = new Date(n);
  const now = new Date();
  const pad = (v) => String(v).padStart(2, '0');
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (!includeDateIfOld || sameDay) {
    return hms;
  }
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hms}`;
}

function detectSurface(transcriptPath) {
  const norm = String(transcriptPath || '').replace(/\\/g, '/').toLowerCase();
  if (norm.includes('/antigravity-cli/')) return 'CLI';
  if (norm.includes('/antigravity-ide/')) return 'IDE';
  if (norm.includes('/antigravity/')) return 'App';
  return 'AGY';
}

function extractUserRequestBody(rawText) {
  if (!rawText || typeof rawText !== 'string') return '';
  let text = rawText;
  const reqMatch = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i.exec(text);
  if (reqMatch && reqMatch[1]) {
    text = reqMatch[1];
  } else {
    text = text.replace(/<[A-Z_]+>[\s\S]*?<\/[A-Z_]+>/g, ' ');
  }
  return text.trim();
}

function cleanUserTitle(rawText) {
  const body = extractUserRequestBody(rawText);
  if (!body) return '';
  const firstLine = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return '';
  return firstLine.length > 42 ? `${firstLine.slice(0, 40)}…` : firstLine;
}

function cleanUserGoal(rawText, maxLen = 110) {
  const body = extractUserRequestBody(rawText);
  if (!body) return '';
  const compact = body.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  return compact.length > maxLen ? `${compact.slice(0, maxLen - 1)}…` : compact;
}

function unwrapArgString(val) {
  if (val === null || val === undefined) return '';
  if (typeof val !== 'string') return String(val);
  const trimmed = val.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed.trim();
    } catch {
      return trimmed.slice(1, -1).replace(/\\\\/g, '\\').replace(/\\"/g, '"').trim();
    }
  }
  return trimmed;
}

function shortBaseName(rawPath) {
  const clean = unwrapArgString(rawPath).replace(/[\\/]+$/, '');
  if (!clean) return '';
  const parts = clean.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : clean;
}

function cleanVisibleNote(rawContent, maxLen = 180) {
  if (!rawContent || typeof rawContent !== 'string') return '';
  const stripped = rawContent
    .replace(/<agent-embed\b[^>]*>[\s\S]*?<\/agent-embed>/gi, ' ')
    .replace(/<agent-embed\b[^>]*\/?>/gi, ' ')
    .replace(/<plugin-card\b[^>]*>[\s\S]*?<\/plugin-card>/gi, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^[#>+\-\s]+|^\*\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return '';
  return stripped.length > maxLen ? `${stripped.slice(0, maxLen - 1)}…` : stripped;
}

function cleanThinkingExcerpt(rawThinking, maxLen = 165) {
  if (!rawThinking || typeof rawThinking !== 'string') return '';
  const blocks = rawThinking
    .split(/\r?\n\s*\r?\n|\r?\n/)
    .map((b) => b.replace(/^[#*>\-\s]+/, '').replace(/\s+/g, ' ').trim())
    .filter((b) => b.length >= 5)
    .filter((b) => !/^(i'm thinking through how to approach this\.?|thinking process:?|let's think step by step\.?|let's carefully.*)$/i.test(b));
  if (blocks.length === 0) return '';
  const zhBlocks = blocks.filter((b) => /[\u4e00-\u9fa5]/.test(b));
  const chosen = zhBlocks.length > 0 ? zhBlocks[zhBlocks.length - 1] : blocks[blocks.length - 1];
  return chosen.length > maxLen ? `${chosen.slice(0, maxLen - 1)}…` : chosen;
}

function summarizeStepActivity(stepObj, validText) {
  const rawContent = typeof stepObj?.content === 'string' ? stepObj.content : '';
  const hasEmbeddedUi = /<agent-embed\b/i.test(rawContent);
  const calls = Array.isArray(stepObj?.tool_calls) ? stepObj.tool_calls : [];

  const readFiles = [];
  const writeFiles = [];
  let hasHtmlArtifact = false;
  let hasDocArtifact = false;
  let hasAskQuestion = false;
  let hasTestCmd = false;
  let hasCmd = false;
  let hasSubagent = false;
  const extraChips = [];

  for (const tc of calls) {
    const name = String(tc?.name || '').trim();
    const args = (tc && typeof tc.args === 'object' && tc.args) || {};
    if (!name) continue;

    if (name === 'read_file' || name === 'view_file') {
      const bn = shortBaseName(args.Path || args.AbsolutePath || args.TargetFile);
      if (bn && !readFiles.includes(bn)) readFiles.push(bn);
    } else if (
      name === 'edit_file' ||
      name === 'write_file' ||
      name === 'replace_file_content' ||
      name === 'multi_replace_file_content'
    ) {
      const rawP = unwrapArgString(args.Path || args.TargetFile).replace(/\\/g, '/');
      const bn = shortBaseName(rawP);
      if (/\/brain\/[^/]+\//i.test(rawP) && /\.html?$/i.test(bn)) {
        hasHtmlArtifact = true;
        extraChips.push(`🎨 交互卡片 ${bn}`);
      } else if (/\/brain\/[^/]+\//i.test(rawP) && /\.md$/i.test(bn)) {
        hasDocArtifact = true;
        extraChips.push(`📋 看板文档 ${bn}`);
      } else if (bn && !writeFiles.includes(bn)) {
        writeFiles.push(bn);
      }
    } else if (name === 'run_command') {
      hasCmd = true;
      const summary = unwrapArgString(args.toolSummary);
      const cmdLine = unwrapArgString(args.CommandLine);
      const isGitCommitOrPush = /\bgit\s+(commit|push|add|status|fetch|pull)\b/i.test(cmdLine);
      const isTest = !isGitCommitOrPush && (
        /\b(mvn\s+test|npm\s+test|pnpm\s+test|node\s+--test|pytest|vitest|jest|gradle\s+test|cargo\s+test)\b/i.test(cmdLine)
        || /\b(unit\s+test|run.*tests?|运行.*(单测|测试)|回归(测试|验证))\b/i.test(summary)
      );
      if (isTest) hasTestCmd = true;
      const label = summary || (cmdLine ? cmdLine.slice(0, 28) : '执行终端命令');
      extraChips.push(`${isTest ? '🧪' : '⚡'} ${label.length > 30 ? `${label.slice(0, 29)}…` : label}`);
    } else if (name === 'ask_question') {
      hasAskQuestion = true;
      extraChips.push('💬 发起方案拍板提问');
    } else if (name === 'invoke_subagent' || name === 'send_message' || name === 'swarm' || name === 'run_workflow') {
      hasSubagent = true;
      const role = unwrapArgString(args.Role || args.TypeName || args.action || '子代理');
      extraChips.push(`🤝 协同: ${role.slice(0, 22)}`);
    } else if (name === 'manage_task') {
      extraChips.push('⏱️ 跟进后台任务');
    } else if (name === 'search_web' || name === 'search_marketplace') {
      const q = unwrapArgString(args.query || '外部资料');
      extraChips.push(`🌐 检索: ${q.slice(0, 20)}`);
    } else {
      const cleanName = unwrapArgString(args.ToolName || args.ServerName || name.replace(/^mcp_/, ''));
      extraChips.push(`🔌 ${cleanName.slice(0, 22)}`);
    }
  }

  const chips = [];
  if (writeFiles.length === 1) {
    chips.push(`✏️ 修改 ${writeFiles[0]}`);
  } else if (writeFiles.length > 1) {
    chips.push(`✏️ 修改 ${writeFiles[0]} 等 ${writeFiles.length} 个文件`);
  }
  if (readFiles.length === 1) {
    chips.push(`📖 精读 ${readFiles[0]}`);
  } else if (readFiles.length > 1) {
    chips.push(`📖 精读 ${readFiles[0]} 等 ${readFiles.length} 个文件`);
  }
  for (const c of extraChips) {
    if (chips.length < 4) chips.push(c);
  }
  if (hasEmbeddedUi && chips.length < 4) {
    chips.unshift('🎨 已内嵌交互微视图');
  }

  let phaseIcon = '💭';
  let phaseLabel = '深度推演';
  let phaseTone = 'muted';

  if (hasAskQuestion) {
    phaseIcon = '💬';
    phaseLabel = '等待你拍板';
    phaseTone = 'yellow';
  } else if (hasEmbeddedUi || hasHtmlArtifact) {
    phaseIcon = '🎨';
    phaseLabel = '构建交互视图';
    phaseTone = 'green';
  } else if (writeFiles.length > 0) {
    phaseIcon = '🛠️';
    phaseLabel = '代码落地修改';
    phaseTone = 'blue';
  } else if (hasTestCmd) {
    phaseIcon = '🧪';
    phaseLabel = '运行验证测试';
    phaseTone = 'green';
  } else if (hasDocArtifact) {
    phaseIcon = '📋';
    phaseLabel = '整理方案看板';
    phaseTone = 'blue';
  } else if (hasSubagent) {
    phaseIcon = '🤝';
    phaseLabel = '多智能体协作';
    phaseTone = 'blue';
  } else if (hasCmd && readFiles.length > 0) {
    phaseIcon = '🔍';
    phaseLabel = '同步与检索线索';
    phaseTone = 'blue';
  } else if (hasCmd) {
    phaseIcon = '⚡';
    phaseLabel = '命令执行探测';
    phaseTone = 'blue';
  } else if (readFiles.length > 0) {
    phaseIcon = '📖';
    phaseLabel = '阅读源码上下文';
    phaseTone = 'muted';
  } else if (calls.length === 0 && validText) {
    phaseIcon = '✅';
    phaseLabel = '结论汇总答复';
    phaseTone = 'green';
  }

  return {
    hasEmbeddedUi,
    actionChips: chips.slice(0, 4),
    phaseIcon,
    phaseLabel,
    phaseTone,
  };
}

function hasValidVisibleText(stepObj) {
  if (!stepObj || typeof stepObj.content !== 'string') return false;
  return stepObj.content.trim().length > 0;
}

function hasValidThinking(stepObj) {
  if (!stepObj || typeof stepObj.thinking !== 'string') return false;
  return stepObj.thinking.trim().length > 0;
}

function normalizeStatus(session) {
  if (!session) return 'idle';
  if (session.status === 'interrupted') return 'interrupted';
  if (session.status === 'generating' || session.status === 'tool_running') return session.status;
  return 'idle';
}

function round1(num) {
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.round(num * 10) / 10;
}

function snapCompactionThreshold(tokens) {
  const n = Number(tokens || 0);
  if (n >= 460000 && n <= 560000) return 512000;
  if (n >= 220000 && n <= 290000) return 256000;
  if (n >= 175000 && n <= 220000) return 200000;
  return n > 0 ? n : 512000;
}

function inferContextWindowLimit(modelName, rawModelId, compactionLimitTokens) {
  const combined = `${modelName || ''} ${rawModelId || ''}`.toLowerCase();
  if (/gemini[-_\s]?4|gemini[-_\s]?3|gemini[-_\s]?2\.5|gemini[-_\s]?pro|gemini[-_\s]?flash/.test(combined)) {
    return 1000000;
  }
  if (/claude|sonnet|opus|haiku/.test(combined)) {
    return compactionLimitTokens > 220000 ? 1000000 : 200000;
  }
  if (/gpt[-_\s]?[45]|o[134]/.test(combined)) {
    return 256000;
  }
  return Math.max(1000000, Number(compactionLimitTokens || 0));
}

function estimateTextTokens(str) {
  if (!str || typeof str !== 'string') return 0;
  let cjk = 0;
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) > 0x2e80) cjk += 1;
  }
  return Math.round(cjk * 1.1 + (str.length - cjk) / 3.8);
}

function inferContextThreshold(modelName, rawModelId, compactions) {
  const list = Array.isArray(compactions) ? compactions : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const before = Number(list[i]?.beforeContextTokens || 0);
    if (before > 0) {
      return {
        limitTokens: snapCompactionThreshold(before),
        source: 'observed',
        label: '实测压缩线',
      };
    }
  }
  const combined = `${modelName || ''} ${rawModelId || ''}`.toLowerCase();
  if (/gemini[-_\s]?4|gemini[-_\s]?3|gemini[-_\s]?2\.5|gemini[-_\s]?pro|gemini[-_\s]?flash/.test(combined)) {
    return { limitTokens: 512000, source: 'estimated', label: '参考压缩线' };
  }
  if (/claude|sonnet|opus|haiku/.test(combined)) {
    return { limitTokens: 200000, source: 'estimated', label: '参考压缩线' };
  }
  if (/gpt[-_\s]?[45]|o[134]/.test(combined)) {
    return { limitTokens: 256000, source: 'estimated', label: '参考压缩线' };
  }
  return { limitTokens: 512000, source: 'default', label: '参考压缩线' };
}

function inferCacheTtlProfile(modelName, rawModelId) {
  const combined = `${modelName || ''} ${rawModelId || ''}`.toLowerCase();
  if (/claude|sonnet|opus|haiku/.test(combined)) {
    return {
      mode: 'fixed',
      hotWindowMs: 5 * 60 * 1000,
      softWindowMs: 5 * 60 * 1000,
      expireWindowMs: 5 * 60 * 1000,
      label: '5m 固定窗口',
      hint: '固定 5 分钟滑动缓存窗口，每次命中自动续期',
    };
  }
  return {
    mode: 'implicit',
    hotWindowMs: 3 * 60 * 1000,
    softWindowMs: 5 * 60 * 1000,
    expireWindowMs: 30 * 60 * 1000,
    label: '隐式缓存 · 3m 热区',
    hint: '隐式缓存无固定 TTL：0–3m 高命中，3–5m 衰减，>30m 基本失效',
  };
}

function resolveFastTranscriptFile(rawPath) {
  if (!rawPath) return '';
  if (rawPath.endsWith('transcript_full.jsonl')) {
    try {
      if (fs.statSync(rawPath).size > 8 * 1024 * 1024) {
        const compact = path.join(path.dirname(rawPath), 'transcript.jsonl');
        if (fs.existsSync(compact)) return compact;
      }
    } catch {}
  }
  return rawPath;
}

/**
 * Deterministic 2-layer passive interruption detector for sessions currently marked active:
 * 1) Conversation SQLite `.db` / `.db-wal` recorded a new `context canceled by user` after `activeStartMs`;
 * 2) The owning Language Server daemon process (`ownerPid` / `ownerHubFile`) exited or restarted.
 * Returns true if the session transitioned to `interrupted`.
 */
function detectPassiveInterruption(session, parsedSteps) {
  if (!session || (session.status !== 'generating' && session.status !== 'tool_running')) {
    return false;
  }

  const refStartMs = Number(
    session.activeStartMs || session.currentInvocationStartMs || session.lastHookAtMs || 0
  );

  // Check if a new PLANNER_RESPONSE already landed in transcript after refStartMs
  const hasNewStepAfterStart = refStartMs > 0 && parsedSteps.some((entry) => {
    if (entry.type !== 'PLANNER_RESPONSE') return false;
    const ts = Date.parse(entry.created_at || '') || 0;
    return ts >= refStartMs - 1000;
  });

  const dbCancel = inspectConversationDbCancel(session.conversationId, session.transcriptPath);

  // Layer 1: Explicit user cancellation recorded in conversation SQLite store
  if (dbCancel.exists && refStartMs > 0 && dbCancel.maxMtimeMs > refStartMs) {
    const hasBaseline = typeof session.dbCancelBaselineCount === 'number';
    const newlyCanceled = hasBaseline
      ? dbCancel.cancelCount > session.dbCancelBaselineCount
      : (dbCancel.cancelCount > 0 && dbCancel.tailHasCancel && !hasNewStepAfterStart);

    if (newlyCanceled) {
      const stopAt = Math.round(dbCancel.maxMtimeMs);
      session.status = 'interrupted';
      session.interruptedAtMs = stopAt;
      session.stoppedAtMs = stopAt;
      session.interruptedElapsedMs = Math.max(0, stopAt - refStartMs);
      session.interruptedReason = '用户手动中断';
      session.activeStartMs = null;
      session.waitingFirstResponse = false;
      session.waitingFirstValidText = false;
      return true;
    }
  }

  // Layer 2: Owning Language Server process(es) exited or restarted
  const candidatePids = Array.isArray(session.ownerPids) && session.ownerPids.length > 0
    ? session.ownerPids
    : (session.ownerPid ? [session.ownerPid] : []);

  if (candidatePids.length > 0) {
    let hubReplaced = false;
    if (session.ownerPid && session.ownerHubFile && session.ownerHubMtimeMs) {
      try {
        if (fs.existsSync(session.ownerHubFile)) {
          const st = fs.statSync(session.ownerHubFile);
          if (Math.round(st.mtimeMs) !== Number(session.ownerHubMtimeMs)) {
            hubReplaced = true;
          }
        }
      } catch {}
    }

    const allDead = candidatePids.every((p) => !isPidAlive(p));
    if (hubReplaced || allDead) {
      const fallbackStop = dbCancel.exists && dbCancel.maxMtimeMs > refStartMs
        ? Math.round(dbCancel.maxMtimeMs)
        : Number(session.lastHookAtMs || refStartMs || Date.now());
      session.status = 'interrupted';
      session.interruptedAtMs = fallbackStop;
      session.stoppedAtMs = fallbackStop;
      session.interruptedElapsedMs = refStartMs > 0 ? Math.max(0, fallbackStop - refStartMs) : null;
      session.interruptedReason = '宿主服务已重启/退出';
      session.activeStartMs = null;
      session.waitingFirstResponse = false;
      session.waitingFirstValidText = false;
      return true;
    }
  }

  return false;
}

function syncSessionFromTranscript(conversationId, opts = {}) {
  if (!conversationId) return null;
  const existing = readJsonSafe(getSessionFile(conversationId), null) || {
    conversationId,
    title: '',
    surface: 'AGY',
    modelName: '',
    cwd: '',
    transcriptPath: '',
    sessionStartedAtMs: 0,
    schemaVersion: 3,
    status: 'idle',
    activeStartMs: null,
    stepTimings: {},
    steps: [],
    updatedAtMs: Date.now(),
  };

  existing.schemaVersion = 3;
  const previousStatus = existing.status;
  const previousActiveStart = existing.activeStartMs;

  const transcriptPath = opts.transcriptPath || existing.transcriptPath || findTranscriptPath(conversationId);
  if (transcriptPath) {
    existing.transcriptPath = transcriptPath;
    existing.surface = detectSurface(transcriptPath);
  }
  if (opts.cwd) existing.cwd = opts.cwd;
  if (opts.workspacePaths && Array.isArray(opts.workspacePaths) && opts.workspacePaths[0] && !existing.cwd) {
    existing.cwd = opts.workspacePaths[0];
  }
  if (opts.modelName && opts.modelName !== 'auto') {
    existing.modelName = opts.modelName;
  }
  if (opts.lastUserInput) {
    const candidate = cleanUserTitle(opts.lastUserInput);
    if (candidate && !existing.title) {
      existing.title = candidate;
    }
    const liveGoal = cleanUserGoal(opts.lastUserInput);
    if (liveGoal) {
      existing.currentTurnGoal = liveGoal;
    }
  }

  if (opts.ownerPid !== undefined) {
    existing.ownerPid = opts.ownerPid;
    existing.ownerPids = Array.isArray(opts.ownerPids) ? opts.ownerPids : (opts.ownerPid ? [opts.ownerPid] : []);
    existing.ownerHubFile = opts.ownerHubFile || '';
    existing.ownerHubMtimeMs = opts.ownerHubMtimeMs || 0;
  }

  if (opts.captureCancelBaseline) {
    const baseCancel = inspectConversationDbCancel(conversationId, existing.transcriptPath);
    existing.dbCancelBaselineCount = baseCancel.cancelCount;
  }

  if (opts.status) {
    existing.status = opts.status;
    existing.lastHookAtMs = Date.now();
    if (opts.status === 'idle') {
      existing.stoppedAtMs = existing.lastHookAtMs;
      existing.interruptedAtMs = null;
      existing.interruptedElapsedMs = null;
      existing.interruptedReason = '';
    } else if (opts.status === 'interrupted') {
      const stopAt = Number(opts.interruptedAtMs || existing.lastHookAtMs);
      existing.interruptedAtMs = stopAt;
      existing.stoppedAtMs = stopAt;
      existing.interruptedElapsedMs = opts.interruptedElapsedMs ?? null;
      existing.interruptedReason = opts.interruptedReason || '会话已中断';
    } else if (opts.status === 'generating' || opts.status === 'tool_running') {
      existing.interruptedAtMs = null;
      existing.interruptedElapsedMs = null;
      existing.interruptedReason = '';
    }
  }

  if (opts.activeStartMs !== undefined) {
    existing.activeStartMs = opts.activeStartMs;
  }

  existing.stepTimings = existing.stepTimings || {};

  const readTarget = resolveFastTranscriptFile(transcriptPath);
  let parsedSteps = [];
  let fileMtimeMs = 0;
  let fileBirthtimeMs = 0;
  if (readTarget && fs.existsSync(readTarget)) {
    try {
      const stat = fs.statSync(readTarget);
      fileMtimeMs = stat.mtimeMs;
      fileBirthtimeMs = stat.birthtimeMs || stat.ctimeMs || 0;
      const content = fs.readFileSync(readTarget, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          parsedSteps.push(obj);
          if (!existing.sessionStartedAtMs && obj.created_at) {
            const ts = Date.parse(obj.created_at);
            if (ts > 0) existing.sessionStartedAtMs = ts;
          }
          if (!existing.title && obj.type === 'USER_INPUT' && obj.content) {
            const t = cleanUserTitle(obj.content);
            if (t) existing.title = t;
          }
          if (obj.type === 'USER_INPUT' && typeof obj.content === 'string') {
            const m = /`Model Selection` from [^\n]+? to ([^\n.]+?)\./.exec(obj.content);
            if (m && m[1]) existing.modelName = m[1].trim();
          }
          if (obj.model && typeof obj.model === 'string') {
            existing.rawModelId = obj.model.trim();
            if (!existing.modelName) existing.modelName = existing.rawModelId;
          }
        } catch {}
      }
    } catch {}
  }

  if (opts.activeStartMs) {
    const advanced = parsedSteps.some((entry) =>
      (entry.type === 'USER_INPUT' || entry.type === 'PLANNER_RESPONSE') &&
      Date.parse(entry.created_at || '') > Number(previousActiveStart || 0));
    if (previousStatus === 'generating' && previousActiveStart && !advanced) {
      existing.activeStartMs = previousActiveStart;
    }
    existing.currentInvocationStartMs = existing.activeStartMs;
    existing.stoppedAtMs = null;
  }

  if (!existing.sessionStartedAtMs) {
    existing.sessionStartedAtMs = fileBirthtimeMs || existing.activeStartMs || Date.now();
  }

  // Record exact T1 (startMs) and T4 (endMs) when hook fires at LLM step completion
  const pendingTiming = existing.pendingStepTiming && typeof existing.pendingStepTiming === 'object'
    ? existing.pendingStepTiming
    : null;
  const effLlmEndMs = Number(opts.llmEndMs || (pendingTiming && pendingTiming.llmEndMs) || 0);
  const effLlmStartMs = Number(opts.llmStartMs || (pendingTiming && pendingTiming.llmStartMs) || existing.activeStartMs || 0);

  if (effLlmEndMs > 0 && parsedSteps.length > 0) {
    for (let i = parsedSteps.length - 1; i >= 0; i--) {
      const s = parsedSteps[i];
      if (s.type === 'PLANNER_RESPONSE') {
        if (parsedSteps.slice(i + 1).some((entry) => entry.type === 'ERROR_MESSAGE')) break;
        const idxKey = String(s.step_index);
        const stepCreatedMs = s.created_at ? Date.parse(s.created_at) : 0;
        // Guard against applying a stale pending timing to an older historical step before the new step flushed
        const notStaleForStep = !stepCreatedMs || effLlmEndMs >= stepCreatedMs - 2000;
        if (!existing.stepTimings[idxKey] && notStaleForStep) {
          const rawStart = effLlmStartMs;
          const t1Ms =
            stepCreatedMs && rawStart && stepCreatedMs - rawStart > 2500
              ? stepCreatedMs
              : rawStart || stepCreatedMs || effLlmEndMs - 1000;
          const t4Ms = Math.max(t1Ms + 50, effLlmEndMs);
          const stepDurationMs = Math.max(50, t4Ms - t1Ms);
          existing.stepTimings[idxKey] = {
            logicalStartMs: rawStart || null,
            t1Ms,
            t4Ms,
            durationMs: stepDurationMs,
            precise: Boolean(rawStart > 0 && t1Ms === rawStart),
          };
          if (!opts.readOnly) {
            existing.pendingStepTiming = null;
          }
        }
        break;
      }
    }
  }
  if (!opts.readOnly && opts.status === 'generating') {
    existing.pendingStepTiming = null;
  }

  // Run passive interruption detection only during read/poll paths (active hooks already know live state)
  const passivelyInterrupted = opts.fromActiveHook
    ? false
    : detectPassiveInterruption(existing, parsedSteps);

  // Precise first-chunk / completion timestamps for decode-speed TPS (null on runtimes without node:sqlite)
  const dbStepTimings = readConversationDbStepTimings(conversationId, existing.transcriptPath);

  let totalOutputTokens = 0;
  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let compactionInputTokens = 0;
  let compactionCacheReadTokens = 0;
  let compactionOutputTokens = 0;
  let timedOutputTokens = 0;
  let timedDurationMs = 0;
  let e2eTimedSteps = 0;
  let e2ePeakTps = 0;
  let dbMatchedSteps = 0;
  let decodeQualifiedSteps = 0;
  let decodeOutputTokens = 0;
  let decodeGenMs = 0;
  let decodePeakTps = 0;
  const ttftList = [];

  let currentContextTokens = 0;
  let lastContextInputTokens = 0;
  let lastContextCacheReadTokens = 0;
  let lastContextOutputTokens = 0;
  let lastContextStepIdx = null;
  let lastContextDelta = null;
  let peakContextTokens = 0;
  let peakContextStepIdx = null;
  let stepsSinceLastCompaction = 0;
  let contextAfterLastCompaction = null;
  let pendingCompaction = null;
  const compactions = [];
  const contextHistory = [];
  let epochContextSamples = [];

  let prevCacheStepCtx = 0;
  let prevCacheTouchAtMs = 0;
  let lastCacheRefreshAtMs = 0;
  let lastCacheReadTokensStep = 0;
  let lastCacheStatus = 'none'; // 'none' | 'cold' | 'post_compaction' | 'hit' | 'miss'
  let lastCacheGapSec = null;
  let cacheMissCount = 0;
  let cacheMissRecomputeTokens = 0;
  let lastCacheMiss = null;
  let expectPostCompactionCache = false;

  let turnIndex = 0;
  let turnT0LogMs = 0;
  let turnFirstT1Ms = 0;
  let turnPrepMs = null;
  let turnStepSeq = 0;
  let turnFrozenFirstResponseMs = null;
  let turnFrozenFirstResponseStepIdx = null;
  let turnFrozenFirstResponseKind = null;
  let turnFrozenFirstTextStepMs = null;
  let turnFrozenFirstTextStepIdx = null;
  let turnFrozenFirstToolMs = null;
  let turnFrozenFirstToolStepIdx = null;
  let turnFrozenFirstThinkStepMs = null;
  let currentTurnGoal = existing.currentTurnGoal || '';
  let turnLatestVisibleNote = '';
  let turnLatestVisibleStepIdx = null;
  let turnLatestThinkingExcerpt = '';
  let turnLatestThinkingStepIdx = null;
  let turnLatestActionChips = [];
  let turnLatestPhaseIcon = '🧭';
  let turnLatestPhaseLabel = '准备出发';
  let turnLatestPhaseTone = 'muted';

  const completedTurnFirstResponseList = [];
  const completedTurnFirstTextList = [];
  const computedSteps = [];

  for (let i = 0; i < parsedSteps.length; i++) {
    const s = parsedSteps[i];
    if (s.type === 'USER_INPUT') {
      turnIndex += 1;
      turnT0LogMs = s.created_at ? Date.parse(s.created_at) : 0;
      turnFirstT1Ms = 0;
      turnPrepMs = null;
      turnStepSeq = 0;
      turnFrozenFirstResponseMs = null;
      turnFrozenFirstResponseStepIdx = null;
      turnFrozenFirstResponseKind = null;
      turnFrozenFirstTextStepMs = null;
      turnFrozenFirstTextStepIdx = null;
      turnFrozenFirstToolMs = null;
      turnFrozenFirstToolStepIdx = null;
      turnFrozenFirstThinkStepMs = null;
      const g = cleanUserGoal(s.content);
      if (g) currentTurnGoal = g;
      turnLatestVisibleNote = '';
      turnLatestVisibleStepIdx = null;
      turnLatestThinkingExcerpt = '';
      turnLatestThinkingStepIdx = null;
      turnLatestActionChips = [];
      turnLatestPhaseIcon = '🧭';
      turnLatestPhaseLabel = '构思路线';
      turnLatestPhaseTone = 'blue';
      continue;
    }

    if (s.type === 'CHECKPOINT') {
      const cIn = Number(s.input_tokens || 0);
      const cCache = Number(s.cache_read_tokens || 0);
      const cOut = Number(s.output_tokens || 0);
      const cPrompt = cIn + cCache;
      const cTotal = cPrompt + cOut;
      compactionInputTokens += cIn;
      compactionCacheReadTokens += cCache;
      compactionOutputTokens += cOut;
      totalInputTokens += cIn;
      totalCacheReadTokens += cCache;
      totalOutputTokens += cOut;

      const beforeCtx = Math.max(cPrompt, currentContextTokens || 0) || null;
      if (beforeCtx && beforeCtx > peakContextTokens) {
        peakContextTokens = beforeCtx;
        peakContextStepIdx = s.step_index;
      }

      const rawContent = String(s.content || '');
      const isCompactionResume = /resuming from a compaction/i.test(rawContent);
      const isLegacyCheckpoint = /\{\{\s*CHECKPOINT\s+\d+\s*\}\}/i.test(rawContent);
      const label = isCompactionResume
        ? '上下文自动压缩'
        : isLegacyCheckpoint
        ? '历史上下文截断'
        : '上下文压缩';

      const rec = {
        index: compactions.length + 1,
        stepIndex: s.step_index,
        turnIndex,
        atMs: s.created_at ? Date.parse(s.created_at) || 0 : 0,
        label,
        beforeContextTokens: beforeCtx,
        afterContextTokens: null,
        savedTokens: null,
        reductionPct: null,
        inputTokens: cIn,
        cacheReadTokens: cCache,
        outputTokens: cOut,
        totalTokens: cTotal,
      };
      compactions.push(rec);
      pendingCompaction = rec;
      stepsSinceLastCompaction = 0;
      contextAfterLastCompaction = null;
      epochContextSamples = [];
      expectPostCompactionCache = true;
      prevCacheStepCtx = 0;
      if (rec.atMs > 0) {
        prevCacheTouchAtMs = rec.atMs;
        lastCacheRefreshAtMs = rec.atMs;
      }
      if (beforeCtx) {
        contextHistory.push({ stepIndex: s.step_index, tokens: beforeCtx, isCompaction: true });
      }
      continue;
    }

    if (s.type !== 'PLANNER_RESPONSE') continue;
    turnStepSeq += 1;

    const outTok = Number(s.output_tokens || 0);
    const inTok = Number(s.input_tokens || 0);
    const cacheTok = Number(s.cache_read_tokens || 0);
    totalOutputTokens += outTok;
    totalInputTokens += inTok;
    totalCacheReadTokens += cacheTok;

    const stepCtx = inTok + cacheTok;
    if (stepCtx > 0) {
      if (pendingCompaction) {
        pendingCompaction.afterContextTokens = stepCtx;
        if (pendingCompaction.beforeContextTokens && pendingCompaction.beforeContextTokens > 0) {
          pendingCompaction.savedTokens = Math.max(0, pendingCompaction.beforeContextTokens - stepCtx);
          pendingCompaction.reductionPct = round1(
            (pendingCompaction.savedTokens / pendingCompaction.beforeContextTokens) * 100
          );
        }
        contextAfterLastCompaction = stepCtx;
        pendingCompaction = null;
      }
      lastContextDelta = currentContextTokens > 0 ? stepCtx - currentContextTokens : null;
      currentContextTokens = stepCtx;
      lastContextInputTokens = inTok;
      lastContextCacheReadTokens = cacheTok;
      lastContextOutputTokens = outTok;
      lastContextStepIdx = s.step_index;
      if (stepCtx > peakContextTokens) {
        peakContextTokens = stepCtx;
        peakContextStepIdx = s.step_index;
      }
      contextHistory.push({ stepIndex: s.step_index, tokens: stepCtx, isCompaction: false });
      epochContextSamples.push(stepCtx);
    }
    stepsSinceLastCompaction += 1;

    const idxKey = String(s.step_index);
    const stepCreatedMs = s.created_at ? Date.parse(s.created_at) : 0;
    const savedTiming = existing.stepTimings[idxKey];

    let t1Ms = 0;
    let t4Ms = 0;
    let durationMs = null;
    let precise = false;

    if (savedTiming && savedTiming.durationMs > 0) {
      t1Ms = savedTiming.t1Ms || savedTiming.startMs || stepCreatedMs;
      durationMs = savedTiming.durationMs;
      t4Ms = savedTiming.t4Ms || savedTiming.endMs || (t1Ms + durationMs);
      precise = Boolean(savedTiming.precise);
    } else if (stepCreatedMs > 0) {
      t1Ms = stepCreatedMs;
      const nextStep = parsedSteps[i + 1];
      if (nextStep && nextStep.created_at && nextStep.type !== 'USER_INPUT' && nextStep.type !== 'ERROR_MESSAGE') {
        const nextMs = Date.parse(nextStep.created_at);
        if (nextMs > stepCreatedMs && nextMs - stepCreatedMs <= 300000) {
          t4Ms = nextMs;
          durationMs = nextMs - stepCreatedMs;
        }
      } else if (i === parsedSteps.length - 1 && fileMtimeMs > stepCreatedMs && fileMtimeMs - stepCreatedMs <= 300000) {
        t4Ms = Math.round(fileMtimeMs);
        durationMs = Math.round(fileMtimeMs - stepCreatedMs);
      }
    }

    if (stepCtx > 0) {
      // Track prompt cache freshness & unexpected expiration / recompute events
      const stepEndOrStartMs = t4Ms || stepCreatedMs || 0;
      const gapSec =
        prevCacheTouchAtMs > 0 && stepCreatedMs > prevCacheTouchAtMs
          ? Math.round((stepCreatedMs - prevCacheTouchAtMs) / 1000)
          : null;
      lastCacheGapSec = gapSec;
      lastCacheReadTokensStep = cacheTok;

      if (expectPostCompactionCache) {
        lastCacheStatus = 'post_compaction';
        expectPostCompactionCache = false;
      } else if (prevCacheStepCtx === 0) {
        lastCacheStatus = cacheTok > 0 ? 'hit' : 'cold';
      } else if (prevCacheStepCtx >= 5000 && stepCtx >= 5000) {
        if (cacheTok >= prevCacheStepCtx * 0.5) {
          lastCacheStatus = 'hit';
        } else {
          lastCacheStatus = 'miss';
          cacheMissCount += 1;
          cacheMissRecomputeTokens += inTok;
          lastCacheMiss = {
            stepIndex: s.step_index,
            atMs: stepCreatedMs || stepEndOrStartMs,
            gapSec,
            recomputedTokens: inTok,
            prevContextTokens: prevCacheStepCtx,
            cacheReadTokens: cacheTok,
          };
        }
      } else {
        lastCacheStatus = cacheTok > 0 ? 'hit' : 'cold';
      }

      prevCacheStepCtx = stepCtx;
      if (stepEndOrStartMs > 0) {
        prevCacheTouchAtMs = stepEndOrStartMs;
        lastCacheRefreshAtMs = stepEndOrStartMs;
      }
    }

    if (turnStepSeq === 1 && t1Ms > 0) {
      turnFirstT1Ms = savedTiming?.logicalStartMs || t1Ms;
      if (precise && turnT0LogMs > 0 && t1Ms >= turnT0LogMs && t1Ms - turnT0LogMs < 30000) {
        turnPrepMs = Math.round(t1Ms - turnT0LogMs);
      }
    }

    // Legacy end-to-end estimate: request start -> tool dispatch / stop, so it includes time to first token.
    // Only used for TPS when agy's DB timestamps are unavailable (e.g. hooks on Node 20).
    let e2eTps = 0;
    if (outTok > 0 && durationMs !== null && durationMs > 0) {
      e2eTps = round1(outTok / (durationMs / 1000));
      timedOutputTokens += outTok;
      timedDurationMs += durationMs;
      e2eTimedSteps += 1;
      // Avoid tiny short bursts (e.g. 40 tokens in 0.1s) distorting peak TPS to 400+ tok/s
      if (durationMs >= 1500 && outTok >= 150 && e2eTps > e2ePeakTps) {
        e2ePeakTps = e2eTps;
      }
    }

    // Standard output speed: output tokens / (completed - first chunk); TTFT kept separately.
    // The DB step must report exactly the transcript's output tokens, otherwise it is ignored.
    const dbTiming = dbStepTimings ? dbStepTimings.get(idxKey) : null;
    const dbMatched = Boolean(dbTiming && dbTiming.outputTokens === outTok);
    let ttftMs = null;
    let genMs = null;
    let decodeTps = 0;
    if (dbMatched) {
      dbMatchedSteps += 1;
      ttftMs = Math.round(dbTiming.firstChunkMs - dbTiming.startMs);
      genMs = Math.round(dbTiming.endMs - dbTiming.firstChunkMs);
      ttftList.push(ttftMs);
      // Short steps arrive in one or two chunks, so their generation window is not measurable.
      if (outTok >= DECODE_MIN_OUTPUT_TOKENS && genMs >= DECODE_MIN_GEN_MS) {
        decodeTps = round1(outTok / (genMs / 1000));
        decodeOutputTokens += outTok;
        decodeGenMs += genMs;
        decodeQualifiedSteps += 1;
        if (decodeTps > decodePeakTps) decodePeakTps = decodeTps;
      }
    }

    const validText = hasValidVisibleText(s);
    const validThink = hasValidThinking(s);
    const hasTools = Array.isArray(s.tool_calls) && s.tool_calls.length > 0;
    const hasSubstantiveResponse = validText || hasTools || validThink || outTok > 0;

    const turnOriginMs = turnT0LogMs || turnFirstT1Ms || t1Ms;

    let frozeFirstResponseHere = false;
    let frozeFirstTextHere = false;
    let frozeFirstToolHere = false;

    if (
      turnFrozenFirstResponseMs === null &&
      hasSubstantiveResponse &&
      t4Ms > 0 &&
      turnOriginMs > 0 &&
      t4Ms >= turnOriginMs
    ) {
      turnFrozenFirstResponseMs = Math.round(t4Ms - turnOriginMs);
      turnFrozenFirstResponseStepIdx = s.step_index;
      turnFrozenFirstResponseKind = validText && hasTools
        ? 'text_and_tool'
        : validText
        ? 'text'
        : hasTools
        ? 'tool'
        : 'think';
      frozeFirstResponseHere = true;
      completedTurnFirstResponseList.push(turnFrozenFirstResponseMs);
    }

    if (turnFrozenFirstTextStepMs === null && validText && t4Ms > 0 && turnOriginMs > 0 && t4Ms >= turnOriginMs) {
      turnFrozenFirstTextStepMs = Math.round(t4Ms - turnOriginMs);
      turnFrozenFirstTextStepIdx = s.step_index;
      frozeFirstTextHere = true;
      completedTurnFirstTextList.push(turnFrozenFirstTextStepMs);
    }

    if (
      turnFrozenFirstTextStepMs === null &&
      turnFrozenFirstToolMs === null &&
      !validText &&
      hasTools &&
      t4Ms > 0 &&
      turnOriginMs > 0 &&
      t4Ms >= turnOriginMs
    ) {
      turnFrozenFirstToolMs = Math.round(t4Ms - turnOriginMs);
      turnFrozenFirstToolStepIdx = s.step_index;
      frozeFirstToolHere = true;
    }

    if (
      turnFrozenFirstTextStepMs === null &&
      turnFrozenFirstThinkStepMs === null &&
      validThink &&
      t4Ms > 0 &&
      turnOriginMs > 0 &&
      t4Ms >= turnOriginMs
    ) {
      turnFrozenFirstThinkStepMs = Math.round(t4Ms - turnOriginMs);
    }

    let stepKind = 'empty';
    if (validText && hasTools) stepKind = 'text_and_tool';
    else if (validText) stepKind = 'text_only';
    else if (hasTools) stepKind = 'tool_only';
    else if (validThink) stepKind = 'think_only';

    const visibleNote = validText ? cleanVisibleNote(s.content) : '';
    const thinkingExcerpt = validThink ? cleanThinkingExcerpt(s.thinking) : '';
    const activity = summarizeStepActivity(s, validText);

    if (visibleNote) {
      turnLatestVisibleNote = visibleNote;
      turnLatestVisibleStepIdx = s.step_index;
    }
    if (thinkingExcerpt) {
      turnLatestThinkingExcerpt = thinkingExcerpt;
      turnLatestThinkingStepIdx = s.step_index;
    }
    if (activity.actionChips.length > 0) {
      turnLatestActionChips = activity.actionChips;
    }
    turnLatestPhaseIcon = activity.phaseIcon;
    turnLatestPhaseLabel = activity.phaseLabel;
    turnLatestPhaseTone = activity.phaseTone;

    computedSteps.push({
      stepIndex: s.step_index,
      turnIndex,
      turnStepSeq,
      stepKind,
      hasValidText: validText,
      hasThinking: validThink,
      hasTools,
      hasEmbeddedUi: activity.hasEmbeddedUi,
      visibleNote,
      thinkingExcerpt,
      actionChips: activity.actionChips,
      phaseIcon: activity.phaseIcon,
      phaseLabel: activity.phaseLabel,
      phaseTone: activity.phaseTone,
      frozeFirstResponseHere,
      frozeFirstTextHere,
      frozeFirstToolHere,
      outputTokens: outTok,
      inputTokens: inTok,
      cacheReadTokens: cacheTok,
      stepTotalTokens: inTok + cacheTok + outTok,
      t1Ms: t1Ms || null,
      t2FirstTextMs: null,
      t3FirstRenderMs: null,
      t4EndMs: t4Ms || null,
      stepFirstTextMs: null,
      durationMs: durationMs !== null ? Math.round(durationMs) : null,
      tps: e2eTps,
      e2eTps,
      decodeTps,
      ttftMs,
      genMs,
      thinkingTokens: dbMatched ? dbTiming.thinkingTokens : null,
      answerTokens: dbMatched ? dbTiming.answerTokens : null,
      precise,
      atMs: t4Ms || stepCreatedMs || Date.now(),
    });
  }

  analyzeRetries(parsedSteps, existing, computedSteps);

  // Detect brand-new turn PreInvocation before transcript.jsonl flushes the new USER_INPUT entry
  const lastParsed = parsedSteps.length > 0 ? parsedSteps[parsedSteps.length - 1] : null;
  const isFreshTurnPreFlush =
    opts.status === 'generating' &&
    Boolean(opts.activeStartMs) &&
    previousStatus !== 'generating' &&
    previousStatus !== 'tool_running' &&
    Boolean(lastParsed && lastParsed.type !== 'USER_INPUT');

  if (isFreshTurnPreFlush) {
    turnIndex += 1;
    turnT0LogMs = opts.activeStartMs;
    turnFirstT1Ms = opts.activeStartMs;
    turnPrepMs = null;
    turnStepSeq = 0;
    turnFrozenFirstResponseMs = null;
    turnFrozenFirstResponseStepIdx = null;
    turnFrozenFirstResponseKind = null;
    turnFrozenFirstTextStepMs = null;
    turnFrozenFirstTextStepIdx = null;
    turnFrozenFirstToolMs = null;
    turnFrozenFirstToolStepIdx = null;
    turnFrozenFirstThinkStepMs = null;
    turnLatestVisibleNote = '';
    turnLatestVisibleStepIdx = null;
    turnLatestThinkingExcerpt = '';
    turnLatestThinkingStepIdx = null;
    turnLatestActionChips = [];
    turnLatestPhaseIcon = '🧭';
    turnLatestPhaseLabel = '构思路线';
    turnLatestPhaseTone = 'blue';
    existing.pendingFirstResponse = null;
  }

  // Adopt sub-millisecond PreToolUse first-response timestamp if Step 1 has not flushed to transcript yet
  const pendingFirstResp = existing.pendingFirstResponse && typeof existing.pendingFirstResponse === 'object'
    ? existing.pendingFirstResponse
    : null;
  const activeTurnRefOriginMs = turnT0LogMs || turnFirstT1Ms || existing.activeStartMs || 0;
  if (
    turnFrozenFirstResponseMs === null &&
    pendingFirstResp &&
    Number(pendingFirstResp.ms) > 0 &&
    (!activeTurnRefOriginMs || Number(pendingFirstResp.atMs || 0) >= activeTurnRefOriginMs - 2000)
  ) {
    turnFrozenFirstResponseMs = Math.round(Number(pendingFirstResp.ms));
    turnFrozenFirstResponseKind = pendingFirstResp.kind || 'tool';
    completedTurnFirstResponseList.push(turnFrozenFirstResponseMs);
  }
  if (!opts.readOnly && (turnFrozenFirstResponseStepIdx !== null || opts.status === 'idle' || opts.status === 'interrupted')) {
    existing.pendingFirstResponse = null;
  }

  const normState = normalizeStatus(existing);
  if (normState === 'generating') {
    const nextSeq = turnStepSeq + 1;
    existing.currentTurnStepSeq = nextSeq;
    if (nextSeq === 1 && existing.activeStartMs) {
      turnFirstT1Ms = existing.activeStartMs;
      if (turnT0LogMs > 0 && existing.activeStartMs >= turnT0LogMs && existing.activeStartMs - turnT0LogMs < 30000) {
        turnPrepMs = Math.round(existing.activeStartMs - turnT0LogMs);
      }
    }
    existing.waitingFirstResponse = turnFrozenFirstResponseMs === null;
    existing.waitingFirstValidText = turnFrozenFirstTextStepMs === null;
    existing.turnOriginMs =
      turnT0LogMs > 0 && turnFirstT1Ms > 0 && turnFirstT1Ms >= turnT0LogMs && turnFirstT1Ms - turnT0LogMs < 10000
        ? turnT0LogMs
        : (turnFirstT1Ms || existing.activeStartMs || turnT0LogMs || Date.now());
  } else if (normState === 'tool_running') {
    existing.currentTurnStepSeq = Math.max(1, turnStepSeq);
    // Once a tool is running in this turn, the model has ALREADY finished thinking & initiated action!
    if (turnFrozenFirstResponseMs === null) {
      const origin =
        turnT0LogMs > 0 && turnFirstT1Ms > 0 && turnFirstT1Ms >= turnT0LogMs && turnFirstT1Ms - turnT0LogMs < 10000
          ? turnT0LogMs
          : (turnFirstT1Ms || turnT0LogMs || existing.turnOriginMs || 0);
      const endRef = Number(effLlmEndMs || existing.lastHookAtMs || fileMtimeMs || Date.now());
      if (origin > 0 && endRef >= origin) {
        turnFrozenFirstResponseMs = Math.max(50, Math.round(endRef - origin));
        turnFrozenFirstResponseKind = 'tool';
      }
    }
    existing.waitingFirstResponse = false;
    existing.waitingFirstValidText = turnFrozenFirstTextStepMs === null;
    existing.turnOriginMs =
      turnT0LogMs > 0 && turnFirstT1Ms > 0 && turnFirstT1Ms >= turnT0LogMs && turnFirstT1Ms - turnT0LogMs < 10000
        ? turnT0LogMs
        : (turnFirstT1Ms || turnT0LogMs || null);
  } else {
    existing.currentTurnStepSeq = turnStepSeq;
    existing.waitingFirstResponse = false;
    existing.waitingFirstValidText = false;
    existing.turnOriginMs = null;
  }

  const lastStep = computedSteps.length > 0 ? computedSteps[computedSteps.length - 1] : null;
  const lastTimedStep = [...computedSteps].reverse().find((x) => x.durationMs !== null && x.durationMs > 0) || lastStep;
  // 'decode' once agy's DB timestamps line up with this transcript; otherwise the legacy end-to-end estimate.
  const tpsMode = dbMatchedSteps > 0 ? 'decode' : 'e2e';
  let avgTps = 0;
  let peakTps = 0;
  let lastTps = 0;
  let lastTpsStep = null;
  if (tpsMode === 'decode') {
    for (const st of computedSteps) st.tps = st.decodeTps;
    lastTpsStep = [...computedSteps].reverse().find((x) => x.decodeTps > 0) || null;
    lastTps = lastTpsStep ? lastTpsStep.decodeTps : 0;
    avgTps = decodeGenMs > 0 ? round1(decodeOutputTokens / (decodeGenMs / 1000)) : 0;
    peakTps = decodePeakTps;
  } else {
    lastTpsStep = lastTimedStep;
    lastTps = lastTimedStep ? lastTimedStep.tps : 0;
    avgTps = timedDurationMs > 0 ? round1(timedOutputTokens / (timedDurationMs / 1000)) : 0;
    peakTps = e2ePeakTps;
    if (peakTps === 0 && lastTimedStep && lastTimedStep.tps > 0) {
      peakTps = lastTimedStep.tps;
    }
  }
  const lastTtftStep = [...computedSteps].reverse().find((x) => x.ttftMs !== null && x.ttftMs !== undefined) || null;
  const sortedTtft = [...ttftList].sort((a, b) => a - b);
  const medianTtftMs = sortedTtft.length > 0 ? sortedTtft[Math.floor(sortedTtft.length / 2)] : null;

  const avgTurnFirstResponseMs = completedTurnFirstResponseList.length > 0
    ? Math.round(completedTurnFirstResponseList.reduce((a, b) => a + b, 0) / completedTurnFirstResponseList.length)
    : null;
  const avgTurnFirstTextStepMs = completedTurnFirstTextList.length > 0
    ? Math.round(completedTurnFirstTextList.reduce((a, b) => a + b, 0) / completedTurnFirstTextList.length)
    : null;

  const lastPromptTotal = lastStep ? lastStep.inputTokens + lastStep.cacheReadTokens : 0;
  const cacheHitRate = lastPromptTotal > 0 ? round1((lastStep.cacheReadTokens / lastPromptTotal) * 100) : 0;
  const totalPromptTokens = totalInputTokens + totalCacheReadTokens;
  const sessionCacheHitRate = totalPromptTokens > 0 ? round1((totalCacheReadTokens / totalPromptTokens) * 100) : 0;
  const totalTokens = totalInputTokens + totalCacheReadTokens + totalOutputTokens;
  const compactionTotalTokens = compactionInputTokens + compactionCacheReadTokens + compactionOutputTokens;
  const justCompacted = Boolean(pendingCompaction);
  const thresholdInfo = inferContextThreshold(existing.modelName, existing.rawModelId, compactions);
  const windowLimitTokens = inferContextWindowLimit(
    existing.modelName,
    existing.rawModelId,
    thresholdInfo.limitTokens
  );
  const activeContextTokens = justCompacted ? 0 : currentContextTokens;
  const windowUsagePct = windowLimitTokens > 0 && activeContextTokens > 0
    ? round1((activeContextTokens / windowLimitTokens) * 100)
    : 0;
  const compactionUsagePct = thresholdInfo.limitTokens > 0 && activeContextTokens > 0
    ? round1((activeContextTokens / thresholdInfo.limitTokens) * 100)
    : 0;
  const contextUsagePct = windowUsagePct;
  const remainingToThresholdTokens = thresholdInfo.limitTokens > 0 && !justCompacted
    ? Math.max(0, thresholdInfo.limitTokens - activeContextTokens)
    : null;
  const freeWindowTokens = windowLimitTokens > 0 && !justCompacted
    ? Math.max(0, windowLimitTokens - activeContextTokens)
    : windowLimitTokens;

  // Compute CLI `/context`-style category breakdown for the active epoch (normalized to exact API activeContextTokens)
  const breakdown = (() => {
    const freeToCompact = !justCompacted
      ? Math.max(0, thresholdInfo.limitTokens - activeContextTokens)
      : thresholdInfo.limitTokens;
    const compactReserve = Math.max(
      0,
      windowLimitTokens - Math.max(activeContextTokens, thresholdInfo.limitTokens)
    );
    if (justCompacted || activeContextTokens <= 0) {
      return {
        systemTokens: 0,
        checkpointTokens: justCompacted ? Number(pendingCompaction?.outputTokens || 0) : 0,
        userTokens: 0,
        assistantTokens: 0,
        toolTokens: 0,
        freeToCompactTokens: freeToCompact,
        compactReserveTokens: compactReserve,
        freeTotalTokens: freeWindowTokens,
      };
    }

    let lastCkptIdx = -1;
    let firstGlobalPlanner = null;
    let firstGlobalUserEst = 0;
    for (let idx = 0; idx < parsedSteps.length; idx++) {
      const e = parsedSteps[idx];
      if (e.type === 'CHECKPOINT') lastCkptIdx = idx;
      if (!firstGlobalPlanner) {
        if (e.type === 'USER_INPUT') firstGlobalUserEst += estimateTextTokens(e.content);
        if (e.type === 'PLANNER_RESPONSE' && Number(e.input_tokens || 0) + Number(e.cache_read_tokens || 0) > 0) {
          firstGlobalPlanner = e;
        }
      }
    }

    const firstGlobalCtx = firstGlobalPlanner
      ? Number(firstGlobalPlanner.input_tokens || 0) + Number(firstGlobalPlanner.cache_read_tokens || 0)
      : 0;
    const baseSystemEstimate = Math.max(0, firstGlobalCtx - firstGlobalUserEst);

    const epochEntries = lastCkptIdx >= 0 ? parsedSteps.slice(lastCkptIdx) : parsedSteps;
    const epochPlanners = epochEntries.filter(
      (e) => e.type === 'PLANNER_RESPONSE' && Number(e.input_tokens || 0) + Number(e.cache_read_tokens || 0) > 0
    );
    const firstEpochPlanner = epochPlanners[0] || null;
    const lastEpochPlanner = epochPlanners[epochPlanners.length - 1] || null;
    const firstEpochCtx = firstEpochPlanner
      ? Number(firstEpochPlanner.input_tokens || 0) + Number(firstEpochPlanner.cache_read_tokens || 0)
      : 0;

    let assistantRaw = 0;
    for (let idx = 0; idx < epochPlanners.length - 1; idx++) {
      assistantRaw += Number(epochPlanners[idx].output_tokens || 0);
    }

    let userRaw = 0;
    let firstEpochUserEst = 0;
    let seenFirstEpochPlanner = false;
    for (const e of epochEntries) {
      if (e === firstEpochPlanner) seenFirstEpochPlanner = true;
      if (e === lastEpochPlanner) break;
      if (e.type === 'USER_INPUT' || e.type === 'SYSTEM_MESSAGE') {
        const est = estimateTextTokens(e.content);
        userRaw += est;
        if (!seenFirstEpochPlanner) firstEpochUserEst += est;
      }
    }

    let systemTokens = 0;
    let checkpointTokens = 0;
    if (lastCkptIdx >= 0) {
      const ckptEntry = parsedSteps[lastCkptIdx];
      const ckptOut = Number(ckptEntry?.output_tokens || 0);
      const maxSysAfterCkpt = Math.max(0, firstEpochCtx - ckptOut - firstEpochUserEst);
      checkpointTokens = Math.min(
        activeContextTokens,
        ckptOut > 0 ? ckptOut : Math.max(0, firstEpochCtx - Math.min(baseSystemEstimate, firstEpochCtx))
      );
      systemTokens = Math.min(
        Math.max(0, activeContextTokens - checkpointTokens),
        baseSystemEstimate > 0 ? Math.min(baseSystemEstimate, maxSysAfterCkpt || firstEpochCtx) : maxSysAfterCkpt
      );
    } else {
      systemTokens = Math.min(activeContextTokens, Math.max(0, firstEpochCtx - firstEpochUserEst));
    }

    const remainAfterBase = Math.max(0, activeContextTokens - systemTokens - checkpointTokens);
    let userTokens = Math.min(remainAfterBase, userRaw);
    const remainAfterUser = Math.max(0, remainAfterBase - userTokens);
    let assistantTokens = Math.min(remainAfterUser, assistantRaw);
    const toolTokens = Math.max(0, remainAfterUser - assistantTokens);

    return {
      systemTokens,
      checkpointTokens,
      userTokens,
      assistantTokens,
      toolTokens,
      freeToCompactTokens: freeToCompact,
      compactReserveTokens: compactReserve,
      freeTotalTokens: freeWindowTokens,
    };
  })();

  // Attribute largest single-step context jumps in the active epoch (Top 3 heavy consumers)
  const topConsumers = (() => {
    if (justCompacted || activeContextTokens <= 0) return [];
    let lastCkptIdx = -1;
    for (let idx = 0; idx < parsedSteps.length; idx++) {
      if (parsedSteps[idx].type === 'CHECKPOINT') lastCkptIdx = idx;
    }
    const epoch = lastCkptIdx >= 0 ? parsedSteps.slice(lastCkptIdx + 1) : parsedSteps;
    const jumps = [];
    let prevPlanner = null;
    let prevCtx = 0;
    let betweenUserHasMedia = false;
    let betweenUserSnippet = '';

    for (const e of epoch) {
      if (e.type === 'USER_INPUT') {
        if (Array.isArray(e.media) && e.media.length > 0) betweenUserHasMedia = true;
        const g = cleanUserGoal(e.content, 34);
        if (g) betweenUserSnippet = g;
        continue;
      }
      if (e.type !== 'PLANNER_RESPONSE') continue;
      const curCtx = Number(e.input_tokens || 0) + Number(e.cache_read_tokens || 0);
      if (curCtx <= 0) continue;

      if (prevPlanner && prevCtx > 0) {
        const delta = curCtx - prevCtx;
        if (delta >= 1500) {
          const act = summarizeStepActivity(prevPlanner, hasValidVisibleText(prevPlanner));
          const cleanChips = (act.actionChips || [])
            .map((c) => String(c).replace(/^[^\w\u4e00-\u9fa5/.\-([<]+\s*/, '').trim())
            .filter(Boolean);
          let label = '';
          let kind = 'tool';
          if (betweenUserHasMedia && cleanChips.length === 0) {
            label = betweenUserSnippet ? `附带图片 · ${betweenUserSnippet}` : '用户附带图片输入';
            kind = 'user';
          } else if (cleanChips.length > 0) {
            label = cleanChips.slice(0, 2).join(' + ');
            if (betweenUserHasMedia) label = `附带图片 + ${label}`;
            kind = 'tool';
          } else if (betweenUserSnippet) {
            label = `用户输入 · ${betweenUserSnippet}`;
            kind = 'user';
          } else {
            label = `模型推理回复 (Step #${prevPlanner.step_index})`;
            kind = 'assistant';
          }
          jumps.push({
            stepIndex: prevPlanner.step_index,
            deltaTokens: delta,
            label: label.length > 44 ? `${label.slice(0, 43)}…` : label,
            kind,
          });
        }
      }

      prevPlanner = e;
      prevCtx = curCtx;
      betweenUserHasMedia = false;
      betweenUserSnippet = '';
    }

    return jumps.sort((a, b) => b.deltaTokens - a.deltaTokens).slice(0, 3);
  })();
  const contextGrowthSinceCompaction =
    compactions.length > 0 && !justCompacted && contextAfterLastCompaction !== null
      ? activeContextTokens - contextAfterLastCompaction
      : null;
  let recentAvgGrowthTokens = null;
  if (!justCompacted && epochContextSamples.length >= 2) {
    const windowSamples = epochContextSamples.slice(-10);
    const spanDelta = windowSamples[windowSamples.length - 1] - windowSamples[0];
    const spanSteps = windowSamples.length - 1;
    if (spanSteps > 0 && spanDelta > 0) {
      recentAvgGrowthTokens = Math.round(spanDelta / spanSteps);
    }
  }
  const estimatedStepsToCompaction =
    !justCompacted &&
    remainingToThresholdTokens !== null &&
    remainingToThresholdTokens > 0 &&
    recentAvgGrowthTokens > 0
      ? Math.max(1, Math.round(remainingToThresholdTokens / recentAvgGrowthTokens))
      : null;
  const totalCompactionSavedTokens = compactions.reduce((sum, c) => sum + Number(c.savedTokens || 0), 0);
  const latestCompaction = compactions.length > 0 ? compactions[compactions.length - 1] : null;
  const cacheTtlProfile = inferCacheTtlProfile(existing.modelName, existing.rawModelId);

  existing.totalTokens = totalTokens;
  existing.totalOutputTokens = totalOutputTokens;
  existing.totalInputTokens = totalInputTokens;
  existing.totalCacheReadTokens = totalCacheReadTokens;
  existing.sessionCacheHitRate = sessionCacheHitRate;
  existing.compactionInputTokens = compactionInputTokens;
  existing.compactionCacheReadTokens = compactionCacheReadTokens;
  existing.compactionOutputTokens = compactionOutputTokens;
  existing.compactionTotalTokens = compactionTotalTokens;
  existing.cacheStats = {
    mode: cacheTtlProfile.mode,
    windowLabel: cacheTtlProfile.label,
    hint: cacheTtlProfile.hint,
    hotWindowMs: cacheTtlProfile.hotWindowMs,
    softWindowMs: cacheTtlProfile.softWindowMs,
    expireWindowMs: cacheTtlProfile.expireWindowMs,
    lastRefreshAtMs: lastCacheRefreshAtMs || null,
    lastStatus: lastCacheStatus,
    lastHitRate: justCompacted ? 0 : cacheHitRate,
    lastReadTokens: lastCacheReadTokensStep,
    lastGapSec: lastCacheGapSec,
    missCount: cacheMissCount,
    missRecomputeTokens: cacheMissRecomputeTokens,
    lastMiss: lastCacheMiss,
    totalCacheReadTokens,
    sessionCacheHitRate,
  };
  existing.contextStats = {
    currentTokens: activeContextTokens,
    inputTokens: justCompacted ? 0 : lastContextInputTokens,
    cacheReadTokens: justCompacted ? 0 : lastContextCacheReadTokens,
    lastOutputTokens: justCompacted ? (pendingCompaction?.outputTokens || 0) : lastContextOutputTokens,
    estimatedNextTokens: justCompacted
      ? (pendingCompaction?.outputTokens || 0)
      : (activeContextTokens + lastContextOutputTokens),
    cacheHitRate: justCompacted ? 0 : cacheHitRate,
    lastDeltaTokens: justCompacted ? null : lastContextDelta,
    lastStepIndex: lastContextStepIdx,
    peakTokens: peakContextTokens,
    peakStepIndex: peakContextStepIdx,
    windowLimitTokens,
    windowUsagePct,
    freeWindowTokens,
    compactionThresholdTokens: thresholdInfo.limitTokens,
    compactionUsagePct,
    referenceLimitTokens: thresholdInfo.limitTokens,
    referenceLimitSource: thresholdInfo.source,
    referenceLimitLabel: thresholdInfo.label,
    usagePct: contextUsagePct,
    remainingToLimitTokens: remainingToThresholdTokens,
    breakdown,
    topConsumers,
    stepsSinceLastCompaction,
    growthSinceCompaction: contextGrowthSinceCompaction,
    recentAvgGrowthTokens,
    estimatedStepsToCompaction,
    history: contextHistory.slice(-40),
    justCompacted,
  };
  existing.compactionStats = {
    count: compactions.length,
    totalSavedTokens: totalCompactionSavedTokens,
    totalCompactionTokens: compactionTotalTokens,
    totalCompactionInputTokens: compactionInputTokens,
    totalCompactionCacheReadTokens: compactionCacheReadTokens,
    totalCompactionOutputTokens: compactionOutputTokens,
    justCompacted,
    latest: latestCompaction,
    records: compactions.slice(-20),
  };
  existing.totalInferenceMs = Math.round(timedDurationMs);
  existing.stepCount = computedSteps.length;
  existing.tpsMode = tpsMode;
  existing.lastTps = lastTps;
  existing.avgTps = avgTps;
  existing.peakTps = peakTps;
  existing.tpsSampleSteps = tpsMode === 'decode' ? decodeQualifiedSteps : e2eTimedSteps;
  existing.lastTpsStepIdx = lastTpsStep ? lastTpsStep.stepIndex : null;
  existing.lastTpsOutputTokens = lastTpsStep ? lastTpsStep.outputTokens : 0;
  existing.lastTpsTtftMs = lastTpsStep && lastTpsStep.ttftMs !== undefined ? lastTpsStep.ttftMs : null;
  existing.lastTpsGenMs = lastTpsStep && lastTpsStep.genMs !== undefined ? lastTpsStep.genMs : null;
  existing.lastTtftMs = lastTtftStep ? lastTtftStep.ttftMs : null;
  existing.medianTtftMs = medianTtftMs;

  existing.turnPrepMs = turnPrepMs;
  existing.turnModelFirstTextMs = null;
  existing.turnRenderDelayMs = null;
  existing.turnVisibleTtfrMs = null;
  existing.turnFirstResponseMs = turnFrozenFirstResponseMs;
  existing.turnFirstResponseStepIdx = turnFrozenFirstResponseStepIdx;
  existing.turnFirstResponseKind = turnFrozenFirstResponseKind;
  existing.avgTurnFirstResponseMs = avgTurnFirstResponseMs;
  existing.turnFirstTextStepMs = turnFrozenFirstTextStepMs;
  existing.turnFirstTextStepIdx = turnFrozenFirstTextStepIdx;
  existing.avgTurnFirstTextStepMs = avgTurnFirstTextStepMs;
  existing.turnFirstToolMs = turnFrozenFirstToolMs;
  existing.turnFirstToolStepIdx = turnFrozenFirstToolStepIdx;
  existing.turnFirstThinkStepMs = turnFrozenFirstThinkStepMs;

  existing.lastDurationMs = lastTimedStep && lastTimedStep.durationMs !== null ? lastTimedStep.durationMs : null;
  existing.lastStepPrecise = lastTimedStep ? Boolean(lastTimedStep.precise) : false;
  existing.lastOutputTokens = lastTimedStep ? lastTimedStep.outputTokens : 0;
  existing.lastInputTokens = lastStep ? lastStep.inputTokens : 0;
  existing.lastCacheReadTokens = lastStep ? lastStep.cacheReadTokens : 0;
  existing.cacheHitRate = cacheHitRate;
  existing.currentTurnIndex = turnIndex;
  existing.currentTurnGoal = currentTurnGoal || existing.title || '';
  existing.latestVisibleNote = turnLatestVisibleNote;
  existing.latestVisibleStepIdx = turnLatestVisibleStepIdx;
  existing.latestThinkingExcerpt = turnLatestThinkingExcerpt;
  existing.latestThinkingStepIdx = turnLatestThinkingStepIdx;
  existing.latestActionChips = turnLatestActionChips;
  existing.latestPhaseIcon = turnLatestPhaseIcon;
  existing.latestPhaseLabel = turnLatestPhaseLabel;
  existing.latestPhaseTone = turnLatestPhaseTone;
  existing.steps = computedSteps.slice(-MAX_STEPS_KEPT);

  if (passivelyInterrupted && existing.interruptedAtMs) {
    existing.updatedAtMs = existing.interruptedAtMs;
  } else {
    existing.updatedAtMs = opts.touch === false
      ? (existing.stoppedAtMs || (lastStep ? lastStep.atMs : fileMtimeMs || existing.updatedAtMs || Date.now()))
      : Date.now();
  }

  if (!existing.title) {
    existing.title = `会话 ${String(conversationId).slice(0, 8)}`;
  }

  // Persist if normal hook write OR if passive detector newly resolved a stuck active session into `interrupted`
  if (!opts.readOnly || passivelyInterrupted) {
    writeJsonAtomic(getSessionFile(conversationId), existing);
    updateSessionIndex(existing);
  }
  return existing;
}

/**
 * O(1) sub-millisecond fast path for `PreToolUse` (`pre_tool`) hook:
 * Avoids scanning `transcript.jsonl`, 16MB SQLite `.db`/`.db-wal` files, or `index.json`
 * on the hot tool-dispatch path (especially when multiple tools fire in parallel).
 * Captures exact pre-tool `llmStartMs` / `llmEndMs` into `pendingStepTiming` and flips
 * `generating -> tool_running` once; subsequent parallel tool calls in the same step are no-ops.
 */
function markToolRunningFast(conversationId, opts = {}) {
  if (!conversationId) return null;
  const sessionFile = getSessionFile(conversationId);
  const existing = readJsonSafe(sessionFile, null);
  const nowMs = Number(opts.nowMs || Date.now());

  if (existing && existing.status === 'tool_running') {
    return existing;
  }

  const next = existing || {
    conversationId,
    title: '',
    surface: opts.transcriptPath ? detectSurface(opts.transcriptPath) : 'AGY',
    modelName: opts.modelName && opts.modelName !== 'auto' ? opts.modelName : '',
    cwd: opts.cwd || (Array.isArray(opts.workspacePaths) && opts.workspacePaths[0]) || '',
    transcriptPath: opts.transcriptPath || '',
    sessionStartedAtMs: nowMs,
    schemaVersion: 3,
    status: 'tool_running',
    activeStartMs: null,
    stepTimings: {},
    steps: [],
    updatedAtMs: nowMs,
  };

  if (!existing || existing.status === 'generating') {
    next.status = 'tool_running';
    next.lastHookAtMs = nowMs;
    next.updatedAtMs = nowMs;
    next.interruptedAtMs = null;
    next.interruptedElapsedMs = null;
    next.interruptedReason = '';
    next.pendingStepTiming = {
      llmStartMs: existing && existing.activeStartMs ? existing.activeStartMs : null,
      llmEndMs: nowMs,
    };
    // Freeze first-step response (TTFA) immediately at PreToolUse so tool run time is never counted as waiting
    next.waitingFirstResponse = false;
    if (next.turnFirstResponseMs === null || next.turnFirstResponseMs === undefined) {
      const origin = Number((existing && (existing.turnOriginMs || existing.activeStartMs)) || nowMs);
      const respMs = Math.max(50, Math.round(nowMs - origin));
      next.turnFirstResponseMs = respMs;
      next.turnFirstResponseKind = 'tool';
      next.pendingFirstResponse = {
        originMs: origin,
        ms: respMs,
        kind: 'tool',
        atMs: nowMs,
      };
    }
    next.activeStartMs = null;
    if (opts.transcriptPath && !next.transcriptPath) {
      next.transcriptPath = opts.transcriptPath;
      next.surface = detectSurface(opts.transcriptPath);
    }
    if (opts.cwd && !next.cwd) next.cwd = opts.cwd;
    if (opts.modelName && opts.modelName !== 'auto') next.modelName = opts.modelName;
    writeJsonAtomic(sessionFile, next);
  }
  return next;
}

/**
 * Layer 4 manual fallback: allows UI/CLI to explicitly freeze a hung session into `interrupted`.
 */
function markSessionInterrupted(conversationId, reason = '手动停止计时') {
  if (!conversationId) return null;
  const existing = readJsonSafe(getSessionFile(conversationId), null);
  const nowMs = Date.now();
  const refStart = Number(
    (existing && (existing.activeStartMs || existing.currentInvocationStartMs || existing.turnOriginMs)) || 0
  );
  detailCache.delete(conversationId);
  return syncSessionFromTranscript(conversationId, {
    status: 'interrupted',
    interruptedAtMs: nowMs,
    interruptedElapsedMs: refStart > 0 ? Math.max(0, nowMs - refStart) : null,
    interruptedReason: reason,
    activeStartMs: null,
  });
}

function toSummary(session, nowMs = Date.now()) {
  const status = normalizeStatus(session);
  const rSum = retrySummary(session, nowMs);
  const startedAtMs = Number(session.sessionStartedAtMs || 0);
  const updatedAtMs = Number(session.updatedAtMs || 0);
  const totalOut = Number(session.totalOutputTokens || 0);
  const totalIn = Number(session.totalInputTokens || 0);
  const totalCache = Number(session.totalCacheReadTokens || 0);
  const totalTokens = Number(session.totalTokens || (totalIn + totalCache + totalOut));

  // Freeze session total duration immediately upon idle, interrupted, or stalled!
  const isLiveSession =
    (status === 'generating' || status === 'tool_running') && rSum.healthState !== 'stalled';
  const freezeRefMs = Number(
    session.interruptedAtMs || session.stoppedAtMs || session.lastProgressAtMs || updatedAtMs || nowMs
  );
  const endRefMs = isLiveSession ? nowMs : Math.max(startedAtMs, freezeRefMs);
  const sessionSpanMs = startedAtMs > 0 ? Math.max(0, endRefMs - startedAtMs) : 0;

  const hasTurnFirstRespField = session.turnFirstResponseMs !== undefined;
  const fallbackFirstRespMs = hasTurnFirstRespField
    ? session.turnFirstResponseMs
    : (session.turnFirstToolMs ?? session.turnFirstTextStepMs ?? null);
  const waitingFirstResponse =
    isLiveSession &&
    status === 'generating' &&
    (session.waitingFirstResponse !== undefined
      ? Boolean(session.waitingFirstResponse)
      : fallbackFirstRespMs === null);
  const waitingFirstValidText =
    isLiveSession && Boolean(session.waitingFirstValidText);
  const rawOriginMs = Number(session.turnOriginMs || session.activeStartMs || nowMs);
  const turnOriginMs = (waitingFirstResponse || waitingFirstValidText) ? rawOriginMs : null;
  const activeStartMs = (status === 'generating' && isLiveSession) ? Number(session.activeStartMs || nowMs) : null;

  const waitingFirstResponseElapsedMs = waitingFirstResponse && rawOriginMs
    ? Math.max(0, nowMs - rawOriginMs)
    : null;
  const waitingFirstTextElapsedMs = waitingFirstValidText && rawOriginMs
    ? Math.max(0, nowMs - rawOriginMs)
    : null;
  const activeStepElapsedMs = (status === 'generating' && activeStartMs)
    ? Math.max(0, nowMs - activeStartMs)
    : null;

  return {
    ...rSum,
    schemaVersion: Number(session.schemaVersion || 0),
    conversationId: session.conversationId,
    title: session.title || `会话 ${String(session.conversationId).slice(0, 8)}`,
    surface: session.surface || 'AGY',
    modelName: session.modelName || '',
    cwd: session.cwd || '',
    sessionStartedAtMs: startedAtMs,
    sessionSpanMs,
    isLiveSession,
    totalInferenceMs: Number(session.totalInferenceMs || 0),
    status,
    activeStartMs,
    turnOriginMs,
    waitingFirstResponse,
    waitingFirstResponseElapsedMs,
    waitingFirstValidText,
    waitingFirstTextElapsedMs,
    activeStepElapsedMs,
    currentTurnStepSeq: Number(session.currentTurnStepSeq || 0),
    turnPrepMs: session.turnPrepMs !== undefined ? session.turnPrepMs : null,
    turnModelFirstTextMs: null,
    turnRenderDelayMs: null,
    turnVisibleTtfrMs: null,
    turnFirstResponseMs: fallbackFirstRespMs,
    turnFirstResponseStepIdx: session.turnFirstResponseStepIdx ?? null,
    turnFirstResponseKind: session.turnFirstResponseKind || null,
    avgTurnFirstResponseMs: session.avgTurnFirstResponseMs !== undefined
      ? session.avgTurnFirstResponseMs
      : (session.avgTurnFirstTextStepMs !== undefined ? session.avgTurnFirstTextStepMs : null),
    turnFirstTextStepMs: session.turnFirstTextStepMs !== undefined ? session.turnFirstTextStepMs : null,
    turnFirstTextStepIdx: session.turnFirstTextStepIdx ?? null,
    avgTurnFirstTextStepMs: session.avgTurnFirstTextStepMs !== undefined ? session.avgTurnFirstTextStepMs : null,
    turnFirstToolMs: session.turnFirstToolMs !== undefined ? session.turnFirstToolMs : null,
    turnFirstToolStepIdx: session.turnFirstToolStepIdx ?? null,
    turnFirstThinkStepMs: session.turnFirstThinkStepMs !== undefined ? session.turnFirstThinkStepMs : null,
    lastDurationMs: session.lastDurationMs !== undefined ? session.lastDurationMs : null,
    lastStepPrecise: Boolean(session.lastStepPrecise),
    lastTps: Number(session.lastTps || 0),
    avgTps: Number(session.avgTps || 0),
    peakTps: Number(session.peakTps || 0),
    tpsMode: session.tpsMode === 'decode' ? 'decode' : 'e2e',
    tpsSampleSteps: Number(session.tpsSampleSteps || 0),
    lastTpsStepIdx: session.lastTpsStepIdx ?? null,
    lastTpsOutputTokens: Number(session.lastTpsOutputTokens || 0),
    lastTpsTtftMs: session.lastTpsTtftMs ?? null,
    lastTpsGenMs: session.lastTpsGenMs ?? null,
    lastTtftMs: session.lastTtftMs ?? null,
    medianTtftMs: session.medianTtftMs ?? null,
    lastOutputTokens: Number(session.lastOutputTokens || 0),
    lastInputTokens: Number(session.lastInputTokens || 0),
    lastCacheReadTokens: Number(session.lastCacheReadTokens || 0),
    totalTokens,
    totalInputTokens: totalIn,
    totalCacheReadTokens: totalCache,
    totalOutputTokens: totalOut,
    sessionCacheHitRate: Number(session.sessionCacheHitRate || 0),
    compactionTotalTokens: Number(session.compactionTotalTokens || 0),
    cacheStats: (() => {
      const c = session.cacheStats || {};
      const lastRefreshAtMs = Number(c.lastRefreshAtMs || 0) || null;
      const idleMs = lastRefreshAtMs ? Math.max(0, nowMs - lastRefreshAtMs) : null;
      return {
        mode: c.mode || 'implicit',
        windowLabel: c.windowLabel || '隐式缓存 · 3m 热区',
        hint: c.hint || '隐式缓存无固定 TTL：0–3m 高命中，3–5m 衰减，>30m 基本失效',
        hotWindowMs: Number(c.hotWindowMs || 3 * 60 * 1000),
        softWindowMs: Number(c.softWindowMs || 5 * 60 * 1000),
        expireWindowMs: Number(c.expireWindowMs || 30 * 60 * 1000),
        lastRefreshAtMs,
        idleMs,
        isActiveKeepAlive: isLiveSession,
        lastStatus: c.lastStatus || 'none',
        lastHitRate: Number(c.lastHitRate || 0),
        lastReadTokens: Number(c.lastReadTokens || 0),
        lastGapSec: c.lastGapSec ?? null,
        missCount: Number(c.missCount || 0),
        missRecomputeTokens: Number(c.missRecomputeTokens || 0),
        lastMiss: c.lastMiss || null,
        totalCacheReadTokens: totalCache,
        sessionCacheHitRate: Number(session.sessionCacheHitRate || 0),
      };
    })(),
    contextStats: session.contextStats || {
      currentTokens: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      lastOutputTokens: 0,
      estimatedNextTokens: 0,
      cacheHitRate: 0,
      lastDeltaTokens: null,
      lastStepIndex: null,
      peakTokens: 0,
      peakStepIndex: null,
      windowLimitTokens: 1000000,
      windowUsagePct: 0,
      freeWindowTokens: 1000000,
      compactionThresholdTokens: 512000,
      compactionUsagePct: 0,
      referenceLimitTokens: 512000,
      referenceLimitSource: 'default',
      referenceLimitLabel: '参考压缩线',
      usagePct: 0,
      remainingToLimitTokens: 512000,
      breakdown: {
        systemTokens: 0,
        checkpointTokens: 0,
        userTokens: 0,
        assistantTokens: 0,
        toolTokens: 0,
        freeToCompactTokens: 512000,
        compactReserveTokens: 488000,
        freeTotalTokens: 1000000,
      },
      topConsumers: [],
      stepsSinceLastCompaction: 0,
      growthSinceCompaction: null,
      recentAvgGrowthTokens: null,
      estimatedStepsToCompaction: null,
      history: [],
      justCompacted: false,
    },
    compactionStats: session.compactionStats || {
      count: 0,
      totalSavedTokens: 0,
      totalCompactionTokens: 0,
      totalCompactionInputTokens: 0,
      totalCompactionCacheReadTokens: 0,
      totalCompactionOutputTokens: 0,
      justCompacted: false,
      latest: null,
      records: [],
    },
    cacheHitRate: Number(session.cacheHitRate || 0),
    stepCount: Number(session.stepCount || 0),
    currentTurnIndex: Number(session.currentTurnIndex || 0),
    currentTurnGoal: session.currentTurnGoal || session.title || '',
    latestVisibleNote: session.latestVisibleNote || '',
    latestVisibleStepIdx: session.latestVisibleStepIdx ?? null,
    latestThinkingExcerpt: session.latestThinkingExcerpt || '',
    latestThinkingStepIdx: session.latestThinkingStepIdx ?? null,
    latestActionChips: Array.isArray(session.latestActionChips) ? session.latestActionChips : [],
    latestPhaseIcon: session.latestPhaseIcon || '☕',
    latestPhaseLabel: session.latestPhaseLabel || '随时待命',
    latestPhaseTone: session.latestPhaseTone || 'muted',
    updatedAtMs,
  };
}

function updateSessionIndex(updatedSession) {
  const nowMs = Date.now();
  const idx = readJsonSafe(INDEX_FILE, { sessions: [], updatedAtMs: 0 }) || { sessions: [] };
  const map = new Map();
  if (Array.isArray(idx.sessions)) {
    for (const s of idx.sessions) {
      if (s && s.conversationId) {
        map.set(s.conversationId, toSummary(s, nowMs));
      }
    }
  }
  if (updatedSession && updatedSession.conversationId) {
    map.set(updatedSession.conversationId, toSummary(updatedSession, nowMs));
  }
  const sorted = Array.from(map.values())
    .sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0))
    .slice(0, MAX_INDEX_SESSIONS);

  writeJsonAtomic(INDEX_FILE, {
    schemaVersion: 3,
    updatedAtMs: nowMs,
    sessions: sorted,
  });
  return sorted;
}

function findTranscriptPath(conversationId) {
  if (!conversationId) return '';
  const surfaces = ['antigravity', 'antigravity-ide', 'antigravity-cli'];
  for (const dir of surfaces) {
    const candidate = path.join(
      GEMINI_DIR,
      dir,
      'brain',
      conversationId,
      '.system_generated',
      'logs',
      'transcript.jsonl'
    );
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

const detailCache = new Map();
let knownTranscripts = new Map();
let lastBrainScanMs = 0;

function hydrateRecentBrainSessions(maxPerSurface = 6, force = false) {
  if (!force && Date.now() - lastBrainScanMs < 4000) return;
  lastBrainScanMs = Date.now();
  const next = new Map();
  for (const surface of ['antigravity', 'antigravity-ide', 'antigravity-cli']) {
    const brainDir = path.join(GEMINI_DIR, surface, 'brain');
    try {
      const entries = fs.readdirSync(brainDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^[0-9a-f-]{8,}$/i.test(entry.name))
        .map((entry) => {
          const transcript = path.join(brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
          try { return { id: entry.name, transcript, time: fs.statSync(transcript).mtimeMs }; } catch { return null; }
        }).filter(Boolean).sort((a, b) => b.time - a.time).slice(0, maxPerSurface);
      for (const entry of entries) next.set(entry.id, entry.transcript);
    } catch {}
  }
  knownTranscripts = next;
}

function getSessionDetail(conversationId, autoHydrate = true) {
  if (!conversationId) return null;
  const sessionFile = getSessionFile(conversationId);
  let session = readJsonSafe(sessionFile, null);
  const transcript = (session && session.transcriptPath) || knownTranscripts.get(conversationId) || findTranscriptPath(conversationId);

  if (autoHydrate && transcript) {
    try {
      const stat = fs.statSync(resolveFastTranscriptFile(transcript));
      const sessionStat = fs.existsSync(sessionFile) ? fs.statSync(sessionFile) : null;
      const isCurrentlyActive = session && (session.status === 'generating' || session.status === 'tool_running');
      const dbSig = conversationDbSignature(conversationId, transcript).sigKey;
      const key = [stat.mtimeMs, stat.size, sessionStat?.mtimeMs, sessionStat?.size, dbSig].join(':');
      const cached = detailCache.get(conversationId);
      // Do not serve stale cached 'generating' state without checking DB cancel / ownerPid liveness!
      if (!isCurrentlyActive && cached && cached.key === key) {
        session = cached.session;
      } else {
        session = syncSessionFromTranscript(conversationId, { transcriptPath: transcript, touch: false, readOnly: true });
        detailCache.set(conversationId, { key, session });
        if (detailCache.size > SESSION_CACHE_MAX) detailCache.delete(detailCache.keys().next().value);
      }
    } catch {}
  } else if (session && (session.status === 'generating' || session.status === 'tool_running')) {
    session = syncSessionFromTranscript(conversationId, { touch: false, readOnly: true });
  }

  if (!session) return null;
  return { ...toSummary(session), steps: session.steps || [] };
}

function listRecentSessions({ hydrate = false } = {}) {
  if (hydrate || !lastBrainScanMs) hydrateRecentBrainSessions();
  const ids = new Set(knownTranscripts.keys());
  try {
    // Only recently written session files can reach the top list. Hydrating every historical file made each
    // poll O(all sessions) and, past the detail cache size, re-parsed every transcript on every poll.
    const recentFiles = fs.readdirSync(SESSIONS_DIR)
      .filter((file) => file.endsWith('.json'))
      .map((file) => {
        try {
          return { id: file.slice(0, -5), mtimeMs: fs.statSync(path.join(SESSIONS_DIR, file)).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, LIST_CANDIDATE_SESSIONS);
    for (const entry of recentFiles) ids.add(entry.id);
  } catch {}
  return Array.from(ids).map((id) => getSessionDetail(id, true)).filter(Boolean)
    .map(({ steps, ...summary }) => summary)
    .sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0))
    .slice(0, MAX_INDEX_SESSIONS);
}

module.exports = {
  TPS_ROOT,
  SESSIONS_DIR,
  INDEX_FILE,
  PREFS_FILE,
  readJsonSafe,
  writeJsonAtomic,
  isPidAlive,
  inspectConversationDbCancel,
  markSessionInterrupted,
  getPrefs,
  setPrefs,
  toggleTokenFormat,
  formatTokensByMode,
  getDurationTier,
  formatDurationSpan,
  formatStartClock,
  getSessionFile,
  markToolRunningFast,
  syncSessionFromTranscript,
  hydrateRecentBrainSessions,
  getSessionDetail,
  listRecentSessions,
  normalizeStatus,
  round1,
  parsePlannerStepMetadata,
  readConversationDbStepTimings,
  DECODE_MIN_OUTPUT_TOKENS,
  DECODE_MIN_GEN_MS,
};
