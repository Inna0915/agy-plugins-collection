import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getStateDir } from './ls-client.mjs';
import { buildCardSummary, buildCoordinatorReport } from './transcript.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_SCRIPT = join(HERE, '..', 'scripts', 'codex-thread-runner.mjs');

const SUPPORTED_ENGINES = new Set(['antigravity', 'codex']);
const VALID_TASK_KINDS = new Set(['implement', 'review', 'plan']);
const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const CODEX_DESKTOP_URL_RE = /^codex:\/\/threads\/[0-9a-f-]{8,64}$/i;

const codexTelemetryCache = new Map(); // cacheKey -> { stamp, telemetry }
const codexTimelineCache = new Map(); // cacheKey -> { stamp, parsed }
const codexActivityCache = new Map(); // cacheKey -> { stamp, activity }

export function normalizeEngine(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (SUPPORTED_ENGINES.has(s)) return s;
  return 'antigravity';
}

export function isCodexThread(t) {
  return normalizeEngine(t?.engine) === 'codex';
}

export function normalizeCodexTaskKind(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return VALID_TASK_KINDS.has(s) ? s : 'implement';
}

export function normalizeCodexEffort(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return VALID_EFFORTS.has(s) ? s : '';
}

function safeFileStamp(filePath) {
  if (!filePath) return '';
  try {
    const st = statSync(filePath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '';
  }
}

export function isCodexProcessAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export function resolveCodexScriptsDir() {
  const envDir = String(process.env.PROJECT_THREADS_CODEX_SCRIPTS_DIR || '').trim();
  if (envDir && existsSync(join(envDir, 'Invoke-CodexTask.ps1'))) {
    return envDir;
  }
  const geminiDir = process.env.ANTIGRAVITY_GEMINI_DIR || join(homedir(), '.gemini');
  const home = homedir();
  const candidates = [
    join(geminiDir, 'config', 'plugins', 'worker-dispatch', 'skills', 'codex-worker', 'scripts'),
    join(home, '.claude', 'skills', 'codex-worker', 'scripts'),
    'D:/dev/github/dsh-plugins-collection/skills/codex-worker/scripts',
  ];
  for (const c of candidates) {
    if (c && existsSync(join(c, 'Invoke-CodexTask.ps1'))) {
      return c;
    }
  }
  return '';
}

export function resolvePwshExe() {
  const envExe = String(process.env.PROJECT_THREADS_PWSH_EXE || '').trim();
  if (envExe && existsSync(envExe)) return envExe;
  const candidates = [
    'C:/Program Files/PowerShell/7/pwsh.exe',
    'C:/Program Files/PowerShell/7-preview/pwsh.exe',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return process.platform === 'win32' ? 'pwsh.exe' : 'pwsh';
}

export function readCodexConfigDefaults() {
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  const cfgPath = join(codexHome, 'config.toml');
  const defaults = {
    configPath: cfgPath,
    model: '',
    effort: '',
    serviceTier: '',
    contextWindow: 400000,
    autoCompactTokenLimit: 340000,
  };
  if (!existsSync(cfgPath)) return defaults;
  try {
    const raw = readFileSync(cfgPath, 'utf8');
    // Read only top-level keys (before first [section] header)
    const topLines = [];
    for (const line of raw.split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) break;
      topLines.push(line);
    }
    const topText = topLines.join('\n');
    const strVal = (key) => {
      const m = topText.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm'));
      return m ? m[1].trim() : '';
    };
    const numVal = (key) => {
      const m = topText.match(new RegExp(`^\\s*${key}\\s*=\\s*(\\d+)`, 'm'));
      return m ? Number(m[1]) : 0;
    };
    defaults.model = strVal('model');
    defaults.effort = strVal('model_reasoning_effort');
    defaults.serviceTier = strVal('service_tier');
    const win = numVal('model_context_window');
    if (win > 0) defaults.contextWindow = win;
    const lim = numVal('model_auto_compact_token_limit');
    if (lim > 0) defaults.autoCompactTokenLimit = lim;
  } catch {
    // Ignore parse errors
  }
  return defaults;
}

export function getCodexEngineInfo() {
  const scriptsDir = resolveCodexScriptsDir();
  const pwshExe = resolvePwshExe();
  const defaults = readCodexConfigDefaults();
  return {
    available: Boolean(scriptsDir),
    scriptsDir,
    pwshExe,
    defaults,
  };
}

export function buildCodexTaskName(threadId, title) {
  const slug = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);
  const base = `codex-${String(threadId || 'thr').replace(/[^a-zA-Z0-9_-]/g, '')}${slug ? `-${slug}` : ''}`;
  return base.slice(0, 72);
}

export function buildCodexInitialPrompt({
  threadId,
  title,
  taskPrompt,
  taskKind = 'implement',
  memoryText = '',
  structuredHandoff = false,
}) {
  const sections = [`# [${threadId}] ${String(title || 'Codex Task').trim()}`, ''];
  if (memoryText && memoryText.trim()) {
    sections.push('## Inherited Project Memory', memoryText.trim(), '');
  }
  sections.push('## Task Instructions', String(taskPrompt || '').trim(), '');
  if (!structuredHandoff) {
    sections.push(
      '## Completion & Handback Protocol',
      `1. Task kind is \`${taskKind}\`. Stay strictly within the allowed workspace boundaries.`,
      '2. End your final message with a concise structured `### Thread Summary` section listing key findings/changes, modified files or verification commands, and any reusable project-wide notes for Shared Memory.',
    );
  }
  return sections.join('\n');
}

export function buildCodexInvokeArgs({
  invokeScript,
  projectDir,
  codexTask,
  promptFile,
  taskKind = 'implement',
  model = '',
  effort = '',
  fast = false,
  structuredHandoff = false,
  createWorktree = true,
  sessionId = '',
  skipGitRepoCheck = false,
}) {
  const args = [
    '-NonInteractive',
    '-NoProfile',
    '-File',
    invokeScript,
    '-Project',
    projectDir,
    '-Task',
    codexTask,
    '-PromptFile',
    promptFile,
    '-Caller',
    'Antigravity',
    '-ReportStartup',
  ];

  const isResume = Boolean(String(sessionId || '').trim());
  if (isResume) {
    // On resume, Invoke-CodexTask.ps1 automatically inherits taskKind, mode, model, effort, serviceTier, and worktree cwd
    args.push('-SessionId', String(sessionId).trim());
  } else {
    const kind = normalizeCodexTaskKind(taskKind);
    args.push('-TaskKind', kind);
    if (kind === 'review' || kind === 'plan') {
      args.push('-Mode', 'read-only', '-WorktreeMode', 'off');
    } else {
      args.push('-Mode', 'yolo');
      if (createWorktree === false) {
        args.push('-NoWorktree');
      } else {
        args.push('-WorktreeMode', 'auto');
      }
    }

    const reqModel = String(model || '').trim();
    if (reqModel && !/^(?:inherit|auto|default|config)$/i.test(reqModel)) {
      args.push('-Model', reqModel);
    }
    const reqEffort = normalizeCodexEffort(effort);
    if (reqEffort) {
      args.push('-Effort', reqEffort);
    }
    if (fast) {
      args.push('-Fast');
    }
    if (structuredHandoff) {
      args.push('-StructuredHandoff');
    }
  }

  if (skipGitRepoCheck) {
    args.push('-SkipGitRepoCheck');
  }

  return args;
}

