#!/usr/bin/env bash
# Throwaway visual spike; captures only, no behavioral assertions.
set -euo pipefail
cd "$(dirname "$0")/.."
SHOTS_OUT=shots/local/human-items-dense scripts/visual-capture.sh human-items-dense.screens.spec.ts
