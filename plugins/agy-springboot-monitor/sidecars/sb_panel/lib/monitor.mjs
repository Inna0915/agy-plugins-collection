import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve a real standalone `node.exe` / `node` binary instead of `process.execPath`.
 * Antigravity Sidecars run inside `Antigravity.exe` (Electron with ELECTRON_RUN_AS_NODE=1),
 * which is NOT whitelisted by enterprise transparent file-encryption (DLP) drivers.
 * Spawning `sb.mjs` with the system `node.exe` ensures transparent decryption & consistent file sizes.
 */
function resolveSystemNodeExe() {
  const execBase = path.basename(process.execPath || '').toLowerCase();
  if (execBase === 'node.exe' || execBase === 'node') {
    return { exe: process.execPath, isHostApp: false };
  }

  const candidates = [];
  if (process.env.SPRINGBOOT_CTL_NODE && fs.existsSync(process.env.SPRINGBOOT_CTL_NODE)) {
    candidates.push(process.env.SPRINGBOOT_CTL_NODE);
  }
  try {
    const whereCmd = process.platform === 'win32' ? 'where.exe' : 'which';
    const out = execFileSync(whereCmd, ['node'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    for (const line of String(out || '').split(/\r?\n/)) {
      const p = line.trim();
      if (p && fs.existsSync(p)) candidates.push(p);
    }
  } catch {
    // ignore
  }
  if (process.platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Program Files (x86)\\nodejs\\node.exe',
      process.env.NVM_SYMLINK ? path.join(process.env.NVM_SYMLINK, 'node.exe') : '',
      path.join(os.homedir(), 'AppData', 'Roaming', 'nvm', 'current', 'node.exe')
    );
  } else {
    candidates.push('/usr/local/bin/node', '/usr/bin/node', '/opt/homebrew/bin/node');
  }

  for (const c of candidates) {
    if (!c || !fs.existsSync(c)) continue;
    const base = path.basename(c).toLowerCase();
    if (base === 'node.exe' || base === 'node') {
      return { exe: path.resolve(c), isHostApp: true };
    }
  }
  return { exe: process.execPath, isHostApp: true };
}

const NODE_RUNTIME = resolveSystemNodeExe();
const NODE_EXE = NODE_RUNTIME.exe;
const RUNNING_UNDER_HOST_APP = NODE_RUNTIME.isHostApp;

function cleanNodeEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function resolveSkillScriptsDir() {
  const candidates = [
    process.env.SPRINGBOOT_CTL_SCRIPTS,
    path.join(os.homedir(), '.agents', 'skills', 'springboot-ctl', 'scripts'),
    path.join(os.homedir(), '.gemini', 'config', 'skills', 'springboot-ctl', 'scripts'),
    path.join(os.homedir(), '.claude', 'skills', 'springboot-ctl', 'scripts'),
    path.join(os.homedir(), '.codex', 'skills', 'springboot-ctl', 'scripts'),
    path.join(os.homedir(), '.cursor', 'skills', 'springboot-ctl', 'scripts'),
    path.resolve(__dirname, '..', '..', '..', 'skills', 'springboot-ctl', 'scripts')
  ].filter(Boolean);

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'sb.mjs'))) return dir;
  }
  throw new Error(
    '未找到 springboot-ctl Skill 脚本目录。请先运行 install.ps1 安装 springboot-ctl Skill，或设置环境变量 SPRINGBOOT_CTL_SCRIPTS。'
  );
}

const SKILL_SCRIPTS_DIR = resolveSkillScriptsDir();
const SB_CLI_PATH = path.join(SKILL_SCRIPTS_DIR, 'sb.mjs');

const stateMod = await import(pathToFileURL(path.join(SKILL_SCRIPTS_DIR, 'lib', 'state.mjs')).href);
const mavenMod = await import(pathToFileURL(path.join(SKILL_SCRIPTS_DIR, 'lib', 'maven.mjs')).href);
const cfgMod = await import(pathToFileURL(path.join(SKILL_SCRIPTS_DIR, 'lib', 'config-detect.mjs')).href);
const procMod = await import(pathToFileURL(path.join(SKILL_SCRIPTS_DIR, 'lib', 'proc.mjs')).href);

const {
  LOGS_DIR,
  ensureStateDirs,
  formatDuration,
  formatMemoryMB,
  loadAllInstances,
  loadProjects,
  normalizeFsPath,
  sanitizeId,
  toForwardSlash
} = stateMod;

const IDE_NOISE_PATTERNS = [
  /antigravity-companion/i,
  /org\.jetbrains\.idea\.maven\.server/i,
  /idea\.maven\.embedder/i,
  /org\.jetbrains\.jps\.cmdline\.Launcher/i,
  /jps-launcher/i,
  /com\.intellij\.idea\.Main/i,
  /org\.codehaus\.plexus\.classworlds\.launcher\.Launcher/i,
  /GradleDaemon/i,
  /KotlinCompileDaemon/i,
  /\bJmxHelper\b/,
  /\bJavacHelper\b/,
  /com\.sun\.tools\.jcmd/i,
  /eclipse\.equinox\.launcher/i
];

// ============================================================
// In-Memory State (Non-Blocking Background Refresh)
// ============================================================

let latestOsProcs = [];
let lastScanAtMs = 0;
let scanInFlight = false;
let scanError = '';
let lastClientActivityMs = 0;