export function launchCodexRun({
  threadId,
  round = 1,
  projectDir,
  codexTask,
  promptText,
  userMessage = '',
  taskKind = 'implement',
  model = '',
  effort = '',
  fast = false,
  structuredHandoff = false,
  createWorktree = true,
  sessionId = '',
}) {
  const scriptsDir = resolveCodexScriptsDir();
  if (!scriptsDir) {
    throw new Error(
      'Codex worker scripts not found. Ensure the worker-dispatch plugin (skills/codex-worker/scripts/Invoke-CodexTask.ps1) is installed.',
    );
  }
  const invokeScript = join(scriptsDir, 'Invoke-CodexTask.ps1');
  const pwshExe = resolvePwshExe();

  const promptsDir = join(getStateDir(), 'codex-prompts');
  mkdirSync(promptsDir, { recursive: true });
  const stamp = Date.now();
  const promptFile = join(promptsDir, `${threadId}-r${round}-${stamp}.md`);
  const reqFile = join(promptsDir, `${threadId}-r${round}-${stamp}.req.json`);
  writeFileSync(promptFile, String(promptText || ''), 'utf8');

  const skipGitRepoCheck = !existsSync(join(projectDir, '.git'));
  const invokeArgs = buildCodexInvokeArgs({
    invokeScript,
    projectDir,
    codexTask,
    promptFile,
    taskKind,
    model,
    effort,
    fast,
    structuredHandoff,
    createWorktree,
    sessionId,
    skipGitRepoCheck,
  });

  const reqPayload = {
    threadId,
    round,
    projectDir,
    codexTask,
    promptFile,
    pwshExe,
    invokeArgs,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(reqFile, JSON.stringify(reqPayload, null, 2), 'utf8');

  const child = spawn(process.execPath, [RUNNER_SCRIPT, reqFile], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env },
  });
  child.unref();

  return {
    round,
    runId: '',
    statusFile: '',
    eventsFile: '',
    finalFile: '',
    promptFile,
    reqFile,
    userMessage: String(userMessage || ''),
    launcherPid: child.pid || 0,
    runnerPid: 0,
    state: 'starting',
    exitCode: null,
    errorKind: '',
    error: '',
    startedAt: reqPayload.createdAt,
    finishedAt: '',
  };
}

