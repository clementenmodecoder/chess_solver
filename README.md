# ♞ Chess Lens — Visual Chess Position Analyzer

A Chrome extension (Manifest V3) that **visually** recognizes a chessboard on
the current page — any site, any board widget, even a plain image — rebuilds
the position, converts it to FEN and analyzes it **locally** with Stockfish
(WASM). It displays a Lichess/Chess.com-style vertical evaluation bar next to
the board and a compact analysis panel (best move, evaluation, principal
variations).

It is an **analysis tool for puzzles, studies, local boards and finished
games**. It detects competitive games in progress (live-play URLs, running
clocks) and refuses to analyze them.

## Quick start

```bash
npm install
npm run build
```

Then load it in Chrome:

1. open `chrome://extensions`
2. enable **Developer mode** (top right)
3. click **Load unpacked** and select the `dist/` folder

Usage: open a page showing a chessboard (a puzzle, a study, an analysis
board, a screenshot, a diagram…) and **click the Chess Lens toolbar icon**.
The extension finds the board, recognizes the position and starts analyzing.
Click the icon again (or the ✕ in the panel) to turn it off.

Panel controls:

| Control | Action |
| --- | --- |
| ⟳ Scan | Re-scan the board now |
| ⏸ / ▶ | Pause/resume automatic re-analysis |
| White/Black to move | Toggle side to move (screen capture cannot tell) |
| ⇅ | Flip the detected orientation |
| FEN | Copy the current FEN to the clipboard |
| ⛶ | Manually select the board region (fallback when detection fails) |
| ⚙ | Open settings (engine depth/time, number of lines, watch mode) |

## How it works

Everything runs locally; no external service is contacted.

```
toolbar click (activeTab)
  └─ content script injected
       ├─ DOM candidates: large square-ish elements (generic, site-agnostic)
       ├─ screen capture of the visible tab (PNG, service worker)
       ├─ board localization
       │    ├─ candidate verification: 8×8 alternating two-color pattern score
       │    ├─ fallback: full-image scan — 1D gradient projections + combs of
       │    │   9 evenly spaced lines per axis (tensorflow_chessbot-style)
       │    └─ sub-pixel refinement: median edge-transition alignment +
       │        robust per-line grid snapping
       ├─ per-square recognition
       │    ├─ background: corner-patch estimate vs. board-wide parity color
       │    │   (adaptive to per-square highlights and bulky pieces)
       │    ├─ soft foreground mask (noise-adaptive threshold), hole filling,
       │    │   largest-component filtering (drops coordinate labels, dots)
       │    ├─ piece type: soft-Jaccard silhouette matching against templates
       │    │   generated from 5 open-source piece sets (cburnett, merida,
       │    │   chessnut, fantasy, rhosgfx)
       │    └─ piece color: tiny logistic model over normalized fill/outline/
       │        texture features, trained offline on synthetic boards
       │        (scripts/train-color.mjs) — no ML runtime shipped
       ├─ coherence: exactly one king per color (K/Q crown confusions get
       │   demoted), material sanity checks, pawn back-rank checks
       ├─ orientation: army placement + pawn-rank impossibilities
       ├─ FEN: conservative castling inference, side-to-move toggle in UI
       └─ engine: Stockfish 19 Lite (single-thread WASM, ~1.8 MB) in a Web
           Worker inside an MV3 offscreen document; MultiPV, streamed
           info lines → eval bar + panel (UCI→SAN via chess.js)
```

Re-scans are triggered by a `MutationObserver` on the detected board element
(debounced, min ~1 s between captures) or light polling when there is no
trackable element; the engine is only restarted when the recognized position
actually changes.

## Permissions

Minimal by design — no host permissions, nothing runs until you click:

- `activeTab` – capture the visible tab after your click
- `scripting` – inject the content script on click
- `offscreen` – host the engine worker (MV3 service workers can't)
- `storage` – persist settings

## Development

```bash
npm test            # unit + recognition suite (36 tests, 43 synthetic fixtures)
npm run test:e2e    # real-Chromium end-to-end test (Playwright)
npm run typecheck
npm run build       # → dist/
```

Generated artifacts (committed, so builds work offline):

- `src/vision/templates.gen.json` – piece silhouettes (`npm run gen:templates`)
- `src/vision/colorModel.gen.json` – color model weights (`npm run train:color`)
- `assets/icons/` – extension icons (`npm run gen:icons`)

Test fixtures (`npm run gen:fixtures`) render synthetic boards: 6 piece
styles × 5 board themes × sizes 192–800 px × both orientations, plus move
highlights, coordinate labels, page clutter and a piece style that is *held
out* of the shape templates to measure generalization. The E2E test loads a
test build of the extension in headless Chromium, opens pages with rendered
boards, and asserts the full pipeline: FEN recognized in-browser, Stockfish
reaching depth, and the live-game guard blocking a page with running clocks.

Debug helpers:

```bash
node scripts/debug-vision.mjs <fixture-substr> cells   # per-cell mismatches
node scripts/debug-cell.mjs <fixture-substr> <r> <c>   # one cell's silhouette
```

## Limitations

- **Side to move / castling / en passant are not visible on a screenshot.**
  Side to move defaults to White (toggle in the panel); castling rights are
  inferred conservatively (king+rook on start squares); en passant is unset.
- Works with standard 2D boards with alternating square colors. 3D boards,
  heavily textured/photographic boards and unusual grid decorations are out
  of scope (use ⛶ manual selection for borderline cases).
- Piece styles very far from the bundled template vocabulary may misread;
  the panel shows a low-confidence warning in that case.
- The board must be fully visible in the viewport when scanning.
- Single-threaded "lite" engine build (still far stronger than humans); the
  full/multi-threaded builds are larger and need cross-origin isolation.

## License

GPL-3.0-or-later (required by the bundled Stockfish engine). See `LICENSE`,
`THIRD_PARTY_NOTICES.md` and `assets/pieces/LICENSES.md`.
