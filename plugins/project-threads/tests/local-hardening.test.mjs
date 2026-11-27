import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildModelConfigLookup,
  resolveConcreteModelIdFromLookup,
} from '../lib/ls-client.mjs';
import { extractSessionTelemetry } from '../lib/transcript.mjs';
import {
  dispatchThread,
  getDefaultThreadModel,
  getModelSelectorState,
  initCoordinator,
  inspectWorktreeGit,
  invalidateWorktreeGitCache,
  loadRegistry,
  resolveConversationConcreteModel,
  saveRegistry,
} from '../lib/store.mjs';

const require = createRequire(import.meta.url);

test('edit-integrity-guard blocks IDE editor tools inside sibling .worktrees while keeping temp/scratch allowed', () => {
  const guardPath = fileURLToPath(new URL('../../edit-integrity-guard/hooks/guard.js', import.meta.url));
  const guard = require(guardPath);

  const ctx = {
    hookEventName: 'PreToolUse',
    cwd: 'D:\\dev\\demo-repo',
    workspacePaths: ['D:\\dev\\demo-repo'],
    artifactDirectoryPath: 'C:\\Users\\OMEN\\.gemini\\antigravity\\brain\\conv-test',
  };

  // Sibling Git worktree must be treated as workspace file and denied for edit_file/write_file
  const wtFile = 'D:\\dev\\.worktrees\\demo-repo\\thr-001-fix\\src\\App.java';
  assert.equal(guard.isWorkspaceFile(wtFile, ctx), true);
  const denyRes = guard.evaluateHook('pre', {
    ...ctx,
    toolCall: { name: 'edit_file', args: { Path: wtFile } },
  });
  assert.equal(denyRes.decision, 'deny');

  // Temp worktrees (like unit tests) and .gemini/scratch must stay excluded/allowed
  const tempWtFile = join(tmpdir(), 'pt-test', '.worktrees', 'repo', 'thr-001', 'README.md');
  assert.equal(guard.isWorkspaceFile(tempWtFile, ctx), false);
  const allowTemp = guard.evaluateHook('pre', {
    ...ctx,
    toolCall: { name: 'write_file', args: { Path: tempWtFile } },
  });
  assert.equal(allowTemp.decision, 'allow');

  const scratchFile = 'C:\\Users\\OMEN\\.gemini\\antigravity\\brain\\conv-test\\scratch\\ops.json';
  assert.equal(guard.isWorkspaceFile(scratchFile, ctx), false);
});

