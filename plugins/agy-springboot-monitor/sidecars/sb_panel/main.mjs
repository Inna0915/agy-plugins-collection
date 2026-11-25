import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';
import {
  getProjectMeta,
  getSnapshot,
  readServiceLogs,
  startMonitorLoop,
  triggerBackgroundScan,
  triggerRestart,
  triggerStart,
  triggerStop
} from './lib/monitor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
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
    const htmlM = Math.round(statSync(INDEX_HTML_PATH).mtimeMs);
    const cssM = Math.round(statSync(STYLES_CSS_PATH).mtimeMs);
    const jsM = Math.round(statSync(APP_JS_PATH).mtimeMs);
    return `${htmlM}-${cssM}-${jsM}`;
  } catch {
    return String(Date.now());
  }
}

startMonitorLoop(2500);

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
  const snap = getSnapshot({ includeAll: Boolean(data?.includeAll) });
  return {
    ...snap,
    assetVersion: currentAssetVersion(),
  };
});

app.api('/api/refresh', async (data) => {
  await triggerBackgroundScan();
  return {
    ...getSnapshot({ includeAll: Boolean(data?.includeAll) }),
    assetVersion: currentAssetVersion(),
  };
});

app.api('/api/project-meta', (data) => {
  return getProjectMeta(data?.workspace);
});

app.api('/api/start', (data) => {
  return triggerStart(data || {});
});

app.api('/api/stop', (data) => {
  return triggerStop(data || {});
});

app.api('/api/restart', (data) => {
  return triggerRestart(data || {});
});

app.api('/api/logs', (data) => {
  return readServiceLogs(data || {});
});

await app.run();
