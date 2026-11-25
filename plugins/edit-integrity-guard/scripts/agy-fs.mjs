#!/usr/bin/env node
/**
 * agy-fs.mjs — Atomic, transparent-encryption-friendly UTF-8 & BOM/EOL-preserving file tool.
 *
 * Commands:
 *   node agy-fs.mjs read <path> [startLine] [endLine] [--start N] [--end M] [--max-lines 800]
 *   node agy-fs.mjs read-many <path[:start-end]> ...
 *   node agy-fs.mjs apply (--stdin | --spec <jsonPath>) [--dry-run] [--cleanup]
 */

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_LINES = 800;
const DEFAULT_MAX_BYTES = 46080;

function fail(message) {
  process.stderr.write(`[agy-fs ERROR] ${message}\n`);
  process.exit(1);
}

function resolveTargetPath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') {
    fail('Missing file path.');
  }
  const trimmed = rawPath.trim();
  if (!trimmed) {
    fail('Empty file path.');
  }
  return path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(process.cwd(), trimmed);
}

function detectBinaryOrUtf16(buf) {
  if (buf.length >= 2) {
    if (buf[0] === 0xff && buf[1] === 0xfe) {
      return 'UTF-16LE BOM detected (not UTF-8)';
    }
    if (buf[0] === 0xfe && buf[1] === 0xff) {
      return 'UTF-16BE BOM detected (not UTF-8)';
    }
  }
  const scanLen = Math.min(buf.length, 8192);
  for (let i = 0; i < scanLen; i++) {
    if (buf[i] === 0x00) {
      return `Binary content detected (null byte at offset ${i})`;
    }
  }
  return null;
}

function decodeFileBuffer(buf, filePath) {
  const binaryErr = detectBinaryOrUtf16(buf);
  if (binaryErr) {
    fail(`${filePath}: ${binaryErr}`);
  }
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const bodyBuf = hasBom ? buf.subarray(3) : buf;
  const rawText = bodyBuf.toString('utf8');

  let crlfCount = 0;
  let bareLfCount = 0;
  for (let i = 0; i < rawText.length; i++) {
    if (rawText.charCodeAt(i) === 0x0a) {
      if (i > 0 && rawText.charCodeAt(i - 1) === 0x0d) {
        crlfCount++;
      } else {
        bareLfCount++;
      }
    }
  }

  let eol;
  if (crlfCount === 0 && bareLfCount === 0) {
    eol = process.platform === 'win32' ? '\r\n' : '\n';
  } else if (crlfCount >= bareLfCount) {
    eol = '\r\n';
  } else {
    eol = '\n';
  }

  const normalized = rawText.replace(/\r\n/g, '\n');
  return {
    hasBom,
    eol,
    eolLabel: eol === '\r\n' ? 'CRLF' : 'LF',
    crlfCount,
    bareLfCount,
    normalized
  };
}

function encodeFileBuffer(normalizedText, hasBom, eol) {
  const withNormalized = normalizedText.replace(/\r\n/g, '\n');
  const finalText = eol === '\r\n' ? withNormalized.replace(/\n/g, '\r\n') : withNormalized;
  const bodyBuf = Buffer.from(finalText, 'utf8');
  return hasBom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bodyBuf]) : bodyBuf;
}

