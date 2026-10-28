#!/usr/bin/env bash
# Throwaway spike: capture only, no tests/lint/verification. No baseline is written.
set -euo pipefail
cd "$(dirname "$0")/.."
SHOTS_OUT=shots/local/human-actions bash scripts/visual-capture.sh human-actions.screens.spec.ts
