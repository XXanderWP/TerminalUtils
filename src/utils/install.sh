#!/usr/bin/env bash

set -euo pipefail

OWNER="XXanderWP"
REPO="TerminalUtils"
DEFAULT_INSTALL_DIR="${HOME}/terminalutils"

if [[ -t 1 ]]; then
	C_RESET="\033[0m"
	C_BOLD="\033[1m"
	C_DIM="\033[2m"
	C_CYAN="\033[36m"
	C_GREEN="\033[32m"
	C_YELLOW="\033[33m"
	C_RED="\033[31m"
else
	C_RESET=""
	C_BOLD=""
	C_DIM=""
	C_CYAN=""
	C_GREEN=""
	C_YELLOW=""
	C_RED=""
fi

TOTAL_STEPS=6
CURRENT_STEP=0

print_banner() {
	printf "\n${C_CYAN}${C_BOLD}"
	printf "╔══════════════════════════════════════════════════════╗\n"
	printf "║                TerminalUtils Installer              ║\n"
	printf "╚══════════════════════════════════════════════════════╝\n"
	printf "${C_RESET}${C_DIM}Latest release setup for Linux/macOS${C_RESET}\n\n"
}

draw_progress() {
	local width=34
	local percent=$(( CURRENT_STEP * 100 / TOTAL_STEPS ))
	local filled=$(( percent * width / 100 ))
	local empty=$(( width - filled ))
	local fill_bar empty_bar

	fill_bar=$(printf "%${filled}s" "" | tr ' ' '#')
	empty_bar=$(printf "%${empty}s" "" | tr ' ' '-')
	printf "${C_CYAN}[${fill_bar}${empty_bar}] %3d%%${C_RESET}\n" "$percent"
}

step_done() {
	local message="$1"
	CURRENT_STEP=$((CURRENT_STEP + 1))
	printf "${C_GREEN}✓${C_RESET} %s\n" "$message"
	draw_progress
	printf "\n"
}

fail() {
	printf "\n${C_RED}${C_BOLD}Installation failed:${C_RESET} %s\n" "$1" >&2
	exit 1
}

spinner_run() {
	local message="$1"
	shift
	local log_file
	log_file=$(mktemp)

	"$@" >"$log_file" 2>&1 &
	local cmd_pid=$!
	local spin='|/-\\'
	local i=0

	printf "${C_YELLOW}→${C_RESET} %s " "$message"
	while kill -0 "$cmd_pid" 2>/dev/null; do
		i=$(( (i + 1) % 4 ))
		printf "\r${C_YELLOW}→${C_RESET} %s ${C_DIM}%c${C_RESET}" "$message" "${spin:$i:1}"
		sleep 0.1
	done

	wait "$cmd_pid" || {
		printf "\r${C_RED}✗${C_RESET} %s\n" "$message"
		sed -n '1,20p' "$log_file" >&2
		rm -f "$log_file"
		return 1
	}

	printf "\r${C_GREEN}✓${C_RESET} %s\n" "$message"
	rm -f "$log_file"
}

need_cmd() {
	local cmd="$1"
	command -v "$cmd" >/dev/null 2>&1 || fail "Required command not found: ${cmd}"
}

json_extract() {
	local key="$1"
	local file="$2"
	sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$file" | head -n 1
}

find_asset_url() {
	local asset_name="$1"
	local file="$2"
	sed -n "s/.*\"browser_download_url\"[[:space:]]*:[[:space:]]*\"\([^\"]*\/${asset_name}\)\".*/\1/p" "$file" | head -n 1
}

normalize_path() {
	local input="$1"
	if [[ "$input" == ~* ]]; then
		input="${HOME}${input:1}"
	fi
	local dir
	dir=$(mkdir -p "$input" && cd "$input" && pwd)
	printf "%s" "$dir"
}

