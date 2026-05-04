#!/usr/bin/env bash
set -uo pipefail

# PolinRider / Beavertail Malware Cleaner
# DPRK Contagious Interview (UNC5342)
#
# Zero dependencies - pure bash. No Node.js required.
# NEVER makes outbound network calls.
#
# Upstream / provenance:
#   This file is vendored into the repo for CI-gating purposes from the
#   original `polinrider-cleaner.sh`. Local edits here address review
#   feedback (regex character class de-duplication, mktemp temp dir,
#   direct-grep file signatures, per-tool C2 parser). When syncing a new
#   upstream version, re-apply the diff or push these fixes upstream first.
#
# Usage:
#   ./polinrider-cleaner.sh                    # Scan only (cwd)
#   ./polinrider-cleaner.sh --full             # Full system scan
#   ./polinrider-cleaner.sh --clean            # Scan + remove (with confirmation)
#   ./polinrider-cleaner.sh --clean --force    # Remove without confirmation
#   ./polinrider-cleaner.sh --dir /path/to/dir # Scan specific directory
#   ./polinrider-cleaner.sh --log cleanup.log  # Save log

# ============================================================
# Malware Signatures (synced with scan-org-repos.sh / scan-repo.sh)
# ============================================================

C2_IPS=("136.0.9.8" "198.105.127.210" "23.27.202.27")

MALWARE_STRINGS=(
  "global['!']"
  'global["!"]'
  '_$_1e42'
  'rmcej%otb%'
  '/verify-human/'
  '8-1168-1'
  '8-493-2'
  'String.fromCharCode(127)'
  'temp_auto_push'
)

MALWARE_REGEX_PATTERNS=(
  'global\s*\[\s*['"'"'"]!['"'"'"]\]'
  '\b_\$_[0-9a-f]{4}\b'
  '\b_t_[suc]\b'
  '\bss_info\b'
  '\bss_cb\b'
  '\bss_eval\b'
  '\bss_exit\b'
  '\bss_inz\b'
  'git commit --amend.*--no-verify'
  'git push.*-[a-zA-Z]*f.*--no-verify'
)

CONFIG_FILE_NAMES=(
  'postcss.config.mjs' 'postcss.config.js' 'postcss.config.cjs'
  'tailwind.config.js' 'tailwind.config.ts' 'tailwind.config.mjs'
  'eslint.config.mjs' 'eslint.config.js' 'eslint.config.cjs'
  'jest.config.js' 'jest.config.ts'
  'vite.config.js' 'vite.config.ts' 'vite.config.mjs'
  'cypress.config.js' 'cypress.config.ts'
)

MALWARE_PACKAGES=("socket.io-client")

MALWARE_FILENAMES=(
  'temp_auto_push.bat'
)

DEVICEID_CLEAN_MARKER='__exportStar(require("./devdeviceid.js"), exports);'
DEVICEID_MAX_CLEAN_SIZE=5000

# ============================================================
# State
# ============================================================

MODE="scan"
FORCE=false
FULL=false
PROJECT_DIR="$(pwd)"
LOG_FILE=""
FINDINGS=0
CRITICAL=0
CLEANED=0
MANUAL=0
BACKUP_DIR=""

# Use a private mktemp directory so a malicious user cannot pre-plant
# symlinks at a predictable PID-only path and redirect our writes.
TMP_DIR="$(mktemp -d -t polinrider.XXXXXXXX 2>/dev/null || mktemp -d /tmp/polinrider.XXXXXXXX)"
TMP_PREFIX="${TMP_DIR}/polinrider"

# ============================================================
# Colors
# ============================================================

if [[ -t 1 ]]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  CYAN='\033[0;36m'
  GRAY='\033[0;90m'
  BGRED='\033[41;37m'
  NC='\033[0m'
else
  RED='' GREEN='' YELLOW='' CYAN='' GRAY='' BGRED='' NC=''
fi

# ============================================================
# Logging
# ============================================================

