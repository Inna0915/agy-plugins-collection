import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const TELEMETRY_PATH = join(__dirname, '../../lib/telemetry.cjs');
const RETRIES_PATH = join(__dirname, '../../lib/retries.cjs');

let telemetry = require(TELEMETRY_PATH);
let lastLibMtimeKey = '';

function getTelemetry() {
  try {
    const key = `${Math.round(statSync(TELEMETRY_PATH).mtimeMs)}-${Math.round(statSync(RETRIES_PATH).mtimeMs)}`;
    if (lastLibMtimeKey && key !== lastLibMtimeKey) {
      delete require.cache[require.resolve(RETRIES_PATH)];
      delete require.cache[require.resolve(TELEMETRY_PATH)];
      telemetry = require(TELEMETRY_PATH);
    }
    lastLibMtimeKey = key;
  } catch {}
  return telemetry;
}

const INDEX_HTML_PATH = join(__dirname, 'index.html');
const STYLES_CSS_PATH = join(__dirname, 'styles.css');
const APP_JS_PATH = join(__dirname, 'app.js');

const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
};

function currentAssetVersion() {
  try {
    const cssMtime = Math.round(statSync(STYLES_CSS_PATH).mtimeMs);
    const jsMtime = Math.round(statSync(APP_JS_PATH).mtimeMs);
    return `${cssMtime}-${jsMtime}`;
  } catch {
    return String(Date.now());
  }
}

const app = new SidecarApp();

app.page('/', () => {
  const ver = currentAssetVersion();
  const rawHtml = readFileSync(INDEX_HTML_PATH, 'utf-8');
  const stampedHtml = rawHtml
    .replace(/\/styles\.css(?:\?[^"']*)?/g, `/styles.css?v=${ver}`)
    .replace(/\/app\.js(?:\?[^"']*)?/g, `/app.js?v=${ver}`);
  return new Response(stampedHtml, {
    contentType: 'text/html; charset=utf-8',
    headers: NO_CACHE_HEADERS,
  });
});

app.page('/styles.css', () => new Response(readFileSync(STYLES_CSS_PATH, 'utf-8'), {
  contentType: 'text/css; charset=utf-8',
  headers: NO_CACHE_HEADERS,
}));

app.page('/app.js', () => new Response(readFileSync(APP_JS_PATH, 'utf-8'), {
  contentType: 'application/javascript; charset=utf-8',
  headers: NO_CACHE_HEADERS,
}));

app.api('/api/snapshot', (data) => {
  const lib = getTelemetry();
  const hostConversationId = app.config?.conversationId || '';
  let targetId = String(data?.conversationId || hostConversationId || '').trim();
  let current = targetId ? lib.getSessionDetail(targetId, true) : null;

  if (!current && !targetId) {
    lib.hydrateRecentBrainSessions(3);
    const recent = lib.listRecentSessions({ hydrate: false });
    targetId = recent[0]?.conversationId || '';
    current = targetId ? lib.getSessionDetail(targetId, true) : null;
  }

  return {
    serverNowMs: Date.now(),
    assetVersion: currentAssetVersion(),
    prefs: lib.getPrefs(),
    hostConversationId,
    current,
  };
});

app.api('/api/prefs', (data) => {
  const lib = getTelemetry();
  if (data?.toggle) {
    return lib.toggleTokenFormat();
  }
  return lib.setPrefs(data || {});
});

await app.run();