function readJsonSafe(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function discoverLatestStatusFile(projectDir, codexTask, knownStatusFiles = new Set(), minMtimeMs = 0) {
  if (!projectDir || !codexTask) return '';
  const logDir = join(projectDir, 'work', 'alpha', 'logs', codexTask);
  if (!existsSync(logDir)) return '';
  try {
    const candidates = readdirSync(logDir)
      .filter((f) => f.endsWith('.status.json'))
      .map((f) => {
        const full = join(logDir, f);
        try {
          return { full, mtimeMs: statSync(full).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const fresh = candidates.find(
      (c) => !knownStatusFiles.has(c.full) && (!minMtimeMs || c.mtimeMs >= minMtimeMs - 2000),
    );
    return fresh?.full || '';
  } catch {
    return '';
  }
}

export function formatCodexModelLabel({ model = '', effort = '', serviceTier = '' } = {}) {
  const m = String(model || '').trim();
  const e = String(effort || '').trim();
  const tier = String(serviceTier || '').trim().toLowerCase();
  const base = m || 'Codex';
  const extras = [];
  if (e) extras.push(e);
  if (tier === 'fast' || tier === 'priority') extras.push('fast');
  return extras.length ? `${base} (${extras.join(' · ')})` : base;
}

export function formatCodexHandoffMarkdown(handoff, fallbackRaw = '') {
  if (!handoff || typeof handoff !== 'object') {
    const raw = String(fallbackRaw || '').trim();
    if (raw.startsWith('{') && raw.endsWith('}')) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && typeof parsed.summary === 'string') {
          return formatCodexHandoffMarkdown(parsed, '');
        }
      } catch {
        // Keep raw markdown
      }
    }
    return raw;
  }

  const lines = [];
  const status = String(handoff.status || 'done').trim();
  if (status && status !== 'done') {
    lines.push(`> **Handoff Status**: \`${status}\``, '');
  }
  if (handoff.summary) {
    lines.push('## Summary', String(handoff.summary).trim(), '');
  }
  if (handoff.root_cause) {
    lines.push('## Root Cause', String(handoff.root_cause).trim(), '');
  }
  if (Array.isArray(handoff.changed_files) && handoff.changed_files.length > 0) {
    lines.push('## Changed Files');
    for (const f of handoff.changed_files) {
      if (typeof f === 'string') {
        lines.push(`- \`${f}\``);
      } else if (f && typeof f === 'object') {
        const p = f.path || f.file || JSON.stringify(f);
        const note = f.reason || f.summary || f.change || '';
        lines.push(note ? `- \`${p}\` — ${note}` : `- \`${p}\``);
      }
    }
    lines.push('');
  }
  if (Array.isArray(handoff.findings) && handoff.findings.length > 0) {
    lines.push('## Findings');
    for (const item of handoff.findings) {
      if (typeof item === 'string') {
        lines.push(`- ${item}`);
      } else if (item && typeof item === 'object') {
        const sev = item.severity ? `[${item.severity}] ` : '';
        const loc = item.location || item.file ? `\`${item.location || item.file}\` ` : '';
        const msg = item.message || item.title || item.description || JSON.stringify(item);
        lines.push(`- ${sev}${loc}${msg}`);
      }
    }
    lines.push('');
  }
  if (Array.isArray(handoff.verification) && handoff.verification.length > 0) {
    lines.push('## Verification');
    for (const v of handoff.verification) {
      if (typeof v === 'string') {
        lines.push(`- ${v}`);
      } else if (v && typeof v === 'object') {
        const cmd = v.command ? `\`${String(v.command).slice(0, 140)}\`` : '';
        const code = Number.isInteger(v.exit_code) ? ` (exit ${v.exit_code})` : '';
        const res = v.result ? `: ${v.result}` : '';
        lines.push(`- ${cmd}${code}${res}`.trim());
      }
    }
    lines.push('');
  }
  if (Array.isArray(handoff.guards_and_fallbacks) && handoff.guards_and_fallbacks.length > 0) {
    lines.push('## Guards & Fallbacks');
    for (const g of handoff.guards_and_fallbacks) {
      lines.push(`- ${typeof g === 'string' ? g : JSON.stringify(g)}`);
    }
    lines.push('');
  }
  if (Array.isArray(handoff.risks) && handoff.risks.length > 0) {
    lines.push('## Risks');
    for (const r of handoff.risks) {
      lines.push(`- ${typeof r === 'string' ? r : JSON.stringify(r)}`);
    }
    lines.push('');
  }
  if (Array.isArray(handoff.open_questions) && handoff.open_questions.length > 0) {
    lines.push('## Open Questions / Needs Input');
    for (const q of handoff.open_questions) {
      lines.push(`- ${typeof q === 'string' ? q : JSON.stringify(q)}`);
    }
    lines.push('');
  }
  if (Array.isArray(handoff.next_steps) && handoff.next_steps.length > 0) {
    lines.push('## Next Steps');
    for (const n of handoff.next_steps) {
      lines.push(`- ${typeof n === 'string' ? n : JSON.stringify(n)}`);
    }
    lines.push('');
  }

  // Always end with a concise `### Thread Summary` so `buildCoordinatorReport` preserves it intact
  lines.push('### Thread Summary');
  lines.push(`- **Status**: \`${status}\``);
  if (handoff.summary) {
    lines.push(`- **Summary**: ${String(handoff.summary).trim()}`);
  }
  if (Array.isArray(handoff.changed_files) && handoff.changed_files.length > 0) {
    lines.push(`- **Changed Files**: ${handoff.changed_files.length} file(s)`);
  }
  return lines.join('\n').trim();
}

export function formatCodexErrorBanner(status) {
  if (!status) return '';
  const kind = String(status.errorKind || '').trim();
  const rawErr = String(status.error || '').trim();
  if (kind === 'active_writer') {
    return (
      `[active_writer] Codex 会话正在 Codex Desktop 中打开或被占用，当前无法并发续接。` +
      `请切回 Codex Desktop 继续对话，或在面板中新建一条 Codex 线程。\n${rawErr}`
    ).trim();
  }
  if (kind === 'capacity') {
    return `[capacity] Codex 服务端暂时满载，稍后发送追问即可使用原会话重试。\n${rawErr}`.trim();
  }
  if (kind === 'invalid_handoff') {
    return `[invalid_handoff] 结构化回执校验未通过，可发送追问要求 Codex 补齐字段。\n${rawErr}`.trim();
  }
  if (status.state === 'timeout' || status.exitCode === 124) {
    return `[timeout] Codex 本轮执行超时（exit 124）。${rawErr ? `\n${rawErr}` : ''}`;
  }
  if (kind || rawErr) {
    return `[${kind || 'error'}] ${rawErr || `Codex exited with code ${status.exitCode}`}`;
  }
  if (status.state === 'failed' || (Number.isInteger(status.exitCode) && status.exitCode !== 0)) {
    return `Codex 本轮执行失败（exitCode=${status.exitCode ?? '?'}）`;
  }
  return '';
}

function readRunFinalMarkdown(run, status) {
  if (status?.handoff && typeof status.handoff === 'object') {
    return formatCodexHandoffMarkdown(status.handoff);
  }
  const finalPath = run?.finalFile || status?.final || '';
  if (finalPath && existsSync(finalPath)) {
    try {
      const raw = readFileSync(finalPath, 'utf8').trim();
      if (raw) {
        return formatCodexHandoffMarkdown(null, raw);
      }
    } catch {
      // Ignore read errors
    }
  }
  // Fallback: last agent_message in events.jsonl
  const evPath = run?.eventsFile || status?.events || '';
  if (evPath && existsSync(evPath)) {
    try {
      const lines = readFileSync(evPath, 'utf8').split(/\r?\n/).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const ev = JSON.parse(lines[i]);
          if (ev?.type === 'item.completed' && ev?.item?.type === 'agent_message' && ev?.item?.text) {
            return formatCodexHandoffMarkdown(null, String(ev.item.text).trim());
          }
        } catch {
          // Ignore malformed line
        }
      }
    } catch {
      // Ignore read errors
    }
  }
  return '';
}

