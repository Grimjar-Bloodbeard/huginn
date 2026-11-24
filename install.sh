#!/usr/bin/env bash
# Huginn installer for Linux (and Termux on Android, best effort).
#
#   curl -fsSL <repo raw url>/install.sh | bash     one line, nothing to download first
#   bash install.sh             install or update, then type:  huginn
#   bash install.sh --capture   also allow the live packet view (asks for sudo once)
#   bash install.sh --uninstall remove the huginn command (asks before deleting data)
#   bash install.sh --yes       answer yes to installing missing system packages
#
# Huginn is read-only: it maps the network you are on, binds to 127.0.0.1 only, and makes no
# outbound connections of its own. Only run it on a network you own or have written permission
# to watch. It never needs root to run; sudo is only asked for to install packages or to grant
# packet-capture permission, and you can say no to both.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" && pwd)"   # piped from curl: no file, so "here"
HUGINN_DIR="${HUGINN_HOME:-$HOME/.local/share/huginn}"
IS_TERMUX=0
if [ -n "${TERMUX_VERSION:-}" ] || [[ "${PREFIX:-}" == *com.termux* ]]; then IS_TERMUX=1; fi
if [ "$IS_TERMUX" = 1 ]; then BIN="${PREFIX}/bin"; else BIN="${HUGINN_BIN:-$HOME/.local/bin}"; fi

usage() {
  cat <<'USAGE'
Huginn installer
  curl -fsSL <repo raw url>/install.sh | bash      one-line install
  bash install.sh               install or update, then type:  huginn
  bash install.sh --capture     also allow the live packet view (asks for sudo once)
  bash install.sh --uninstall   remove Huginn (asks before deleting saved data)
  bash install.sh --yes         say yes to installing missing system packages
Options work with the one-liner too:  curl ... | bash -s -- --capture
USAGE
}

MODE=install; YES=0; WANT_CAPTURE=0
for a in "$@"; do
  case "$a" in
    --capture) WANT_CAPTURE=1 ;;
    --capture-only) MODE=capture ;;
    --uninstall) MODE=uninstall ;;
    -y|--yes) YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $a (try --help)"; exit 2 ;;
  esac
done

# ================================================================ helpers
say()  { printf '%s\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m%s\033[0m\n' "$*"; }
die()  { printf '\033[31m%s\033[0m\n' "$*"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
# Is there a terminal we can actually talk to? /dev/tty can exist yet fail to open (no controlling
# terminal: CI, ssh without -t), so try opening it rather than trusting -r.
TTY_OK=0
if (: < /dev/tty) 2>/dev/null; then TTY_OK=1; fi
# Ask a yes/no question on the terminal (works under curl | bash too). No terminal means no.
ask() {
  if [ "$YES" = 1 ]; then return 0; fi
  local reply=""
  if [ "$TTY_OK" = 1 ]; then
    printf '%s [y/N] ' "$1" > /dev/tty 2>/dev/null || true
    read -r reply < /dev/tty 2>/dev/null || true
  fi
  [[ "$reply" =~ ^[Yy] ]]
}

# ================================================================ one-line install (curl | bash)
# Piped from curl, this script has no Huginn folder next to it. Download the repository, unpack
# it to a temporary folder, and run the installer from there with the keyboard reattached (so
# prompts work and nothing reads the rest of the pipe). The real repo and branch are filled in
# when the public kit is built; the source tree leaves them as placeholders.
HUGINN_REPO="${HUGINN_REPO:-Grimjar-Bloodbeard/huginn}"
HUGINN_REF="${HUGINN_REF:-linux-preview}"
if [ ! -d "$SRC/huginn" ] || [ ! -d "$SRC/kit" ]; then
  case "$HUGINN_REPO" in
    __*) die "Run this from the unpacked Huginn folder (the one with huginn/, odin/ and kit/ in it)." ;;
  esac
  url="${HUGINN_TARBALL:-https://github.com/$HUGINN_REPO/archive/refs/heads/$HUGINN_REF.tar.gz}"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT   # any failure before the handoff leaves nothing behind
  say "Downloading Huginn ($HUGINN_REPO, $HUGINN_REF)..."
  if have curl; then curl -fsSL "$url" -o "$tmp/huginn.tar.gz" || die "Download failed: $url"
  elif have wget; then wget -qO "$tmp/huginn.tar.gz" "$url" || die "Download failed: $url"
  else die "Needs curl or wget to download Huginn."; fi
  tar -xzf "$tmp/huginn.tar.gz" -C "$tmp" || die "Couldn't unpack the download."
  dir="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  if [ -z "$dir" ] || [ ! -f "$dir/install.sh" ]; then die "The download didn't contain an installer."; fi
  export HUGINN_BOOTSTRAP_TMP="$tmp"   # the real installer deletes it once the files are copied
  trap - EXIT
  if [ "$TTY_OK" = 1 ]; then exec bash "$dir/install.sh" "$@" < /dev/tty; fi
  exec bash "$dir/install.sh" "$@" < /dev/null