const IDLE_SLEEP_MS = 15000; // Pause background PowerShell OS scans when side pane is closed/idle > 15s
const pendingActions = new Map(); // id or pid -> { action, startedAt }
const startingReservations = new Map(); // lowerId -> { id, startedAt } (prevents double-click launch race)
const userStoppedIds = new Map(); // lowerId -> ts (suppresses false "start failed" banner on manual cancel)
const lastLaunchOptions = new Map(); // id -> launch payload (for smart Restart!)
const recentEvents = []; // newest first, max 12
const projectMetaCache = new Map(); // normPath -> { ts, data }
let workspaceListCache = { ts: 0, items: [] };

function markClientActive() {
  const now = Date.now();
  const wasIdle = lastClientActivityMs === 0 || (now - lastClientActivityMs > IDLE_SLEEP_MS);
  lastClientActivityMs = now;
  if (wasIdle && (now - lastScanAtMs > 2000)) {
    triggerBackgroundScan();
  }
}

function hasBusyManagedServices() {
  if (pendingActions.size > 0 || startingReservations.size > 0) return true;
  for (const inst of loadAllInstances()) {
    if (['BUILDING', 'STARTING', 'STOPPING', 'RESTARTING'].includes(inst.status)) {
      const alive = (inst.pid && procMod.isProcessAlive(inst.pid)) || (inst.runnerPid && procMod.isProcessAlive(inst.runnerPid));
      if (alive) return true;
    }
  }
  return false;
}

function pushEvent(level, message) {
  recentEvents.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    time: new Date().toTimeString().slice(0, 8),
    ts: Date.now(),
    level, // 'info' | 'ok' | 'warn' | 'err'
    message
  });
  if (recentEvents.length > 12) recentEvents.length = 12;
}

function parseJavaCmd(cmd) {
  let jarFile = '';
  let argfile = '';
  let mainClass = '';

  const jarM = cmd.match(/-jar\s+(?:"([^"]+)"|(\S+))/i);
  if (jarM) {
    jarFile = jarM[1] || jarM[2] || '';
    mainClass = path.basename(jarFile);
  }
  const argM = cmd.match(/(?:^|\s)@(?:"([^"]+)"|(\S+))/);
  if (argM) argfile = argM[1] || argM[2] || '';

  if (!mainClass) {
    const tokens = cmd.match(/"[^"]*"|\S+/g) || [];
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i].replace(/^"|"$/g, '');
      if (t.startsWith('-') || t.startsWith('@')) {
        if (t === '-cp' || t === '-classpath' || t === '-jar' || t === '-m' || t === '--module') i++;
        continue;
      }
      if (/^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_$]*)+$/.test(t)) {
        mainClass = t;
        break;
      }
    }
  }
  return { mainClass, jarFile, argfile };
}

function scanWindowsJavaProcessesAsync() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve([]);
      return;
    }
    const psScript = `
$procs = @(Get-CimInstance Win32_Process -Filter "Name='java.exe' OR Name='javaw.exe'" | ForEach-Object {
  [PSCustomObject]@{
    pid = $_.ProcessId
    ppid = $_.ParentProcessId
    name = $_.Name
    cmd = $_.CommandLine
    created = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }
    rss = [int64]$_.WorkingSetSize
  }
})
$ports = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
  [PSCustomObject]@{
    pid = $_.OwningProcess
    port = $_.LocalPort
  }
})
$parents = @{}
foreach ($pr in $procs) {
  $k = [string]$pr.ppid
  if ($pr.ppid -and -not $parents.ContainsKey($k)) {
    $pObj = Get-Process -Id $pr.ppid -ErrorAction SilentlyContinue
    if ($pObj) { $parents[$k] = [string]$pObj.ProcessName }
  }
}
[PSCustomObject]@{
  procs = $procs
  ports = $ports
  parents = $parents
} | ConvertTo-Json -Depth 4 -Compress
`;
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { encoding: 'utf8', windowsHide: true, timeout: 9000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) {
          scanError = err ? err.message : '';
          resolve(null);
          return;
        }
        try {
          const data = JSON.parse(stdout.trim());
          const procs = Array.isArray(data.procs) ? data.procs : (data.procs ? [data.procs] : []);
          const ports = Array.isArray(data.ports) ? data.ports : (data.ports ? [data.ports] : []);
          const parents = data.parents || {};

          const portsByPid = new Map();
          for (const pt of ports) {
            if (!portsByPid.has(pt.pid)) portsByPid.set(pt.pid, new Set());
            portsByPid.get(pt.pid).add(pt.port);
          }

          const mapped = procs.map((p) => {
            const cmd = String(p.cmd || '');
            const parentName = parents[String(p.ppid)] || '';
            const listenPorts = [...(portsByPid.get(p.pid) || [])].sort((a, b) => a - b);
            const debugMatch = cmd.match(/jdwp[^\s]*address=(?:[^:,\s]+:)?(\d+)/i);
            const debugPort = debugMatch ? parseInt(debugMatch[1], 10) : null;
            const isNoise = IDE_NOISE_PATTERNS.some((re) => re.test(cmd));
            const parsed = parseJavaCmd(cmd);

            let source = 'manual';
            if (/idea_rt\.jar|IntelliJ/i.test(cmd) || /idea64/i.test(parentName)) {
              source = 'IDEA';
            }

            return {
              pid: p.pid,
              ppid: p.ppid,
              parentName,
              name: p.name,
              cmd,
              createdAt: p.created || '',
              rssBytes: p.rss || 0,
              ports: listenPorts.filter((pt) => pt !== debugPort),
              debugPort,
              isNoise,
              source,
              mainClass: parsed.mainClass,
              jarFile: parsed.jarFile
            };
          });
          scanError = '';
          resolve(mapped);
        } catch (parseErr) {
          scanError = parseErr.message;
          resolve(null);
        }
      }
    );
  });
}

