#!/usr/bin/env bash
# Launcher for new-version utilities (Unix-like)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE=${NODE:-node}
"$NODE" "$SCRIPT_DIR/new-version.js" "$@"
