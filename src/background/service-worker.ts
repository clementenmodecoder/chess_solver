/** MV3 service worker: injects the content script on action click (activeTab,
 *  no host permissions), captures the visible tab for the vision pipeline,
 *  and routes engine traffic to/from the offscreen document that hosts the
 *  Stockfish WASM worker. */

import type {
  BackgroundToOffscreen,
  CaptureResponse,
  ContentToBackground,
  OffscreenToBackground,
  Settings,
} from '../messages';
import { DEFAULT_SETTINGS } from '../messages';

const OFFSCREEN_URL = 'offscreen.html';

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url) return;
  if (!/^https?:|^file:/.test(tab.url)) return;
  try {
    // Ping an existing content script; inject if absent.
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle-overlay' });
    devRememberTab(tab.id, false);
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });
    devRememberTab(tab.id, true);
  }
});

// --- Dev auto-reload --------------------------------------------------------
// A dev build (scripts/build.mjs --dev) ships dev.json with a build id and a
// version URL on the developer's machine. The worker polls that URL; when
// the id changes, the files on disk have already been replaced, so the
// extension reloads itself and re-injects the overlay into the tabs where it
// was active. Absent in release builds (dev.json missing => no-op).
interface DevConfig {
  buildId: string;
  versionUrl: string;
}
let devConfig: DevConfig | null | undefined;

async function loadDevConfig(): Promise<DevConfig | null> {
  if (devConfig !== undefined) return devConfig;
  try {
    const res = await fetch(chrome.runtime.getURL('dev.json'));
    devConfig = res.ok ? ((await res.json()) as DevConfig) : null;
  } catch {
    devConfig = null;
  }
  return devConfig;
}

function devRememberTab(tabId: number, active: boolean): void {
  loadDevConfig().then((cfg) => {
    if (!cfg) return;
    chrome.storage.local.get('devActiveTabs').then((stored) => {
      const tabs = new Set<number>((stored.devActiveTabs as number[] | undefined) ?? []);
      // A toggle flips the state: remember only tabs that end up active.
      if (active) tabs.add(tabId);
      else if (tabs.has(tabId)) tabs.delete(tabId);
      else tabs.add(tabId);
      chrome.storage.local.set({ devActiveTabs: [...tabs] });
    });
  });
}