log_info()  { local ts; ts=$(date +%H:%M:%S); echo -e "${CYAN}[${ts}] [INFO] $1${NC}"; [[ -n "$LOG_FILE" ]] && echo "[${ts}] [INFO] $1" >> "$LOG_FILE"; }
log_warn()  { local ts; ts=$(date +%H:%M:%S); echo -e "${YELLOW}[${ts}] [WARN] $1${NC}"; [[ -n "$LOG_FILE" ]] && echo "[${ts}] [WARN] $1" >> "$LOG_FILE"; }
log_error() { local ts; ts=$(date +%H:%M:%S); echo -e "${RED}[${ts}] [ERROR] $1${NC}"; [[ -n "$LOG_FILE" ]] && echo "[${ts}] [ERROR] $1" >> "$LOG_FILE"; }
log_ok()    { local ts; ts=$(date +%H:%M:%S); echo -e "${GREEN}[${ts}] [OK] $1${NC}"; [[ -n "$LOG_FILE" ]] && echo "[${ts}] [OK] $1" >> "$LOG_FILE"; }
log_crit()  { local ts; ts=$(date +%H:%M:%S); echo -e "${BGRED}[${ts}] [CRIT] $1${NC}"; [[ -n "$LOG_FILE" ]] && echo "[${ts}] [CRIT] $1" >> "$LOG_FILE"; }

section() {
  echo ""
  echo -e "${CYAN}────────────────────────────────────────────────────────────${NC}"
  echo -e "${CYAN}  $1${NC}"
  echo -e "${CYAN}────────────────────────────────────────────────────────────${NC}"
}

finding() {
  local severity="$1" target="$2" filepath="$3" ftype="$4"
  shift 4
  FINDINGS=$((FINDINGS + 1))
  if [[ "$severity" == "critical" ]]; then
    CRITICAL=$((CRITICAL + 1))
    echo -e "\n  ${BGRED} CRITICAL ${NC} ${target}"
  else
    echo -e "\n  ${YELLOW} MEDIUM ${NC} ${target}"
  fi
  echo -e "  ${GRAY}Path:${NC} ${filepath}"
  echo -e "  ${GRAY}Type:${NC} ${ftype}"
  for evidence in "$@"; do
    echo -e "  ${GRAY}  -${NC} ${evidence}"
  done
}

# ============================================================
# File signature check
# ============================================================

