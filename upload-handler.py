import subprocess
import sys
import questionary
import platform
import os
import json
from repos import repo_options

# Background update check (optional)
try:
    script_dir = os.path.dirname(os.path.abspath(__file__))
    import update_check
    update_check.background_check(script_dir)
    flag_file = os.path.join(script_dir, ".update_available.json")
    if os.path.exists(flag_file):
        print("⚠️ Update available. Open the main utility and choose 'Check for updates' to update.")
except Exception:
    pass


def go_back():
    """Return to the main utility menu."""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    if platform.system() == "Windows":
        subprocess.run(["powershell", "-ExecutionPolicy", "Bypass", "-File", os.path.join(script_dir, "util.ps1")])
    else:
        subprocess.run([os.path.join(script_dir, "util.sh")])
    return


def get_git_remote_url():
    """Return the configured 'origin' remote URL or an error message."""
    try:
        url = subprocess.check_output([
            "git", "config", "--get", "remote.origin.url"
        ], stderr=subprocess.DEVNULL).decode().strip()
        if url:
            return url
        return "Remote 'origin' is not configured."
    except subprocess.CalledProcessError:
        return "Not a git repository."


def detect_repo():
    rep = get_git_remote_url()
    if not rep:
        return None
    detected_repos = []
    for item in repo_options:
        if item["repo"] in rep:
            detected_repos.append(format_repo_info_string(item))
    return detected_repos


def format_repo_info_string(data):
    name = data.get('name') or data.get('repo')
    pairs = data.get('pairs', [])
    pair_str = ""
    if pairs:
        first = pairs[0]
        pair_str = f"{first.get('head')} → {first.get('base')}"
    return f"{name} ({pair_str}) " + (f"[ https://github.com/{data['repo']} ]" if data.get('name') else "")


def intro():
    print("Detecting repository...")
    reps = detect_repo()
    if reps:
        if len(reps) == 1:
            print(f"Detected repository: {reps[0]} in current folder.")
        else:
            print(f"Detected repository: {reps[0]} (x{len(reps)} configs) in current folder.")
        return reps
    print("Could not detect repository from git remote URL in current folder.")
    return None


