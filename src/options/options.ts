import { DEFAULT_SETTINGS, type Settings } from '../messages';

const $ = (id: string) => document.getElementById(id) as HTMLInputElement;

async function load(): Promise<Settings> {
  const stored = await chrome.storage.sync.get('settings');
  const s = stored.settings as Partial<Settings> | undefined;
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    engine: { ...DEFAULT_SETTINGS.engine, ...(s?.engine ?? {}) },
  };
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function save(): void {
  const settings: Settings = {
    engine: {
      depth: clamp(parseInt($('depth').value, 10) || 0, 0, 40),
      movetimeMs: clamp(parseInt($('movetime').value, 10) || 0, 0, 120000),
      multiPv: clamp(parseInt($('multipv').value, 10) || 1, 1, 3),
    },
    watchBoard: $('watch').checked,
    elo: 0,
  };
  if (settings.engine.depth === 0 && settings.engine.movetimeMs === 0) {
    settings.engine.movetimeMs = 5000;
    $('movetime').value = '5000';
  }
  chrome.storage.sync.set({ settings }).then(() => {
    const saved = document.getElementById('saved')!;
    saved.style.visibility = 'visible';
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => (saved.style.visibility = 'hidden'), 1200);
  });
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

load().then((s) => {
  $('depth').value = String(s.engine.depth);
  $('movetime').value = String(s.engine.movetimeMs);
  $('multipv').value = String(s.engine.multiPv);
  $('watch').checked = s.watchBoard;
  for (const id of ['depth', 'movetime', 'multipv', 'watch']) {
    $(id).addEventListener('change', save);
  }
});
