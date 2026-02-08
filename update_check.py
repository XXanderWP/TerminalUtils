"""Update checking utilities.

Provides interactive and background update checks. Background checks write a
small marker file `.update_available.json` next to the scripts when an update
is available so other scripts can notify the user to open the main utility.
"""

import os
import time
import json
import urllib.request
import urllib.error

import toml


OWNER = "XXanderWP"
REPO = "TerminalUtils"
CACHE_NAME = ".update_cache.json"
FLAG_NAME = ".update_available.json"


def _get_local_version(script_dir):
    pyproject = os.path.join(script_dir, "pyproject.toml")
    if not os.path.exists(pyproject):
        return None
    try:
        data = toml.load(pyproject)
        return data.get("project", {}).get("version") or data.get("tool", {}).get("poetry", {}).get("version")
    except Exception:
        return None


def _parse_version(v):
    if not v:
        return ()
    v = v.lstrip("vV")
    parts = []
    for p in v.split("."):
        try:
            parts.append(int(p))
        except ValueError:
            break
    return tuple(parts)


def _compare_versions(a, b):
    return (_parse_version(a) > _parse_version(b)) - (_parse_version(a) < _parse_version(b))


def _fetch_latest(owner=OWNER, repo=REPO):
    url = f"https://api.github.com/repos/{owner}/{repo}/releases/latest"
    req = urllib.request.Request(url, headers={"User-Agent": "terminalutils-update-check"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.load(resp)
        return data.get("tag_name")


def _read_cache(script_dir):
    cache_file = os.path.join(script_dir, CACHE_NAME)
    if not os.path.exists(cache_file):
        return {}
    try:
        with open(cache_file, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {}


def _write_cache(script_dir, obj):
    cache_file = os.path.join(script_dir, CACHE_NAME)
    try:
        with open(cache_file, "w", encoding="utf-8") as fh:
            json.dump(obj, fh)
    except Exception:
        pass


def _write_flag(script_dir, latest, local):
    flag = os.path.join(script_dir, FLAG_NAME)
    obj = {"latest": latest, "local": local, "timestamp": time.time()}
    try:
        with open(flag, "w", encoding="utf-8") as fh:
            json.dump(obj, fh)
    except Exception:
        pass


def _remove_flag(script_dir):
    flag = os.path.join(script_dir, FLAG_NAME)
    try:
        if os.path.exists(flag):
            os.remove(flag)
    except Exception:
        pass


def interactive_check(script_dir):
    """Perform an interactive check and print result to stdout."""
    now = time.time()
    cache = _read_cache(script_dir)
    last_checked = cache.get("last_checked", 0)
    cached_latest = cache.get("latest")
    if now - last_checked < 300 and cached_latest:
        latest = cached_latest
    else:
        try:
            latest = _fetch_latest()
        except Exception:
            print("Could not reach GitHub to check for updates.")
            return
        cache = {"last_checked": now, "latest": latest}
        _write_cache(script_dir, cache)

    local_v = _get_local_version(script_dir)
    if not local_v:
        print("Local version not found (pyproject.toml missing or invalid).")
        return

    if not latest:
        print("No releases found on GitHub.")
        return

    cmp = _compare_versions(latest, local_v)
    if cmp > 0:
        print(f"Update available: {latest} (local: {local_v}). Please update (git pull or check release page).")
        _write_flag(script_dir, latest, local_v)
    elif cmp == 0:
        print(f"You are up to date (version {local_v}).")
        _remove_flag(script_dir)
    else:
        print(f"Local version ({local_v}) is newer than latest release ({latest}).")
        _remove_flag(script_dir)


def background_check(script_dir):
    """Silent background check used by auxiliary scripts.

    If an update is available, write a flag file so the user is prompted to open
    the main utility to perform the update.
    """
    now = time.time()
    cache = _read_cache(script_dir)
    last_checked = cache.get("last_checked", 0)
    cached_latest = cache.get("latest")
    if now - last_checked < 300 and cached_latest:
        latest = cached_latest
    else:
        try:
            latest = _fetch_latest()
        except Exception:
            return
        cache = {"last_checked": now, "latest": latest}
        _write_cache(script_dir, cache)

    local_v = _get_local_version(script_dir)
    if not local_v:
        return

    if not latest:
        _remove_flag(script_dir)
        return

    cmp = _compare_versions(latest, local_v)
    if cmp > 0:
        _write_flag(script_dir, latest, local_v)
    else:
        _remove_flag(script_dir)