fi
# After a one-line install, remove the temporary download once the files are copied.
if [ -n "${HUGINN_BOOTSTRAP_TMP:-}" ] && [ -f "$HUGINN_BOOTSTRAP_TMP/huginn.tar.gz" ]; then
  trap 'rm -rf "$HUGINN_BOOTSTRAP_TMP"' EXIT
fi

# ================================================================ system packages
PM=""
if [ "$IS_TERMUX" = 1 ]; then PM=pkg
elif have apt-get; then PM=apt
elif have dnf; then PM=dnf
elif have pacman; then PM=pacman
elif have zypper; then PM=zypper
elif have apk; then PM=apk; fi

pkg_names() {   # what to install for: base (node, python, tools) or setcap
  case "$PM:$1" in
    apt:base)    echo "nodejs npm python3 python3-venv python3-pip iproute2 iputils-ping" ;;
    dnf:base)    echo "nodejs npm python3 python3-pip iproute iputils" ;;
    pacman:base) echo "nodejs npm python python-pip iproute2 iputils" ;;
    zypper:base) echo "nodejs npm python3 python3-pip iproute2 iputils" ;;
    apk:base)    echo "nodejs npm python3 py3-pip iproute2 iputils" ;;
    pkg:base)    echo "nodejs python iproute2" ;;
    apt:setcap)  echo "libcap2-bin" ;;
    dnf:setcap|pacman:setcap|apk:setcap) echo "libcap" ;;
    zypper:setcap) echo "libcap-progs" ;;
    *) echo "" ;;
  esac
}
install_pkgs() {
  local names cmd
  names="$(pkg_names "$1")"
  if [ -z "$PM" ] || [ -z "$names" ]; then
    warn "Couldn't work out this system's package manager. Install by hand: Node.js 18+, npm, Python 3 with venv."
    return 1
  fi
  case "$PM" in
    apt)    cmd="sudo apt-get install -y $names" ;;
    dnf)    cmd="sudo dnf install -y $names" ;;
    pacman) cmd="sudo pacman -S --needed --noconfirm $names" ;;
    zypper) cmd="sudo zypper install -y $names" ;;
    apk)    cmd="sudo apk add $names" ;;
    pkg)    cmd="pkg install -y $names" ;;
  esac
  say "Missing system packages. This would run:"
  say "  $cmd"
  if ! ask "Run it now?"; then warn "Run that yourself, then run this installer again."; return 1; fi
  if [ "$PM" = apt ]; then sudo apt-get update -qq || true; fi
  eval "$cmd"
}

