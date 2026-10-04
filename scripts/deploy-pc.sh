#!/usr/bin/env bash
# Build a DEV build and push it to the Windows PC's desktop; the extension
# there auto-reloads within ~3s (scripts/dev-server.mjs must be running here).
set -euo pipefail
cd "$(dirname "$0")/.."
PC=${PC:-cleme@100.71.203.7}
DEST=${DEST:-C:/Users/cleme/Desktop/chess-lens}
export CHESS_LENS_DEV_URL=${CHESS_LENS_DEV_URL:-http://100.109.220.64:8765/version}
# Keep the previous id live until the new files are fully on the PC.
PREV=$(cat .dev-build-id 2>/dev/null || echo release)
node scripts/build.mjs --dev >/dev/null
NEW=$(cat .dev-build-id)
echo "$PREV" > .dev-build-id
ssh "$PC" "Remove-Item -Recurse -Force '${DEST//\//\\}' -ErrorAction SilentlyContinue" >/dev/null 2>&1 || true
scp -r -q dist "$PC:$DEST"
# Also serve the build at <DEST>/dist: an earlier upload nested the folder
# and the extension may have been loaded from that path.
scp -r -q dist "$PC:$DEST/dist"
echo "$NEW" > .dev-build-id
echo "deployed $NEW"
