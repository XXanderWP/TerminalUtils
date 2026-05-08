#!/usr/bin/env bash
# Minimal installer script for TerminalUtils (Linux/macOS)
# - Checks/installs Node.js (best-effort)
# - Downloads latest release from GitHub and extracts it here
# - Installs npm dependencies
# - Adds the install folder to the user's PATH persistently

set -euo pipefail

REPO="XXanderWP/TerminalUtils"
HERE="$(pwd)"

info(){ printf "[info] %s\n" "$*"; }
err(){ printf "[error] %s\n" "$*" >&2; }

check_node(){
  if command -v node >/dev/null 2>&1; then echo node; return; fi
  echo "";
}

install_node_linux(){
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update && sudo apt-get install -y nodejs npm
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y nodejs npm
  elif command -v yum >/dev/null 2>&1; then
    sudo yum install -y nodejs npm
  else
    return 1
  fi
}

install_node_macos(){
  if command -v brew >/dev/null 2>&1; then
    brew install node
  else
    return 1
  fi
}

ensure_node(){
  NODE_BIN=$(check_node)
  if [ -n "$NODE_BIN" ]; then
    info "Found node: $($NODE_BIN --version 2>&1)"
    return 0
  fi

  info "Node.js not found. Attempting to install..."
  uname_s=$(uname -s)
  if [ "$uname_s" = "Linux" ]; then
    if install_node_linux; then
      info "Node.js installed (Linux)."
    else
      err "Automatic installation failed. Please install Node.js LTS manually and re-run this script."
      return 1
    fi
  elif [ "$uname_s" = "Darwin" ]; then
    if install_node_macos; then
      info "Node.js installed (macOS)."
    else
      err "Homebrew not found. Please install Homebrew and then Node.js, or install Node.js manually."
      return 1
    fi
  else
    err "Unsupported OS: $uname_s. Please install Node.js manually."
    return 1
  fi

  NODE_BIN=$(check_node)
  if [ -z "$NODE_BIN" ]; then
    err "Node.js still not available after install attempt. Aborting."
    return 1
  fi
  info "Using node: $NODE_BIN"
}

download_and_extract(){
  info "Querying latest release for $REPO..."
  ZIP_URL=$(curl -sL "https://api.github.com/repos/$REPO/releases/latest" | grep -m1 '"zipball_url"' | sed -E 's/.*"zipball_url"\s*:\s*"([^"]+)".*/\1/')
  if [ -z "$ZIP_URL" ]; then
    err "Could not determine latest release URL."
    return 1
  fi

  info "Downloading latest release..."
  # Use curl progress bar
  curl -L "$ZIP_URL" -o project.zip --progress-bar

  info "Extracting release into current folder..."
  tmpdir=$(mktemp -d)
  if command -v unzip >/dev/null 2>&1; then
    unzip -q project.zip -d "$tmpdir"
  else
    err "unzip is required to extract release archive. Please install unzip and retry."
    return 1
  fi
  # Move extracted content (zipball usually contains a top-level folder)
  topdir=$(find "$tmpdir" -maxdepth 1 -type d | tail -n 1)
  if [ -n "$topdir" ] && [ -d "$topdir" ]; then
    shopt -s dotglob
    mv "$topdir"/* . || true
    rm -rf "$tmpdir"
  fi
  rm -f project.zip
}

install_dependencies(){
  if ! command -v npm >/dev/null 2>&1; then
    err "npm not found after Node.js install."
    return 1
  fi
  info "Installing npm dependencies..."
  npm install --omit=dev
}

add_path_persist(){
  SHELL_NAME=$(basename "$SHELL" 2>/dev/null || echo "sh")
  info "Adding $HERE to PATH in your shell profile..."

  add_line="export PATH=\"\$PATH:$HERE\""
  # .profile and .bashrc and .zshrc
  for f in ~/.profile ~/.bashrc ~/.zshrc; do
    [ -f "$f" ] || continue
    if ! grep -F "$HERE" "$f" >/dev/null 2>&1; then
      printf "\n# TerminalUtils: add to PATH\n%s\n" "$add_line" >> "$f"
      info "Updated $f"
    fi
  done
  # For systems without these files, add to ~/.profile
  if [ ! -f ~/.profile ] && [ ! -f ~/.bashrc ] && [ ! -f ~/.zshrc ]; then
    printf "%s\n" "$add_line" > ~/.profile
    info "Created ~/.profile with PATH entry"
  fi
}

main(){
  info "Starting installer for TerminalUtils"
  if ! ensure_node; then
    err "Node.js is required. Installer cannot continue."
    exit 1
  fi

  download_and_extract
  install_dependencies
  info "Setting executable flags for scripts..."
  chmod +x *.sh *.js *.ps1 2>/dev/null || true

  add_path_persist

  info "Installation complete. Open a new terminal to pick up PATH changes."
}

main "$@"