async function devPoll(): Promise<void> {
  const cfg = await loadDevConfig();
  if (!cfg) return;
  try {
    const res = await fetch(`${cfg.versionUrl}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const remote = (await res.text()).trim();
    if (remote && remote !== cfg.buildId) {
      await chrome.storage.local.set({ devReinject: true });
      chrome.runtime.reload();
    }
  } catch {
    /* dev server unreachable: try again later */
  }
}

async function devReinjectAfterReload(): Promise<void> {
  const cfg = await loadDevConfig();
  if (!cfg) return;
  const stored = await chrome.storage.local.get(['devReinject', 'devActiveTabs']);
  if (!stored.devReinject) return;
  await chrome.storage.local.set({ devReinject: false });
  for (const tabId of (stored.devActiveTabs as number[] | undefined) ?? []) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    } catch {
      /* tab gone */
    }
  }
}

loadDevConfig().then((cfg) => {
  if (!cfg) return;
  devReinjectAfterReload();
  setInterval(devPoll, 3000);
  // Alarms keep the poll alive across worker suspensions (dev builds only
  // declare the permission; release/test builds have no chrome.alarms).
  chrome.alarms?.create('dev-poll', { periodInMinutes: 0.5 });
});
// Dev builds: a remembered tab that navigates/reloads gets the overlay back
// without another toolbar click.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete' || !tab.url || !/^https?:/.test(tab.url)) return;
  loadDevConfig().then(async (cfg) => {
    if (!cfg) return;
    const stored = await chrome.storage.local.get('devActiveTabs');
    if (!((stored.devActiveTabs as number[] | undefined) ?? []).includes(tabId)) return;
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'ping' });
    } catch {
      chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }).catch(() => {});
    }
  });
});
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === 'dev-poll') devPoll();
});

// Per-service-worker-lifetime creation lock: concurrent callers (analyze +
// vision-recognize on startup) must not both call createDocument, which
// throws "Only a single offscreen document may be created".
let offscreenCreation: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
  });
  if (contexts.length > 0) return;
  if (!offscreenCreation) {
    offscreenCreation = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['WORKERS' as chrome.offscreen.Reason],
        justification: 'Runs the Stockfish WASM chess engine and the board recognition model in Web Workers',
      })
      .catch((err) => {
        // Lost a race against another service-worker lifetime: fine.
        if (!String(err?.message ?? err).includes('single offscreen')) throw err;
      })
      .finally(() => {
        offscreenCreation = null;
      });
  }
  await offscreenCreation;
}

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get('settings');
  const s = stored.settings as Partial<Settings> | undefined;
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    engine: { ...DEFAULT_SETTINGS.engine, ...(s?.engine ?? {}) },
  };
}

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'sync' || !changes.settings) return;
  const settings = await getSettings();
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id !== undefined) {
      chrome.tabs.sendMessage(tab.id, { type: 'settings-changed', settings }).catch(() => {});
    }
  }
});

chrome.runtime.onMessage.addListener(
  (message: ContentToBackground | OffscreenToBackground, sender, sendResponse) => {
    switch (message.type) {
      case 'capture': {
        const windowId = sender.tab?.windowId;
        chrome.tabs
          .captureVisibleTab(windowId ?? chrome.windows.WINDOW_ID_CURRENT, { format: 'png' })
          .then((dataUrl) => sendResponse({ ok: true, dataUrl } satisfies CaptureResponse))
          .catch((err) =>
            sendResponse({ ok: false, error: String(err?.message ?? err) } satisfies CaptureResponse),
          );
        return true;
      }

      case 'analyze': {
        // No state may live in this service worker (it is torn down between
        // events): the request id comes from the content script and the tab
        // id rides along inside every engine message.
        const tabId = sender.tab?.id;
        if (tabId === undefined) return;
        ensureOffscreen()
          .then(() =>
            chrome.runtime.sendMessage({
              type: 'engine-analyze',
              fen: message.fen,
              options: message.options,
              requestId: message.requestId,
              tabId,
            } satisfies BackgroundToOffscreen),
          )
          .then(() => sendResponse({ ok: true }))
          .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
        return true;
      }

      case 'vision-recognize': {
        ensureOffscreen()
          .then(() =>
            chrome.runtime.sendMessage({
              type: 'offscreen-vision-recognize',
              dataUrl: message.dataUrl,
              exactBoard: message.exactBoard,
            } satisfies BackgroundToOffscreen),
          )
          .then((result) => sendResponse(result))
          .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
        return true;
      }

      case 'vision-scan': {
        // Capture here (needs the tab's window), then hand the frame and the
        // page's geometry to the offscreen host, which does all pixel work.
        const windowId = sender.tab?.windowId;
        const t0 = Date.now();
        const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
          Promise.race([
            p,
            new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms)),
          ]);
        let captureMs = 0;
        Promise.all([
          withTimeout(
            chrome.tabs.captureVisibleTab(windowId ?? chrome.windows.WINDOW_ID_CURRENT, { format: 'png' }),
            8000,
            'screen capture',
          ).then((dataUrl) => {
            captureMs = Date.now() - t0;
            return dataUrl;
          }),
          withTimeout(ensureOffscreen(), 8000, 'engine host startup'),
        ])
          .then(([dataUrl]) =>
            withTimeout(
              chrome.runtime.sendMessage({
                type: 'offscreen-vision-scan',
                dataUrl,
                request: message.request,
              } satisfies BackgroundToOffscreen),
              20000,
              'board recognition',
            ),
          )
          .then((result) => sendResponse({ ...(result ?? { ok: false, error: 'no response from the engine host' }), captureMs, totalMs: Date.now() - t0 }))
          .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err), captureMs, totalMs: Date.now() - t0 }));
        return true;
      }

      case 'engine-diag': {
        ensureOffscreen()
          .then(() => chrome.runtime.sendMessage({ type: 'offscreen-engine-diag' } satisfies BackgroundToOffscreen))
          .then((diag) => sendResponse(diag))
          .catch((err) => sendResponse({ error: String(err?.message ?? err) }));
        return true;
      }

      case 'stop-analysis': {
        ensureOffscreen()
          .then(() => chrome.runtime.sendMessage({ type: 'engine-stop' } satisfies BackgroundToOffscreen))
          .catch(() => {});
        return;
      }

      case 'engine-update': {
        // From offscreen -> forward to the tab named inside the update.
        if (typeof message.update?.tabId === 'number') {
          chrome.tabs
            .sendMessage(message.update.tabId, { type: 'engine-update', update: message.update })
            .catch(() => {});
        }
        return;
      }

      case 'open-options': {
        chrome.runtime.openOptionsPage();
        return;
      }

      case 'open-review': {
        chrome.tabs.create({ url: chrome.runtime.getURL('review.html') });
        return;
      }

      case 'get-settings': {
        getSettings().then((settings) => sendResponse(settings));
        return true;
      }
    }
  },
);
