# Piece set licenses

The SVG piece sets in this directory are used to generate the recognition
silhouette templates (`src/vision/templates.gen.json`), to train the piece
color model (`src/vision/colorModel.gen.json`), to render the synthetic test
fixtures, and (cburnett wN) for the extension icon. They were obtained from
the [lichess-org/lila](https://github.com/lichess-org/lila) repository
(`public/piece/…`); the license information below comes from lila's
[COPYING.md](https://github.com/lichess-org/lila/blob/master/COPYING.md).

| Set        | Author                                   | License   |
| ---------- | ---------------------------------------- | --------- |
| `cburnett` | Colin M.L. Burnett                       | GPLv2+    |
| `merida`   | Armando Hernandez Marroquin              | GPLv2+    |
| `chessnut` | Alexis Luengas                           | Apache 2.0 |
| `fantasy`  | Maurizio Monge                           | MIT       |
| `spatial`  | Maurizio Monge                           | MIT       |
| `rhosgfx`  | RhosGFX                                  | CC0 1.0   |

All of these licenses are compatible with this project's GPL-3.0-or-later
license. The `spatial` set is used for tests only (held out from the shape
templates to measure generalization).
