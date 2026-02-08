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
import shutil
import zipfile
import tempfile


script_dir = os.path.dirname(os.path.abspath(__file__))

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
        return data.get("tag_name"), data.get("zipball_url")


def download_and_apply_update(zip_url, dest_dir):
    """Download zipball from zip_url and replace files in dest_dir.

    This will download the zip to a temporary file, extract it to a temp dir,
    then copy contents over dest_dir (excluding .git and .github).
    """
    if not zip_url:
        print("No zip URL for release.")
        return False

    tmp_zip = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")
    tmp_zip.close()
    try:
        print("Downloading update...")
        with urllib.request.urlopen(urllib.request.Request(zip_url, headers={"User-Agent": "terminalutils-update-check"}), timeout=60) as resp:
            total = resp.length or 0
            chunk_size = 8192
            downloaded = 0
            with open(tmp_zip.name, "wb") as out:
                while True:
                    chunk = resp.read(chunk_size)
                    if not chunk:
                        break
                    out.write(chunk)
                    downloaded += len(chunk)
                    if total:
                        pct = int(downloaded / total * 100)
                        print(f"{pct}% downloaded", end="\r")
        print("\nDownload complete.")

        tmp_dir = tempfile.mkdtemp()
        try:
            # prefer unzip if available
            try:
                shutil.unpack_archive(tmp_zip.name, tmp_dir)
            except Exception:
                # fallback to zipfile
                with zipfile.ZipFile(tmp_zip.name) as z:
                    z.extractall(tmp_dir)

            # the zipball usually has a single top-level directory
            entries = [os.path.join(tmp_dir, p) for p in os.listdir(tmp_dir)]
            top = entries[0] if entries else tmp_dir

            # copy files from top to dest_dir
            for root, dirs, files in os.walk(top):
                # compute relative path
                rel = os.path.relpath(root, top)
                if rel == ".":
                    rel = ""
                if rel.startswith('.git') or rel.startswith('.github'):
                    continue
                target_root = os.path.join(dest_dir, rel) if rel else dest_dir
                os.makedirs(target_root, exist_ok=True)
                for f in files:
                    # skip installer scripts
                    if f in ("install.sh", "install.ps1", "install.psh"):
                        continue
                    src_file = os.path.join(root, f)
                    dst_file = os.path.join(target_root, f)
                    try:
                        shutil.copy2(src_file, dst_file)
                    except Exception as e:
                        print(f"Failed to copy {src_file} -> {dst_file}: {e}")
        finally:
            try:
                shutil.rmtree(tmp_dir)
            except Exception:
                pass
    finally:
        try:
            os.unlink(tmp_zip.name)
        except Exception:
            pass
    return True

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
        # Offer automatic update
        print(f"Update available: {latest} (local: {local_v}).")
        if questionary.confirm(f"Download and apply update {latest} now?", default=False).ask():
            # fetch zip URL
            _, zip_url = fetch_latest_github_release("XXanderWP", "TerminalUtils")
            ok = download_and_apply_update(zip_url, script_dir)
            if ok:
                # clear cache and flag
                try:
                    if os.path.exists(cache_file):
                        os.remove(cache_file)
                    flagf = os.path.join(script_dir, ".update_available.json")
                    if os.path.exists(flagf):
                        os.remove(flagf)
                except Exception:
                    pass
                print("Update applied. Please restart the utility.")
            else:
                print("Update failed.")
        else:
            print("Update skipped.")
    elif cmp == 0:
        print(f"You are up to date (version {local_v}).")
    else:
        print(f"Local version ({local_v}) is newer than latest release ({latest}).")

def main():
    choices = [
        "Check for updates",
        "Connect to server via SSH",
        "Create and merge GitHub pull request",
        "Update project version",
        "Exit",
    ]

    choice = questionary.select("What do you want to do?", choices=choices).ask()
    

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
