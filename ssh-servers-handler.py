"""SSH servers selection helper.

This script reads a simple servers list from `servers.txt` (in the same
directory) and presents an interactive menu to connect via SSH.

Format of `servers.txt`:
    Display Name|user@host.example.com
Lines starting with '#' or empty lines are ignored.
"""

import os
import platform
import re
import subprocess
import sys

import questionary

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


def load_servers(file_path):
    """Load servers from a text file.

    Each non-empty, non-comment line must contain a name and an address
    separated by a '|' character. Returns an ordered list of (name, addr).
    """
    servers = []
    if not os.path.exists(file_path):
        return servers
    with open(file_path, "r", encoding="utf-8") as fh:
        for ln in fh:
            ln = ln.strip()
            if not ln or ln.startswith("#"):
                continue
            if "|" not in ln:
                # skip invalid lines
                continue
            parts = [p.strip() for p in ln.split("|")]
            name = parts[0] if len(parts) > 0 else ""
            addr = parts[1] if len(parts) > 1 else ""
            pwd = parts[2] if len(parts) > 2 else None
            servers.append((name, addr, pwd))
    return servers


def ssh_servers_handler():
    # Determine script directory and servers file
    script_dir = os.path.dirname(os.path.abspath(__file__))
    servers_file = os.path.join(script_dir, "servers.txt")

    # Ensure servers file exists; if not, create a template header so users
    # (and CI) can populate it. We do not abort — user can add servers via menu.
    if not os.path.exists(servers_file):
        try:
            with open(servers_file, "w", encoding="utf-8") as fh:
                fh.write("# Servers file for ssh-servers-handler.py\n")
                fh.write("# Format: Display Name|user@host\n")
                fh.write("# Lines starting with '#' are ignored.\n")
            print(f"Created template servers file at {servers_file}. You can add servers via the menu or edit the file.")
        except Exception as e:
            print("Failed to create servers.txt:", e)

    servers = load_servers(servers_file)

    # Build choices in the form: Name (user@host)
    choices = [f"{name} ({addr})" for name, addr, _ in servers]
    # Add management actions at the bottom
    choices += ["Add server", "Clear SSH known_hosts", "Back"]

    choice = questionary.select("Select a server to connect:", choices=choices).ask()

    if choice is None:
        print("No server selected.")
        if platform.system() == "Windows":
            subprocess.run(["powershell", "-ExecutionPolicy", "Bypass", "-File", os.path.join(script_dir, "util.ps1")])
        else:
            subprocess.run([os.path.join(script_dir, "util.sh")])
        return

    if choice == "Back":
        if platform.system() == "Windows":
            subprocess.run(["powershell", "-ExecutionPolicy", "Bypass", "-File", os.path.join(script_dir, "util.ps1")])
        else:
            subprocess.run([os.path.join(script_dir, "util.sh")])
        return

    if choice == "Clear SSH known_hosts":
        warn = questionary.confirm(
            "This will permanently clear your SSH known_hosts file (~/.ssh/known_hosts).\nAre you sure you want to proceed?",
            default=False,
        ).ask()
        if not warn:
            # return to the menu
            return ssh_servers_handler()
        known = os.path.expanduser("~/.ssh/known_hosts")
        try:
            if os.path.exists(known):
                # truncate the file
                with open(known, "w", encoding="utf-8") as fh:
                    fh.truncate(0)
                print(f"Cleared known_hosts at {known}.")
            else:
                print(f"No known_hosts file found at {known}.")
        except Exception as e:
            print("Failed to clear known_hosts:", e)
        # return to the menu
        return ssh_servers_handler()

    if choice == "Add server":
        display = questionary.text("Display name:").ask()
        host = questionary.text("Host or IP:").ask()
        user = None
        while not user:
            user = questionary.text("User (required):").ask()
        password = questionary.password("Password (leave empty for key auth):").ask()
        user_host = f"{user}@{host}" if user else host
        entry = f"{display}|{user_host}"
        if password:
            entry = entry + f"|{password}"
        try:
            with open(servers_file, "a", encoding="utf-8") as fh:
                fh.write(entry + "\n")
            print("Server added to servers.txt. Note: passwords are stored in plain text.")
        except Exception as e:
            print("Failed to add server:", e)
        return ssh_servers_handler()

    match = re.search(r"\((.*?)\)", choice)
    if not match:
        print("Invalid selection format.")
        if platform.system() == "Windows":
            subprocess.run(["powershell", "-ExecutionPolicy", "Bypass", "-File", os.path.join(script_dir, "util.ps1")])
        else:
            subprocess.run([os.path.join(script_dir, "util.sh")])
        return

    # Find corresponding server tuple
    idx = choices.index(choice)
    sel_name, sel_addr, sel_pwd = servers[idx]
    selected_addr = sel_addr

    # Launch SSH client
    def _extract_host(addr: str) -> str:
        # addr may be user@host or host or user@host:port
        if "@" in addr:
            host_part = addr.split("@", 1)[1]
        else:
            host_part = addr
        # strip port if present
        if ":" in host_part:
            host_part = host_part.split(":", 1)[0]
        return host_part

    def _probe_ssh(addr: str) -> (bool, str):
        """Do a quick non-interactive probe to detect host key mismatch.

        Returns (ok, stderr_text). ok=True if probe succeeded.
        """
        try:
            # BatchMode=yes prevents password prompts; ConnectTimeout short for probe
            proc = subprocess.run([
                "ssh",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=5",
                "-o",
                "StrictHostKeyChecking=yes",
                addr,
                "true",
            ], capture_output=True, text=True)
            ok = proc.returncode == 0
            return ok, (proc.stderr or "")
        except FileNotFoundError:
            return False, "SSH client not found"

    try:
        print(f"Connecting to {selected_addr}...")
        ok, stderr = _probe_ssh(selected_addr)
        if ok:
            # Launch interactive session
            subprocess.run(["ssh", selected_addr])
            return
        # Check for host key changed message
        stderr_up = stderr.upper()
        if "REMOTE HOST IDENTIFICATION HAS CHANGED" in stderr_up or "HOST KEY VERIFICATION FAILED" in stderr_up:
            host = _extract_host(selected_addr)
            print("Detected host key mismatch for", host)
            confirm = questionary.confirm(
                f"Host key for {host} appears changed. Remove existing known_hosts entry for {host} and retry?",
                default=False,
            ).ask()
            if confirm:
                # try ssh-keygen -R host first
                try:
                    rk = subprocess.run(["ssh-keygen", "-R", host], capture_output=True, text=True)
                    if rk.returncode == 0:
                        print(f"Removed known_hosts entry for {host} using ssh-keygen.")
                    else:
                        # fallback to manual edit
                        raise Exception(rk.stderr)
                except Exception:
                    known = os.path.expanduser("~/.ssh/known_hosts")
                    try:
                        if os.path.exists(known):
                            with open(known, "r", encoding="utf-8", errors="ignore") as fh:
                                lines = fh.readlines()
                            new_lines = [ln for ln in lines if host not in ln]
                            with open(known, "w", encoding="utf-8") as fh:
                                fh.writelines(new_lines)
                            print(f"Removed known_hosts entries containing {host} from {known}.")
                    except Exception as e:
                        print("Failed to remove known_hosts entry:", e)
                # retry interactive ssh (use password if provided and supported)
                try:
                    if sel_pwd:
                        # Try sshpass on Unix
                        from shutil import which
                        if platform.system() != "Windows" and which("sshpass"):
                            subprocess.run(["sshpass", "-p", sel_pwd, "ssh", selected_addr])
                        elif platform.system() == "Windows" and which("plink"):
                            subprocess.run(["plink", selected_addr, "-pw", sel_pwd])
                        else:
                            print("Password provided but no helper found (sshpass/plink). Falling back to interactive ssh.")
                            subprocess.run(["ssh", selected_addr])
                    else:
                        subprocess.run(["ssh", selected_addr])
                except FileNotFoundError:
                    print("SSH client not found. Ensure 'ssh' is installed and available in PATH.")
                return
        # other errors
        print(stderr or "Failed to connect via ssh. Check that ssh is installed and the address is correct.")
    except FileNotFoundError:
        print("SSH client not found. Ensure 'ssh' is installed and available in PATH.")


if __name__ == "__main__":
    ssh_servers_handler()