function summarizeShellCommand(cmdRaw) {
  const raw = String(cmdRaw || '').trim();
  if (!raw) return 'shell';
  // Unwrap `"C:\Program Files\PowerShell\7\pwsh.exe" -Command "..."` wrapper
  let inner = raw;
  const pwshMatch = raw.match(/pwsh(?:\.exe)?["']?\s+(?:-[A-Za-z]+\s+)*-Command\s+["']([\s\S]+?)["']\s*$/i);
  if (pwshMatch && pwshMatch[1]) {
    inner = pwshMatch[1].replace(/\\"/g, '"').trim();
  }
  const firstLine = inner.split(/\r?\n/)[0].trim();
  return firstLine.length > 84 ? `${firstLine.slice(0, 81)}…` : firstLine;
}

function parseCodexRunEvents(eventsFile) {
  if (!eventsFile || !existsSync(eventsFile)) {
    return { entries: [], calls: [], activeTool: '', activeToolObj: null, toolStepCount: 0, turnUsage: null };
  }
  let raw = '';
  try {
    raw = readFileSync(eventsFile, 'utf8');
  } catch {
    return { entries: [], calls: [], activeTool: '', activeToolObj: null, toolStepCount: 0, turnUsage: null };
  }

  const entries = [];
  const calls = [];
  const byItemId = new Map();
  let activeTool = '';
  let activeToolObj = null;
  let toolStepCount = 0;
  let turnUsage = null;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!ev || typeof ev !== 'object') continue;

    if (ev.type === 'turn.completed' && ev.usage && typeof ev.usage === 'object') {
      turnUsage = ev.usage;
      continue;
    }

    const item = ev.item;
    if (!item || typeof item !== 'object') continue;

    if (item.type === 'command_execution') {
      const target = summarizeShellCommand(item.command);
      const isDone = ev.type === 'item.completed' || item.status === 'completed' || item.exit_code !== null;
      const out = String(item.aggregated_output || '').trim().slice(0, 900);
      const existing = item.id ? byItemId.get(item.id) : null;
      if (existing) {
        existing.running = !isDone;
        existing.done = isDone;
        if (out) existing.outputPreview = out;
      } else {
        const entry = {
          kind: 'tool',
          category: 'cmd',
          name: 'command_execution',
          rawTarget: target,
          target,
          shortFile: '',
          lineRange: '',
          fileUri: '',
          label: target,
          detail: String(item.command || ''),
          outputPreview: out,
          running: !isDone,
          done: isDone,
        };
        entries.push(entry);
        calls.push(entry);
        if (item.id) byItemId.set(item.id, entry);
        toolStepCount++;
      }
      activeTool = target;
      activeToolObj = { category: 'cmd', target };
      continue;
    }

    if (item.type === 'mcp_tool_call') {
      const target = [item.server, item.tool].filter(Boolean).join('.') || 'mcp';
      const isDone = ev.type === 'item.completed' || item.status === 'completed';
      const out = item.result
        ? (typeof item.result === 'string' ? item.result : JSON.stringify(item.result)).slice(0, 900)
        : '';
      const existing = item.id ? byItemId.get(item.id) : null;
      if (existing) {
        existing.running = !isDone;
        existing.done = isDone;
        if (out) existing.outputPreview = out;
      } else {
        const entry = {
          kind: 'tool',
          category: 'mcp',
          name: 'mcp_tool_call',
          rawTarget: target,
          target,
          shortFile: '',
          lineRange: '',
          fileUri: '',
          label: target,
          detail: item.arguments ? JSON.stringify(item.arguments).slice(0, 240) : '',
          outputPreview: out,
          running: !isDone,
          done: isDone,
        };
        entries.push(entry);
        calls.push(entry);
        if (item.id) byItemId.set(item.id, entry);
        toolStepCount++;
      }
      activeTool = target;
      activeToolObj = { category: 'mcp', target };
      continue;
    }

    if (item.type === 'reasoning' && ev.type === 'item.completed') {
      const txt = String(item.text || '').trim();
      if (txt) {
        entries.push({
          kind: 'thought',
          durationSec: 1,
          text: txt.slice(0, 1200),
        });
      }
      continue;
    }

    if (item.type === 'agent_message' && ev.type === 'item.completed') {
      const txt = String(item.text || '').trim();
      if (txt) {
        entries.push({
          kind: 'note',
          stepId: `codex-note-${entries.length}`,
          text: txt,
        });
      }
    }
  }

  return { entries, calls, activeTool, activeToolObj, toolStepCount, turnUsage };
}

function round1(num) {
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.round(num * 10) / 10;
}

export function extractCodexTelemetry(t) {
  const cx = t?.codex;
  if (!cx) return null;

  const defaults = readCodexConfigDefaults();
  const nativePath = String(cx.nativeSession || '').trim();
  const runs = Array.isArray(cx.runs) ? cx.runs : [];
  const eventsFiles = runs.map((r) => r?.eventsFile).filter(Boolean);

  const stamp = [
    nativePath ? `n:${safeFileStamp(nativePath)}` : '',
    ...eventsFiles.map((f) => `e:${safeFileStamp(f)}`),
    `cfg:${defaults.autoCompactTokenLimit}:${defaults.contextWindow}`,
  ]
    .filter(Boolean)
    .join('|');
  if (!stamp) return null;

  const cacheKey = `${t.threadId}|${nativePath || eventsFiles.join(',')}`;
  const cached = codexTelemetryCache.get(cacheKey);
  if (cached && cached.stamp === stamp) {
    return cached.telemetry;
  }

  let totalTokens = 0;
  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalOutputTokens = 0;
  let currentContextTokens = 0;
  let peakContextTokens = 0;
  let compactionCount = 0;
  let windowLimitTokens = defaults.contextWindow || 400000;
  let compactionThresholdTokens = defaults.autoCompactTokenLimit || 340000;
  let compactionThresholdSource = 'estimated';
  let parsedFromRollout = false;

  if (nativePath && existsSync(nativePath)) {
    try {
      const raw = readFileSync(nativePath, 'utf8');
      let lastTokenInfo = null;
      let lastCompactionBefore = 0;
      let pendingCompaction = false;
      for (const line of raw.split(/\r?\n/)) {
        if (!line) continue;
        // Fast string pre-filter before JSON.parse on multi-MB rollout files
        if (!line.includes('token_count') && !line.includes('"compacted"')) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (obj?.type === 'compacted') {
          compactionCount += 1;
          pendingCompaction = true;
          const prevCtx =
            Number(obj?.payload?.latest_token_usage_record?.last_token_usage?.input_tokens) ||
            currentContextTokens;
          if (prevCtx > 0) {
            lastCompactionBefore = prevCtx;
            if (prevCtx > peakContextTokens) peakContextTokens = prevCtx;
          }
          continue;
        }
        if (obj?.type === 'event_msg' && obj?.payload?.type === 'token_count' && obj?.payload?.info) {
          const info = obj.payload.info;
          lastTokenInfo = info;
          const lastIn = Number(info?.last_token_usage?.input_tokens || 0);
          if (lastIn > 0) {
            pendingCompaction = false;
            currentContextTokens = lastIn;
            if (lastIn > peakContextTokens) peakContextTokens = lastIn;
          }
          const win = Number(info?.model_context_window || 0);
          if (win > 0) windowLimitTokens = win;
        }
      }

      if (lastTokenInfo?.total_token_usage) {
        parsedFromRollout = true;
        const u = lastTokenInfo.total_token_usage;
        const rawIn = Number(u.input_tokens || 0);
        const cachedIn = Number(u.cached_input_tokens || 0);
        const outTok = Number(u.output_tokens || 0);
        totalCacheReadTokens = cachedIn;
        // In OpenAI/Codex usage, input_tokens already includes cached_input_tokens
        totalInputTokens = Math.max(0, rawIn - cachedIn);
        totalOutputTokens = outTok;
        totalTokens = Number(u.total_tokens || 0) || rawIn + outTok;
        if (pendingCompaction) {
          currentContextTokens = 0;
        }
        if (lastCompactionBefore > 0 && !defaults.autoCompactTokenLimit) {
          compactionThresholdTokens = lastCompactionBefore;
          compactionThresholdSource = 'observed';
        } else if (defaults.autoCompactTokenLimit > 0) {
          compactionThresholdTokens = Math.min(defaults.autoCompactTokenLimit, windowLimitTokens);
          compactionThresholdSource = 'configured';
        } else {
          compactionThresholdTokens = Math.round(windowLimitTokens * 0.85);
        }
      }
    } catch {
      // Fall back to events.jsonl below
    }
  }

  if (!parsedFromRollout && eventsFiles.length > 0) {
    for (const ef of eventsFiles) {
      const parsed = parseCodexRunEvents(ef);
      if (parsed.turnUsage) {
        const rawIn = Number(parsed.turnUsage.input_tokens || 0);
        const cachedIn = Number(parsed.turnUsage.cached_input_tokens || 0);
        const outTok = Number(parsed.turnUsage.output_tokens || 0);
        totalCacheReadTokens += cachedIn;
        totalInputTokens += Math.max(0, rawIn - cachedIn);
        totalOutputTokens += outTok;
        totalTokens += rawIn + outTok;
      }
    }
  }

  if (totalTokens === 0 && currentContextTokens === 0 && compactionCount === 0) {
    return null;
  }

  const compactionUsagePct =
    compactionThresholdTokens > 0 && currentContextTokens > 0
      ? round1((currentContextTokens / compactionThresholdTokens) * 100)
      : 0;

  const telemetry = {
    totalTokens,
    totalInputTokens,
    totalCacheReadTokens,
    totalOutputTokens,
    currentContextTokens,
    peakContextTokens: Math.max(peakContextTokens, currentContextTokens),
    compactionThresholdTokens,
    compactionThresholdSource,
    compactionUsagePct,
    windowLimitTokens,
    compactionCount,
    justCompacted: false,
  };

  codexTelemetryCache.set(cacheKey, { stamp, telemetry });
  if (codexTelemetryCache.size > 120) {
    codexTelemetryCache.delete(codexTelemetryCache.keys().next().value);
  }
  return telemetry;
}

