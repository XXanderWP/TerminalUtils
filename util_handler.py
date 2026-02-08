"""Utility menu wrapper.

Presents a small interactive menu and dispatches to platform-appropriate
helper scripts. All user-visible text is in English.
"""

import os
import platform
import subprocess
import time
import json
import urllib.request
import urllib.error

import toml
import questionary


def main():
    choices = [
        "Check for updates",
        "Connect to server via SSH",
        "Create and merge GitHub pull request",
        "Update project version",
        "Exit",
    ]

    choice = questionary.select("What do you want to do?", choices=choices).ask()
    script_dir = os.path.dirname(os.path.abspath(__file__))

    # Handle update check option separately
    if choice == "Check for updates":
        check_for_updates()
        return

    # Map menu entry to pair of (windows_script, unix_script)
    mapping = {
        "Connect to server via SSH": ("ssh-servers.ps1", "ssh-servers.sh"),
        "Create and merge GitHub pull request": ("upload.ps1", "upload.sh"),
        "Update project version": ("new-version.ps1", "new-version.sh")
    }

    # Import update check helpers from external module (optional)
    try:
        import update_check
        # perform a silent background check (uses internal caching to limit frequency)
        try:
            update_check.background_check(script_dir)
        except Exception:
            pass
        # If a flag file exists, notify the user to open main menu and press "Check for updates"
        flag_file = os.path.join(script_dir, ".update_available.json")
        if os.path.exists(flag_file):
            try:
                with open(flag_file, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
                    latest = data.get("latest")
            except Exception:
                latest = None
            print(f"⚠️ Update available ({latest}). Open the main utility and choose 'Check for updates' to update.")
    except Exception:
        # update_check optional — continue without update notifications
        pass

    def get_local_version():
        """Read local version from pyproject.toml located next to the script."""
        pyproject = os.path.join(script_dir, "pyproject.toml")
        if not os.path.exists(pyproject):
            return None
        try:
            data = toml.load(pyproject)
            return data.get("project", {}).get("version") or data.get("tool", {}).get("poetry", {}).get("version")
        except Exception:
            return None

    def parse_version(v):
        """Parse a semantic version string into a tuple of integers for comparison."""
        parts = []
        if not v:
            return ()
        v = v.lstrip("vV")
        for p in v.split("."):
            try:
                parts.append(int(p))
            except ValueError:
                # stop at first non-integer part
                break
        return tuple(parts)

    def compare_versions(a, b):
        return (parse_version(a) > parse_version(b)) - (parse_version(a) < parse_version(b))

    def fetch_latest_github_release(owner, repo):
        url = f"https://api.github.com/repos/{owner}/{repo}/releases/latest"
        req = urllib.request.Request(url, headers={"User-Agent": "terminalutils-update-check"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.load(resp)
            return data.get("tag_name")

    def check_for_updates():
        """Check GitHub for latest release and compare with local version.

        Cached results are stored in .update_cache.json next to the script for 5 minutes.
        """
        cache_file = os.path.join(script_dir, ".update_cache.json")
        now = time.time()
        cache = {}
        if os.path.exists(cache_file):
            try:
                with open(cache_file, "r", encoding="utf-8") as fh:
                    cache = json.load(fh)
            except Exception:
                cache = {}

        last_checked = cache.get("last_checked", 0)
        cached_latest = cache.get("latest")
        # 5 minutes = 300 seconds
        if now - last_checked < 300 and cached_latest:
            latest = cached_latest
        else:
            try:
                latest = fetch_latest_github_release("XXanderWP", "TerminalUtils")
            except urllib.error.URLError:
                print("Could not reach GitHub to check for updates.")
                return
            except Exception:
                print("Failed to determine latest release.")
                return
            cache = {"last_checked": now, "latest": latest}
            try:
                with open(cache_file, "w", encoding="utf-8") as fh:
                    json.dump(cache, fh)
            except Exception:
                pass

        local_v = get_local_version()
        if not local_v:
            print("Local version not found (pyproject.toml missing or invalid).")
            return

        if not latest:
            print("No releases found on GitHub.")
            return

        cmp = compare_versions(latest, local_v)
        if cmp > 0:
            print(f"Update available: {latest} (local: {local_v}). Please update (git pull or check release page).")
        elif cmp == 0:
            print(f"You are up to date (version {local_v}).")
        else:
            print(f"Local version ({local_v}) is newer than latest release ({latest}).")


    if choice == "Exit" or choice is None:
        print("Exiting...")
        return

    win_script, unix_script = mapping.get(choice, (None, None))
    if not win_script and not unix_script:
        print("Unknown action.")
        return

    if platform.system() == "Windows":
        script_path = os.path.join(script_dir, win_script)
        subprocess.run(["powershell", "-ExecutionPolicy", "Bypass", "-File", script_path])
    else:
        script_path = os.path.join(script_dir, unix_script)
        subprocess.run([script_path])


if __name__ == "__main__":
    main()