is_terminalutils_dir() {
	local dir="$1"
	[[ -d "$dir" ]] || return 1

	local required=("util" "upload" "new-version" "ssh-servers" "util.ps1" "upload.ps1" "new-version.ps1" "ssh-servers.ps1")
	local script
	for script in "${required[@]}"; do
		[[ -f "$dir/$script" ]] || return 1
	done

	return 0
}

find_existing_install_dir() {
	local entry
	IFS=':' read -r -a path_entries <<< "${PATH:-}"
	for entry in "${path_entries[@]}"; do
		[[ -n "$entry" ]] || continue
		if is_terminalutils_dir "$entry"; then
			normalize_path "$entry"
			return 0
		fi
	done

	return 1
}

append_path_block_sh() {
	local rc_file="$1"
	local install_dir="$2"

	[[ -f "$rc_file" ]] || touch "$rc_file"

	if grep -Fq '# >>> terminalutils path >>>' "$rc_file"; then
		return
	fi

	{
		printf "\n# >>> terminalutils path >>>\n"
		printf "export PATH=\"\$PATH:%s\"\n" "$install_dir"
		printf "# <<< terminalutils path <<<\n"
	} >> "$rc_file"
}

append_path_block_fish() {
	local install_dir="$1"
	local fish_rc="${HOME}/.config/fish/config.fish"

	mkdir -p "$(dirname "$fish_rc")"
	[[ -f "$fish_rc" ]] || touch "$fish_rc"

	if grep -Fq '# >>> terminalutils path >>>' "$fish_rc"; then
		return
	fi

	{
		printf "\n# >>> terminalutils path >>>\n"
		printf "if not contains -- \"%s\" \$PATH\n" "$install_dir"
		printf "    set -gx PATH \$PATH \"%s\"\n" "$install_dir"
		printf "end\n"
		printf "# <<< terminalutils path <<<\n"
	} >> "$fish_rc"
}

configure_path() {
	local install_dir="$1"
	local shell_name
	shell_name=$(basename "${SHELL:-}")

	local rc_files=("${HOME}/.profile")
	if [[ "$shell_name" == "bash" ]]; then
		rc_files+=("${HOME}/.bashrc" "${HOME}/.bash_profile")
	fi
	if [[ "$shell_name" == "zsh" ]]; then
		rc_files+=("${HOME}/.zshrc" "${HOME}/.zprofile")
	fi

	if [[ -f "${HOME}/.bashrc" ]]; then rc_files+=("${HOME}/.bashrc"); fi
	if [[ -f "${HOME}/.bash_profile" ]]; then rc_files+=("${HOME}/.bash_profile"); fi
	if [[ -f "${HOME}/.zshrc" ]]; then rc_files+=("${HOME}/.zshrc"); fi
	if [[ -f "${HOME}/.zprofile" ]]; then rc_files+=("${HOME}/.zprofile"); fi
	if [[ -f "${HOME}/.kshrc" ]]; then rc_files+=("${HOME}/.kshrc"); fi
	if [[ -f "${HOME}/.mkshrc" ]]; then rc_files+=("${HOME}/.mkshrc"); fi

	local unique_files=()
	local seen
	for seen in "${rc_files[@]}"; do
		local is_new=1
		local existing
		for existing in "${unique_files[@]}"; do
			if [[ "$existing" == "$seen" ]]; then
				is_new=0
				break
			fi
		done
		if [[ "$is_new" -eq 1 ]]; then
			unique_files+=("$seen")
		fi
	done

	local rc
	for rc in "${unique_files[@]}"; do
		append_path_block_sh "$rc" "$install_dir"
	done

	if command -v fish >/dev/null 2>&1 || [[ -d "${HOME}/.config/fish" ]]; then
		append_path_block_fish "$install_dir"
	fi

	export PATH="$PATH:$install_dir"
}