export async function syncCodexThreadRecord(t, { inspectGitFn = null } = {}) {
  if (!isCodexThread(t)) return { dirty: false, isRunning: false, latestRun: null, latestStatus: null };
  if (!t.codex || typeof t.codex !== 'object') {
    t.codex = { taskName: buildCodexTaskName(t.threadId, t.title), taskKind: 'implement', runs: [] };
  }
  const cx = t.codex;
  const runs = Array.isArray(cx.runs) ? cx.runs : [];
  cx.runs = runs;

  let dirty = false;
  const projectDir = cx.sourceProject || t.workspacePath || t.repoRoot || '';
  const knownStatuses = new Set(runs.map((r) => r?.statusFile).filter(Boolean));
  const latestRun = runs[runs.length - 1] || null;

  if (latestRun && !latestRun.statusFile) {
    const runStartMs = Date.parse(latestRun.startedAt || '') || 0;
    const discovered = discoverLatestStatusFile(projectDir, cx.taskName, knownStatuses, runStartMs);
    if (discovered) {
      latestRun.statusFile = discovered;
      dirty = true;
    }
  }

  const latestStatus = latestRun?.statusFile ? readJsonSafe(latestRun.statusFile) : null;
  if (latestRun && latestStatus) {
    const assignRun = (key, val) => {
      if (val !== undefined && val !== null && val !== '' && latestRun[key] !== val) {
        latestRun[key] = val;
        dirty = true;
      }
    };
    assignRun('runId', latestStatus.runId);
    assignRun('eventsFile', latestStatus.events);
    assignRun('finalFile', latestStatus.final);
    assignRun('runnerPid', latestStatus.runnerPid);
    assignRun('state', latestStatus.state);
    assignRun('finishedAt', latestStatus.finishedAt);
    assignRun('errorKind', latestStatus.errorKind);
    assignRun('error', latestStatus.error);
    if (Number.isInteger(latestStatus.exitCode) && latestRun.exitCode !== latestStatus.exitCode) {
      latestRun.exitCode = latestStatus.exitCode;
      dirty = true;
    }

    if (latestStatus.sessionId && cx.sessionId !== latestStatus.sessionId) {
      cx.sessionId = latestStatus.sessionId;
      dirty = true;
    }
    if (latestStatus.desktopUrl && cx.desktopUrl !== latestStatus.desktopUrl) {
      cx.desktopUrl = latestStatus.desktopUrl;
      dirty = true;
    }
    if (latestStatus.nativeSession && cx.nativeSession !== latestStatus.nativeSession) {
      cx.nativeSession = latestStatus.nativeSession;
      dirty = true;
    }
    if (latestStatus.errorKind !== undefined && cx.lastErrorKind !== (latestStatus.errorKind || '')) {
      cx.lastErrorKind = latestStatus.errorKind || '';
      dirty = true;
    }
    if (latestStatus.error !== undefined && cx.lastError !== (latestStatus.error || '')) {
      cx.lastError = latestStatus.error || '';
      dirty = true;
    }

    // Applied model / effort / serviceTier
    const appSet = latestStatus.appliedSettings || {};
    const cfgDefaults = readCodexConfigDefaults();
    const effModel = appSet.model || latestStatus.requestedModel || cx.requestedModel || cfgDefaults.model || '';
    const effEffort = appSet.effort || latestStatus.requestedEffort || cx.requestedEffort || cfgDefaults.effort || '';
    const effTier = appSet.serviceTier || latestStatus.requestedServiceTier || (cx.fast ? 'fast' : '');
    const displayLabel = formatCodexModelLabel({ model: effModel, effort: effEffort, serviceTier: effTier });
    if (displayLabel && t.modelDisplayName !== displayLabel) {
      t.modelDisplayName = displayLabel;
      dirty = true;
    }
    if (effModel && t.resolvedModel !== effModel) {
      t.resolvedModel = effModel;
      dirty = true;
    }

    // Worktree info (unless already explicitly cleaned via archive/cleanup)
    if (!cx.worktreeCleaned && latestStatus.worktree && typeof latestStatus.worktree === 'object') {
      const wt = latestStatus.worktree;
      if (wt.used) {
        const wtDir = wt.worktreeRoot || wt.effectiveProject || '';
        if (wtDir && existsSync(wtDir) && t.worktreePath !== wtDir) {
          t.worktreePath = wtDir;
          dirty = true;
        }
        if (wt.branch && t.branch !== wt.branch) {
          t.branch = wt.branch;
          dirty = true;
        }
        if (wt.topology && cx.worktreeTopology !== wt.topology) {
          cx.worktreeTopology = wt.topology;
          dirty = true;
        }
        if (Array.isArray(wt.repos)) {
          const reposJson = JSON.stringify(wt.repos);
          if (JSON.stringify(cx.worktreeRepos || []) !== reposJson) {
            cx.worktreeRepos = wt.repos;
            dirty = true;
          }
        }
      }
    }
  }

  // Determine live RUNNING vs IDLE state
  let nextRunState = t.runState || 'RUN_STATE_IDLE';
  if (latestRun) {
    const st = String(latestStatus?.state || latestRun.state || '').toLowerCase();
    if (st === 'finished' || st === 'failed' || st === 'timeout' || st === 'canceled') {
      nextRunState = 'RUN_STATE_IDLE';
    } else {
      const aliveRunner = isCodexProcessAlive(latestStatus?.runnerPid || latestRun.runnerPid);
      const aliveLauncher = isCodexProcessAlive(latestRun.launcherPid);
      const ageMs = Date.now() - (Date.parse(latestRun.startedAt || '') || Date.now());
      if (aliveRunner || aliveLauncher || ageMs < 6000) {
        nextRunState = 'RUN_STATE_RUNNING';
      } else {
        // Re-check status file once in case process just finished milliseconds ago
        const recheck = latestRun.statusFile ? readJsonSafe(latestRun.statusFile) : null;
        if (recheck && ['finished', 'failed', 'timeout', 'canceled'].includes(String(recheck.state || '').toLowerCase())) {
          latestRun.state = recheck.state;
          latestRun.finishedAt = recheck.finishedAt || new Date().toISOString();
          nextRunState = 'RUN_STATE_IDLE';
          dirty = true;
        } else {
          latestRun.state = 'failed';
          latestRun.error = latestRun.error || 'Codex runner exited before writing final status.';
          latestRun.finishedAt = new Date().toISOString();
          nextRunState = 'RUN_STATE_IDLE';
          dirty = true;
        }
      }
    }
  }

  if (nextRunState !== t.runState) {
    t.runState = nextRunState;
    if (nextRunState === 'RUN_STATE_IDLE') {
      t.lastCompletedAt = latestStatus?.finishedAt || latestRun?.finishedAt || new Date().toISOString();
    }
    t.updatedAt = new Date().toISOString();
    dirty = true;
  }

  // Update git status if worktree exists
  if (t.worktreePath && inspectGitFn) {
    if (cx.worktreeTopology === 'multi-repo' && Array.isArray(cx.worktreeRepos) && cx.worktreeRepos.length > 0) {
      let dirtyCount = 0;
      let aheadCount = 0;
      let anyExists = false;
      let lastCommit = '';
      for (const r of cx.worktreeRepos) {
        const subWt = r?.worktree || '';
        if (!subWt || !existsSync(subWt)) continue;
        anyExists = true;
        const g = await inspectGitFn(subWt, '', { maxAgeMs: 15000 });
        if (g) {
          dirtyCount += g.dirtyCount || 0;
          aheadCount += g.aheadCount || 0;
          if (!lastCommit && g.lastCommit) lastCommit = g.lastCommit;
        }
      }
      const nextGit = anyExists
        ? { exists: true, branch: t.branch || `worker/${cx.taskName}`, dirtyCount, aheadCount, lastCommit }
        : { exists: false, branch: t.branch || '', dirtyCount: 0, aheadCount: 0, lastCommit: '' };
      if (JSON.stringify(nextGit) !== JSON.stringify(t.git)) {
        t.git = nextGit;
        dirty = true;
      }
    } else {
      const g = await inspectGitFn(t.worktreePath, t.baseRef, { maxAgeMs: 15000 });
      if (JSON.stringify(g) !== JSON.stringify(t.git)) {
        t.git = g;
        dirty = true;
      }
    }
  }

  return {
    dirty,
    isRunning: nextRunState === 'RUN_STATE_RUNNING',
    latestRun,
    latestStatus,
  };
}