function printFileSlice(rawPath, startLineOpt, endLineOpt, maxLines = DEFAULT_MAX_LINES) {
  const absPath = resolveTargetPath(rawPath);
  if (!existsSync(absPath)) {
    fail(`File does not exist: ${absPath}`);
  }
  const st = statSync(absPath);
  if (!st.isFile()) {
    fail(`Path is not a regular file: ${absPath}`);
  }

  const buf = readFileSync(absPath);
  const decoded = decodeFileBuffer(buf, absPath);
  const lines = decoded.normalized.length === 0 ? [] : decoded.normalized.split('\n');
  const totalLines = lines.length;

  if (totalLines === 0) {
    process.stdout.write(
      `[agy-fs] ${absPath} | empty file (0 lines) | BOM=${decoded.hasBom} | EOL=${decoded.eolLabel}\n`
    );
    return;
  }

  const startLine = Math.max(1, startLineOpt ? Number(startLineOpt) : 1);
  if (!Number.isInteger(startLine) || startLine < 1) {
    fail(`Invalid startLine: ${startLineOpt}`);
  }
  if (startLine > totalLines) {
    process.stdout.write(
      `[agy-fs] ${absPath} | startLine ${startLine} > totalLines ${totalLines} | BOM=${decoded.hasBom} | EOL=${decoded.eolLabel}\n`
    );
    return;
  }

  const requestedEnd = endLineOpt ? Number(endLineOpt) : startLine + maxLines - 1;
  if (!Number.isInteger(requestedEnd) || requestedEnd < startLine) {
    fail(`Invalid endLine: ${endLineOpt}`);
  }
  const endLine = Math.min(totalLines, requestedEnd, startLine + maxLines - 1);

  const outLines = [];
  let byteCount = 0;
  let actualEnd = startLine - 1;
  let truncatedByBytes = false;

  for (let ln = startLine; ln <= endLine; ln++) {
    const formatted = `${ln}: ${lines[ln - 1]}\n`;
    const len = Buffer.byteLength(formatted, 'utf8');
    if (outLines.length > 0 && byteCount + len > DEFAULT_MAX_BYTES) {
      truncatedByBytes = true;
      break;
    }
    outLines.push(formatted);
    byteCount += len;
    actualEnd = ln;
  }

  const truncNote = truncatedByBytes
    ? ` (truncated at ${DEFAULT_MAX_BYTES} bytes; continue from line ${actualEnd + 1})`
    : actualEnd < totalLines && !endLineOpt
      ? ` (capped at ${maxLines} lines; continue from line ${actualEnd + 1})`
      : '';

  process.stdout.write(
    `[agy-fs] ${absPath} | lines ${startLine}-${actualEnd} of ${totalLines} | BOM=${decoded.hasBom} | EOL=${decoded.eolLabel}${truncNote}\n` +
      outLines.join('')
  );
}

function handleReadCommand(args) {
  const positionals = [];
  let startLine = null;
  let endLine = null;
  let maxLines = DEFAULT_MAX_LINES;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--start' || a === '-s') {
      startLine = Number(args[++i]);
    } else if (a === '--end' || a === '-e') {
      endLine = Number(args[++i]);
    } else if (a === '--max-lines') {
      maxLines = Number(args[++i]);
    } else {
      positionals.push(a);
    }
  }

  if (positionals.length === 0) {
    fail('Usage: agy-fs.mjs read <path> [startLine] [endLine]');
  }
  const target = positionals[0];
  if (startLine === null && positionals[1] !== undefined) {
    startLine = Number(positionals[1]);
  }
  if (endLine === null && positionals[2] !== undefined) {
    endLine = Number(positionals[2]);
  }
  printFileSlice(target, startLine, endLine, maxLines);
}

function parsePathWithRange(spec) {
  const m = /^([\s\S]+?):(\d+)(?:-(\d+))?$/.exec(spec.trim());
  if (m && m[1].length > 1) {
    return {
      path: m[1],
      start: Number(m[2]),
      end: m[3] ? Number(m[3]) : null
    };
  }
  return { path: spec.trim(), start: null, end: null };
}

function handleReadManyCommand(args) {
  if (args.length === 0) {
    fail('Usage: agy-fs.mjs read-many <path[:start-end]> ...');
  }
  for (let i = 0; i < args.length; i++) {
    if (i > 0) {
      process.stdout.write('\n');
    }
    const item = parsePathWithRange(args[i]);
    printFileSlice(item.path, item.start, item.end, DEFAULT_MAX_LINES);
  }
}

function findOccurrenceLines(haystack, needle) {
  const lineNumbers = [];
  let pos = 0;
  while (pos <= haystack.length) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    let line = 1;
    for (let i = 0; i < idx; i++) {
      if (haystack.charCodeAt(i) === 0x0a) line++;
    }
    lineNumbers.push(line);
    pos = idx + Math.max(1, needle.length);
  }
  return lineNumbers;
}

function buildMissingTargetHint(normalizedContent, normalizedTarget) {
  const firstNonEmpty = normalizedTarget
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstNonEmpty) return '';
  const srcLines = normalizedContent.split('\n');
  const near = [];
  for (let i = 0; i < srcLines.length; i++) {
    if (srcLines[i].includes(firstNonEmpty)) {
      near.push(i + 1);
      if (near.length >= 5) break;
    }
  }
  if (near.length > 0) {
    return ` Hint: trimmed first line "${firstNonEmpty.slice(0, 80)}" appears near line(s) [${near.join(', ')}] (check whitespace/indentation or surrounding lines).`;
  }
  return ` First non-empty target line "${firstNonEmpty.slice(0, 80)}" was not found anywhere in the file.`;
}

