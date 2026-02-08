#!/usr/bin/env bash
# Minimal installer script for TerminalUtils (Linux/macOS)
# - Checks/installs Python (best-effort)
# - Downloads latest release from GitHub and extracts it here
# - Adds the install folder to the user's PATH persistently

set -euo pipefail

REPO="XXanderWP/TerminalUtils"
HERE="$(pwd)"

info(){ printf "[info] %s\n" "$*"; }
err(){ printf "[error] %s\n" "$*" >&2; }

check_python(){
  if command -v python3 >/dev/null 2>&1; then echo python3; return; fi
  if command -v python >/dev/null 2>&1; then echo python; return; fi
  echo "";
}

install_python_linux(){
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update && sudo apt-get install -y python3 python3-venv
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y python3
  elif command -v yum >/dev/null 2>&1; then
    sudo yum install -y python3
  else
    return 1
  fi
}

install_python_macos(){
  if command -v brew >/dev/null 2>&1; then
    brew install python
  else
    return 1
  fi
}

ensure_python(){
  PY=$(check_python)
  if [ -n "$PY" ]; then
    info "Found python: $($PY --version 2>&1)"
    return 0
  fi

  info "Python not found. Attempting to install..."
  uname_s=$(uname -s)
  if [ "$uname_s" = "Linux" ]; then
    if install_python_linux; then
      info "Python installed (Linux)."
    else
      err "Automatic installation failed. Please install Python 3 manually and re-run this script."
      return 1
    fi
  elif [ "$uname_s" = "Darwin" ]; then
    if install_python_macos; then
      info "Python installed (macOS)."
    else
      err "Homebrew not found. Please install Homebrew and then Python, or install Python manually."
      return 1
    fi
  else
    err "Unsupported OS: $uname_s. Please install Python 3 manually."
    return 1
  fi

  PY=$(check_python)
  if [ -z "$PY" ]; then
    err "Python still not available after install attempt. Aborting."
    return 1
  fi
  info "Using python: $PY"
}

download_and_extract(){
  PY=$(check_python)
  if [ -z "$PY" ]; then
    err "Python not found. Aborting download."
    return 1
  fi

  info "Querying latest release for $REPO..."
  ZIP_URL=$(curl -sL "https://api.github.com/repos/$REPO/releases/latest" | $PY -c "import sys,json;print(json.load(sys.stdin)['zipball_url'])")
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
    # fallback to python-based extraction
    $PY -c "import zipfile; zipfile.ZipFile('project.zip').extractall('${tmpdir}')"
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
  if ! ensure_python; then
    err "Python is required. Installer cannot continue."
    exit 1
  fi

  download_and_extract
  info "Setting executable flags for scripts..."
  chmod +x *.sh *.py *.ps1 2>/dev/null || true

  add_path_persist

  info "Installation complete. Open a new terminal to pick up PATH changes."
}

main "$@"
