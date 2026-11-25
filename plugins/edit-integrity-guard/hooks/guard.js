'use strict';

/**
 * Edit Integrity Guard v2.0.0 — Stateless PreToolUse Hook
 *
 * Enforces a single, transparent-encryption-compatible & BOM/EOL-safe workspace editing channel:
 *   1. ALLOWS `scripts/agy-fs.mjs` (`read`, `read-many`, `apply`), read-only/test commands, and `.gemini/` / `scratch/` / temp writes.
 *   2. DENIES workspace `edit_file` / `write_file` / `replace_file_content` (prevents 4KB DLP ciphertext errors & IDE dirty-buffer split-brain; allows non-workspace Artifact / `.gemini` writes).
 *   3. DENIES encoding-unsafe raw shell workspace writes (`Set-Content`, `Add-Content`, `Out-File`, `[IO.File]::Write*`, shell `>` / `>>`, `sed -i`, `perl -i`, `tee`).
 *   4. ASKS user confirmation (`decision: "ask"`) for custom batch scripts (`fs.writeFileSync`, `Path.write_text`, `git apply`) outside `agy-fs.mjs`.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const IDE_EDITOR_TOOLS = new Set([
  'edit_file',
  'write_file',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content'
]);

const SHELL_TOOLS = new Set(['run_command', 'run_shell_command']);
const GUARD_VERSION = '2.0.0';

const SELF_PLUGIN_DIR_RAW = path.resolve(__dirname, '..');
const AGY_FS_SCRIPT_RAW = path.resolve(SELF_PLUGIN_DIR_RAW, 'scripts', 'agy-fs.mjs');
const AGY_FS_DISPLAY_PATH = AGY_FS_SCRIPT_RAW.replace(/\\/g, '/');

const PS_RESERVED_VARS = new Set([
  '_',
  'psitem',
  'args',
  'input',
  'this',
  'pwd',
  'error',
  'matches',
  'lastexitcode',
  'null',
  'true',
  'false',
  'env',
  'home'
]);

function getEnvCaseInsensitive(name) {
  if (!name) return '';
  if (process.env[name] !== undefined && process.env[name] !== '') {
    return process.env[name];
  }
  const upper = name.toUpperCase();
  for (const k of Object.keys(process.env)) {
    if (k.toUpperCase() === upper && process.env[k]) {
      return process.env[k];
    }
  }
  return '';
}

function expandUserEnv(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let s = raw.trim();
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  if (s === '~') {
    s = home;
  } else if (s.startsWith('~/') || s.startsWith('~\\')) {
    s = path.join(home, s.slice(2));
  }
  s = s.replace(/\$\{?env:([A-Za-z_][A-Za-z0-9_]*)\}?/gi, (full, name) => {
    const val = getEnvCaseInsensitive(name);
    return val ? val : full;
  });
  s = s.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (full, name) => {
    const val = getEnvCaseInsensitive(name);
    return val ? val : full;
  });
  s = s.replace(/\$(?:HOME|\{HOME\})(?=$|[\\/])/g, () => home);
  s = s.replace(/\$(?:TMPDIR|\{TMPDIR\})(?=$|[\\/])/g, () => getEnvCaseInsensitive('TMPDIR') || os.tmpdir());
  return s;
}

function normalizePath(targetPath, baseDir) {
  if (!targetPath || typeof targetPath !== 'string') return '';
  let p = expandUserEnv(targetPath);
  if (!p) return '';
  p = p.replace(/^\\\\\?\\/, '');
  if (/^[a-zA-Z]:[\\/]/.test(p)) {
    p = path.win32.resolve(p);
  } else if (p.startsWith('/')) {
    p = path.posix.normalize(p);
  } else if (!path.isAbsolute(p) && baseDir) {
    p = path.resolve(baseDir, p);
  }
  p = p.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (p.length > 1 && !/^[a-zA-Z]:\/$/.test(p)) {
    p = p.replace(/\/+$/, '');
  }
  if (/^[a-zA-Z]:/.test(p)) {
    p = p.toLowerCase();
  }
  return p;
}

const SELF_PLUGIN_DIR_NORM = normalizePath(SELF_PLUGIN_DIR_RAW);
const AGY_FS_SCRIPT_NORM = normalizePath(AGY_FS_SCRIPT_RAW);
const TRUSTED_WORKER_PROD_SCRIPTS = new Set(
  [
    'D:/dev/github/dsh-plugins-collection/skills/codex-worker/scripts/Invoke-CodexTask.ps1',
    'D:/dev/github/dsh-plugins-collection/skills/codex-worker/scripts/Wait-CodexDesktopLink.ps1',
    'D:/dev/github/dsh-plugins-collection/skills/codex-worker/scripts/Add-CodexSidebarThread.ps1',
    'D:/dev/github/dsh-plugins-collection/skills/codex-worker/scripts/Remove-TaskWorktree.ps1',
    'D:/dev/github/dsh-plugins-collection/skills/codex-worker/scripts/Read-CodexAppliedSettings.ps1',
    'D:/dev/github/dsh-plugins-collection/skills/dsh-worker/scripts/Invoke-DshTask.ps1',
    'D:/dev/github/dsh-plugins-collection/skills/dsh-worker/scripts/Remove-TaskWorktree.ps1'
  ].map((p) => normalizePath(p))
);
const TRUSTED_WORKER_TEST_RUNNERS = new Set(
  [
    'D:/dev/github/dsh-plugins-collection/skills/codex-worker/scripts/tests/Test-Dispatcher.ps1',
    'D:/dev/github/dsh-plugins-collection/skills/dsh-worker/scripts/tests/Test-Dispatcher.ps1'
  ].map((p) => normalizePath(p))
);
const WORKER_ENGINE_OVERRIDE_SPECS = [
  { full: 'codexpath', minPrefix: 'co' },
  { full: 'dshentry', minPrefix: 'dshe' },
  { full: 'dshpackage', minPrefix: 'dshp' },
  { full: 'nodepath', minPrefix: 'nod' },
  { full: 'sourceconfig', minPrefix: 'so' }
];

function hasWorkerEngineOverrideArg(commandLine) {
  if (!commandLine || typeof commandLine !== 'string') return false;
  const re = /(?:^|\s)-([A-Za-z][A-Za-z0-9]*)(?=[\s:=]|$)/g;
  let m;
  while ((m = re.exec(commandLine)) !== null) {
    const tok = m[1].toLowerCase();
    for (const spec of WORKER_ENGINE_OVERRIDE_SPECS) {
      if (tok.startsWith(spec.minPrefix) && spec.full.startsWith(tok)) {
        return true;
      }
    }
  }
  return false;
}

function isTrustedWorkerScript(resolvedPath, commandLine, ctx, constants) {
  if (!resolvedPath || !/\.ps1$/i.test(resolvedPath)) return false;
  let normReal = '';
  try {
    normReal = normalizePath(fs.realpathSync(resolvedPath));
  } catch (_) {
    // Fail closed: never trust lexical paths when realpath cannot be resolved
    return false;
  }
  if (!normReal) return false;

  if (TRUSTED_WORKER_PROD_SCRIPTS.has(normReal)) {
    // Only exempt fixed-engine production invocations; custom engine overrides (including PS prefix abbreviations) undergo full inspection
    if (hasWorkerEngineOverrideArg(commandLine)) {
      return false;
    }
    return true;
  }

  if (TRUSTED_WORKER_TEST_RUNNERS.has(normReal)) {
    // Offline test runners are only exempted when -ScratchRoot explicitly resolves to a safe scratch/temp target
    const m = /(?:^|\s)-ScratchRoot\s+(?:'([^'\r\n]+)'|"([^"\r\n]+)"|([^\s;|&><"']+))/i.exec(commandLine || '');
    if (!m) return false;
    const rawScratch = m[1] !== undefined ? `'${m[1]}'` : m[2] !== undefined ? `"${m[2]}"` : m[3];
    return Boolean(rawScratch && isSafeScratchTarget(rawScratch, ctx, constants, 'shell'));
  }

  return false;
}

function isExcludedPath(normPath, ctx) {
  if (!normPath) return true;
  if (normPath.includes('/.gemini/') || normPath.endsWith('/.gemini')) return true;
  if (normPath.includes('/scratch/') || normPath.endsWith('/scratch')) return true;
  if (normPath.includes('/work/tmp/') || normPath.endsWith('/work/tmp')) return true;
  if (
    normPath === '/tmp' ||
    normPath.startsWith('/tmp/') ||
    normPath === '/var/tmp' ||
    normPath.startsWith('/var/tmp/') ||
    normPath.includes('/appdata/local/temp/') ||
    normPath.endsWith('/appdata/local/temp')
  ) {
    return true;
  }
  const sysTmp = normalizePath(os.tmpdir());
  if (sysTmp && (normPath === sysTmp || normPath.startsWith(sysTmp + '/'))) {
    return true;
  }
  if (ctx && ctx.artifactDirectoryPath) {
    const art = normalizePath(ctx.artifactDirectoryPath);
    if (art && (normPath === art || normPath.startsWith(art + '/'))) {
      return true;
    }
  }
  return false;
}

function getWorkspaceRoots(ctx) {
  const roots = [];
  if (ctx && Array.isArray(ctx.workspacePaths)) {
    for (const wp of ctx.workspacePaths) {
      const n = normalizePath(wp);
      if (n) roots.push(n);
    }
  }
  if (roots.length === 0 && ctx && ctx.cwd) {
    const n = normalizePath(ctx.cwd);
    if (n) roots.push(n);
  }
  return roots;
}

function isWorkspaceFile(targetPath, ctx) {
  if (!targetPath || typeof targetPath !== 'string') return false;
  const baseDir = (ctx && (ctx.cwd || (Array.isArray(ctx.workspacePaths) && ctx.workspacePaths[0]))) || '';
  const norm = normalizePath(targetPath, baseDir);
  if (!norm || isExcludedPath(norm, ctx)) return false;
  const roots = getWorkspaceRoots(ctx);
  if (roots.length === 0) return false;
  return roots.some((r) => norm === r || norm.startsWith(r + '/'));
}

function stripTrailingInlineComment(rhs) {
  if (!rhs || typeof rhs !== 'string') return '';
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  for (let i = 0; i < rhs.length; i++) {
    const ch = rhs[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '\\' || ch === '`') {
        i++;
        continue;
      }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inBacktick) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '`') inBacktick = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === '`') {
      inBacktick = true;
      continue;
    }
    if (ch === '}') {
      return rhs.slice(0, i).trim();
    }
    if (ch === '#' && (i === 0 || /\s/.test(rhs[i - 1]))) {
      return rhs.slice(0, i).trim();
    }
    if (ch === '/' && rhs[i + 1] === '/' && (i === 0 || /\s/.test(rhs[i - 1]))) {
      return rhs.slice(0, i).trim();
    }
  }
  return rhs.trim();
}

function splitTopLevelByChar(expr, sepChar) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inBacktick) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '`') inBacktick = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === '`') {
      inBacktick = true;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth > 0) depth--;
      continue;
    }
    if (depth === 0 && ch === sepChar) {
      parts.push(expr.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(expr.slice(start));
  return parts;
}

function interpolateDollarVars(str, psConsts, plainConsts) {
  if (!str || typeof str !== 'string') return null;
  if (str.includes('$(') || str.includes('`') || str.includes('$[')) return null;
  let out = expandUserEnv(str);
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (full, name) => {
    const psVal = psConsts.get(name.toLowerCase());
    if (psVal !== undefined) return psVal;
    const plainVal = plainConsts.get(name);
    if (plainVal !== undefined) return plainVal;
    return full;
  });
  out = out.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (full, name) => {
    const psVal = psConsts.get(name.toLowerCase());
    if (psVal !== undefined) return psVal;
    const plainVal = plainConsts.get(name);
    if (plainVal !== undefined) return plainVal;
    return full;
  });
  return expandUserEnv(out);
}

function evalStaticPathExpr(rawExpr, constants, mode) {
  if (!rawExpr || typeof rawExpr !== 'string') return null;
  const psConsts = (constants && constants.psConsts) || new Map();
  const plainConsts = (constants && constants.plainConsts) || new Map();
  const evalMode = mode || 'code';
  let expr = rawExpr.trim();
  if (!expr) return null;

  while (expr.startsWith('(') && expr.endsWith(')')) {
    const inner = expr.slice(1, -1).trim();
    if (splitTopLevelByChar(inner, ')').length === 1) {
      expr = inner;
    } else {
      break;
    }
  }

  if (expr.startsWith("'") && expr.endsWith("'") && expr.length >= 2 && !expr.slice(1, -1).includes("'")) {
    const inner = expandUserEnv(expr.slice(1, -1));
    return !/[$`{}%]/.test(inner) ? inner : null;
  }

  if (evalMode === 'code' && /^[fFrR]['"]/.test(expr) && expr.length >= 3) {
    const prefix = expr[0].toLowerCase();
    const q = expr[1];
    if (expr.endsWith(q) && !expr.slice(2, -1).includes(q)) {
      let inner = expr.slice(2, -1);
      if (inner.includes('$(') || inner.includes('`')) return null;
      if (prefix === 'f') {
        inner = inner.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (full, name) => {
          const v = plainConsts.get(name);
          return v !== undefined ? v : full;
        });
      }
      const res = expandUserEnv(inner);
      return !/[$`{}%]/.test(res) ? res : null;
    }
  }

  if (expr.startsWith('"') && expr.endsWith('"') && expr.length >= 2 && !expr.slice(1, -1).includes('"')) {
    const inner = expr.slice(1, -1);
    const res = interpolateDollarVars(inner, psConsts, plainConsts);
    return res !== null && !/[$`{}%]/.test(res) ? res : null;
  }

  if (evalMode === 'code' && expr.startsWith('`') && expr.endsWith('`') && expr.length >= 2 && !expr.slice(1, -1).includes('`')) {
    let inner = expr.slice(1, -1);
    if (inner.includes('$(')) return null;
    inner = inner.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (full, name) => {
      const v = plainConsts.get(name);
      return v !== undefined ? v : full;
    });
    const res = expandUserEnv(inner);
    return !/[$`{}%]/.test(res) ? res : null;
  }

  const joinPathMatch = /^Join-Path\s+(?:-Path\s+)?(.+?)\s+(?:-ChildPath\s+)?(.+)$/i.exec(expr);
  if (joinPathMatch) {
    const p1 = evalStaticPathExpr(joinPathMatch[1], constants, 'shell');
    const p2 = evalStaticPathExpr(joinPathMatch[2], constants, 'shell');
    if (p1 && p2) {
      const joined = `${p1.replace(/[\\/]+$/, '')}/${p2.replace(/^[\\/]+/, '')}`;
      return !/[$`{}%]/.test(joined) ? joined : null;
    }
    return null;
  }

  if (evalMode === 'code') {
    const joinCallMatch = /^(?:path\.join|os\.path\.join|pathlib\.Path|Path)\s*\(([\s\S]+)\)$/.exec(expr);
    if (joinCallMatch) {
      const rawArgs = splitTopLevelByChar(joinCallMatch[1], ',');
      const resolvedParts = [];
      for (const a of rawArgs) {
        const v = evalStaticPathExpr(a, constants, 'code');
        if (!v) return null;
        resolvedParts.push(v);
      }
      if (resolvedParts.length > 0) {
        const joined = resolvedParts
          .map((seg, idx) => (idx === 0 ? seg.replace(/[\\/]+$/, '') : seg.replace(/^[\\/]+|[\\/]+$/g, '')))
          .join('/');
        return !/[$`{}%]/.test(joined) ? joined : null;
      }
    }

    const plusParts = splitTopLevelByChar(expr, '+');
    if (plusParts.length > 1) {
      const resolvedParts = [];
      for (const part of plusParts) {
        const v = evalStaticPathExpr(part, constants, 'code');
        if (v === null) return null;
        resolvedParts.push(v);
      }
      const joined = resolvedParts.join('');
      return joined && !/[$`{}%]/.test(joined) ? joined : null;
    }

    const slashParts = splitTopLevelByChar(expr, '/');
    if (slashParts.length > 1 && /^(?:pathlib\.)?Path\s*\(/.test(slashParts[0].trim())) {
      const resolvedParts = [];
      for (const part of slashParts) {
        const v = evalStaticPathExpr(part, constants, 'code');
        if (!v) return null;
        resolvedParts.push(v);
      }
      const joined = resolvedParts
        .map((seg, idx) => (idx === 0 ? seg.replace(/[\\/]+$/, '') : seg.replace(/^[\\/]+|[\\/]+$/g, '')))
        .join('/');
      return !/[$`{}%]/.test(joined) ? joined : null;
    }

    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(expr)) {
      const v = plainConsts.get(expr);
      return v !== undefined && !/[$`{}%]/.test(v) ? v : null;
    }
  }

  const bareDollar = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/.exec(expr);
  if (bareDollar) {
    const envAttempt = expandUserEnv(expr);
    if (envAttempt !== expr && !/[$`{}%]/.test(envAttempt)) {
      return envAttempt;
    }
    const name = bareDollar[1] || bareDollar[2];
    const v = psConsts.get(name.toLowerCase()) ?? plainConsts.get(name);
    return v !== undefined && !/[$`{}%]/.test(v) ? v : null;
  }

  if (evalMode === 'shell') {
    if (expr.includes('$(') || expr.includes('`') || /[<>|&;()]/.test(expr)) return null;
    let assembled = '';
    let i = 0;
    while (i < expr.length) {
      const ch = expr[i];
      if (ch === "'") {
        const end = expr.indexOf("'", i + 1);
        if (end === -1) return null;
        const lit = expr.slice(i + 1, end);
        if (/[$`{}%]/.test(lit)) return null;
        assembled += lit;
        i = end + 1;
      } else if (ch === '"') {
        const end = expr.indexOf('"', i + 1);
        if (end === -1) return null;
        const seg = interpolateDollarVars(expr.slice(i + 1, end), psConsts, plainConsts);
        if (seg === null) return null;
        assembled += seg;
        i = end + 1;
      } else {
        let end = i;
        while (end < expr.length && expr[end] !== "'" && expr[end] !== '"') end++;
        const seg = interpolateDollarVars(expr.slice(i, end), psConsts, plainConsts);
        if (seg === null) return null;
        assembled += seg;
        i = end;
      }
    }
    const res = expandUserEnv(assembled);
    return res && !/[$`{}%]/.test(res) ? res : null;
  }

  return null;
}

function extractStaticConstants(text) {
  const psConsts = new Map();
  const plainConsts = new Map();
  if (!text || typeof text !== 'string') {
    return { psConsts, plainConsts };
  }

  const psTainted = new Set(PS_RESERVED_VARS);
  const psCounts = new Map();
  const psCandidates = [];

  for (const m of text.matchAll(/\bforeach\s*\(\s*\$([A-Za-z_][A-Za-z0-9_]*)\b/gi)) {
    psTainted.add(m[1].toLowerCase());
  }
  for (const m of text.matchAll(/(?:-OutVariable|-ov|-ErrorVariable|-ev|-WarningVariable|-wv)\s+['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/gi)) {
    psTainted.add(m[1].toLowerCase());
  }
  for (const m of text.matchAll(/\b(?:Set-Variable|New-Variable|Remove-Variable|Clear-Variable|sv|nv|rv|clv)\b[^\r\n;|&]*?(?:-Name\s+|\s+)['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/gi)) {
    psTainted.add(m[1].toLowerCase());
  }
  for (const m of text.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)\s*(?:\+\+|--|[+\-*/%&|^]=)/g)) {
    psTainted.add(m[1].toLowerCase());
  }
  for (const m of text.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/g)) {
    const k = m[1].toLowerCase();
    psCounts.set(k, (psCounts.get(k) || 0) + 1);
  }
  for (const m of text.matchAll(/(?:^|[;\r\n|&({]\s*)\$([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)\s*([^\r\n;|&]+)/g)) {
    const k = m[1].toLowerCase();
    if (!psTainted.has(k) && psCounts.get(k) === 1) {
      const rhs = stripTrailingInlineComment(m[2]);
      if (rhs) psCandidates.push({ key: k, rhs });
    }
  }

  const plainTainted = new Set();
  const plainCounts = new Map();
  const plainCandidates = [];

  for (const m of text.matchAll(/\b(?:for|select)\s+(?:\(\s*)?(?:const\s+|let\s+|var\s+)?([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
    plainTainted.add(m[1]);
  }
  for (const m of text.matchAll(/\bread\b[^\r\n;|&]*?\s([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
    plainTainted.add(m[1]);
  }
  for (const m of text.matchAll(/\bas\s+([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
    plainTainted.add(m[1]);
  }
  for (const m of text.matchAll(/(?<![.\w$:])([A-Za-z_][A-Za-z0-9_]*)\s*(?:\+\+|--|[+\-*/%&|^]=)/g)) {
    plainTainted.add(m[1]);
  }
  for (const m of text.matchAll(/(?<![.\w$:])([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/g)) {
    const k = m[1];
    plainCounts.set(k, (plainCounts.get(k) || 0) + 1);
  }
  for (const m of text.matchAll(/(?:^|[;\r\n|&({]\s*)(?:(?:const|let|var|export|local|readonly)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)\s*([^\r\n;|&]+)/g)) {
    const k = m[1];
    if (!plainTainted.has(k) && plainCounts.get(k) === 1) {
      const rhs = stripTrailingInlineComment(m[2]);
      if (rhs) plainCandidates.push({ key: k, rhs });
    }
  }

  const ctxConsts = { psConsts, plainConsts };
  for (let pass = 0; pass < 4; pass++) {
    let progressed = false;
    for (const item of psCandidates) {
      if (psConsts.has(item.key)) continue;
      const val = evalStaticPathExpr(item.rhs, ctxConsts, 'shell') ?? evalStaticPathExpr(item.rhs, ctxConsts, 'code');
      if (val !== null) {
        psConsts.set(item.key, val);
        progressed = true;
      }
    }
    for (const item of plainCandidates) {
      if (plainConsts.has(item.key)) continue;
      const val = evalStaticPathExpr(item.rhs, ctxConsts, 'code') ?? evalStaticPathExpr(item.rhs, ctxConsts, 'shell');
      if (val !== null) {
        plainConsts.set(item.key, val);
        progressed = true;
      }
    }
    if (!progressed) break;
  }

  return ctxConsts;
}

function isSafeScratchTarget(literalOrUnquotedPath, ctx, constants, mode) {
  if (!literalOrUnquotedPath || typeof literalOrUnquotedPath !== 'string') return false;
  const trimmed = literalOrUnquotedPath.trim();
  if (/^(?:\$null|NUL|\/dev\/null|CON)$/i.test(trimmed)) return true;

  let candidate = trimmed;
  if (/^['"`]/.test(trimmed) || /[$`{}%]/.test(trimmed) || (constants && (mode === 'code' || mode === 'shell'))) {
    const resolved = evalStaticPathExpr(trimmed, constants, mode || 'shell');
    if (resolved !== null) {
      candidate = resolved;
    } else if (/^['"`]/.test(trimmed) || /[$`{}%]/.test(trimmed)) {
      const envExpanded = expandUserEnv(trimmed);
      if (envExpanded !== trimmed && !/^['"`]/.test(envExpanded) && !/[$`{}%]/.test(envExpanded)) {
        candidate = envExpanded;
      } else {
        return false;
      }
    }
  }

  if (/[$`{}%]/.test(candidate)) return false;
  if (/^(?:\$null|NUL|\/dev\/null|CON)$/i.test(candidate)) return true;
  const baseDir = (ctx && (ctx.cwd || (Array.isArray(ctx.workspacePaths) && ctx.workspacePaths[0]))) || '';
  const norm = normalizePath(candidate, baseDir);
  if (!norm) return false;
  return isExcludedPath(norm, ctx);
}

function isAgyFsCommandSegment(segment, ctx, constants) {
  const m = /^node(?:\.exe)?\b(?:\s+(?:-[a-zA-Z0-9_-]+|--[a-zA-Z0-9_=-]+))*\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s;|&><"']+))/i.exec(
    segment.trim()
  );
  if (!m) return false;
  const rawScript = m[1] || m[2] || m[3];
  const expanded = evalStaticPathExpr(rawScript, constants, 'shell') || expandUserEnv(rawScript);
  const baseDir = (ctx && (ctx.cwd || (Array.isArray(ctx.workspacePaths) && ctx.workspacePaths[0]))) || process.cwd();
  const norm = normalizePath(expanded, baseDir);
  return norm === AGY_FS_SCRIPT_NORM;
}

function hasUnsafeHereStringExecution(cmd, ctx, constants) {
  if (!cmd || !/@['"]/.test(cmd)) return false;
  const pipeRe = /@(['"])[\s\S]*?\r?\n\1@\s*\|\s*([^\r\n;|&]+)/g;
  let m;
  while ((m = pipeRe.exec(cmd)) !== null) {
    const sink = m[2].trim();
    if (/^(?:iex|Invoke-Expression|powershell|pwsh|cmd|sh|bash|python3?|py|bun|deno)\b/i.test(sink)) {
      return true;
    }
    if (/^node(?:\.exe)?\b/i.test(sink) && !isAgyFsCommandSegment(sink, ctx, constants)) {
      return true;
    }
  }
  if (/\b(?:iex|Invoke-Expression)\b/i.test(cmd)) return true;
  if (/\b(?:node|bun|deno|python3?|py|powershell|pwsh)\b[^\r\n;|&]*?\s(?:-e|--eval|-c|-Command|-EncodedCommand)\s+\$/i.test(cmd)) {
    return true;
  }
  return false;
}

function stripPassiveHereStrings(cmd) {
  if (!cmd || typeof cmd !== 'string') return '';
  let out = cmd;
  out = out.replace(/@'[\s\S]*?\r?\n'@/g, " '' ");
  out = out.replace(/@"[\s\S]*?\r?\n"@/g, ' "" ');
  out = out.replace(/@'[^']*?'@/g, " '' ");
  out = out.replace(/@"[^"]*?"@/g, ' "" ');
  return out;
}

function stripInlineCodeBlocksForRedirection(cmd) {
  let out = stripPassiveHereStrings(cmd);
  out = out.replace(
    /(\b(?:node|bun|deno|python3?|py)\b[^\r\n;|&]*?(?:\s+-e|\s+--eval|\s+-c)\s+)('(?:\\.|[^'])*'|"(?:\\.|[^"])*")/gi,
    '$1 ""'
  );
  return out;
}

function isTestScriptPath(scriptPath) {
  return /\.(?:test|spec)\.(?:js|mjs|cjs|ts|py)$/i.test(scriptPath.trim());
}

function findReferencedScriptFiles(commandLine, ctx, constants) {
  if (!commandLine || typeof commandLine !== 'string') return [];
  const results = new Set();
  const baseDir = (ctx && (ctx.cwd || (Array.isArray(ctx.workspacePaths) && ctx.workspacePaths[0]))) || process.cwd();

  const runnerPatterns = [
    /\b(?:node|bun|tsx|ts-node|deno|python3?|py)\b(?:\s+(?:-[a-zA-Z0-9_-]+|--[a-zA-Z0-9_=-]+))*\s+(?:"([^"\r\n]+\.(?:js|mjs|cjs|ts|py))"|'([^'\r\n]+\.(?:js|mjs|cjs|ts|py))'|([^\s;|&><"']+\.(?:js|mjs|cjs|ts|py)))/gi,
    /\b(?:powershell|pwsh)(?:\.exe)?\b[^\r\n;|&]*?\s(?:-File|-f)\s+(?:"([^"\r\n]+\.ps1)"|'([^'\r\n]+\.ps1)'|([^\s;|&><"']+\.ps1))/gi
  ];

  for (const re of runnerPatterns) {
    let m;
    while ((m = re.exec(commandLine)) !== null) {
      if (/\b(?:node|bun|deno)\b[^\r\n;|&]*?\s(?:-c|--check)\b/i.test(m[0])) continue;
      const candidate = m[1] || m[2] || m[3];
      if (!candidate || candidate === '-') continue;
      if (isTestScriptPath(candidate)) continue;
      const expanded = evalStaticPathExpr(candidate, constants, 'shell') || expandUserEnv(candidate);
      const resolved =
        path.isAbsolute(expanded) || /^[a-zA-Z]:[\\/]/.test(expanded) ? expanded : path.resolve(baseDir, expanded);
      const normResolved = normalizePath(resolved);
      if (SELF_PLUGIN_DIR_NORM && (normResolved === SELF_PLUGIN_DIR_NORM || normResolved.startsWith(SELF_PLUGIN_DIR_NORM + '/'))) {
        continue;
      }
      if (isTrustedWorkerScript(resolved, commandLine, ctx, constants)) {
        continue;
      }
      results.add(resolved);
    }
  }
  return Array.from(results);
}

function stripJsComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\r\n]*/g, ' ');
}

function stripHashComments(code) {
  return code.replace(/(?:^|(?<=\s))#[^\r\n]*/gm, ' ');
}

function inferLangFromSource(sourceLabel) {
  if (!sourceLabel || sourceLabel === 'commandLine') return 'shell';
  const lower = sourceLabel.toLowerCase();
  if (/\.(?:js|mjs|cjs|ts|tsx|jsx)$/.test(lower)) return 'js';
  if (/\.py$/.test(lower)) return 'py';
  if (/\.ps1$/.test(lower)) return 'ps1';
  return 'shell';
}

/**
 * Inspects shell/script text for workspace writes.
 * Returns { detected: false } or { detected: true, severity: 'unsafe_raw' | 'custom_script', evidence, source }.
 */
function analyzeWriteCalls(rawText, ctx, sourceLabel, precomputedConstants) {
  if (!rawText || typeof rawText !== 'string') return { detected: false };

  const lang = inferLangFromSource(sourceLabel);
  const text =
    lang === 'js'
      ? stripJsComments(rawText)
      : lang === 'py' || lang === 'ps1' || lang === 'shell'
        ? stripHashComments(rawText)
        : rawText;

  const constants = precomputedConstants || extractStaticConstants(text);
  const rawFindings = [];
  const customFindings = [];

  const checkShellCmdlets = lang === 'shell' || lang === 'ps1';
  const checkJsPrimitives = lang === 'shell' || lang === 'js';
  const checkPyPrimitives = lang === 'shell' || lang === 'py';

  // Tier 1 (unsafe_raw -> deny): PowerShell Set-Content / Add-Content / Out-File / [IO.File]::Write* / sed -i / perl -i / tee
  if (checkShellCmdlets) {
    const psCmdletRe = /\b(?:Set-Content|Add-Content|Out-File)\b(?:[^\r\n;|&]*?(?:-Path|-LiteralPath|-FilePath)\s+|\s+)(?:'([^'\r\n]+)'|"([^"\r\n]+)"|([^\s;|&()-][^\s;|&()]*))?/gi;
    {
      let m;
      while ((m = psCmdletRe.exec(text)) !== null) {
        const rawTarget = m[1] !== undefined ? `'${m[1]}'` : m[2] !== undefined ? `"${m[2]}"` : m[3];
        if (rawTarget && isSafeScratchTarget(rawTarget, ctx, constants, 'shell')) {
          continue;
        }
        rawFindings.push({ severity: 'unsafe_raw', source: sourceLabel, evidence: m[0].slice(0, 120) });
      }
    }

    const psDotNetRe = /\[(?:System\.)?IO\.File\]::(?:WriteAllText|WriteAllLines|WriteAllBytes|AppendAllText|AppendAllLines|Copy|Move|Delete)\s*\(\s*([^,)\r\n]+)/gi;
    {
      let m;
      while ((m = psDotNetRe.exec(text)) !== null) {
        const lit = evalStaticPathExpr(m[1], constants, 'shell') ?? evalStaticPathExpr(m[1], constants, 'code');
        if (lit && isSafeScratchTarget(lit, ctx)) continue;
        rawFindings.push({ severity: 'unsafe_raw', source: sourceLabel, evidence: m[0].slice(0, 120) });
      }
    }

    const sedPerlRe = /\b(?:sed|perl)\b[^\r\n;|&]*\s(?:-[a-zA-Z]*i[a-zA-Z]*|--in-place)\b/g;
    {
      let m;
      while ((m = sedPerlRe.exec(text)) !== null) {
        rawFindings.push({ severity: 'unsafe_raw', source: sourceLabel, evidence: m[0].slice(0, 120) });
      }
    }

    const teeRe = /\btee\b(?:\s+-a)?\s+(?:'([^'\r\n]+)'|"([^"\r\n]+)"|([^\s;|&]+))/g;
    {
      let m;
      while ((m = teeRe.exec(text)) !== null) {
        const rawTarget = m[1] !== undefined ? `'${m[1]}'` : m[2] !== undefined ? `"${m[2]}"` : m[3];
        if (rawTarget && isSafeScratchTarget(rawTarget, ctx, constants, 'shell')) continue;
        rawFindings.push({ severity: 'unsafe_raw', source: sourceLabel, evidence: m[0].slice(0, 120) });
      }
    }
  }

  if (rawFindings.length > 0) {
    return { detected: true, ...rawFindings[0] };
  }

  // Tier 2 (custom_script -> ask): Custom Node/Python write primitives or git apply outside agy-fs.mjs
  if (checkJsPrimitives) {
    const fsPrefix = "(?:\\b(?:fs(?:\\.promises)?|fsp|fsPromises|promises)|require\\s*\\(\\s*['\"](?:node:)?fs(?:/promises)?['\"]\\s*\\)|import\\s*\\(\\s*['\"](?:node:)?fs(?:/promises)?['\"]\\s*\\))";
    const jsFirstArgPatterns = [
      /(?:\.|(?<![.\w]))(?:writeFileSync|appendFileSync|createWriteStream|rmSync|unlinkSync|truncateSync)\s*\(\s*([^,)\r\n]+)/g,
      new RegExp(`(?:${fsPrefix}\\.|(?<![.\\w]))(?:writeFile|appendFile|rm|unlink)\\s*\\(\\s*([^,)\\r\\n]+)`, 'g'),
      /\b(?:Bun\.write|Deno\.writeTextFile(?:Sync)?|Deno\.writeFile(?:Sync)?)\s*\(\s*([^,)\r\n]+)/g
    ];
    for (const re of jsFirstArgPatterns) {
      let m;
      while ((m = re.exec(text)) !== null) {
        const lit = evalStaticPathExpr(m[1], constants, 'code');
        if (lit && isSafeScratchTarget(lit, ctx)) continue;
        customFindings.push({ severity: 'custom_script', source: sourceLabel, evidence: m[0].slice(0, 120) });
      }
    }

    const jsTwoArgPatterns = [
      /(?:\.|(?<![.\w]))(?:renameSync|copyFileSync)\s*\(\s*([^,)\r\n]+)\s*,\s*([^,)\r\n]+)/g,
      new RegExp(`(?:${fsPrefix}\\.)(?:rename|copyFile)\\s*\\(\\s*([^,)\\r\\n]+)\\s*,\\s*([^,)\\r\\n]+)`, 'g')
    ];
    for (const re of jsTwoArgPatterns) {
      let m;
      while ((m = re.exec(text)) !== null) {
        const l1 = evalStaticPathExpr(m[1], constants, 'code');
        const l2 = evalStaticPathExpr(m[2], constants, 'code');
        if (l1 && l2 && isSafeScratchTarget(l1, ctx) && isSafeScratchTarget(l2, ctx)) continue;
        customFindings.push({ severity: 'custom_script', source: sourceLabel, evidence: m[0].slice(0, 120) });
      }
    }
  }

  if (checkPyPrimitives) {
    const pyOpenRe = /\bopen\s*\(\s*([^,\r\n]+)\s*,\s*(?:mode\s*=\s*)?(['"][^'"]*?[wax+][^'"]*?['"])/g;
    {
      let m;
      while ((m = pyOpenRe.exec(text)) !== null) {
        const lit = evalStaticPathExpr(m[1], constants, 'code');
        if (lit && isSafeScratchTarget(lit, ctx)) continue;
        customFindings.push({ severity: 'custom_script', source: sourceLabel, evidence: m[0].slice(0, 120) });
      }
    }

    const pyMethodRe = /(Path\s*\(\s*([^)]+)\s*\)|[A-Za-z_][A-Za-z0-9_.]*)\.(?:write_text|write_bytes)\s*\(/g;
    {
      let m;
      while ((m = pyMethodRe.exec(text)) !== null) {
        const lit = evalStaticPathExpr(m[1], constants, 'code');
        if (lit && isSafeScratchTarget(lit, ctx)) continue;
        customFindings.push({ severity: 'custom_script', source: sourceLabel, evidence: m[0].slice(0, 120) });
      }
    }

    const pyOtherRe = /\b(?:fileinput\.input\s*\([^)]*inplace\s*=\s*True|(?:shutil\.(?:copy|copy2|move)|os\.(?:replace|rename|remove|unlink))\s*\([^)]+\))/g;
    {
      let m;
      while ((m = pyOtherRe.exec(text)) !== null) {
        customFindings.push({ severity: 'custom_script', source: sourceLabel, evidence: m[0].slice(0, 120) });
      }
    }
  }

  if (checkShellCmdlets) {
    const gitApplyRe = /\bgit\s+apply\b(?![^\r\n;|&]*(?:--check|--stat)\b)/g;
    {
      let m;
      while ((m = gitApplyRe.exec(text)) !== null) {
        customFindings.push({ severity: 'custom_script', source: sourceLabel, evidence: m[0].slice(0, 120) });
      }
    }
  }

  if (customFindings.length > 0) {
    return { detected: true, ...customFindings[0] };
  }
  return { detected: false };
}

function detectShellRedirection(commandLine, ctx, precomputedConstants) {
  const stripped = stripInlineCodeBlocksForRedirection(commandLine);
  const constants = precomputedConstants || extractStaticConstants(stripped);

  let inSingle = false;
  let inDouble = false;
  let i = 0;
  while (i < stripped.length) {
    const ch = stripped[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      i++;
      continue;
    }
    if (inDouble) {
      if (ch === '\\' || ch === '`') {
        i += 2;
        continue;
      }
      if (ch === '"') inDouble = false;
      i++;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      i++;
      continue;
    }
    if (ch === '#' && (i === 0 || /[\s;|&({]/.test(stripped[i - 1]))) {
      while (i < stripped.length && stripped[i] !== '\n' && stripped[i] !== '\r') i++;
      continue;
    }

    if (ch === '>') {
      const prev = i > 0 ? stripped[i - 1] : '';
      if (prev === '-' || prev === '=' || prev === '<') {
        i++;
        continue;
      }

      let after = i + 1;
      if (stripped[after] === '>') after++;
      if (stripped[after] === '=') {
        i = after + 1;
        continue;
      }
      if (stripped[after] === '&' && /[0-9\-]/.test(stripped[after + 1] || '')) {
        i = after + 2;
        while (i < stripped.length && /[0-9]/.test(stripped[i])) i++;
        continue;
      }

      while (after < stripped.length && (stripped[after] === ' ' || stripped[after] === '\t')) {
        after++;
      }

      let end = after;
      let tokSingle = false;
      let tokDouble = false;
      while (end < stripped.length) {
        const tc = stripped[end];
        if (tokSingle) {
          if (tc === "'") tokSingle = false;
          end++;
          continue;
        }
        if (tokDouble) {
          if (tc === '\\' || tc === '`') {
            end += 2;
            continue;
          }
          if (tc === '"') tokDouble = false;
          end++;
          continue;
        }
        if (tc === "'") {
          tokSingle = true;
          end++;
          continue;
        }
        if (tc === '"') {
          tokDouble = true;
          end++;
          continue;
        }
        if (/[\s;|&><()\r\n]/.test(tc)) break;
        end++;
      }

      const raw = stripped.slice(after, end).trim();
      i = end;
      if (!raw) continue;
      if (/^(?:\$null|nul|\/dev\/null|CON)$/i.test(raw)) continue;
      if (isSafeScratchTarget(raw, ctx, constants, 'shell')) continue;
      return {
        detected: true,
        severity: 'unsafe_raw',
        evidence: `shell redirection > ${raw}`,
        source: 'commandLine'
      };
    }

    i++;
  }

  return { detected: false };
}

function detectShellWorkspaceWrite(commandLine, ctx) {
  if (!commandLine || typeof commandLine !== 'string') return { detected: false };

  const rawConstants = extractStaticConstants(commandLine);
  const safeToStripHereStrings = !hasUnsafeHereStringExecution(commandLine, ctx, rawConstants);
  const effectiveCmd = safeToStripHereStrings ? stripPassiveHereStrings(commandLine) : commandLine;
  const constants = safeToStripHereStrings ? extractStaticConstants(effectiveCmd) : rawConstants;

  const redirHit = detectShellRedirection(effectiveCmd, ctx, constants);
  if (redirHit.detected) return redirHit;

  const codeHit = analyzeWriteCalls(effectiveCmd, ctx, 'commandLine', constants);
  if (codeHit.detected && codeHit.severity === 'unsafe_raw') {
    return codeHit;
  }

  const scriptFiles = findReferencedScriptFiles(effectiveCmd, ctx, constants);
  let customHit = codeHit.detected ? codeHit : null;

  for (const sf of scriptFiles) {
    try {
      if (!fs.existsSync(sf)) continue;
      const st = fs.statSync(sf);
      if (!st.isFile() || st.size > 512 * 1024) continue;
      const body = fs.readFileSync(sf, 'utf8');
      const scriptHit = analyzeWriteCalls(body, ctx, sf);
      if (scriptHit.detected) {
        if (scriptHit.severity === 'unsafe_raw') {
          return { ...scriptHit, script: sf };
        }
        if (!customHit) {
          customHit = { ...scriptHit, script: sf };
        }
      }
    } catch (_) {
      // Ignore unreadable external script files
    }
  }

  if (customHit) {
    return customHit;
  }
  return { detected: false };
}

function extractIdeTargetPath(args) {
  if (!args || typeof args !== 'object') return '';
  const raw =
    args.Path ??
    args.path ??
    args.TargetFile ??
    args.targetFile ??
    args.FilePath ??
    args.filePath ??
    '';
  return String(raw || '');
}

function handlePreToolUse(payload) {
  const toolCall = payload.toolCall || {};
  const toolName = String(toolCall.name || '');
  const args = toolCall.args || {};

  if (IDE_EDITOR_TOOLS.has(toolName)) {
    const target = extractIdeTargetPath(args);
    if (!isWorkspaceFile(target, payload)) {
      return { decision: 'allow' };
    }
    return {
      decision: 'deny',
      reason: `[edit-integrity-guard] 工作区已全局切换为受控脚本单一通道（兼容企业 4KB 透明加密文件并杜绝 IDE 脏缓冲区冲突），禁止对工作区文件调用 ${toolName}。请改用 run_command 执行：node "${AGY_FS_DISPLAY_PATH}" apply --stdin（或 --spec <scratch.json>）。`
    };
  }

  if (SHELL_TOOLS.has(toolName)) {
    const cmd = String(args.CommandLine ?? args.commandLine ?? args.command ?? args.Command ?? '');
    const hit = detectShellWorkspaceWrite(cmd, payload);
    if (!hit.detected) {
      return { decision: 'allow' };
    }
    if (hit.severity === 'unsafe_raw') {
      return {
        decision: 'deny',
        reason: `[edit-integrity-guard] 禁止使用高危裸写盘命令直接修改工作区文件（触发特征：${hit.evidence}），这会破坏无 BOM UTF-8 编码或把 CRLF 污染为 LF/UTF-16LE。请统一调用：node "${AGY_FS_DISPLAY_PATH}" apply --stdin（或 --spec <scratch.json>）。`
      };
    }
    return {
      decision: 'ask',
      reason: `[edit-integrity-guard] 检测到自定义批处理脚本写工作区（触发特征：${hit.evidence}）。常规多文件修改请优先使用内置的 agy-fs.mjs（免弹窗直通且自动保留 BOM 与 CRLF）；如确需执行自定义批处理脚本，请确认脚本已保留原文件 BOM 与 CRLF 行尾。`
    };
  }

  return { decision: 'allow' };
}

function evaluateHook(modeArg, payload) {
  const hookEvent = payload && payload.hookEventName;
  const isPost = modeArg === 'post' || (modeArg !== 'pre' && hookEvent === 'PostToolUse');
  return isPost ? {} : handlePreToolUse(payload || {});
}

function main() {
  const modeArg = process.argv[2] || '';
  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) {
      process.stdout.write(JSON.stringify(modeArg === 'post' ? {} : { decision: 'allow' }));
      return;
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (_) {
      process.stdout.write(JSON.stringify(modeArg === 'post' ? {} : { decision: 'allow' }));
      return;
    }
    const result = evaluateHook(modeArg, payload);
    process.stdout.write(JSON.stringify(result));
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  GUARD_VERSION,
  AGY_FS_DISPLAY_PATH,
  normalizePath,
  isExcludedPath,
  isWorkspaceFile,
  isSafeScratchTarget,
  extractStaticConstants,
  evalStaticPathExpr,
  detectShellWorkspaceWrite,
  evaluateHook
};