def check_gh_cli():
    """Ensure the GitHub CLI (gh) is available."""
    try:
        subprocess.run(["gh", "--version"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (subprocess.CalledProcessError, FileNotFoundError):
        print("❌ GitHub CLI (gh) is not installed or not available in PATH.")
        sys.exit(1)


def pull_handler():
    check_gh_cli()

    repos = intro()

    # Build repository selection (unique repositories). Each entry in repos.py
    # now contains a list of branch pairs to choose from.
    repo_map = {}
    for item in repo_options:
        key = f"{item.get('name') or item.get('repo')} [{item.get('repo')} ]"
        repo_map[key] = item

    # If the current folder is a git repo, try to extract its remote slug
    def parse_remote_to_slug(url: str):
        if not url:
            return None
        url = url.strip()
        if url.startswith("git@"):
            # git@github.com:owner/repo.git
            parts = url.split(":", 1)
            if len(parts) > 1:
                return parts[1].rstrip(".git")
            return None
        for marker in ("github.com/", "gitlab.com/"):
            if marker in url:
                slug = url.split(marker, 1)[1]
                return slug.rstrip(".git")
        return None

    remote_url = get_git_remote_url()
    remote_slug = parse_remote_to_slug(remote_url)
    if remote_slug and not any(item['repo'] == remote_slug for item in repo_map.values()):
        add_choice = questionary.confirm(f"Repository {remote_slug} detected but not present in config. Add it with inferred branches?", default=False).ask()
        if add_choice:
            # attempt to list remote branches
            branches = []
            try:
                out = subprocess.check_output(["git", "ls-remote", "--heads", "origin"], stderr=subprocess.DEVNULL).decode()
                for ln in out.splitlines():
                    if "refs/heads/" in ln:
                        branches.append(ln.split("refs/heads/")[1].strip())
            except Exception:
                branches = []

            # pick unique branches and build all head->base pairs (limit to 30)
            branches = list(dict.fromkeys(branches))
            pairs = []
            # Create realistic pairs: pair each branch with common base branches
            common_bases = ["main", "master", "develop", "beta", "staging", "release"]
            for h in branches:
                for b in common_bases:
                    if b in branches and h != b:
                        pairs.append({"head": h, "base": b})
                if len(pairs) >= 30:
                    break

            # fallback to common branches if none found
            if not pairs:
                commons = ["develop", "main", "beta"]
                for h in commons:
                    for b in commons:
                        if h != b:
                            pairs.append({"head": h, "base": b})
            new_entry = {"name": remote_slug.split('/')[-1], "repo": remote_slug, "pairs": pairs}
            # append to repos.json
            try:
                repos_json = os.path.join(os.path.dirname(os.path.abspath(__file__)), "repos.json")
                if os.path.exists(repos_json):
                    with open(repos_json, "r", encoding="utf-8") as fh:
                        data = json.load(fh)
                else:
                    data = []
                data.append(new_entry)
                with open(repos_json, "w", encoding="utf-8") as fh:
                    json.dump(data, fh, indent=2, ensure_ascii=False)
                # also update in-memory repo_map
                key = f"{new_entry.get('name')} [{new_entry.get('repo')} ]"
                repo_map[key] = new_entry
                print(f"Added {remote_slug} to repos.json with {len(pairs)} pairs.")
            except Exception as e:
                print(f"Failed to add repository to repos.json: {e}")

    # Repository and branch-pair selection loop. Allows Back/Cancel actions.
    repo_choice = None
    config = None
    while True:
        # Auto-detect and offer quick action
        if not repo_choice and repos:
            detected = None
            for candidate in repos:
                for key, item in repo_map.items():
                    if item['repo'] in candidate:
                        detected = key
                        break
                if detected:
                    break

            if detected:
                action = questionary.select(
                    f"Detected repository: {detected}\nWhat do you want to do?",
                    choices=["Use detected repository", "Choose another repository", "Cancel"],
                ).ask()
                if action == "Use detected repository":
                    repo_choice = detected
                elif action == "Cancel":
                    go_back()
                    return
                # else choose manually

        if not repo_choice:
            repo_choice = questionary.select(
                "Select a repository to create and merge a pull request:",
                choices=list(repo_map.keys()),
            ).ask()

        if not repo_choice:
            print("❌ No selection made. Exiting.")
            go_back()
            return

        selected_repo = repo_map[repo_choice]
        pairs = selected_repo.get('pairs', [])
        if not pairs:
            print("❌ No branch pairs configured for this repository.")
            go_back()
            return

        pair_choices = [f"{p['head']} → {p['base']}" for p in pairs]
        pair_choice = questionary.select(
            f"Select branch pair for {selected_repo['name']} ({selected_repo['repo']}):",
            choices=["Back"] + pair_choices + ["Cancel"],
        ).ask()

        if pair_choice == "Back":
            repo_choice = None
            continue
        if pair_choice == "Cancel" or not pair_choice:
            print("❌ No selection made. Exiting.")
            go_back()
            return

        head, base = [s.strip() for s in pair_choice.split('→')]
        config = { 'repo': selected_repo['repo'], 'head': head, 'base': base }
        break

    # Create Pull Request
    print(f"\n🔧 Creating pull request from '{config['head']}' to '{config['base']}' for '{config['repo']}'...")
    create_result = subprocess.run([
        "gh",
        "pr",
        "create",
        "--repo",
        config["repo"],
        "--base",
        config["base"],
        "--head",
        config["head"],
        "--title",
        f"Merge {config['head']} into {config['base']}",
        "--body",
        f"Automatic pull request: {config['head']} → {config['base']}",
    ])

    if create_result.returncode != 0:
        print("❌ Failed to create pull request.")
        go_back()
        return

    # Get PR number
    try:
        pr_number = subprocess.check_output([
            "gh",
            "pr",
            "list",
            "--repo",
            config["repo"],
            "--head",
            config["head"],
            "--json",
            "number",
            "--jq",
            ".[0].number",
        ], text=True).strip()
    except subprocess.CalledProcessError:
        print("❌ Failed to retrieve pull request number.")
        go_back()
        return

    if not pr_number:
        print("❌ Pull request number not found.")
        go_back()
        return

    # Merge PR
    print(f"\n🔁 Merging pull request #{pr_number}...")
    merge_result = subprocess.run(["gh", "pr", "merge", pr_number, "--repo", config["repo"], "--merge"]) 

    if merge_result.returncode == 0:
        print("\n✅ Pull request successfully merged.")
        print("\n📎 Useful links:")
        print(f"• Repository: https://github.com/{config['repo']}")
        print(f"• Pull Request: https://github.com/{config['repo']}/pull/{pr_number}")
        print(f"• GitHub Actions: https://github.com/{config['repo']}/actions")
    else:
        print("❌ Failed to merge the pull request.")


if __name__ == "__main__":
    pull_handler()
