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
| ⚙ | Open settings (engine depth/time, number of lines, strength cap, watch mode) |
| Review | Open the Game Review page (PGN → full report) |

## How it works

Everything runs locally; no external service is contacted.

```
toolbar click (activeTab)
  └─ content script injected
       ├─ DOM candidates: large square-ish elements (generic, site-agnostic)
       ├─ screen capture of the visible tab (PNG, service worker)
       ├─ board localization (own detector)
       │    ├─ candidate verification: 8×8 alternating two-color pattern score
       │    ├─ fallback: full-image scan — 1D gradient projections + combs of
       │    │   9 evenly spaced lines per axis (tensorflow_chessbot-style)
       │    └─ sub-pixel refinement: median edge-transition alignment +
       │        robust per-line grid snapping
       ├─ PRIMARY recognizer — fenshot CNN (offscreen document)
       │    ├─ @scoriiu/fenshot (MIT): compact tile classifier trained on
       │    │   ~72 piece sets × ~55 board themes with screenshot
       │    │   degradations; 1.3 MB ONNX on onnxruntime-web (WASM)
       │    ├─ gets our crop (or the full viewport when our detector found
       │    │   nothing — fenshot has its own gradient-peak detector)
       │    └─ per-tile confidence; unreliable reads fall through
       ├─ FALLBACK recognizer — classical vision (fully self-contained)
       │    ├─ background: corner-patch / board-parity / per-column models
       │    │   (adaptive to highlights, bulky pieces, wood-grain streaks)
       │    ├─ soft foreground mask (noise-adaptive threshold), hole filling,
       │    │   morphological opening, largest-component filtering (drops
       │    │   coordinate labels, texture streaks, move dots)
       │    ├─ piece type: soft-Jaccard silhouette matching against templates
       │    │   from 5 open-source piece sets, PLUS silhouettes learned
       │    │   per-site from previous validated scans (adapts to any theme)
       │    └─ piece color: tiny logistic model over normalized fill/outline/
       │        texture features, trained offline (scripts/train-color.mjs)
       ├─ coherence: exactly one king per color (K/Q crown confusions fixed
       │   both ways, the CNN's read breaks silhouette ties), per-board
       │   relative color clustering (themed sets where both armies share a
       │   hue), promotion budget (no extra queen while 8 pawns remain),
       │   implausible piece counts demoted, pawn back-rank and material
       │   sanity checks
       ├─ orientation: army placement + pawn-rank impossibilities
       ├─ FEN: conservative castling inference, side-to-move toggle in UI
       └─ engine: Stockfish 19 Lite (single-thread WASM, ~1.8 MB) in a Web
           Worker inside the same MV3 offscreen document; MultiPV, streamed
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

## Game Review (PGN)

Click **Review** in the panel (or open `review.html` from the extension) and
paste a PGN or open a `.pgn` file. The page evaluates every position with
Stockfish (MultiPV 2, three speed presets) and produces a chess.com-style
report: accuracy per player, every move classified (Brilliant, Great, Best,
Excellent, Good, Book, Inaccuracy, Mistake, Miss, Blunder), the evaluation
graph, key moments, and a navigable board that shows the move that should
have been played on every mistake. All local; a 70-ply game takes ~17 s in
Fast mode, ~1 min in Normal.

The scale follows the win-probability model used by lichess and chess.com:
`win% = 50 + 50·(2/(1+e^(-0.00368·cp)) − 1)`; a move's accuracy is
`103.17·e^(−0.04354·drop) − 3.17`; classes are by win% drop (Best ≤ 0.5,
Excellent < 2, Good < 5, Inaccuracy < 10, Mistake < 20, Blunder ≥ 20),
Great = the only move that holds, Brilliant = a sound sacrifice that is best,
Miss = failing to cash in the opponent's previous error. Book = a compact
embedded table of mainstream opening lines.

## Testing on a real site

Only ever test on **https://www.chess.com/play/computer** (a game against a
bot) or on puzzle/analysis pages, never in a game against a human: that is
what the live-game guard is for, and it is also chess.com's fair-play rule.

```bash
npm run test:smoke   # headless Chromium + test build on chess.com/play/computer
```

The smoke test injects the extension on the bot-game page, checks that the
start position is recognized exactly and analyzed, then plays 1.e4 and checks
that watch mode follows the move and infers "Black to move". Screenshots are
written to `dist-test/smoke/`. A real crop of chess.com's themed board is kept
in `tests/real/` as a unit-test fixture.

## Development

```bash
npm test            # unit + recognition suite (43 tests, 43 synthetic fixtures + real crops)
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
node scripts/debug-screenshot.mjs <png> [x,y,w,h]      # real screenshot: detection + colors
```

## Limitations

- **Side to move / castling / en passant are not visible on a screenshot.**
  Side to move defaults to White (toggle in the panel); castling rights are
  inferred conservatively (king+rook on start squares); en passant is unset.
- Works with standard 2D boards with alternating square colors. 3D boards,
  heavily textured/photographic boards and unusual grid decorations are out
  of scope (use ⛶ manual selection for borderline cases).
- A piece style foreign to both the CNN's training corpus and the template
  vocabulary may misread; the panel shows a low-confidence warning, and the
  fallback recognizer learns the site's silhouettes from validated scans.
- The board must be fully visible in the viewport when scanning.
- Single-threaded "lite" engine build (still far stronger than humans); the
  full/multi-threaded builds are larger and need cross-origin isolation.
- Exotic piece sets (e.g. chess.com's seasonal themes) are read by the
  classical recognizer with the CNN as tiebreaker; a 1 px grid error can
  still swap look-alike crowns on such sets. Use ⟳ or ⛶ when the panel
  warns about low confidence.

## License

GPL-3.0-or-later (required by the bundled Stockfish engine). See `LICENSE`,
`THIRD_PARTY_NOTICES.md` and `assets/pieces/LICENSES.md`.
