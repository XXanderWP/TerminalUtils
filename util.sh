#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PYTHON=${PYTHON:-python3}
"$PYTHON" "$SCRIPT_DIR/util_handler.py" "$@"