check_file_signatures() {
  local filepath="$1"
  local hits=()

  if [[ ! -f "$filepath" ]] || [[ ! -r "$filepath" ]]; then
    return
  fi

  # Run grep against the file directly. Reading the whole file into a shell
  # variable and re-piping it through grep N times is slower and breaks on
  # binary data / files larger than ARG_MAX.

  # Fixed string signatures
  for sig in "${MALWARE_STRINGS[@]}"; do
    if grep -qF -- "$sig" "$filepath" 2>/dev/null; then
      hits+=("Contains malware string: $sig")
    fi
  done

  # C2 IPs
  for ip in "${C2_IPS[@]}"; do
    if grep -qF -- "$ip" "$filepath" 2>/dev/null; then
      hits+=("Contains C2 IP: $ip")
    fi
  done

  # Regex patterns
  for pat in "${MALWARE_REGEX_PATTERNS[@]}"; do
    if grep -qE -- "$pat" "$filepath" 2>/dev/null; then
      hits+=("Matches pattern: $pat")
    fi
  done

  if [[ ${#hits[@]} -gt 0 ]]; then
    printf '%s\n' "${hits[@]}"
  fi
}

# ============================================================
# IDE Scanner
# ============================================================

scan_ide_file() {
  local filepath="$1"
  local ide_name="$2"
  local ftype="$3"        # deviceid | discord_core | app_main
  local restore="$4"      # truncate | reinstall

  if [[ ! -f "$filepath" ]]; then
    return
  fi

  local evidence=()
  local filesize
  filesize=$(wc -c < "$filepath" 2>/dev/null | tr -d ' ')

  # Size check for deviceid files
  if [[ "$ftype" == "deviceid" ]] && [[ "$filesize" -gt "$DEVICEID_MAX_CLEAN_SIZE" ]]; then
    evidence+=("File size anomaly: ${filesize} bytes (expected < ${DEVICEID_MAX_CLEAN_SIZE})")
  fi

  # Check for injected code after clean marker (deviceid only)
  if [[ "$ftype" == "deviceid" ]]; then
    if grep -qF "$DEVICEID_CLEAN_MARKER" "$filepath" 2>/dev/null; then
      local marker_line
      marker_line=$(grep -n "$DEVICEID_CLEAN_MARKER" "$filepath" 2>/dev/null | head -1 | cut -d: -f1)
      local total_lines
      total_lines=$(wc -l < "$filepath" | tr -d ' ')
      if [[ -n "$marker_line" ]] && [[ "$total_lines" -gt "$marker_line" ]]; then
        local extra_lines=$((total_lines - marker_line))
        evidence+=("Injected code after deviceid marker: ${extra_lines} extra lines")
      fi
    fi
  fi

  # Signature scan
  local sig_output
  sig_output=$(check_file_signatures "$filepath")
  if [[ -n "$sig_output" ]]; then
    while IFS= read -r line; do
      [[ -n "$line" ]] && evidence+=("$line")
    done <<< "$sig_output"
  fi

  if [[ ${#evidence[@]} -gt 0 ]]; then
    finding "critical" "$ide_name" "$filepath" "ide_injection (${ftype})" "${evidence[@]}"
    echo "${filepath}|${ide_name}|${ftype}|${restore}" >> "${TMP_PREFIX}_ide.tmp"
  fi
}

guess_ide_name() {
  local fp="$1"
  local lower
  lower=$(echo "$fp" | tr '[:upper:]' '[:lower:]')

  if [[ "$lower" == *"cursor"* ]]; then echo "Cursor"; return; fi
  if [[ "$lower" == *"antigravity"* ]]; then echo "Antigravity"; return; fi
  if [[ "$lower" == *"visual studio code"* ]] || [[ "$lower" == *"/code/"* ]]; then echo "Visual Studio Code"; return; fi
  if [[ "$lower" == *"vscodium"* ]]; then echo "VSCodium"; return; fi
  if [[ "$lower" == *"windsurf"* ]]; then echo "Windsurf"; return; fi
  if [[ "$lower" == *"github desktop"* ]]; then echo "GitHub Desktop"; return; fi
  if [[ "$lower" == *"discord"* ]]; then echo "Discord"; return; fi

  local app_name
  app_name=$(echo "$fp" | grep -oE '/[^/]+\.app/' | head -1 | tr -d '/' | sed 's/\.app//')
  if [[ -n "$app_name" ]]; then echo "$app_name"; return; fi

  echo "Unknown IDE (${fp})"
}

scan_all_ide() {
  local scanned=0

  rm -f "${TMP_PREFIX}_ide.tmp"
  touch "${TMP_PREFIX}_ide.tmp"

  # Step 1: Known fixed paths
  local known_paths=()

  case "$(uname -s)" in
    Darwin)
      known_paths+=(
        "/Applications/Visual Studio Code.app/Contents/Resources/app/node_modules/@vscode/deviceid/dist/index.js|Visual Studio Code|deviceid|truncate"
        "/Applications/Cursor.app/Contents/Resources/app/node_modules/@vscode/deviceid/dist/index.js|Cursor|deviceid|truncate"
        "/Applications/Antigravity.app/Contents/Resources/app/node_modules/@vscode/deviceid/dist/index.js|Antigravity|deviceid|truncate"
        "$HOME/Library/Application Support/discord/modules/discord_desktop_core/core/index.js|Discord|discord_core|reinstall"
        "/Applications/GitHub Desktop.app/Contents/Resources/app/main.js|GitHub Desktop|app_main|reinstall"
      )
      ;;
    Linux)
      known_paths+=(
        "/usr/share/code/resources/app/node_modules/@vscode/deviceid/dist/index.js|Visual Studio Code|deviceid|truncate"
        "/usr/share/cursor/resources/app/node_modules/@vscode/deviceid/dist/index.js|Cursor|deviceid|truncate"
        "/usr/share/antigravity/resources/app/node_modules/@vscode/deviceid/dist/index.js|Antigravity|deviceid|truncate"
        "$HOME/.config/discord/modules/discord_desktop_core/core/index.js|Discord|discord_core|reinstall"
      )
      ;;
  esac

  local scanned_set=""
  for entry in "${known_paths[@]}"; do
    local fp ide_name ftype restore
    IFS='|' read -r fp ide_name ftype restore <<< "$entry"
    if [[ -f "$fp" ]]; then
      scan_ide_file "$fp" "$ide_name" "$ftype" "$restore"
      scanned=$((scanned + 1))
      scanned_set="${scanned_set}|${fp}|"
    fi
  done

  # Step 2: System-wide discovery using find
  local search_roots=()

  case "$(uname -s)" in
    Darwin)
      [[ -d "/Applications" ]] && search_roots+=("/Applications")
      [[ -d "$HOME/Applications" ]] && search_roots+=("$HOME/Applications")
      [[ -d "$HOME/Library/Application Support" ]] && search_roots+=("$HOME/Library/Application Support")
      ;;
    Linux)
      [[ -d "/usr/share" ]] && search_roots+=("/usr/share")
      [[ -d "/usr/local/share" ]] && search_roots+=("/usr/local/share")
      [[ -d "/opt" ]] && search_roots+=("/opt")
      [[ -d "/snap" ]] && search_roots+=("/snap")
      [[ -d "$HOME/.local/share" ]] && search_roots+=("$HOME/.local/share")
      [[ -d "$HOME/.config" ]] && search_roots+=("$HOME/.config")
      [[ -d "$HOME/.var/app" ]] && search_roots+=("$HOME/.var/app")
      ;;
  esac

  log_info "  Searching ${#search_roots[@]} system directories for IDE installations..."

  for root in "${search_roots[@]}"; do
    while IFS= read -r fp; do
      [[ -z "$fp" ]] && continue
      if [[ "$scanned_set" == *"|${fp}|"* ]]; then continue; fi
      scanned_set="${scanned_set}|${fp}|"
      local name
      name=$(guess_ide_name "$fp")
      scan_ide_file "$fp" "$name" "deviceid" "truncate"
      scanned=$((scanned + 1))
    done < <(find "$root" -maxdepth 8 -path "*/deviceid/dist/index.js" -type f 2>/dev/null)

    while IFS= read -r fp; do
      [[ -z "$fp" ]] && continue
      [[ "$fp" != *"index.js" ]] && continue
      if [[ "$scanned_set" == *"|${fp}|"* ]]; then continue; fi
      scanned_set="${scanned_set}|${fp}|"
      scan_ide_file "$fp" "Discord" "discord_core" "reinstall"
      scanned=$((scanned + 1))
    done < <(find "$root" -maxdepth 6 -path "*discord_desktop_core*" -name "index.js" -type f 2>/dev/null)
  done

  log_info "  Total IDE files checked: ${scanned}"
}

# ============================================================
# Config File Scanner
# ============================================================

scan_config_files() {
  local start_dir="$1"
  if [[ ! -d "$start_dir" ]]; then return; fi

  # Build find -name arguments
  local find_names=""
  for name in "${CONFIG_FILE_NAMES[@]}"; do
    if [[ -n "$find_names" ]]; then
      find_names="$find_names -o"
    fi
    find_names="$find_names -name $name"
  done

  # Add known malware filenames
  for name in "${MALWARE_FILENAMES[@]}"; do
    find_names="$find_names -o -name $name"
  done

  while IFS= read -r filepath; do
    [[ -z "$filepath" ]] && continue

    case "$filepath" in
      */node_modules/*|*/.git/*|*/.next/*|*/dist/*|*/build/*|*/.cache/*|*/.pnpm/*|*/.venv/*) continue ;;
    esac

    local fname
    fname=$(basename "$filepath")

    # Known malware files — always flag
    local is_malware_file=false
    for mf in "${MALWARE_FILENAMES[@]}"; do
      if [[ "$fname" == "$mf" ]]; then
        is_malware_file=true
        break
      fi
    done

    if [[ "$is_malware_file" == true ]]; then
      finding "critical" "$fname" "$filepath" "malware_file" "Known malware file: ${fname}"
      echo "$filepath" >> "${TMP_PREFIX}_config.tmp"
      continue
    fi

    # Config files — check signatures
    local evidence=()
    local sig_output
    sig_output=$(check_file_signatures "$filepath")
    if [[ -n "$sig_output" ]]; then
      while IFS= read -r line; do
        [[ -n "$line" ]] && evidence+=("$line")
      done <<< "$sig_output"
    fi

    if [[ ${#evidence[@]} -gt 0 ]]; then
      finding "critical" "$fname" "$filepath" "config_infection" "${evidence[@]}"
      echo "$filepath" >> "${TMP_PREFIX}_config.tmp"
    fi
  done < <(find "$start_dir" -maxdepth 10 \( -name node_modules -o -name .git -o -name .next -o -name dist -o -name build -o -name .cache -o -name .pnpm -o -name .venv \) -prune -o \( $find_names \) -type f -print 2>/dev/null)
}

scan_configs_all() {
  rm -f "${TMP_PREFIX}_config.tmp"
  touch "${TMP_PREFIX}_config.tmp"

  scan_config_files "$PROJECT_DIR"

  if [[ "$FULL" == true ]]; then
    local project_roots=("$HOME/src" "$HOME/projects" "$HOME/repos" "$HOME/workspace" "$HOME/work" "$HOME/dev" "$HOME/code" "$HOME/Work" "$HOME/Documents" "$HOME/Desktop")
    local searched=1

    log_info "  Full mode: scanning project directories..."
    for root in "${project_roots[@]}"; do
      if [[ -d "$root" ]] && [[ "$root" != "$PROJECT_DIR" ]]; then
        scan_config_files "$root"
        searched=$((searched + 1))
      fi
    done
    log_info "  Directories searched: ${searched}"
  fi
}

# ============================================================
# C2 Connection Scanner
# ============================================================

scan_c2_connections() {
  rm -f "${TMP_PREFIX}_conn.tmp"
  touch "${TMP_PREFIX}_conn.tmp"

  local output=""
  local tool=""

  if command -v lsof &>/dev/null; then
    tool="lsof"
    output=$(lsof -i -n -P 2>/dev/null || true)
  elif command -v ss &>/dev/null; then
    tool="ss"
    output=$(ss -tunap 2>/dev/null || true)
  elif command -v netstat &>/dev/null; then
    tool="netstat"
    output=$(netstat -an 2>/dev/null || true)
  fi

  if [[ -z "$output" ]]; then
    log_warn "  Could not check network connections (no lsof/ss/netstat or permission denied)"
    return
  fi

  local conn_found=0
  for ip in "${C2_IPS[@]}"; do
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue

      # Column layout differs across the three tools — parse per-tool so
      # we don't end up reporting "Process tcp (PID ESTAB)" for ss/netstat.
      local proc_name="unknown" pid_str="?"
      case "$tool" in
        lsof)
          # lsof -i -n -P: COMMAND PID USER FD TYPE DEVICE SIZE NODE NAME
          proc_name=$(echo "$line" | awk '{print $1}')
          pid_str=$(echo "$line" | awk '{print $2}')
          ;;
        ss)
          # ss -tunap appends users:(("name",pid=N,fd=...)) when the socket
          # is owned by a process the caller is allowed to inspect.
          if [[ "$line" =~ users:\(\(\"([^\"]+)\",[[:space:]]*pid=([0-9]+) ]]; then
            proc_name="${BASH_REMATCH[1]}"
            pid_str="${BASH_REMATCH[2]}"
          fi
          ;;
        netstat)
          # `netstat -an` does not expose PID/process. Flag the connection
          # but mark attribution unknown; rerun under lsof for the PID.
          proc_name="(netstat: process not exposed; rerun with lsof for PID)"
          ;;
      esac

      finding "critical" "Process ${proc_name} (PID ${pid_str})" "N/A" "active_c2_connection" "Active connection to C2 ${ip}: ${line}"
      echo "${pid_str}|${proc_name}|${ip}" >> "${TMP_PREFIX}_conn.tmp"
      conn_found=$((conn_found + 1))
    done < <(echo "$output" | grep -F "$ip" || true)
  done

  log_info "  Connection findings: ${conn_found}"
}

# ============================================================
# npm Package Scanner
# ============================================================

scan_malware_packages() {
  rm -f "${TMP_PREFIX}_pkg.tmp"
  touch "${TMP_PREFIX}_pkg.tmp"

  local pkg_json="${PROJECT_DIR}/package.json"
  if [[ ! -f "$pkg_json" ]]; then return; fi

  for pkg_name in "${MALWARE_PACKAGES[@]}"; do
    local pkg_dir="${PROJECT_DIR}/node_modules/${pkg_name}"
    if [[ ! -d "$pkg_dir" ]]; then continue; fi

    if grep -qF "\"${pkg_name}\"" "$pkg_json" 2>/dev/null; then
      finding "low" "$pkg_name" "$pkg_dir" "malware_package" "Package in package.json - review if intentional"
    else
      finding "medium" "$pkg_name" "$pkg_dir" "malware_package" "Package in node_modules but NOT in package.json - likely malware-installed"
      echo "$pkg_dir" >> "${TMP_PREFIX}_pkg.tmp"
    fi
  done
}

# ============================================================
# Cleaners
# ============================================================

make_backup_dir() {
  local ts
  ts=$(date +%Y%m%d-%H%M%S)
  BACKUP_DIR="${PROJECT_DIR}/.polinrider-backup-${ts}"
  mkdir -p "$BACKUP_DIR"
  log_info "Backup directory: ${BACKUP_DIR}"
}

clean_ide_files() {
  if [[ ! -s "${TMP_PREFIX}_ide.tmp" ]]; then return; fi

  while IFS='|' read -r filepath ide_name ftype restore; do
    [[ -z "$filepath" ]] && continue

    local backup_name
    backup_name=$(echo "$filepath" | tr '/' '_')
    cp "$filepath" "${BACKUP_DIR}/${backup_name}"
    log_info "Backed up: ${filepath}"

    if [[ "$restore" == "truncate" ]] && [[ "$ftype" == "deviceid" ]]; then
      local marker_line
      marker_line=$(grep -n "$DEVICEID_CLEAN_MARKER" "$filepath" 2>/dev/null | head -1 | cut -d: -f1)

      if [[ -n "$marker_line" ]]; then
        local before_size
        before_size=$(wc -c < "$filepath" | tr -d ' ')
        head -n "$marker_line" "$filepath" > "${filepath}.clean"
        mv "${filepath}.clean" "$filepath"
        local after_size
        after_size=$(wc -c < "$filepath" | tr -d ' ')
        log_ok "Restored ${ide_name}: ${before_size} -> ${after_size} bytes"
        CLEANED=$((CLEANED + 1))
      else
        log_warn "${ide_name}: clean marker not found, cannot auto-restore"
        MANUAL=$((MANUAL + 1))
      fi
    else
      log_warn "${ide_name}: automatic restore not safe. Reinstall the application."
      case "$ide_name" in
        "Visual Studio Code") log_warn "  Download: https://code.visualstudio.com/" ;;
        "Cursor")             log_warn "  Download: https://cursor.sh/" ;;
        "Discord")            log_warn "  Download: https://discord.com/download" ;;
        "GitHub Desktop")     log_warn "  Download: https://desktop.github.com/" ;;
        *)                    log_warn "  Reinstall from official source" ;;
      esac
      MANUAL=$((MANUAL + 1))
    fi
  done < "${TMP_PREFIX}_ide.tmp"
}

clean_config_files() {
  if [[ ! -s "${TMP_PREFIX}_config.tmp" ]]; then return; fi

  while IFS= read -r filepath; do
    [[ -z "$filepath" ]] && continue

    local fname
    fname=$(basename "$filepath")
    mv "$filepath" "${BACKUP_DIR}/${fname}.quarantined"

    log_ok "Quarantined: ${filepath} -> ${BACKUP_DIR}/${fname}.quarantined"
    log_warn "You need to create a new clean ${fname} for your project"
    CLEANED=$((CLEANED + 1))
  done < "${TMP_PREFIX}_config.tmp"
}

clean_c2_connections() {
  if [[ ! -s "${TMP_PREFIX}_conn.tmp" ]]; then return; fi

  while IFS='|' read -r pid_str proc_name ip; do
    [[ -z "$pid_str" ]] && continue

    local pid
    pid=$(echo "$pid_str" | grep -oE '[0-9]+' | head -1)
    if [[ -z "$pid" ]]; then continue; fi

    if kill -TERM "$pid" 2>/dev/null; then
      sleep 1
      if kill -0 "$pid" 2>/dev/null; then
        kill -KILL "$pid" 2>/dev/null || true
        log_ok "Force-killed: ${proc_name} (PID ${pid})"
      else
        log_ok "Terminated: ${proc_name} (PID ${pid})"
      fi
      CLEANED=$((CLEANED + 1))
    else
      log_warn "Could not terminate: ${proc_name} (PID ${pid}) - may need sudo"
    fi
  done < "${TMP_PREFIX}_conn.tmp"
}

clean_malware_packages() {
  if [[ ! -s "${TMP_PREFIX}_pkg.tmp" ]]; then return; fi

  while IFS= read -r pkg_dir; do
    [[ -z "$pkg_dir" ]] && continue

    rm -rf "$pkg_dir"
    log_ok "Removed: ${pkg_dir}"
    CLEANED=$((CLEANED + 1))
  done < "${TMP_PREFIX}_pkg.tmp"
}

# ============================================================
# Reports
# ============================================================

print_scan_report() {
  section "Scan Results"

  if [[ "$FINDINGS" -eq 0 ]]; then
    log_ok "No PolinRider/Beavertail artifacts detected. System appears clean."
    return
  fi

  echo ""
  echo "  Total findings: ${FINDINGS}"
  if [[ "$CRITICAL" -gt 0 ]]; then
    echo -e "  ${RED}Critical: ${CRITICAL}${NC}"
  fi
  local medium=$((FINDINGS - CRITICAL))
  if [[ "$medium" -gt 0 ]]; then
    echo -e "  ${YELLOW}Medium/Low: ${medium}${NC}"
  fi
}

print_coverage() {
  section "Scan Coverage"

  echo -e "\n  ${GREEN}Checked:${NC}"
  echo "  - IDE injections: known paths + find-based system-wide discovery"
  echo "  - Active C2 connections: all network connections via lsof/ss/netstat"
  if [[ "$FULL" == true ]]; then
    echo "  - Config files: all project directories under home"
  else
    echo "  - Config files: ${PROJECT_DIR} only"
  fi
  echo "  - npm packages: ${PROJECT_DIR}/node_modules"
  echo "  - Known malware files: ${MALWARE_FILENAMES[*]}"

  echo -e "\n  ${YELLOW}Limitations (may miss):${NC}"
  echo "  - IDE files in non-standard locations not reachable by find"
  echo "  - Projects outside of home directory (use --dir for specific paths)"
  echo "  - Memory-only artifacts (global variables, active JS contexts)"
  echo "  - npm packages installed via --prefix to non-standard locations"

  if [[ "$FULL" != true ]]; then
    echo -e "\n  ${YELLOW}Tip: Run with --full to scan all project directories under home.${NC}"
  fi
}

print_clean_report() {
  section "Cleanup Summary"

  echo ""
  echo "  Auto-cleaned: ${CLEANED}"
  echo "  Manual action needed: ${MANUAL}"
}

print_post_cleanup() {
  section "Post-Cleanup Security Recommendations"

  echo "  1. Change passwords that may have been captured via clipboard theft"
  echo "  2. Rotate API tokens, SSH keys, and cryptocurrency wallet seeds"
  echo "  3. Check git history for temp_auto_push.bat or suspicious commits"
  echo "  4. Add firewall rules to block: ${C2_IPS[*]} (ports 443, 27017)"
  echo "  5. Monitor network traffic for reconnection attempts to C2 servers"
  echo "  6. Reinstall IDEs flagged as requiring manual action"
  echo "  7. Run: git diff on affected config files to review changes"
  echo "  8. Report to KISA (Korea) or FBI IC3 if applicable"
  echo ""
}

# ============================================================
# CLI
# ============================================================

print_help() {
  cat << 'EOF'

PolinRider / Beavertail Malware Cleaner (bash)

Usage: ./polinrider-cleaner.sh [options]

Options:
  --scan           Scan only, report findings (default)
  --full           Full system scan (all IDEs + all project dirs under home)
  --clean          Scan and clean with confirmation
  --force          Skip confirmation (requires --clean)
  --log <file>     Save log to file
  --dir <path>     Project directory to scan (default: cwd)
  --help, -h       Show this help

Detects:
  - IDE injections (VSCode, Cursor, Antigravity, Discord, GitHub Desktop, any Electron IDE)
  - Infected config files (postcss, tailwind, eslint, jest, vite, cypress configs)
  - Known malware files (temp_auto_push.bat)
  - Active C2 connections to known C2 IPs
  - Malware-installed npm packages (socket.io-client)

EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --scan)     MODE="scan" ;;
      --clean)    MODE="clean" ;;
      --force)    FORCE=true ;;
      --full)     FULL=true ;;
      --log)      shift; LOG_FILE="$1" ;;
      --dir)      shift; PROJECT_DIR="$(cd "$1" && pwd)" ;;
      --help|-h)  print_help; exit 0 ;;
      *)          echo "Unknown option: $1"; print_help; exit 1 ;;
    esac
    shift
  done

  if [[ "$FORCE" == true ]] && [[ "$MODE" != "clean" ]]; then
    echo "Error: --force requires --clean"
    exit 1
  fi
}

confirm_cleanup() {
  if [[ "$FORCE" == true ]]; then return 0; fi

  echo ""
  echo -ne "  ${YELLOW}Proceed with cleanup? [y/N]: ${NC}"
  read -r answer
  case "$answer" in
    [yY]|[yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}

# ============================================================
# Main
# ============================================================

cleanup_tmp() {
  # Created by mktemp -d so it's safe to rm -rf the whole directory.
  [[ -n "${TMP_DIR:-}" ]] && [[ -d "${TMP_DIR}" ]] && rm -rf "${TMP_DIR}"
}

trap cleanup_tmp EXIT

main() {
  parse_args "$@"

  echo ""
  echo -e "${CYAN}============================================================${NC}"
  echo -e "${CYAN}  PolinRider / Beavertail Malware Cleaner${NC}"
  echo -e "${CYAN}  DPRK Contagious Interview (UNC5342)${NC}"
  echo -e "${CYAN}  Mode: $(echo "$MODE" | tr '[:lower:]' '[:upper:]')${NC}"
  echo -e "${CYAN}============================================================${NC}"

  log_info "Platform: $(uname -s) $(uname -r)"
  log_info "User: $(whoami)@$(hostname)"
  log_info "Project: ${PROJECT_DIR}"
  log_info "Scope: $(if [[ "$FULL" == true ]]; then echo 'FULL SYSTEM'; else echo 'project directory only'; fi)"

  # Phase 1: Scan
  section "Phase 1: Scanning for malware artifacts"

  log_info "Scanning IDE files (known paths + system-wide discovery)..."
  scan_all_ide

  log_info "Scanning project config files..."
  scan_configs_all

  log_info "Scanning active network connections..."
  scan_c2_connections

  log_info "Scanning npm packages..."
  scan_malware_packages

  # Phase 2: Report
  print_scan_report
  print_coverage

  if [[ "$MODE" == "scan" ]]; then
    if [[ "$FINDINGS" -gt 0 ]]; then
      echo -e "\n  ${YELLOW}Use --clean to remove detected artifacts.${NC}\n"
    fi
    exit $(( FINDINGS > 0 ? 1 : 0 ))
  fi

  # Phase 3: Clean
  if [[ "$FINDINGS" -eq 0 ]]; then
    log_ok "System appears clean. No action needed."
    exit 0
  fi

  if ! confirm_cleanup; then
    log_info "Cleanup cancelled by user."
    exit 0
  fi

  section "Phase 2: Cleaning malware artifacts"
  make_backup_dir

  clean_c2_connections
  clean_ide_files
  clean_config_files
  clean_malware_packages

  print_clean_report

  # Phase 4: Verify
  section "Phase 3: Verification"
  log_info "Re-scanning..."

  FINDINGS=0
  CRITICAL=0
  scan_all_ide
  scan_configs_all
  scan_c2_connections
  scan_malware_packages

  if [[ "$FINDINGS" -eq 0 ]]; then
    log_ok "Verification passed. No remaining artifacts detected."
  else
    log_warn "${FINDINGS} findings remain after cleanup."
  fi

  print_post_cleanup
  exit $(( FINDINGS > 0 ? 1 : 0 ))
}

main "$@"
