/** Message contracts between content script, service worker and offscreen
 *  engine host. */

import type { UciInfoLine } from './engine/uci';
import type { LearnedStore } from './vision/learning';

export interface EngineOptions {
  /** Max search depth (0 = unlimited, use movetime). */
  depth: number;
  /** Search time budget in ms (0 = unlimited, use depth). */
  movetimeMs: number;
  multiPv: number;
  /** Engine strength cap in Elo (0 = full strength). */
  elo: number;
}

export interface Settings {
  engine: EngineOptions;
  /** Re-scan automatically when the page board changes. */
  watchBoard: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  engine: { depth: 20, movetimeMs: 6000, multiPv: 3, elo: 0 },
  watchBoard: true,
};

/** content -> background */
export type ContentToBackground =
  | { type: 'capture' }
  | { type: 'analyze'; fen: string; options: EngineOptions; requestId: number }
  | { type: 'stop-analysis' }
  | { type: 'open-options' }
  | { type: 'open-review' }
  | { type: 'get-settings' }
  | { type: 'vision-recognize'; dataUrl: string; exactBoard: boolean }
  | { type: 'vision-scan'; request: ScanMessage }
  | { type: 'engine-diag' };

/** Geometry is in CSS pixels of the tab's viewport; the offscreen host
 *  rescales to capture pixels (device pixel ratio / zoom). */
export interface CssRectMsg {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ScanMessage {
  viewport: { w: number; h: number };
  hints: CssRectMsg[];
  manualRect: CssRectMsg | null;
  orientationFlipped: boolean;
  /** Learned-silhouette store for this site (offscreen documents have no
   *  chrome.storage: the page owns persistence). */
  learned: LearnedStore;
  /** Probe mode: only hash this region and compare with `lastHash`. */
  probeRect: CssRectMsg | null;
  lastHash: number | null;
}

export interface ScanResponse {
  ok: boolean;
  error?: string;
  /** Probe outcome (probeRect given): unchanged => nothing else is filled. */
  unchanged?: boolean;
  hash?: number;
  /** Board rect in CSS pixels. */
  rect?: CssRectMsg | null;
  placement?: string | null;
  whiteAtBottom?: boolean;
  recognizer?: 'cnn' | 'classic';
  confidence?: number;
  lowConfidence?: boolean;
  validation?: { ok: boolean; errors: string[]; warnings: string[] };
  cnn?: { reliable: boolean; minConfidence: number; placement?: string } | null;
  rawPlacement?: string | null;
  timings?: Record<string, number>;
  /** Updated store when the scan harvested new silhouettes. */
  learned?: LearnedStore;
  /** Service-worker side timings (ms). */
  captureMs?: number;
  totalMs?: number;
}

/** CNN board recognition result (fenshot), relayed from the offscreen host. */
export interface VisionResult {
  ok: boolean;
  /** FEN placement, ranks 8..1, read as if White were at the bottom. */
  placement?: string;
  minConfidence?: number;
  meanConfidence?: number;
  reliable?: boolean;
  /** Board bounding box in the submitted image's pixels. */
  corners?: { x0: number; y0: number; x1: number; y1: number };
  error?: string;
}

/** background -> content */
export type BackgroundToContent =
  | { type: 'toggle-overlay' }
  | { type: 'ping' }
  | { type: 'engine-update'; update: EngineUpdate }
  | { type: 'settings-changed'; settings: Settings };

/** background <-> offscreen.
 *  tabId travels inside the messages: the MV3 service worker is ephemeral,
 *  so routing must not depend on any state it keeps in memory. */
export type BackgroundToOffscreen =
  | { type: 'engine-analyze'; fen: string; options: EngineOptions; requestId: number; tabId: number }
  | { type: 'engine-stop' }
  | { type: 'offscreen-vision-recognize'; dataUrl: string; exactBoard: boolean }
  | { type: 'offscreen-vision-scan'; dataUrl: string; request: ScanMessage }
  | { type: 'offscreen-engine-diag' };

export interface EngineUpdate {
  requestId: number;
  /** Tab that requested the analysis; the service worker routes on this. */
  tabId: number;
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

/** Engine host state, for field debugging (⚙ panel / debug hook). */
export interface EngineDiag {
  workerCreated: boolean;
  ready: boolean;
  engineName: string;
  activeRequestId: number | null;
  searching: boolean;
  pendingRequestId: number | null;
  /** Last engine/worker lines, newest last. */
  log: string[];
}