export async function triggerBackgroundScan() {
  if (scanInFlight) return;
  scanInFlight = true;
  try {
    const res = await scanWindowsJavaProcessesAsync();
    if (res !== null) {
      latestOsProcs = res;
      lastScanAtMs = Date.now();
    }
  } finally {
    scanInFlight = false;
  }
}

export function startMonitorLoop(activeIntervalMs = 2500) {
  let stopped = false;
  let timer = null;

  const scheduleNext = () => {
    if (stopped) return;
    const now = Date.now();
    const isClientIdle = lastClientActivityMs === 0 || (now - lastClientActivityMs > IDLE_SLEEP_MS);
    const delayMs = isClientIdle
      ? 3500
      : (hasBusyManagedServices() ? activeIntervalMs : Math.max(5500, activeIntervalMs * 2));
    timer = setTimeout(async () => {
      if (stopped) return;
      const clientIdleNow = lastClientActivityMs === 0 || (Date.now() - lastClientActivityMs > IDLE_SLEEP_MS);
      if (!clientIdleNow) {
        await triggerBackgroundScan();
      }
      scheduleNext();
    }, delayMs);
    if (timer.unref) timer.unref();
  };

  // Run one initial scan on sidecar boot so first panel open is instant, then sleep when idle
  triggerBackgroundScan().finally(scheduleNext);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    }
  };
}

// ============================================================
// Build Live Snapshot (Fast, Synchronous <2ms)
// ============================================================

function filterDisplayPorts(ports, knownPrimaryPort) {
  const unique = [...new Set((ports || []).filter((n) => Number.isFinite(n) && n > 0))];
  if (knownPrimaryPort) {
    // Keep known primary port first, plus any other non-ephemeral ports (< 49152)
    const rest = unique.filter((p) => p !== knownPrimaryPort && p < 49152);
    return [knownPrimaryPort, ...rest];
  }
  const nonEph = unique.filter((p) => p < 49152);
  return nonEph.length > 0 ? nonEph : unique;
}

export function listKnownWorkspaces() {
  const now = Date.now();
  if (now - workspaceListCache.ts < 60000 && workspaceListCache.items.length > 0) {
    return workspaceListCache.items;
  }

  const seen = new Set();
  const items = [];
  const addWs = (dirPath, tag) => {
    if (!dirPath || !fs.existsSync(dirPath)) return;
    const abs = path.resolve(dirPath);
    const norm = normalizeFsPath(abs);
    if (seen.has(norm)) return;
    seen.add(norm);
    items.push({
      name: path.basename(abs),
      path: toForwardSlash(abs),
      tag
    });
  };

  // 1. Saved projects in projects.json
  const projects = loadProjects();
  for (const [, cfg] of Object.entries(projects)) {
    if (cfg && cfg.workspaceDir) addWs(cfg.workspaceDir, 'saved');
  }

  // 2. Active instances
  for (const inst of loadAllInstances()) {
    if (inst.workspace) addWs(inst.workspace, 'active');
  }

  // 3. Scan common code roots for Spring Boot / IDEA Java projects
  const roots = new Set([
    'D:\\dev\\code',
    'D:\\code',
    'D:\\workspace',
    'C:\\dev\\code',
    'E:\\dev\\code',
    path.join(os.homedir(), 'IdeaProjects'),
    path.join(os.homedir(), 'Projects'),
    path.join(os.homedir(), 'code')
  ]);
  for (const it of items) {
    roots.add(path.dirname(it.path));
  }
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    try {
      const ents = fs.readdirSync(root, { withFileTypes: true });
      for (const ent of ents) {
        if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
        const full = path.join(root, ent.name);
        const hasIdea = fs.existsSync(path.join(full, '.idea', 'misc.xml'));
        const hasPom = fs.existsSync(path.join(full, 'pom.xml'));
        if (hasIdea || hasPom) {
          addWs(full, hasIdea ? 'idea' : 'maven');
        }
      }
    } catch {
      // ignore
    }
  }

  // Prioritize fms269 / saved / active first, then alphabetical
  const rank = { active: 0, saved: 1, idea: 2, maven: 3 };
  items.sort((a, b) => (rank[a.tag] ?? 9) - (rank[b.tag] ?? 9) || a.name.localeCompare(b.name));

  workspaceListCache = { ts: now, items: items.slice(0, 40) };
  return workspaceListCache.items;
}