# ================================================================ capture permission (Linux)
grant_capture() {
  if [ "$IS_TERMUX" = 1 ]; then
    warn "On a phone, live packet capture needs root, which Termux doesn't have. The map and the Practice drill still work."
    return 0
  fi
  local py
  py="$(readlink -f "$HUGINN_DIR/venv/bin/python3" 2>/dev/null || true)"
  if [ -z "$py" ] || [ ! -f "$py" ]; then die "Huginn's Python isn't installed yet. Run: bash install.sh"; fi
  # Only ever grant this to Huginn's own copy of Python, never the system's (that would hand every
  # Python script on the machine the right to read packets).
  case "$py" in
    "$HUGINN_DIR"/*) ;;
    *) die "Huginn's Python points outside $HUGINN_DIR ($py), so it isn't safe to grant capture to it. Reinstall with: bash install.sh" ;;
  esac
  if ! have setcap; then
    warn "Granting capture needs the 'setcap' tool."
    install_pkgs setcap || return 1
  fi
  say ""
  say "The live packet sparks need permission to read THIS machine's own packets (Linux calls it CAP_NET_RAW)."
  say "This grants it to Huginn's private Python only:  $py"
  say "It does not make Huginn run as root, and it does not put the network card in promiscuous mode."
  if ! ask "Grant it now with sudo?"; then warn "Skipped. Run  huginn capture  any time to do it."; return 0; fi
  sudo setcap cap_net_raw=eip "$py"
  if have getcap && getcap "$py" | grep -q cap_net_raw; then
    ok "Capture allowed. Restart huginn to see the live sparks."
  else
    warn "setcap ran but the permission doesn't show. Some filesystems (or noexec mounts) refuse capabilities."
  fi
}

# ================================================================ modes that don't install
if [ "$(id -u)" = 0 ] && [ "$IS_TERMUX" = 0 ]; then
  warn "You're running this as root. Run it as your normal user instead; it asks for sudo only when it needs to."
  ask "Carry on as root anyway?" || exit 1
fi
if [ "$MODE" = uninstall ]; then
  rm -f "$BIN/huginn"
  say "Removed the huginn command."
  if [ -d "$HUGINN_DIR" ]; then
    if ask "Also delete Huginn and everything it saved (maps, names, permission records) in $HUGINN_DIR? This can't be undone."; then
      rm -rf "${HUGINN_DIR:?}"
      ok "Deleted $HUGINN_DIR."
    else
      say "Kept your data in $HUGINN_DIR."
    fi
  fi
  exit 0
fi
if [ "$MODE" = capture ]; then grant_capture; exit 0; fi

# ================================================================ prerequisites
node_ok() { have node && node -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' 2>/dev/null; }
py_ok()   { have python3 && python3 -c 'import venv, ensurepip' 2>/dev/null; }

say "Huginn installer"
say "  installs to: $HUGINN_DIR"
say "  command:     $BIN/huginn"
say ""
if ! node_ok || ! have npm || ! py_ok; then install_pkgs base || exit 1; fi
if ! node_ok; then
  die "Huginn needs Node.js 18 or newer, and this system has $(node -v 2>/dev/null || echo none).
Install a current Node from https://nodejs.org (or with nvm), then run this again."
fi
py_ok || die "Python 3 with the venv module is needed (Debian/Ubuntu: sudo apt install python3-venv)."
have ping || warn "No 'ping' command: router and internet latency will show as unknown."
have ss   || warn "No 'ss' command (iproute2): Huginn won't be able to name which program owns a connection."

# ================================================================ copy the program
if [ ! -d "$SRC/huginn" ] || [ ! -d "$SRC/odin" ] || [ ! -d "$SRC/kit" ]; then
  die "Run this from the unpacked Huginn folder (the one with huginn/, odin/ and kit/ in it)."
fi
mkdir -p "$HUGINN_DIR" "$BIN"
if [ "$SRC" != "$HUGINN_DIR" ]; then
  # Keep this machine's settings and Odin's map across updates; replace only the program files.
  keep="$(mktemp -d)"
  for f in config.json network_topology.json devices.json devices.router-baseline; do
    if [ -f "$HUGINN_DIR/odin/$f" ]; then cp "$HUGINN_DIR/odin/$f" "$keep/"; fi
  done
  for d in huginn odin kit for-IT; do
    rm -rf "${HUGINN_DIR:?}/$d"
    if [ -d "$SRC/$d" ]; then cp -R "$SRC/$d" "$HUGINN_DIR/$d"; fi
  done
  cp "$SRC/install.sh" "$HUGINN_DIR/install.sh"
  if [ -f "$SRC/README.md" ]; then cp "$SRC/README.md" "$HUGINN_DIR/README.md"; fi
  cp "$keep"/* "$HUGINN_DIR/odin/" 2>/dev/null || true
  rm -rf "$keep"
fi
chmod +x "$HUGINN_DIR/install.sh"
ok "Program files in place."

# ================================================================ Huginn's own Python
# --copies gives Huginn a private Python binary, so capture permission (if you grant it) covers
# only Huginn, not every Python on the machine. Termux doesn't need it (capture isn't possible there).
if [ ! -x "$HUGINN_DIR/venv/bin/python3" ]; then
  say "Setting up Huginn's private Python..."
  if [ "$IS_TERMUX" = 1 ]; then python3 -m venv "$HUGINN_DIR/venv"; else python3 -m venv --copies "$HUGINN_DIR/venv"; fi
fi
"$HUGINN_DIR/venv/bin/python3" -m pip install --quiet --disable-pip-version-check --upgrade pip
"$HUGINN_DIR/venv/bin/python3" -m pip install --quiet --disable-pip-version-check flask zeroconf scapy
ok "Python ready (Flask, zeroconf, scapy)."

# ================================================================ Huginn's Node modules
( cd "$HUGINN_DIR/huginn" && npm install --omit=dev --no-audit --no-fund --loglevel=error >/dev/null )
ok "Node modules ready."

# ================================================================ the huginn command
cat > "$BIN/huginn" <<LAUNCHER
#!/usr/bin/env bash
# Huginn launcher, written by install.sh.  huginn | huginn capture | huginn uninstall | huginn help
HUGINN_DIR="$HUGINN_DIR"
case "\${1:-}" in
  capture)   exec bash "\$HUGINN_DIR/install.sh" --capture-only ;;
  uninstall) exec bash "\$HUGINN_DIR/install.sh" --uninstall ;;
  help|-h|--help)
    echo "huginn            start Huginn (opens http://127.0.0.1:33613)"
    echo "huginn capture    allow the live packet view (sudo, once)"
    echo "huginn uninstall  remove Huginn"
    echo "Files and saved data: \$HUGINN_DIR"
    exit 0 ;;
esac
export HUGINN_PYTHON="\$HUGINN_DIR/venv/bin/python3"
export SITE_NAME="\${HUGINN_SITE_NAME:-my network}"
exec node "\$HUGINN_DIR/kit/start.js" "\$@"
LAUNCHER
chmod +x "$BIN/huginn"
ok "Command installed: $BIN/huginn"

# ================================================================ PATH
case ":$PATH:" in
  *":$BIN:"*) ;;
  *)
    warn "$BIN isn't on your PATH yet, so typing 'huginn' won't find it."
    rc="$HOME/.bashrc"
    if [ "$(basename "${SHELL:-bash}")" = zsh ]; then rc="$HOME/.zshrc"; fi
    if ask "Add it to $rc?"; then
      printf '\n# added by the Huginn installer\nexport PATH="%s:$PATH"\n' "$BIN" >> "$rc"
      ok "Added. Open a new terminal (or run: source $rc)."
    else
      say "Add this line to your shell profile:  export PATH=\"$BIN:\$PATH\""
    fi ;;
esac

if [ "$WANT_CAPTURE" = 1 ]; then grant_capture; fi

say ""
ok "Done. Start it with:  huginn"
case ":$PATH:" in *":$BIN:"*) ;; *) say "(In this terminal, until you open a new one:  $BIN/huginn )" ;; esac
if [ "$IS_TERMUX" = 0 ] && [ "$WANT_CAPTURE" = 0 ]; then say "For the live packet sparks, run once:  huginn capture"; fi
say "Only run Huginn on a network you own or have written permission to watch."
