# Third-party components

Chess Lens reuses the following open-source components. The project as a
whole is distributed under **GPL-3.0-or-later** (see `LICENSE`), which is the
strictest license in the set below.

## Bundled at runtime

| Component | Version | License | Use |
| --- | --- | --- | --- |
| [Stockfish.js](https://github.com/nmrugg/stockfish.js) (`stockfish` npm) | 19 (lite, single-threaded WASM) | GPLv3 | Chess engine, runs in a Web Worker inside the offscreen document (`dist/engine/`) |
| [Stockfish](https://github.com/official-stockfish/Stockfish) | 17.x ("Stockfish 19 Lite WASM" build) | GPLv3 | The engine itself (compiled to WASM by stockfish.js) |
| [chess.js](https://github.com/jhlywa/chess.js) | 1.x | BSD-2-Clause | FEN parsing/validation and UCI→SAN conversion in the UI |
| [@scoriiu/fenshot](https://github.com/scoriiu/fenshot) | 0.1.x | MIT | Primary board recognizer: CNN tile classifier (`chess-tiles-v2.onnx`, trained across ~72 piece sets / ~55 board themes) + gradient-peak board detection, running in the offscreen document |
| [onnxruntime-web](https://github.com/microsoft/onnxruntime) | 1.x | MIT | WASM inference runtime for the fenshot model (`dist/vision/`) |
| Piece set SVG artwork | — | GPLv2+/Apache-2.0/MIT/CC0 | Recognition templates, color-model training data, icon — see `assets/pieces/LICENSES.md` |

## Development / testing only

| Component | License | Use |
| --- | --- | --- |
| esbuild | MIT | Bundling |
| TypeScript | Apache-2.0 | Type checking |
| Vitest | MIT | Unit tests |
| Playwright | Apache-2.0 | End-to-end tests in Chromium |
| @resvg/resvg-js | MPL-2.0 | Rasterizing SVG piece sets for templates/fixtures/icons |
| pngjs | MIT | PNG encode/decode in tests and generators |

## Design/approach inspiration (no code copied)

- [tensorflow_chessbot](https://github.com/Elucidation/tensorflow_chessbot)
  (Sam Ragusa): the idea of localizing a chessboard through 1D gradient
  projections and evenly spaced line combs (fenshot's detector is a direct
  MIT port of it; our own fallback detector re-implements the idea
  differently, with median edge-transition alignment and robust grid
  snapping).
- Lichess/Chess.com evaluation bars: visual concept of the vertical
  evaluation gauge (implemented from scratch here).
- Other surveyed projects: [chessvision.ai](https://chessvision.ai)
  (proprietary), [ChessboardFenTensorflowJs](https://github.com/Elucidation/ChessboardFenTensorflowJs),
  [linrock/chessboard-recognizer](https://github.com/linrock/chessboard-recognizer),
  [BoardToFEN](https://github.com/DanielGoman/BoardToFEN). fenshot was chosen
  as the shipped model for its browser-first design, MIT license, tiny model
  (1.3 MB), theme coverage and per-tile confidence contract. The classical
  pipeline (silhouette template matching + logistic color model + per-site
  learned silhouettes) is kept as a fully self-contained fallback.
