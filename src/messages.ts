/** Message contracts between content script, service worker and offscreen
 *  engine host. */

import type { UciInfoLine } from './engine/uci';

export interface EngineOptions {
  /** Max search depth (0 = unlimited, use movetime). */
  depth: number;
  /** Search time budget in ms (0 = unlimited, use depth). */
  movetimeMs: number;
  multiPv: number;
}

export interface Settings {
  engine: EngineOptions;
  /** Re-scan automatically when the page board changes. */
  watchBoard: boolean;
  /** Skill: cap engine strength (0 = full). */
  elo: number;
}

export const DEFAULT_SETTINGS: Settings = {
  engine: { depth: 20, movetimeMs: 6000, multiPv: 3 },
  watchBoard: true,
  elo: 0,
};

/** content -> background */
export type ContentToBackground =
  | { type: 'capture' }
  | { type: 'analyze'; fen: string; options: EngineOptions }
  | { type: 'stop-analysis' }
  | { type: 'open-options' }
  | { type: 'get-settings' };

/** background -> content */
export type BackgroundToContent =
  | { type: 'toggle-overlay' }
  | { type: 'engine-update'; update: EngineUpdate }
  | { type: 'settings-changed'; settings: Settings };

/** background <-> offscreen */
export type BackgroundToOffscreen =
  | { type: 'engine-analyze'; fen: string; options: EngineOptions; requestId: number }
  | { type: 'engine-stop' };

export interface EngineUpdate {
  requestId: number;
  /** Latest info per multipv index (1-based); White-POV scores. */
  lines: UciInfoLine[];
  bestMove?: string;
  engineName?: string;
  done: boolean;
  error?: string;
}

export type OffscreenToBackground = { type: 'engine-update'; update: EngineUpdate };

export interface CaptureResponse {
  ok: boolean;
  dataUrl?: string;
  error?: string;
}