export function peekCodexLiveActivity(t) {
  const cx = t?.codex;
  const runs = Array.isArray(cx?.runs) ? cx.runs : [];
  const latestRun = runs[runs.length - 1] || null;
  if (!latestRun) {
    return {
      activeTool: '',
      activeToolObj: null,
      stepsProgress: null,
      stepsList: null,
      toolStepCount: 0,
      hasPendingBgTask: false,
      pendingBgTaskSummary: '',
      needsUserAction: false,
      lastSummary: t?.lastSummary || '',
      lastStepIndex: -1,
    };
  }

  const stamp = [
    safeFileStamp(latestRun.statusFile),
    safeFileStamp(latestRun.eventsFile),
    safeFileStamp(latestRun.finalFile),
    `rs:${t.runState}|r:${runs.length}`,
  ].join('|');
  const cacheKey = `${t.threadId}|act`;
  const cached = codexActivityCache.get(cacheKey);
  if (cached && cached.stamp === stamp) {
    return cached.activity;
  }

  const status = latestRun.statusFile ? readJsonSafe(latestRun.statusFile) : null;
  const evData = parseCodexRunEvents(latestRun.eventsFile || status?.events || '');
  const isFinished =
    t.runState === 'RUN_STATE_IDLE' ||
    ['finished', 'failed', 'timeout', 'canceled'].includes(String(status?.state || latestRun.state || '').toLowerCase());

  let lastSummary = '';
  let needsUserAction = false;
  let lastStepIndex = -1;

  if (isFinished) {
    lastStepIndex = runs.length;
    const finalMd = readRunFinalMarkdown(latestRun, status);
    const errText = formatCodexErrorBanner(status);
    if (finalMd) {
      lastSummary = buildCardSummary(finalMd);
    } else if (errText) {
      lastSummary = errText.replace(/\r?\n+/g, ' ').slice(0, 320);
    }
    const handoffStatus = String(status?.handoff?.status || '').toLowerCase();
    if (handoffStatus === 'needs_input' || handoffStatus === 'needs_permission' || Boolean(status?.errorKind)) {
      needsUserAction = true;
    } else if (finalMd) {
      const tailSlice = finalMd.slice(-260);
      if (
        /[?？]\s*$/.test(tailSlice) ||
        /待确认|请确认|需要你确认|是否需要|waiting on you|please confirm/i.test(tailSlice)
      ) {
        needsUserAction = true;
      }
    }
  }

  const activity = {
    activeTool: isFinished ? '' : evData.activeTool || 'Starting Codex…',
    activeToolObj: isFinished ? null : evData.activeToolObj || { category: 'other', target: 'Codex' },
    stepsProgress: null,
    stepsList: null,
    toolStepCount: evData.toolStepCount || 0,
    hasPendingBgTask: false,
    pendingBgTaskSummary: '',
    needsUserAction,
    lastSummary,
    lastStepIndex,
  };

  codexActivityCache.set(cacheKey, { stamp, activity });
  if (codexActivityCache.size > 60) {
    codexActivityCache.delete(codexActivityCache.keys().next().value);
  }
  return activity;
}

