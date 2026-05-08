#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE=${NODE:-node}
"$NODE" "$SCRIPT_DIR/upload-handler.js" "$@"
