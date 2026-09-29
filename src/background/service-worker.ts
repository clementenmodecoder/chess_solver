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

/** Tab that owns the current analysis (engine updates are routed to it). */
let analysisTabId: number | null = null;
let requestCounter = 1;

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url) return;
  if (!/^https?:|^file:/.test(tab.url)) return;
  try {
    // Ping an existing content script; inject if absent.
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle-overlay' });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });
  }
});

async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
  });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['WORKERS' as chrome.offscreen.Reason],
    justification: 'Runs the Stockfish WASM chess engine in a Web Worker',
  });
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
        if (sender.tab?.id === undefined) return;
        analysisTabId = sender.tab.id;
        const requestId = requestCounter++;
        ensureOffscreen()
          .then(() =>
            chrome.runtime.sendMessage({
              type: 'engine-analyze',
              fen: message.fen,
              options: message.options,
              requestId,
            } satisfies BackgroundToOffscreen),
          )
          .then(() => sendResponse({ ok: true, requestId }))
          .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
        return true;
      }

      case 'stop-analysis': {
        ensureOffscreen()
          .then(() => chrome.runtime.sendMessage({ type: 'engine-stop' } satisfies BackgroundToOffscreen))
          .catch(() => {});
        return;
      }

      case 'engine-update': {
        // From offscreen -> forward to the analysis tab.
        if (analysisTabId !== null) {
          chrome.tabs
            .sendMessage(analysisTabId, { type: 'engine-update', update: message.update })
            .catch(() => {});
        }
        return;
      }

      case 'open-options': {
        chrome.runtime.openOptionsPage();
        return;
      }

      case 'get-settings': {
        getSettings().then((settings) => sendResponse(settings));
        return true;
      }
    }
  },
);