export function parseCodexTranscript(t, pendingUserMessages = []) {
  const cx = t?.codex || {};
  const runs = Array.isArray(cx.runs) ? cx.runs : [];
  const stampParts = runs.map(
    (r) =>
      `${r.round}:${safeFileStamp(r.statusFile)}:${safeFileStamp(r.eventsFile)}:${safeFileStamp(r.finalFile)}:${r.state || ''}`,
  );
  const baseStamp = `codex|${stampParts.join('|')}|rs:${t.runState || ''}`;
  const cacheKey = t.threadId || 'codex';

  let baseItems = [];
  let activeActivity = '';
  let stepCount = 0;

  const cached = codexTimelineCache.get(cacheKey);
  if (cached && cached.stamp === baseStamp) {
    baseItems = cached.parsed.items;
    activeActivity = cached.parsed.activeActivity;
    stepCount = cached.parsed.stepCount;
  } else {
    const items = [];
    for (let idx = 0; idx < runs.length; idx++) {
      const run = runs[idx];
      const status = run.statusFile ? readJsonSafe(run.statusFile) : null;
      const evPath = run.eventsFile || status?.events || '';
      const evData = parseCodexRunEvents(evPath);
      stepCount += evData.toolStepCount + 1;

      if (idx === 0) {
        const ctxLines = [
          `- Engine: Codex (${cx.taskKind || 'implement'})`,
          cx.taskName ? `- Task: \`${cx.taskName}\`` : '',
          cx.sessionId ? `- Session ID: \`${cx.sessionId}\`` : '',
          cx.desktopUrl ? `- Desktop URL: ${cx.desktopUrl}` : '',
          t.worktreePath ? `- Worktree: \`${t.worktreePath}\`` : '- Workspace: shared / in-place',
          cx.structuredHandoff ? '- Structured Handoff: enabled' : '',
        ].filter(Boolean);
        items.push({
          id: `codex-brief-r1`,
          kind: 'task_brief',
          taskText: t.taskPrompt || '',
          contextText: ctxLines.join('\n'),
          createdAt: run.startedAt || t.createdAt || '',
        });
      } else {
        items.push({
          id: `codex-user-r${run.round}`,
          kind: 'user',
          text: run.userMessage || '(follow-up)',
          createdAt: run.startedAt || '',
        });
      }

      const isLastRun = idx === runs.length - 1;
      const runIsRunning =
        isLastRun &&
        t.runState === 'RUN_STATE_RUNNING' &&
        !['finished', 'failed', 'timeout', 'canceled'].includes(String(status?.state || '').toLowerCase());

      if (evData.entries.length > 0 || runIsRunning) {
        const startedAt = status?.startedAt || run.startedAt || '';
        const endedAt = status?.finishedAt || run.finishedAt || new Date().toISOString();
        const sMs = Date.parse(startedAt);
        const eMs = Date.parse(endedAt);
        const durationSec =
          Number.isFinite(sMs) && Number.isFinite(eMs) && eMs > sMs
            ? Math.min(86400, Math.max(1, Math.round((eMs - sMs) / 1000)))
            : 1;
        items.push({
          id: `codex-trace-r${run.round}`,
          kind: 'trace',
          startedAt,
          endedAt,
          durationSec,
          activeHeader: runIsRunning ? evData.activeTool || 'Running Codex…' : '',
          lastFocus: evData.activeTool || '',
          entries: evData.entries,
          calls: evData.calls,
          thinking: '',
          createdAt: startedAt,
        });
        if (runIsRunning) {
          activeActivity = evData.activeTool || 'Running Codex…';
        }
      }

      if (!runIsRunning) {
        const finalMd = readRunFinalMarkdown(run, status);
        if (finalMd) {
          items.push({
            id: `codex-final-r${run.round}`,
            kind: 'assistant',
            text: finalMd,
            isMilestone: false,
            isProgress: false,
            isFinalReply: isLastRun,
            showFooter: true,
            model: t.modelDisplayName || t.resolvedModel || 'Codex',
            createdAt: status?.finishedAt || run.finishedAt || '',
          });
        }
        const errBanner = formatCodexErrorBanner(status);
        if (errBanner) {
          items.push({
            id: `codex-err-r${run.round}`,
            kind: 'error',
            text: errBanner,
            createdAt: status?.finishedAt || run.finishedAt || '',
          });
        }
      }
    }

    codexTimelineCache.set(cacheKey, {
      stamp: baseStamp,
      parsed: { items, activeActivity, stepCount },
    });
    if (codexTimelineCache.size > 40) {
      codexTimelineCache.delete(codexTimelineCache.keys().next().value);
    }
    baseItems = items;
  }

  const merged = [...baseItems];
  if (Array.isArray(pendingUserMessages) && pendingUserMessages.length > 0) {
    const existingUserTexts = new Set(
      baseItems.filter((it) => it.kind === 'user').map((it) => String(it.text || '').trim()),
    );
    for (const pm of pendingUserMessages) {
      if (pm?.text && !existingUserTexts.has(pm.text.trim())) {
        merged.push({
          id: pm.id || `pending-${pm.createdAt}`,
          kind: 'user',
          text: pm.text,
          pending: true,
          createdAt: pm.createdAt || '',
        });
      }
    }
  }

  return {
    stamp: `${baseStamp}|p:${(pendingUserMessages || []).length}`,
    stepCount,
    activeActivity,
    items: merged,
  };
}

