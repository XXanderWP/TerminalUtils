#!/usr/bin/env bash
# Launcher for new-version utilities (Unix-like)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON=${PYTHON:-python3}
"$PYTHON" "$SCRIPT_DIR/new-version.py" "$@"
