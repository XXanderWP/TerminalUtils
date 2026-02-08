import subprocess
import questionary
import os
import shutil
import sys
import toml
import re

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


def get_npm_executable():
    npm_exe = shutil.which("npm")
    if not npm_exe:
        print("❌ npm not found in PATH. Ensure Node.js is installed and available.")
        sys.exit(1)
    return npm_exe


def check_git_available():
    """Ensure git is available."""
    git_exe = shutil.which("git")
    if not git_exe:
        print("❌ git not found in PATH. Ensure Git is installed and available.")
        sys.exit(1)
    return git_exe


def check_git_clean():
    """Ensure the git working tree is clean."""
    try:
        result = subprocess.run(["git", "status", "--porcelain"], capture_output=True, text=True, check=True)
        if result.stdout.strip():
            print("❌ Git working tree contains uncommitted changes.")
            print("Please commit or discard changes before bumping the version.")
            sys.exit(1)
    except subprocess.CalledProcessError as e:
        print(f"❌ Error checking git status: {e}")
        sys.exit(1)


def git_commit_and_tag(version: str, message: str = None):
    """Create a git commit and tag for the new version."""
    try:
        subprocess.run(["git", "add", "pyproject.toml"], check=True)
        commit_message = message or f"v{version}"
        subprocess.run(["git", "commit", "-m", commit_message], check=True)
        print(f"✅ Created commit: {commit_message}")
        tag_name = f"v{version}"
        subprocess.run(["git", "tag", tag_name], check=True)
        print(f"✅ Created tag: {tag_name}")
    except subprocess.CalledProcessError as e:
        print(f"❌ Git operation failed: {e}")
        sys.exit(1)


def run_npm_version(script_name: str):
    npm_exe = get_npm_executable()
    try:
        subprocess.run([npm_exe, "version", script_name], check=True)
    except subprocess.CalledProcessError as e:
        print(f"❌ npm version {script_name} failed with exit code {e.returncode}")
        sys.exit(e.returncode)


def get_python_version(pyproject_path: str) -> str:
    """Read the project version from pyproject.toml."""
    with open(pyproject_path, "r", encoding="utf-8") as f:
        data = toml.load(f)

    version = (
        data.get("project", {}).get("version") or data.get("tool", {}).get("poetry", {}).get("version")
    )

    if not version:
        print("❌ Could not find version in pyproject.toml")
        sys.exit(1)

    return version


def bump_python_version(version: str, bump_type: str) -> str:
    """Return a bumped semantic version string."""
    match = re.match(r"(\d+)\.(\d+)\.(\d+)", version)
    if not match:
        print(f"❌ Invalid version format: {version}")
        sys.exit(1)

    major, minor, patch = map(int, match.groups())

    if bump_type == "patch":
        patch += 1
    elif bump_type == "minor":
        minor += 1
        patch = 0
    elif bump_type == "major":
        major += 1
        minor = 0
        patch = 0

    return f"{major}.{minor}.{patch}"


def update_pyproject_version(pyproject_path: str, new_version: str):
    """Update the version value inside pyproject.toml.

    This performs a conservative regex replace in either [project] or [tool.poetry]
    sections.
    """
    with open(pyproject_path, "r", encoding="utf-8") as f:
        content = f.read()

    updated = re.sub(
        r'(^\[project\].*?^version\s*=\s*")[^"]+(\")',
        rf'\g<1>{new_version}\g<2>',
        content,
        flags=re.MULTILINE | re.DOTALL,
    )

    if updated == content:
        updated = re.sub(
            r'(^\[tool\.poetry\].*?^version\s*=\s*")[^"]+(\")',
            rf'\g<1>{new_version}\g<2>',
            content,
            flags=re.MULTILINE | re.DOTALL,
        )

    if updated == content:
        print("❌ Failed to update version in pyproject.toml")
        sys.exit(1)

    with open(pyproject_path, "w", encoding="utf-8") as f:
        f.write(updated)


def run_python_version_bump(bump_type: str):
    pyproject_path = "pyproject.toml"
    check_git_available()
    check_git_clean()

    current_version = get_python_version(pyproject_path)
    print(f"📦 Current version: {current_version}")

    new_version = bump_python_version(current_version, bump_type)
    print(f"📦 New version: {new_version}")

    update_pyproject_version(pyproject_path, new_version)
    print("✅ Updated version in pyproject.toml")

    git_commit_and_tag(new_version)


def main():
    has_package_json = os.path.isfile("package.json")
    has_pyproject_toml = os.path.isfile("pyproject.toml")

    if not has_package_json and not has_pyproject_toml:
        print("❌ No package.json or pyproject.toml found in the current directory")
        sys.exit(1)

    project_type = None
    if has_package_json and has_pyproject_toml:
        project_type = questionary.select(
            "Both project types detected. Select one:",
            choices=["Node.js (package.json)", "Python (pyproject.toml)", "Exit"],
        ).ask()

        if not project_type or project_type.startswith("Exit"):
            print("Exiting...")
            return

        project_type = "npm" if "Node.js" in project_type else "python"
    elif has_package_json:
        project_type = "npm"
    else:
        project_type = "python"

    if project_type == "npm":
        get_npm_executable()

    choices = ["Patch (0.0.X)", "Minor (0.X.0)", "Major (X.0.0)", "Exit"]
    choice = questionary.select("Select version bump type:", choices=choices).ask()

    if not choice or choice.startswith("Exit"):
        print("Exiting...")
        return

    bump_type = choice.split(" ")[0].lower()

    if project_type == "npm":
        run_npm_version(bump_type)
    else:
        run_python_version_bump(bump_type)


if __name__ == "__main__":
    main()