export function extractCodexThreadCompletion(t) {
  const cx = t?.codex || {};
  const runs = Array.isArray(cx.runs) ? cx.runs : [];
  const latestRun = runs[runs.length - 1] || null;
  if (!latestRun) {
    return {
      stepIndex: -1,
      cardSummary: '',
      fullReport: '',
      rawFullText: '',
      rawFullTextLength: 0,
      reportTruncated: false,
      waitingOnBackgroundTask: false,
      pendingTaskIds: [],
    };
  }

  const status = latestRun.statusFile ? readJsonSafe(latestRun.statusFile) : null;
  const st = String(status?.state || latestRun.state || '').toLowerCase();
  const isRunning =
    t.runState === 'RUN_STATE_RUNNING' &&
    !['finished', 'failed', 'timeout', 'canceled'].includes(st);
  if (isRunning) {
    return {
      stepIndex: -1,
      cardSummary: '',
      fullReport: '',
      rawFullText: '',
      rawFullTextLength: 0,
      reportTruncated: false,
      waitingOnBackgroundTask: true,
      pendingTaskIds: [latestRun.runId || `${t.threadId}-r${latestRun.round}`],
    };
  }

  const finalMd = readRunFinalMarkdown(latestRun, status);
  const errBanner = formatCodexErrorBanner(status);
  const combinedText = [finalMd, errBanner ? `> **Codex Execution Notice**\n> ${errBanner}` : '']
    .filter(Boolean)
    .join('\n\n')
    .trim();

  if (!combinedText) {
    return {
      stepIndex: -1,
      cardSummary: '',
      fullReport: '',
      rawFullText: '',
      rawFullTextLength: 0,
      reportTruncated: false,
      waitingOnBackgroundTask: false,
      pendingTaskIds: [],
    };
  }

  const fullReport = buildCoordinatorReport(combinedText);
  return {
    stepIndex: runs.length,
    cardSummary: buildCardSummary(combinedText),
    fullReport,
    rawFullText: combinedText,
    rawFullTextLength: combinedText.length,
    reportTruncated: combinedText.length > fullReport.length,
    waitingOnBackgroundTask: false,
    pendingTaskIds: [],
  };
}

export function cleanupCodexWorktree(t, { forceWorktree = false, deleteBranch = true } = {}) {
  const cx = t?.codex || {};
  const projectDir = cx.sourceProject || t.workspacePath || t.repoRoot || '';
  const codexTask = cx.taskName || '';
  const worktreePath = t.worktreePath || '';

  if (!worktreePath) {
    return Promise.resolve({
      ok: true,
      threadId: t.threadId,
      worktreeRemoved: false,
      branchDeleted: false,
      pruned: false,
      skippedReason: '',
      worktreeError: '',
      removedWorktreePath: '',
      deletedBranch: '',
      thread: t,
    });
  }

  const scriptsDir = resolveCodexScriptsDir();
  const removeScript = scriptsDir ? join(scriptsDir, 'Remove-TaskWorktree.ps1') : '';
  if (!removeScript || !existsSync(removeScript) || !projectDir || !codexTask) {
    return Promise.resolve({
      ok: false,
      threadId: t.threadId,
      worktreeRemoved: false,
      branchDeleted: false,
      pruned: false,
      skippedReason: 'remove_script_missing',
      worktreeError: 'Remove-TaskWorktree.ps1 or Codex task metadata not found.',
      removedWorktreePath: '',
      deletedBranch: '',
      thread: t,
    });
  }

  const pwshExe = resolvePwshExe();
  const args = [
    '-NonInteractive',
    '-NoProfile',
    '-File',
    removeScript,
    '-Project',
    projectDir,
    '-Task',
    codexTask,
  ];
  if (deleteBranch) args.push('-DeleteBranch');
  if (forceWorktree) args.push('-Force');

  const isWinBatch = process.platform === 'win32' && /\.(?:bat|cmd)$/i.test(pwshExe);
  const quoteWin = (v) => `"${String(v ?? '').replace(/\r?\n/g, ' ').replace(/"/g, '\\"')}"`;
  const execCmd = isWinBatch ? process.env.ComSpec || 'cmd.exe' : pwshExe;
  const execArgs = isWinBatch
    ? ['/d', '/s', '/c', `"${quoteWin(pwshExe)} ${args.map(quoteWin).join(' ')}"`]
    : args;

  return new Promise((resolveRes) => {
    execFile(
      execCmd,
      execArgs,
      {
        windowsHide: true,
        timeout: 25000,
        maxBuffer: 2 * 1024 * 1024,
        ...(isWinBatch ? { windowsVerbatimArguments: true } : {}),
      },
      (err, stdout, stderr) => {
      const errOut = String(stderr || stdout || err?.message || '').trim();
      if (err) {
        const isDirty = /未提交|uncommitted|modified|dirty/i.test(errOut);
        const isUnmerged = /未合并|unmerged/i.test(errOut);
        resolveRes({
          ok: false,
          threadId: t.threadId,
          worktreeRemoved: false,
          branchDeleted: false,
          pruned: false,
          skippedReason: isDirty ? 'uncommitted_changes' : isUnmerged ? 'unmerged_commits' : 'remove_failed',
          worktreeError: errOut || 'Remove-TaskWorktree.ps1 failed',
          removedWorktreePath: '',
          deletedBranch: '',
          thread: t,
        });
        return;
      }

      resolveRes({
        ok: true,
        threadId: t.threadId,
        worktreeRemoved: true,
        branchDeleted: Boolean(deleteBranch),
        pruned: false,
        skippedReason: '',
        worktreeError: '',
        removedWorktreePath: worktreePath,
        deletedBranch: deleteBranch ? t.branch || `worker/${codexTask}` : '',
        thread: t,
      });
    });
  });
}

export function openCodexDesktopUrl(desktopUrl) {
  const url = String(desktopUrl || '').trim();
  if (!CODEX_DESKTOP_URL_RE.test(url)) {
    return Promise.resolve({ ok: false, error: 'Invalid or unavailable Codex Desktop URL.' });
  }

  return new Promise((resolveOpen) => {
    if (process.platform === 'win32') {
      execFile(
        process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', 'start', '""', url],
        { windowsHide: true, timeout: 6000 },
        (err) => {
          if (err) resolveOpen({ ok: false, error: err.message, desktopUrl: url });
          else resolveOpen({ ok: true, desktopUrl: url });
        },
      );
      return;
    }
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    execFile(opener, [url], { timeout: 6000 }, (err) => {
      if (err) resolveOpen({ ok: false, error: err.message, desktopUrl: url });
      else resolveOpen({ ok: true, desktopUrl: url });
    });
  });
}

export function buildCodexDisplayTitle(threadId, title) {
  return `[${threadId}] ${String(title || '').trim()}`;
}

export function getCodexProjectLabel(projectDir) {
  return projectDir ? basename(projectDir) : 'Project';
}