main() {
	print_banner

	need_cmd curl
	need_cmd awk
	need_cmd unzip

	local api_url="https://api.github.com/repos/${OWNER}/${REPO}/releases/latest"
	local tmp_root
	tmp_root=$(mktemp -d)
	local release_json="${tmp_root}/release.json"
	local main_zip_path="${tmp_root}/main.zip"
	local extract_dir="${tmp_root}/extract"

	trap 'rm -rf "${tmp_root:-}"' EXIT

	spinner_run "Requesting latest release metadata" curl -fsSL "$api_url" -o "$release_json" || fail "Could not fetch latest release metadata."
	step_done "Latest release metadata loaded"

	local tag_name
	tag_name=$(json_extract "tag_name" "$release_json")

	local main_zip_url
	main_zip_url=$(find_asset_url "main.zip" "$release_json")
	[[ -n "$main_zip_url" ]] || fail "Release asset main.zip not found."

	printf "${C_CYAN}${C_BOLD}Latest release:${C_RESET} %s\n\n" "${tag_name:-unknown}"

	local user_dir=""
	local existing_dir=""
	if existing_dir=$(find_existing_install_dir); then
		printf "${C_YELLOW}Detected existing TerminalUtils installation in PATH:${C_RESET} %s\n" "$existing_dir"
		local update_answer="Y"
		if [[ -t 0 ]]; then
			read -r -p "Update existing installation in this directory? [Y/n]: " update_answer
		elif { read -r -p "Update existing installation in this directory? [Y/n]: " update_answer < /dev/tty; } 2>/dev/null; then
			:
		else
			printf "${C_DIM}No interactive input available, updating existing installation.${C_RESET}\n"
		fi

		if [[ -z "$update_answer" || "$update_answer" =~ ^[Yy]$ ]]; then
			user_dir="$existing_dir"
		else
			user_dir=""
		fi
	fi

	if [[ -z "${user_dir:-}" ]]; then
		printf "Installation directory\n"
		printf "Press Enter to use default: ${C_BOLD}%s${C_RESET}\n" "$DEFAULT_INSTALL_DIR"

		user_dir=""
		if [[ -t 0 ]]; then
			read -r -p "Path: " user_dir
		elif { read -r -p "Path: " user_dir < /dev/tty; } 2>/dev/null; then
			:
		else
			printf "${C_DIM}No interactive input available, using default path.${C_RESET}\n"
		fi
		user_dir=${user_dir:-$DEFAULT_INSTALL_DIR}
	fi

	local install_dir
	install_dir=$(normalize_path "$user_dir")
	step_done "Installation directory prepared: ${install_dir}"

	spinner_run "Downloading main.zip" curl -fsSL "$main_zip_url" -o "$main_zip_path" || fail "Could not download main.zip."
	step_done "Release archive downloaded"

	spinner_run "Extracting archive and copying files" bash -c '
		archive="$1"
		tmp_extract="$2"
		dst="$3"
		set -euo pipefail
		rm -rf "$tmp_extract"
		mkdir -p "$tmp_extract"
		unzip -oq "$archive" -d "$tmp_extract"
		shopt -s dotglob nullglob
		for item in "$tmp_extract"/*; do
			name="$(basename "$item")"
			rm -rf "$dst/$name"
			cp -Rf "$item" "$dst/$name"
		done
	' _ "$main_zip_path" "$extract_dir" "$install_dir" || fail "Archive extraction failed."
	step_done "Archive extracted and files copied"

	find "$install_dir" -maxdepth 1 -type f -name 'install*' -delete || true
	chmod +x "$install_dir"/*.sh "$install_dir"/util "$install_dir"/upload "$install_dir"/new-version "$install_dir"/ssh-servers 2>/dev/null || true
	step_done "Files installed and install* scripts removed"

	printf "${C_YELLOW}→${C_RESET} Configuring PATH for common shells\n"
	configure_path "$install_dir" || fail "Could not configure PATH."
	step_done "PATH configuration complete"

	printf "${C_GREEN}${C_BOLD}TerminalUtils installed successfully.${C_RESET}\n"
	printf "Use command: ${C_BOLD}util${C_RESET}\n"
	printf "${C_DIM}If command is not found immediately, restart your terminal window.${C_RESET}\n\n"
}

main "$@"