test('initCoordinator auto-excludes main repo .agents/rules/project-memory.md and inspectWorktreeGit honors TTL cache', async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pt-harden-'));
  const geminiDir = join(tempRoot, '.gemini');
  const appDataDir = join(geminiDir, 'antigravity');
  mkdirSync(join(appDataDir, 'project-threads'), { recursive: true });

  const envKeys = [
    'ANTIGRAVITY_GEMINI_DIR',
    'ANTIGRAVITY_APP_DATA_DIR',
    'ANTIGRAVITY_LS_ADDRESS',
    'ANTIGRAVITY_CSRF_TOKEN',
  ];
  const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  process.env.ANTIGRAVITY_GEMINI_DIR = geminiDir;
  process.env.ANTIGRAVITY_APP_DATA_DIR = appDataDir;
  delete process.env.ANTIGRAVITY_LS_ADDRESS;
  delete process.env.ANTIGRAVITY_CSRF_TOKEN;

  const repoRoot = join(tempRoot, 'repo');
  mkdirSync(repoRoot, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot });
  writeFileSync(join(repoRoot, 'README.md'), '# Repo\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoRoot });

  t.after(() => {
    invalidateWorktreeGitCache();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  await initCoordinator({
    workspacePath: repoRoot,
    conversationId: 'conv-coord-harden-01',
  });

  // 1. Main repo .agents/rules/project-memory.md must be created and ignored via .git/info/exclude
  assert.equal(existsSync(join(repoRoot, '.agents', 'rules', 'project-memory.md')), true);
  const excludeText = readFileSync(join(repoRoot, '.git', 'info', 'exclude'), 'utf8');
  assert.match(excludeText, /\.agents\/rules\/project-memory\.md/);
  const statusOut = execFileSync('git', ['status', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  assert.equal(statusOut, '', 'main repo git status must remain clean after initCoordinator');

  // 2. inspectWorktreeGit respects maxAgeMs TTL cache and refreshes on force: true
  const first = await inspectWorktreeGit(repoRoot, 'main', { maxAgeMs: 20_000 });
  assert.equal(first.dirtyCount, 0);

  writeFileSync(join(repoRoot, 'dirty.txt'), 'changed\n', 'utf8');
  const cached = await inspectWorktreeGit(repoRoot, 'main', { maxAgeMs: 20_000 });
  assert.equal(cached.dirtyCount, 0, 'within TTL window should return cached git snapshot');

  const forced = await inspectWorktreeGit(repoRoot, 'main', { maxAgeMs: 20_000, force: true });
  assert.equal(forced.dirtyCount, 1, 'force: true should bypass cache and observe dirty file');
});

test('PreInvocation hook reminds Worker Thread of worktree isolation once after /compact without repeating', (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pt-worker-compact-'));
  const geminiDir = join(tempRoot, '.gemini');
  const appDataDir = join(geminiDir, 'antigravity');
  mkdirSync(join(appDataDir, 'project-threads'), { recursive: true });

  const envKeys = ['ANTIGRAVITY_GEMINI_DIR', 'ANTIGRAVITY_APP_DATA_DIR'];
  const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  process.env.ANTIGRAVITY_GEMINI_DIR = geminiDir;
  process.env.ANTIGRAVITY_APP_DATA_DIR = appDataDir;

  t.after(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const workerConvId = 'conv-worker-compact-01';
  const reg = loadRegistry();
  reg.threads['thr-099'] = {
    threadId: 'thr-099',
    conversationId: workerConvId,
    workspaceKey: 'd:\\dev\\demo',
    repoRoot: 'D:\\dev\\demo',
    worktreePath: 'D:\\dev\\.worktrees\\demo\\thr-099-fix',
    branch: 'thread/thr-099-fix',
    archived: false,
    lastStepCount: 40,
  };
  saveRegistry(reg);

  const handlerPath = fileURLToPath(new URL('../scripts/hook-handler.mjs', import.meta.url));
  const hookEnv = {
    ...process.env,
    ANTIGRAVITY_GEMINI_DIR: geminiDir,
    ANTIGRAVITY_APP_DATA_DIR: appDataDir,
  };

  // Step drops from 40 -> 3 (/compact occurred): must inject isolation reminder once
  const res1 = spawnSync(process.execPath, [handlerPath, 'PreInvocation'], {
    env: hookEnv,
    input: JSON.stringify({
      hookEventName: 'PreInvocation',
      conversationId: workerConvId,
      initialNumSteps: 3,
    }),
    encoding: 'utf8',
  });
  assert.equal(res1.status, 0);
  const out1 = JSON.parse(res1.stdout.trim());
  assert.equal(Array.isArray(out1.injectSteps), true);
  assert.match(out1.injectSteps[0].systemMessage.systemMessage, /thr-099-fix/);
  assert.match(out1.injectSteps[0].systemMessage.systemMessage, /agy-fs\.mjs/);

  // Next turn (step 5 >= 3): must NOT re-inject
  const res2 = spawnSync(process.execPath, [handlerPath, 'PreInvocation'], {
    env: hookEnv,
    input: JSON.stringify({
      hookEventName: 'PreInvocation',
      conversationId: workerConvId,
      initialNumSteps: 5,
    }),
    encoding: 'utf8',
  });
  assert.equal(res2.status, 0);
  const out2 = JSON.parse(res2.stdout.trim());
  assert.equal(out2.injectSteps, undefined);
});

test('dispatchThread inherits coordinator concrete model via modelEnum and falls back to gemini-4-neon-xhigh', async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pt-model-inherit-'));
  const geminiDir = join(tempRoot, '.gemini');
  const appDataDir = join(geminiDir, 'antigravity');
  mkdirSync(join(appDataDir, 'project-threads'), { recursive: true });

  const envKeys = [
    'ANTIGRAVITY_GEMINI_DIR',
    'ANTIGRAVITY_APP_DATA_DIR',
    'ANTIGRAVITY_LS_ADDRESS',
    'ANTIGRAVITY_CSRF_TOKEN',
    'PROJECT_THREADS_DEFAULT_MODEL',
  ];
  const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));

  const createdPayloads = [];
  let genMetaByConv = {};

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {};
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData') {
        res.end(
          JSON.stringify({
            clientModelConfigs: [
              {
                label: 'Gemini 4 Neon (XHigh)',
                modelId: 'gemini-4-neon-xhigh',
                modelOrAlias: { model: 'MODEL_PLACEHOLDER_M535' },
              },
              {
                label: 'Claude Opus 5.5 (High)',
                modelId: 'claude-opus-5-5-high',
                modelOrAlias: { model: 'MODEL_PLACEHOLDER_M402' },
              },
              {
                label: 'Disabled Model',
                modelId: 'disabled-model-x',
                modelOrAlias: { model: 'MODEL_PLACEHOLDER_M999' },
                disabled: true,
              },
            ],
          }),
        );
        return;
      }
      if (req.url === '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata') {
        res.end(JSON.stringify({ generatorMetadata: genMetaByConv[payload.cascadeId] || [] }));
        return;
      }
      if (req.url === '/product.v1.ConversationService/GetConversation') {
        res.end(JSON.stringify({ conversation: { id: payload.conversationId, metadata: {}, state: {} } }));
        return;
      }
      if (req.url === '/product.v1.ConversationService/CreateConversation') {
        createdPayloads.push(payload);
        res.end(
          JSON.stringify({
            conversation: {
              id: `conv-created-${createdPayloads.length}`,
              state: { runState: 'RUN_STATE_RUNNING' },
            },
          }),
        );
        return;
      }
      if (req.url === '/product.v1.ConversationService/UpdateConversation') {
        res.end(JSON.stringify({ conversation: { id: payload.conversationId } }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  process.env.ANTIGRAVITY_GEMINI_DIR = geminiDir;
  process.env.ANTIGRAVITY_APP_DATA_DIR = appDataDir;
  process.env.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${port}`;
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'test-csrf';
  delete process.env.PROJECT_THREADS_DEFAULT_MODEL;

  t.after(async () => {
    await new Promise((r) => server.close(r));
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  assert.equal(getDefaultThreadModel(), 'gemini-4-neon-xhigh');

  // 1. Lookup preserves effort suffix via modelEnum even when responseModel omits `-xhigh`
  const lookup = buildModelConfigLookup({
    clientModelConfigs: [
      {
        label: 'Gemini 4 Neon (XHigh)',
        modelId: 'gemini-4-neon-xhigh',
        modelOrAlias: { model: 'MODEL_PLACEHOLDER_M535' },
      },
    ],
  });
  assert.equal(
    resolveConcreteModelIdFromLookup(
      { modelEnum: 'MODEL_PLACEHOLDER_M535', responseModel: 'gemini-4-neon', displayName: 'Gemini 4 Neon (XHigh)' },
      lookup,
    ),
    'gemini-4-neon-xhigh',
  );

  const coordConvId = 'conv-coord-model-01';
  const reg = loadRegistry();
  reg.coordinators['conv:conv-coord-model-01'] = {
    key: 'conv:conv-coord-model-01',
    conversationId: coordConvId,
    workspacePath: '',
    title: '[Coordinator] Model Test',
  };
  saveRegistry(reg);

  // 2. When Coordinator uses Claude Opus 5.5 (High), inherit resolves exact concrete modelId
  genMetaByConv[coordConvId] = [
    {
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M402',
        responseModel: 'claude-opus-5-5',
        modelDisplayName: 'Claude Opus 5.5 (High)',
      },
    },
  ];
  const resolvedCoord = await resolveConversationConcreteModel(coordConvId);
  assert.deepEqual(resolvedCoord, {
    id: 'claude-opus-5-5-high',
    label: 'Claude Opus 5.5 (High)',
  });

  const t1 = await dispatchThread({
    coordinatorId: coordConvId,
    title: 'Inherit coord model',
    taskPrompt: 'Check logic',
    createWorktree: false,
  });
  assert.equal(t1.model, 'claude-opus-5-5-high');
  assert.equal(createdPayloads[0].model, 'claude-opus-5-5-high');

  // 3. When Coordinator has no generator metadata yet, fallback is gemini-4-neon-xhigh
  genMetaByConv[coordConvId] = [];
  const t2 = await dispatchThread({
    coordinatorId: coordConvId,
    title: 'Fallback to neon xhigh',
    taskPrompt: 'Check fallback',
    createWorktree: false,
  });
  assert.equal(t2.model, 'gemini-4-neon-xhigh');
  assert.equal(t2.modelDisplayName, 'Gemini 4 Neon (XHigh)');
  assert.equal(createdPayloads[1].model, 'gemini-4-neon-xhigh');

  // 4. getModelSelectorState excludes disabled models and exposes defaultModel
  const selectorState = await getModelSelectorState({ coordinatorId: coordConvId });
  assert.equal(selectorState.defaultModel, 'gemini-4-neon-xhigh');
  assert.equal(selectorState.defaultModelLabel, 'Gemini 4 Neon (XHigh)');
  assert.deepEqual(
    selectorState.models.map((m) => m.id),
    ['gemini-4-neon-xhigh', 'claude-opus-5-5-high'],
  );
});

test('extractSessionTelemetry matches agy-tps-monitor accounting for totalTokens, compaction line, and compaction count', (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pt-tel-'));
  const txPath = join(tempRoot, 'transcript.jsonl');
  t.after(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  // Case 1: Gemini session with 1 CHECKPOINT (observed ~500k -> snaps to 512k) + post-compaction step
  const steps = [
    {
      step_index: 0,
      type: 'USER_INPUT',
      content: '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 4 Neon (XHigh).\n</USER_SETTINGS_CHANGE>',
    },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      model: 'gemini-4-neon-xhigh',
      input_tokens: 120000,
      cache_read_tokens: 380000,
      output_tokens: 4000,
    },
    {
      step_index: 2,
      type: 'CHECKPOINT',
      content: 'Resuming from a compaction...',
      input_tokens: 10000,
      cache_read_tokens: 495000,
      output_tokens: 3000,
    },
    {
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      model: 'gemini-4-neon-xhigh',
      input_tokens: 25000,
      cache_read_tokens: 75000,
      output_tokens: 2000,
    },
  ];
  writeFileSync(txPath, `${steps.map((s) => JSON.stringify(s)).join('\n')}\n`, 'utf8');

  const tel = extractSessionTelemetry('conv-tel-1', { overrideTranscriptPath: txPath });
  assert.equal(tel.compactionCount, 1);
  assert.equal(tel.justCompacted, false);
  assert.equal(tel.compactionThresholdTokens, 512000);
  assert.equal(tel.compactionThresholdSource, 'observed');
  assert.equal(tel.currentContextTokens, 100000);
  assert.equal(tel.compactionUsagePct, 19.5);
  assert.equal(
    tel.totalTokens,
    (120000 + 380000 + 4000) + (10000 + 495000 + 3000) + (25000 + 75000 + 2000),
  );

  // Case 2: Claude model without compaction uses 200K estimated compaction threshold
  const claudeTx = join(tempRoot, 'claude.jsonl');
  writeFileSync(
    claudeTx,
    `${JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      model: 'claude-opus-5-5-high',
      input_tokens: 50000,
      cache_read_tokens: 100000,
      output_tokens: 2500,
    })}\n`,
    'utf8',
  );
  const claudeTel = extractSessionTelemetry('conv-tel-2', { overrideTranscriptPath: claudeTx });
  assert.equal(claudeTel.compactionCount, 0);
  assert.equal(claudeTel.compactionThresholdTokens, 200000);
  assert.equal(claudeTel.compactionThresholdSource, 'estimated');
  assert.equal(claudeTel.currentContextTokens, 150000);
  assert.equal(claudeTel.compactionUsagePct, 75);
  assert.equal(claudeTel.totalTokens, 152500);
});

test('local-hardening static checks: default model inherits/neon-xhigh, dynamic model dropdown, agy-fs guidance, 10s poll, LF endings intact', () => {
  const lsSrc = readFileSync(new URL('../lib/ls-client.mjs', import.meta.url), 'utf8');
  const txSrc = readFileSync(new URL('../lib/transcript.mjs', import.meta.url), 'utf8');
  const storeSrc = readFileSync(new URL('../lib/store.mjs', import.meta.url), 'utf8');
  const serverSrc = readFileSync(new URL('../mcp/server.mjs', import.meta.url), 'utf8');
  const hookSrc = readFileSync(new URL('../scripts/hook-handler.mjs', import.meta.url), 'utf8');
  const mainSrc = readFileSync(new URL('../sidecars/threads/main.mjs', import.meta.url), 'utf8');
  const htmlSrc = readFileSync(new URL('../sidecars/threads/index.html', import.meta.url), 'utf8');
  const appSrc = readFileSync(new URL('../sidecars/threads/app.js', import.meta.url), 'utf8');

  assert.match(lsSrc, /export async function listAvailableModels/);
  assert.match(txSrc, /export function extractSessionTelemetry/);
  assert.match(storeSrc, /model\s*=\s*'inherit'/);
  assert.match(storeSrc, /'gemini-4-neon-xhigh'/);
  assert.match(storeSrc, /agy-fs\.mjs/);
  assert.match(serverSrc, /Defaults to "inherit"\./);
  assert.match(hookSrc, /DIRECTIVE_VERSION\s*=\s*8/);
  assert.match(mainSrc, /'\/api\/models'/);
  assert.match(mainSrc, /},\s*10000\);/);
  assert.match(htmlSrc, /value="gemini-4-neon-xhigh" selected/);
  assert.match(htmlSrc, /id="goal-metrics"/);
  assert.match(appSrc, /\/api\/models/);
  assert.match(appSrc, /renderTelemetryStripInnerHtml/);
  assert.match(appSrc, /const shouldOpen = openTraceIds\.has\(it\.id\);/);

  for (const rel of [
    '../lib/ls-client.mjs',
    '../lib/transcript.mjs',
    '../lib/store.mjs',
    '../mcp/server.mjs',
    '../scripts/hook-handler.mjs',
    '../sidecars/threads/main.mjs',
    './local-hardening.test.mjs',
  ]) {
    const raw = readFileSync(new URL(rel, import.meta.url));
    assert.ok(!raw.includes(Buffer.from('\r')), `${rel} must keep LF line endings`);
  }
});