export function getSnapshot({ includeAll = false } = {}) {
  markClientActive();
  ensureStateDirs();
  const now = Date.now();
  const osByPid = new Map(latestOsProcs.map((p) => [p.pid, p]));
  const managed = loadAllInstances();

  const services = [];
  const matchedPids = new Set();

  // Clear expired pending actions (> 45s safety)
  for (const [k, v] of pendingActions.entries()) {
    if (now - v.startedAt > 45000) pendingActions.delete(k);
  }

  for (const inst of managed) {
    const pidAlive = inst.pid ? procMod.isProcessAlive(inst.pid) : false;
    const runnerAlive = inst.runnerPid ? procMod.isProcessAlive(inst.runnerPid) : false;
    const osProc = inst.pid ? osByPid.get(inst.pid) : null;

    if (!pidAlive && !runnerAlive) {
      // Keep recent FAILED card visible for 90s so user can see why it failed & read logs
      const age = now - Date.parse(inst.startedAt || 0);
      if (inst.status !== 'FAILED' || age > 90000) {
        pendingActions.delete(inst.id);
        continue;
      }
    }

    if (inst.pid) matchedPids.add(inst.pid);
    const livePorts = osProc ? osProc.ports : [];

    // Self-heal STARTING -> UP if JVM is alive and log already reports Started (e.g. if external waiter missed)
    if (inst.status === 'STARTING' && pidAlive && inst.logFile) {
      const logInfo = procMod.inspectLogForReady(inst.logFile);
      if (logInfo && logInfo.started) {
        inst.status = 'UP';
        if (logInfo.port) inst.port = logInfo.port;
        if (logInfo.contextPath) inst.contextPath = logInfo.contextPath;
        inst.readyAt = inst.readyAt || new Date().toISOString();
        try {
          stateMod.saveInstance(inst);
        } catch {
          // ignore
        }
      }
    }

    const displayPorts = filterDisplayPorts(livePorts, inst.port);
    const primaryPort = inst.port || displayPorts[0] || null;
    const contextPath = inst.contextPath || '';
    const url = primaryPort ? `http://localhost:${primaryPort}${contextPath}` : '';

    const pending = pendingActions.get(inst.id) || (inst.pid ? pendingActions.get(String(inst.pid)) : null);
    let status = inst.status || (primaryPort ? 'UP' : 'STARTING');
    if (pending && pending.action === 'stopping') status = 'STOPPING';
    else if (pending && pending.action === 'restarting') status = 'RESTARTING';

    const startedMs = Date.parse(inst.startedAt || (osProc ? osProc.createdAt : '') || 0);
    const rssBytes = osProc ? osProc.rssBytes : 0;

    services.push({
      id: inst.id,
      appName: inst.appName || inst.artifactId || inst.id,
      artifactId: inst.artifactId || '',
      mainClass: inst.mainClass || '',
      source: 'skill',
      pid: inst.pid || inst.runnerPid || null,
      jvmPid: inst.pid || null,
      primaryPort,
      ports: displayPorts,
      contextPath,
      url,
      debugPort: inst.debugPort || (osProc ? osProc.debugPort : null),
      rssBytes,
      rssText: formatMemoryMB(rssBytes),
      startedAt: inst.startedAt || '',
      uptimeText: startedMs > 0 ? formatDuration(now - startedMs) : '-',
      status,
      error: inst.error || '',
      workspace: inst.workspace ? toForwardSlash(inst.workspace) : '',
      logFile: inst.logFile ? toForwardSlash(inst.logFile) : '',
      localModules: Array.isArray(inst.localModules) ? inst.localModules : [],
      selectionSource: inst.selectionSource || '',
      dbDisplay: inst.dbDisplay || '',
      esDisplay: inst.esDisplay || '',
      eslogDisplay: inst.eslogDisplay || '',
      profiles: inst.profiles || '',
      pendingAction: pending ? pending.action : ''
    });
  }

  // Unmanaged Java processes (IDEA / manual)
  for (const p of latestOsProcs) {
    if (matchedPids.has(p.pid)) continue;
    if (p.isNoise && !includeAll) continue;

    let wsHint = '';
    if (p.jarFile) {
      wsHint = toForwardSlash(path.dirname(p.jarFile));
    } else {
      const mWs = p.cmd.match(/([A-Za-z]:[\\/][^"\s;]+[\\/]target[\\/]classes)/i);
      if (mWs) wsHint = toForwardSlash(path.dirname(path.dirname(mWs[1])));
    }

    const displayPorts = filterDisplayPorts(p.ports, null);
    const primaryPort = displayPorts[0] || null;
    const simpleMain = p.mainClass ? p.mainClass.split('.').pop() : p.name;
    const pending = pendingActions.get(String(p.pid)) || pendingActions.get(`pid-${p.pid}`);
    const startedMs = Date.parse(p.createdAt || 0);

    services.push({
      id: `pid-${p.pid}`,
      appName: simpleMain,
      artifactId: '',
      mainClass: p.mainClass || '(unknown)',
      source: p.source,
      pid: p.pid,
      jvmPid: p.pid,
      primaryPort,
      ports: displayPorts,
      contextPath: '',
      url: primaryPort ? `http://localhost:${primaryPort}` : '',
      debugPort: p.debugPort,
      rssBytes: p.rssBytes,
      rssText: formatMemoryMB(p.rssBytes),
      startedAt: p.createdAt || '',
      uptimeText: startedMs > 0 ? formatDuration(now - startedMs) : '-',
      status: pending ? 'STOPPING' : (primaryPort ? 'UP' : 'RUNNING'),
      error: '',
      workspace: wsHint,
      logFile: '',
      localModules: [],
      selectionSource: '',
      dbDisplay: '',
      esDisplay: '',
      eslogDisplay: '',
      profiles: '',
      pendingAction: pending ? pending.action : ''
    });
  }

  // Sort: skill first, then UP/STARTING/BUILDING, then port ascending
  const statusRank = { UP: 0, STARTING: 1, BUILDING: 2, RESTARTING: 3, STOPPING: 4, RUNNING: 5, FAILED: 6 };
  services.sort((a, b) => {
    if (a.source === 'skill' && b.source !== 'skill') return -1;
    if (a.source !== 'skill' && b.source === 'skill') return 1;
    const sr = (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9);
    if (sr !== 0) return sr;
    return (a.primaryPort || 99999) - (b.primaryPort || 99999);
  });

  // Summary metrics
  let totalRssBytes = 0;
  let upCount = 0;
  let busyCount = 0;
  const activePorts = [];
  for (const s of services) {
    if (s.status === 'FAILED') continue;
    totalRssBytes += s.rssBytes || 0;
    if (s.status === 'UP' || s.status === 'RUNNING') upCount++;
    else if (s.status === 'BUILDING' || s.status === 'STARTING' || s.status === 'RESTARTING') busyCount++;
    if (s.primaryPort) activePorts.push(s.primaryPort);
  }

  const runningWorkspaces = new Set(services.filter((s) => s.status !== 'FAILED' && s.workspace).map((s) => normalizeFsPath(s.workspace)));
  const workspaces = listKnownWorkspaces().map((w) => ({
    ...w,
    running: runningWorkspaces.has(normalizeFsPath(w.path))
  }));

  return {
    serverNowMs: now,
    lastScanAtMs,
    scanError,
    summary: {
      total: services.filter((s) => s.status !== 'FAILED').length,
      up: upCount,
      busy: busyCount,
      totalRssBytes,
      totalRssText: totalRssBytes > 0 ? formatMemoryMB(totalRssBytes) : '0MB',
      activePorts: [...new Set(activePorts)].sort((a, b) => a - b)
    },
    services,
    workspaces,
    recentEvents: recentEvents.slice(0, 8)
  };
}

// ============================================================
// Project Metadata (for Quick Launcher Drawer)
// ============================================================

function getProjectMetaViaSystemNode(abs) {
  if (!RUNNING_UNDER_HOST_APP || NODE_EXE === process.execPath) return null;
  const libDirUrl = pathToFileURL(path.join(SKILL_SCRIPTS_DIR, 'lib')).href.replace(/\/$/, '');
  const script = `
import path from 'node:path';
const stateMod = await import(${JSON.stringify(libDirUrl + '/state.mjs')});
const mavenMod = await import(${JSON.stringify(libDirUrl + '/maven.mjs')});
const cfgMod = await import(${JSON.stringify(libDirUrl + '/config-detect.mjs')});
const abs = process.argv[1];
const discovery = mavenMod.discoverWorkspace(abs);
const apps = discovery.apps.map((a) => {
  const dp = cfgMod.detectDefaultPort(a.starterPom, a.mainClass);
  return { name: a.name, artifactId: a.starterPom.artifactId, mainClass: a.mainClass, defaultPort: dp.port, source: a.source };
});
const primaryApp = discovery.apps.find((a) => a.source === 'idea') || discovery.apps[0] || null;
let modules = [], dbs = [], es = [], eslog = [], savedConfig = {};
if (primaryApp) {
  const projects = stateMod.loadProjects();
  const key = stateMod.projectKey(discovery.workspaceDir, primaryApp.starterPom.relDir);
  savedConfig = projects[key] || {};
  const sel = mavenMod.resolveLocalSelection(discovery, primaryApp.starterPom, {}, savedConfig);
  modules = discovery.poms.filter((p) => p.packaging !== 'pom').map((p) => ({
    artifactId: p.artifactId, relDir: p.relDir, enabled: sel.selectedSet.has(p),
    isStarter: p === primaryApp.starterPom, depOfStarter: sel.depGraphReachable.has(p), ideaLinked: p.ideaLinked
  }));
  const ds = cfgMod.discoverDatasources(primaryApp.starterPom);
  dbs = ds.candidates.map((c) => ({ index: c.index, name: c.name, active: c.active, kind: c.kind, vendor: c.vendor, hostPort: c.hostPort, schema: c.schema, username: c.username, source: c.source }));
  const elastic = cfgMod.discoverElasticConfigs(primaryApp.starterPom);
  es = elastic.es.map((c) => ({ index: c.index, name: c.name, active: c.active, kind: c.kind, uris: c.uris, username: c.username, enable: c.enable, source: c.source }));
  eslog = elastic.eslog.map((c) => ({ index: c.index, name: c.name, active: c.active, kind: c.kind, uris: c.uris, username: c.username, source: c.source }));
}
process.stdout.write(JSON.stringify({
  workspace: stateMod.toForwardSlash(discovery.workspaceDir),
  name: path.basename(discovery.workspaceDir),
  ideaJdk: discovery.idea.jdkName || '',
  apps, modules, dbs, es, eslog, savedConfig
}));
`;
  const res = spawnSync(NODE_EXE, ['--input-type=module', '-e', script, abs], {
    env: cleanNodeEnv(),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
    maxBuffer: 8 * 1024 * 1024
  });
  if (res.status === 0 && res.stdout) {
    try {
      return JSON.parse(res.stdout);
    } catch {
      return null;
    }
  }
  return null;
}

export function getProjectMeta(workspacePath) {
  const abs = path.resolve(String(workspacePath || '').trim());
  if (!abs || !fs.existsSync(abs)) {
    throw new Error(`工作区目录不存在: ${workspacePath}`);
  }
  const norm = normalizeFsPath(abs);
  const cached = projectMetaCache.get(norm);
  if (cached && Date.now() - cached.ts < 25000) {
    return cached.data;
  }

  // When running inside Electron/Antigravity.exe, delegate workspace file reading to system node.exe
  // so DLP-encrypted pom.xml / application.yml files are transparently decrypted.
  const viaNode = getProjectMetaViaSystemNode(abs);
  if (viaNode) {
    projectMetaCache.set(norm, { ts: Date.now(), data: viaNode });
    return viaNode;
  }

  const discovery = mavenMod.discoverWorkspace(abs);
  const apps = discovery.apps.map((a) => {
    const dp = cfgMod.detectDefaultPort(a.starterPom, a.mainClass);
    return {
      name: a.name,
      artifactId: a.starterPom.artifactId,
      mainClass: a.mainClass,
      defaultPort: dp.port,
      source: a.source
    };
  });

  const primaryApp = discovery.apps.find((a) => a.source === 'idea') || discovery.apps[0] || null;
  let modules = [];
  let dbs = [];
  let es = [];
  let eslog = [];
  let savedConfig = {};

  if (primaryApp) {
    const projects = loadProjects();
    const key = stateMod.projectKey(discovery.workspaceDir, primaryApp.starterPom.relDir);
    savedConfig = projects[key] || {};
    const sel = mavenMod.resolveLocalSelection(discovery, primaryApp.starterPom, {}, savedConfig);
    modules = discovery.poms
      .filter((p) => p.packaging !== 'pom')
      .map((p) => ({
        artifactId: p.artifactId,
        relDir: p.relDir,
        enabled: sel.selectedSet.has(p),
        isStarter: p === primaryApp.starterPom,
        depOfStarter: sel.depGraphReachable.has(p),
        ideaLinked: p.ideaLinked
      }));

    const ds = cfgMod.discoverDatasources(primaryApp.starterPom);
    dbs = ds.candidates.map((c) => ({
      index: c.index,
      name: c.name,
      active: c.active,
      kind: c.kind,
      vendor: c.vendor,
      hostPort: c.hostPort,
      schema: c.schema,
      username: c.username,
      source: c.source
    }));

    const elastic = cfgMod.discoverElasticConfigs(primaryApp.starterPom);
    es = elastic.es.map((c) => ({
      index: c.index,
      name: c.name,
      active: c.active,
      kind: c.kind,
      uris: c.uris,
      username: c.username,
      enable: c.enable,
      source: c.source
    }));
    eslog = elastic.eslog.map((c) => ({
      index: c.index,
      name: c.name,
      active: c.active,
      kind: c.kind,
      uris: c.uris,
      username: c.username,
      source: c.source
    }));
  }

  const data = {
    workspace: toForwardSlash(discovery.workspaceDir),
    name: path.basename(discovery.workspaceDir),
    ideaJdk: discovery.idea.jdkName || '',
    apps,
    modules,
    dbs,
    es,
    eslog,
    savedConfig
  };
  projectMetaCache.set(norm, { ts: Date.now(), data });
  return data;
}

// ============================================================
// Actions: Start, Stop, Restart, Logs
// ============================================================

function buildSbRunArgs(opts) {
  const args = [SB_CLI_PATH, 'run', path.resolve(opts.workspace)];
  if (opts.id) args.push('--id', sanitizeId(opts.id));
  if (opts.app) args.push('--app', String(opts.app));

  if (opts.localMode === 'starter-only') {
    args.push('--local-only-starter');
  } else if (opts.localMode === 'custom' && opts.localModules) {
    args.push('--local', String(opts.localModules));
  }
  if (opts.excludeLocal) args.push('--exclude-local', String(opts.excludeLocal));
  if (opts.addLocal) args.push('--add-local', String(opts.addLocal));
  if (opts.db) args.push('--db', String(opts.db));
  if (opts.dbUrl) args.push('--db-url', String(opts.dbUrl));
  if (opts.dbName) args.push('--db-name', String(opts.dbName));
  if (opts.dbUser) args.push('--db-user', String(opts.dbUser));
  if (opts.dbDriver) args.push('--db-driver', String(opts.dbDriver));
  if (opts.dbPrefix) args.push('--db-prefix', String(opts.dbPrefix));
  if (opts.es) args.push('--es', String(opts.es));
  if (opts.esUser) args.push('--es-user', String(opts.esUser));
  if (opts.esEnable) args.push('--es-enable', String(opts.esEnable));
  if (opts.eslog) args.push('--eslog', String(opts.eslog));
  if (opts.eslogUser) args.push('--eslog-user', String(opts.eslogUser));
  if (opts.port) args.push('--port', String(opts.port));
  if (opts.strictPort) args.push('--strict-port');
  if (opts.contextPath) args.push('--context-path', String(opts.contextPath));
  if (opts.profile) args.push('--profile', String(opts.profile));
  if (opts.debugPort) args.push('--debug', String(opts.debugPort));
  if (opts.configFile) args.push('--config', String(opts.configFile));
  if (opts.configDir) args.push('--config-dir', String(opts.configDir));
  if (opts.vmArgs) args.push('--vm-args', String(opts.vmArgs));
  if (opts.jdk) args.push('--jdk', String(opts.jdk));
  if (Array.isArray(opts.props)) {
    for (const p of opts.props) {
      if (p) args.push('--prop', String(p));
    }
  }
  if (opts.noBuild) args.push('--no-build');
  if (opts.save) args.push('--save');
  return args;
}

export function triggerStart(opts) {
  markClientActive();
  const ws = String(opts?.workspace || '').trim();
  if (!ws || !fs.existsSync(ws)) {
    throw new Error(`工作区目录不存在: ${ws || '(空)'}`);
  }

  const now = Date.now();
  // Expire stale starting reservations (> 12s) and stop markers (> 20s)
  for (const [k, v] of startingReservations.entries()) {
    if (now - v.startedAt > 12000) startingReservations.delete(k);
  }
  for (const [k, ts] of userStoppedIds.entries()) {
    if (now - ts > 20000) userStoppedIds.delete(k);
  }

  // Derive target id to track wait
  let targetId = opts.id ? sanitizeId(opts.id) : sanitizeId(path.basename(path.resolve(ws)));
  // Include both live instances AND in-flight starting reservations to prevent double-click launch races
  const activeIds = new Set(
    loadAllInstances()
      .filter((x) => (x.pid && procMod.isProcessAlive(x.pid)) || (x.runnerPid && procMod.isProcessAlive(x.runnerPid)))
      .map((x) => x.id.toLowerCase())
  );
  for (const k of startingReservations.keys()) {
    activeIds.add(k);
  }

  if (opts.id && startingReservations.has(targetId.toLowerCase())) {
    throw new Error(`实例 '${targetId}' 正在拉起中，请稍候…`);
  }
  if (!opts.id && activeIds.has(targetId.toLowerCase())) {
    let n = 2;
    while (activeIds.has(`${targetId}-${n}`.toLowerCase())) n++;
    targetId = `${targetId}-${n}`;
  }

  const targetLower = targetId.toLowerCase();
  startingReservations.set(targetLower, { id: targetId, startedAt: now });
  userStoppedIds.delete(targetLower);

  const finalOpts = { ...opts, id: targetId };
  lastLaunchOptions.set(targetId, finalOpts);

  const runArgs = buildSbRunArgs(finalOpts);
  const child = spawn(NODE_EXE, runArgs, {
    cwd: path.resolve(ws),
    env: cleanNodeEnv(),
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true
  });
  child.on('error', (err) => {
    startingReservations.delete(targetLower);
    pushEvent('err', `启动 ${targetId} 失败: ${err.message}`);
  });
  child.on('exit', () => {
    startingReservations.delete(targetLower);
  });

  pushEvent('info', `已触发启动 ${targetId}${finalOpts.db ? ` (库: ${finalOpts.db})` : ''}`);

  // Spawn background `sb wait` so instance status automatically flips STARTING -> UP with real port/contextPath
  setTimeout(() => {
    if (userStoppedIds.has(targetLower)) return;
    const waiter = spawn(NODE_EXE, [SB_CLI_PATH, 'wait', targetId, '--timeout', '360'], {
      cwd: path.resolve(ws),
      env: cleanNodeEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let errOut = '';
    waiter.stderr.on('data', (d) => { errOut += d.toString('utf8'); });
    waiter.on('exit', (code) => {
      startingReservations.delete(targetLower);
      if (code === 0) {
        const inst = loadAllInstances().find((x) => x.id === targetId);
        const portHint = inst && inst.port ? `:${inst.port}${inst.contextPath || ''}` : '';
        pushEvent('ok', `${targetId} 启动就绪 ${portHint}`);
      } else if (!userStoppedIds.has(targetLower)) {
        // Suppress red failure toast if the user intentionally cancelled startup via Stop/Restart
        const firstLine = (errOut || '').split(/\r?\n/).find((l) => l.includes('[FAIL]')) || `退出码 ${code}`;
        pushEvent('err', `${targetId} 启动失败: ${firstLine}`);
      }
      triggerBackgroundScan();
    });
    triggerBackgroundScan();
  }, 800);

  return { ok: true, id: targetId, message: `已开始启动 ${targetId}` };
}

export function triggerStop({ target, id, pid, force = false }) {
  markClientActive();
  const stopTarget = String(target || id || pid || '').trim();
  if (!stopTarget) throw new Error('缺少停止目标 (id / pid / port)');

  const trackKey = String(id || pid || stopTarget);
  pendingActions.set(trackKey, { action: 'stopping', startedAt: Date.now() });
  if (pid) pendingActions.set(String(pid), { action: 'stopping', startedAt: Date.now() });
  if (id) {
    const idL = String(id).toLowerCase();
    userStoppedIds.set(idL, Date.now());
    startingReservations.delete(idL);
  }

  const args = [SB_CLI_PATH, 'stop', stopTarget];
  if (force) args.push('--force');

  pushEvent('info', `正在${force ? '强制' : '优雅'}停止 ${id || stopTarget}...`);

  const child = spawn(NODE_EXE, args, {
    env: cleanNodeEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let out = '';
  let errOut = '';
  child.stdout.on('data', (d) => { out += d.toString('utf8'); });
  child.stderr.on('data', (d) => { errOut += d.toString('utf8'); });
  child.on('exit', (code) => {
    pendingActions.delete(trackKey);
    if (pid) {
      pendingActions.delete(String(pid));
      // Optimistically prune dead PID from cached OS scan so UI updates immediately without waiting for PowerShell scan
      latestOsProcs = latestOsProcs.filter((p) => String(p.pid) !== String(pid));
    }
    if (code === 0) {
      const line = out.trim().split(/\r?\n/).pop() || `已停止 ${id || stopTarget}`;
      pushEvent('ok', line.replace(/^\[STOP\]\s*/, '已停止 '));
    } else {
      pushEvent('err', `停止 ${id || stopTarget} 失败: ${(errOut || out).trim().slice(0, 140)}`);
    }
    triggerBackgroundScan();
  });

  return { ok: true, target: stopTarget };
}

export function triggerRestart({ id, workspace, noBuild = false }) {
  markClientActive();
  const inst = loadAllInstances().find((x) => x.id === id);
  const savedOpts = lastLaunchOptions.get(id);
  const persistedOpts = (inst && inst.launchOpts) ? inst.launchOpts : {};
  const ws = workspace || (inst && inst.workspace) || (savedOpts && savedOpts.workspace);
  if (!ws) throw new Error(`找不到实例 ${id} 的工作区路径，无法重启`);

  const idL = String(id).toLowerCase();
  userStoppedIds.set(idL, Date.now());
  startingReservations.delete(idL);
  pendingActions.set(id, { action: 'restarting', startedAt: Date.now() });
  pushEvent('info', `正在重启 ${id}${noBuild ? ' (跳过编译)' : ''}...`);

  const stopChild = spawn(NODE_EXE, [SB_CLI_PATH, 'stop', id], {
    env: cleanNodeEnv(),
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true
  });
  stopChild.on('exit', () => {
    pendingActions.delete(id);
    // Merge persisted launchOpts (from instances/<id>.json, survives CLI starts & sidecar restarts)
    // with in-memory savedOpts, preserving DB/ES/ESLog/Port/Profile/LocalModules accurately!
    const fallbackLocal = (!persistedOpts.localMode && !savedOpts?.localMode && inst && inst.selectionSource === 'cli:--local' && inst.localModules && inst.localModules.length > 0)
      ? { localMode: 'custom', localModules: inst.localModules.join(',') }
      : {};
    const nextOpts = {
      ...persistedOpts,
      ...(savedOpts || {}),
      ...fallbackLocal,
      id,
      workspace: ws,
      noBuild
    };
    try {
      triggerStart(nextOpts);
    } catch (e) {
      pushEvent('err', `重启 ${id} 失败: ${e.message}`);
    }
  });

  return { ok: true, id };
}

export function readServiceLogs({ id, logFile, lines = 300, errOnly = false, query = '', lastSig = '' }) {
  markClientActive();
  let targetFile = '';
  // Always prefer the live active instance's logFile when an instance id is given,
  // preventing stale client-side logFile paths from pinning an old stopped log.
  if (id) {
    const inst = loadAllInstances().find((x) => x.id === id);
    if (inst && inst.logFile && fs.existsSync(inst.logFile)) {
      targetFile = inst.logFile;
    }
  }
  if (!targetFile && logFile && fs.existsSync(logFile)) {
    targetFile = logFile;
  }
  if (!targetFile && id) {
    ensureStateDirs();
    const prefix = sanitizeId(id).toLowerCase() + '-';
    const files = fs.readdirSync(LOGS_DIR)
      .filter((f) => f.toLowerCase().startsWith(prefix) && f.endsWith('.log'))
      .map((f) => {
        const full = path.join(LOGS_DIR, f);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length > 0) targetFile = files[0].full;
  }

  if (!targetFile || !fs.existsSync(targetFile)) {
    return { ok: false, logFile: '', text: '暂无日志文件（非托管启动的进程不接管日志）。', totalLines: 0 };
  }

  const stat = fs.statSync(targetFile);
  const q = String(query || '').trim().toLowerCase();
  const maxLines = Math.min(1000, Math.max(50, Number(lines) || 300));
  const sig = `${toForwardSlash(targetFile)}|${Math.trunc(stat.mtimeMs)}|${stat.size}|${errOnly ? 1 : 0}|${q}|${maxLines}`;
  if (lastSig && lastSig === sig) {
    return {
      ok: true,
      unchanged: true,
      sig,
      logFile: toForwardSlash(targetFile),
      sizeBytes: stat.size
    };
  }

  // Read at most last 512 KB to keep panel super snappy even on huge logs
  const maxBytes = 512 * 1024;
  let content = '';
  if (stat.size <= maxBytes) {
    content = fs.readFileSync(targetFile, 'utf8');
  } else {
    const fd = fs.openSync(targetFile, 'r');
    const buf = Buffer.alloc(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, stat.size - maxBytes);
    fs.closeSync(fd);
    content = buf.toString('utf8');
  }

  const allLines = content.split(/\r?\n/);

  let outLines;
  if (errOnly) {
    const picked = [];
    for (let i = 0; i < allLines.length; i++) {
      if (/\bERROR\b|Exception|Caused by:|APPLICATION FAILED TO START|Port \d+ was already in use/i.test(allLines[i])) {
        const start = Math.max(0, i - 1);
        const end = Math.min(allLines.length, i + 8);
        for (let j = start; j < end; j++) {
          if (picked.length === 0 || picked[picked.length - 1] !== allLines[j]) {
            picked.push(allLines[j]);
          }
        }
        i = end - 1;
      }
    }
    outLines = picked.length > 0 ? picked : ['(未检索到 ERROR / Exception / Caused by 记录)'];
  } else {
    outLines = allLines;
  }

  if (q) {
    const filtered = outLines.filter((l) => l.toLowerCase().includes(q));
    outLines = filtered.length > 0 ? filtered : [`(未匹配关键词 "${query}")`];
  }

  outLines = outLines.slice(-maxLines);

  return {
    ok: true,
    unchanged: false,
    sig,
    logFile: toForwardSlash(targetFile),
    sizeBytes: stat.size,
    totalLines: allLines.length,
    text: outLines.join('\n')
  };
}