function readAllStdin() {
  return readFileSync(0, 'utf8');
}

function resolveEolChoice(choice, fallbackEol) {
  if (!choice || choice === 'preserve' || choice === 'auto') return fallbackEol;
  const lower = String(choice).toLowerCase();
  if (lower === 'crlf' || choice === '\r\n') return '\r\n';
  if (lower === 'lf' || choice === '\n') return '\n';
  fail(`Invalid eol option "${choice}" (expected "preserve", "crlf", or "lf").`);
}

function resolveBomChoice(choice, fallbackBom) {
  if (choice === undefined || choice === null || choice === 'preserve' || choice === 'auto') {
    return fallbackBom;
  }
  if (typeof choice === 'boolean') return choice;
  fail(`Invalid bom option "${choice}" (expected boolean or "preserve").`);
}

function normalizeSpecPayload(parsed) {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.ops)) {
      return parsed.ops;
    }
    if (parsed.path || parsed.Path || parsed.file || parsed.filePath) {
      return [parsed];
    }
  }
  fail('Invalid spec JSON: expected { "ops": [ ... ] }, an array of ops, or a single op object.');
}

function handleApplyCommand(args) {
  let useStdin = false;
  let specPath = null;
  let dryRun = false;
  let cleanupSpec = false;
  let allowReplacementChar = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--stdin' || a === '-') {
      useStdin = true;
    } else if (a === '--spec' || a === '-f') {
      specPath = args[++i];
    } else if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--cleanup') {
      cleanupSpec = true;
    } else if (a === '--allow-replacement-char') {
      allowReplacementChar = true;
    } else if (!specPath && !useStdin && !a.startsWith('-')) {
      specPath = a;
    } else {
      fail(`Unknown apply argument: ${a}`);
    }
  }

  if (!useStdin && !specPath) {
    fail('Usage: agy-fs.mjs apply (--stdin | --spec <jsonPath>) [--dry-run] [--cleanup]');
  }

  let rawJson;
  let resolvedSpecPath = null;
  if (useStdin) {
    rawJson = readAllStdin();
  } else {
    resolvedSpecPath = resolveTargetPath(specPath);
    if (!existsSync(resolvedSpecPath)) {
      fail(`Spec JSON file not found: ${resolvedSpecPath}`);
    }
    rawJson = readFileSync(resolvedSpecPath, 'utf8');
  }

  // Strip optional UTF-8 BOM on spec JSON itself
  if (rawJson.charCodeAt(0) === 0xfeff) {
    rawJson = rawJson.slice(1);
  }

  if (!allowReplacementChar && rawJson.includes('\ufffd')) {
    fail(
      'Detected Unicode replacement character (U+FFFD) in input JSON, indicating shell encoding corruption. Write the spec JSON to scratch/ with UTF-8 and pass --spec <path>.'
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    fail(`Failed to parse JSON spec: ${err.message}`);
  }

  const ops = normalizeSpecPayload(parsed);
  if (ops.length === 0) {
    fail('Spec "ops" array is empty.');
  }

  /**
   * Virtual file state map keyed by normalized absolute path so multiple ops on the same file compose atomically.
   * Value: { absPath, exists, deleted, hasBom, eol, content, summaryActions: string[] }
   */
  const vfs = new Map();

  function getVirtualFile(absPath) {
    const key = process.platform === 'win32' ? absPath.toLowerCase() : absPath;
    if (vfs.has(key)) {
      return vfs.get(key);
    }
    if (existsSync(absPath)) {
      const st = statSync(absPath);
      if (!st.isFile()) {
        fail(`Target path is not a regular file: ${absPath}`);
      }
      const buf = readFileSync(absPath);
      const decoded = decodeFileBuffer(buf, absPath);
      const state = {
        absPath,
        existedOnDisk: true,
        exists: true,
        deleted: false,
        hasBom: decoded.hasBom,
        eol: decoded.eol,
        content: decoded.normalized,
        dirty: false,
        actions: []
      };
      vfs.set(key, state);
      return state;
    }
    const defaultEol = process.platform === 'win32' ? '\r\n' : '\n';
    const state = {
      absPath,
      existedOnDisk: false,
      exists: false,
      deleted: false,
      hasBom: false,
      eol: defaultEol,
      content: '',
      dirty: false,
      actions: []
    };
    vfs.set(key, state);
    return state;
  }

  // Phase 1: Validate and apply all operations in memory
  for (let opIdx = 0; opIdx < ops.length; opIdx++) {
    const opObj = ops[opIdx];
    if (!opObj || typeof opObj !== 'object') {
      fail(`Op #${opIdx + 1} must be an object.`);
    }

    const rawPath = opObj.path ?? opObj.Path ?? opObj.file ?? opObj.filePath;
    const absPath = resolveTargetPath(rawPath);
    const vf = getVirtualFile(absPath);

    const inferredOp =
      opObj.op ||
      (Array.isArray(opObj.edits) || opObj.target !== undefined || opObj.Target !== undefined
        ? 'edit'
        : opObj.content !== undefined || opObj.Content !== undefined
          ? 'write'
          : '');
    const kind = String(inferredOp).toLowerCase();

    if (kind === 'edit') {
      if (!vf.exists || vf.deleted) {
        fail(`Op #${opIdx + 1} (edit): File does not exist: ${absPath}`);
      }
      const rawEdits = Array.isArray(opObj.edits)
        ? opObj.edits
        : [{ target: opObj.target ?? opObj.Target, replacement: opObj.replacement ?? opObj.Replacement, allowMultiple: opObj.allowMultiple }];

      if (rawEdits.length === 0) {
        fail(`Op #${opIdx + 1} (edit): "edits" array is empty for ${absPath}`);
      }

      for (let eIdx = 0; eIdx < rawEdits.length; eIdx++) {
        const item = rawEdits[eIdx];
        const rawTarget = item && (item.target ?? item.Target);
        const rawReplacement = item && (item.replacement ?? item.Replacement);
        const allowMultiple = Boolean(item && item.allowMultiple);

        if (typeof rawTarget !== 'string' || rawTarget.length === 0) {
          fail(`Op #${opIdx + 1} edit #${eIdx + 1} (${absPath}): "target" must be a non-empty string.`);
        }
        if (typeof rawReplacement !== 'string') {
          fail(`Op #${opIdx + 1} edit #${eIdx + 1} (${absPath}): "replacement" must be a string.`);
        }

        const normTarget = rawTarget.replace(/\r\n/g, '\n');
        const normReplacement = rawReplacement.replace(/\r\n/g, '\n');

        if (normTarget === normReplacement) {
          fail(`Op #${opIdx + 1} edit #${eIdx + 1} (${absPath}): "target" and "replacement" are identical.`);
        }

        const matches = findOccurrenceLines(vf.content, normTarget);
        if (matches.length === 0) {
          const hint = buildMissingTargetHint(vf.content, normTarget);
          fail(`Op #${opIdx + 1} edit #${eIdx + 1} (${absPath}): Target not found.${hint}`);
        }
        if (matches.length > 1 && !allowMultiple) {
          fail(
            `Op #${opIdx + 1} edit #${eIdx + 1} (${absPath}): Target matched ${matches.length} times at lines [${matches.join(', ')}]. Provide more surrounding context or set "allowMultiple": true.`
          );
        }

        if (allowMultiple) {
          vf.content = vf.content.split(normTarget).join(normReplacement);
        } else {
          const idx = vf.content.indexOf(normTarget);
          vf.content = vf.content.slice(0, idx) + normReplacement + vf.content.slice(idx + normTarget.length);
        }
      }

      vf.eol = resolveEolChoice(opObj.eol, vf.eol);
      vf.hasBom = resolveBomChoice(opObj.bom, vf.hasBom);
      vf.dirty = true;
      vf.actions.push(`edited (${rawEdits.length} hunk${rawEdits.length > 1 ? 's' : ''})`);
    } else if (kind === 'write') {
      const rawContent = opObj.content ?? opObj.Content;
      if (typeof rawContent !== 'string') {
        fail(`Op #${opIdx + 1} (write): "content" must be a string for ${absPath}`);
      }
      const overwrite = Boolean(opObj.overwrite ?? opObj.Overwrite);
      const append = Boolean(opObj.append ?? opObj.Append);
      if (overwrite && append) {
        fail(`Op #${opIdx + 1} (write): Cannot set both "overwrite" and "append" for ${absPath}`);
      }
      if (vf.exists && !vf.deleted && !overwrite && !append) {
        fail(`Op #${opIdx + 1} (write): File already exists: ${absPath} (set "overwrite": true or "append": true).`);
      }

      const normContent = rawContent.replace(/\r\n/g, '\n');
      if (append && vf.exists && !vf.deleted) {
        vf.content = vf.content + normContent;
        vf.actions.push('appended');
      } else {
        const wasExisting = vf.exists && !vf.deleted;
        vf.content = normContent;
        vf.actions.push(wasExisting ? 'overwritten' : 'created');
      }

      vf.eol = resolveEolChoice(opObj.eol, vf.eol);
      vf.hasBom = resolveBomChoice(opObj.bom, vf.hasBom);
      vf.exists = true;
      vf.deleted = false;
      vf.dirty = true;
    } else if (kind === 'delete') {
      if (!opObj.confirm) {
        fail(`Op #${opIdx + 1} (delete): Must set "confirm": true to delete ${absPath}`);
      }
      if (!vf.exists || vf.deleted) {
        fail(`Op #${opIdx + 1} (delete): File does not exist: ${absPath}`);
      }
      vf.exists = false;
      vf.deleted = true;
      vf.dirty = true;
      vf.actions.push('deleted');
    } else {
      fail(`Op #${opIdx + 1} (${absPath}): Unknown or missing "op" (expected "edit", "write", or "delete").`);
    }
  }

  // Phase 2: Commit validated changes to disk (in-place write for transparent encryption minifilter compatibility)
  const summaries = [];
  for (const vf of vfs.values()) {
    if (!vf.dirty) continue;
    const eolName = vf.eol === '\r\n' ? 'CRLF' : 'LF';
    if (vf.deleted) {
      if (!dryRun && vf.existedOnDisk) {
        unlinkSync(vf.absPath);
      }
      summaries.push(`[agy-fs] ${dryRun ? '[DRY-RUN] ' : ''}DELETED ${vf.absPath}`);
    } else {
      const outBuf = encodeFileBuffer(vf.content, vf.hasBom, vf.eol);
      if (!dryRun) {
        mkdirSync(path.dirname(vf.absPath), { recursive: true });
        writeFileSync(vf.absPath, outBuf);
      }
      const lineCount = vf.content.length === 0 ? 0 : vf.content.split('\n').length;
      summaries.push(
        `[agy-fs] ${dryRun ? '[DRY-RUN] ' : ''}OK ${vf.absPath} [${vf.actions.join(', ')} | ${lineCount} lines | BOM=${vf.hasBom} | EOL=${eolName}]`
      );
    }
  }

  if (cleanupSpec && resolvedSpecPath && !dryRun && existsSync(resolvedSpecPath)) {
    try {
      unlinkSync(resolvedSpecPath);
    } catch (_) {
      // Ignore cleanup failure
    }
  }

  process.stdout.write(summaries.join('\n') + '\n');
}

function main() {
  const argv = process.argv.slice(2);
  const subcmd = (argv[0] || '').toLowerCase();
  const rest = argv.slice(1);

  if (!subcmd || subcmd === '--help' || subcmd === '-h' || subcmd === 'help') {
    process.stdout.write(
      [
        'agy-fs.mjs — Transparent-encryption-safe & BOM/EOL-preserving atomic file utility',
        'Commands:',
        '  read <path> [startLine] [endLine]          Read UTF-8 text lines with 1-based line numbers',
        '  read-many <path[:start-end]> ...           Read multiple files/slices in one call',
        '  apply --stdin [--dry-run]                  Apply atomic edit/write/delete JSON ops from stdin',
        '  apply --spec <file.json> [--cleanup]       Apply atomic edit/write/delete JSON ops from file'
      ].join('\n') + '\n'
    );
    return;
  }

  if (subcmd === 'read') {
    handleReadCommand(rest);
  } else if (subcmd === 'read-many') {
    handleReadManyCommand(rest);
  } else if (subcmd === 'apply') {
    handleApplyCommand(rest);
  } else {
    fail(`Unknown command "${subcmd}". Expected "read", "read-many", or "apply".`);
  }
}

main();
