#!/bin/sh
# Install Joinery (macOS, Apple Silicon) from a GitHub Release tarball.
#
#   curl -fsSL https://raw.githubusercontent.com/szhabolcs/joinery/main/scripts/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --port 8123     pick the server port
#
# The server port is persisted to <data dir>/.port. Without --port, a re-run
# keeps the persisted port; a first install tries 7317, then 3 random ports.
#
# Environment:
#   JOINERY_VERSION          install this version instead of the latest
#   JOINERY_RELEASE_TARBALL  install from a local tarball (skips download)
#   JOINERY_HOME             install home (default ~/.joinery)
#   JOINERY_INSTALL_BIN_DIR  where to symlink `joinery` (default ~/.local/bin)
#   JOINERY_DATA_DIR         data directory (default $JOINERY_HOME/data)
#   JOINERY_PORT             same as --port
#   JOINERY_SKIP_SERVICE=1   don't install the background service
#
# Safe to re-run: it installs the version alongside others and repoints `current`.
set -eu

REPO="szhabolcs/joinery"
HOME_DIR="${JOINERY_HOME:-$HOME/.joinery}"
BIN_DIR="${JOINERY_INSTALL_BIN_DIR:-$HOME/.local/bin}"
DATA_DIR="${JOINERY_DATA_DIR:-$HOME_DIR/data}"
PORT_FILE="$DATA_DIR/.port"
DEFAULT_PORT=7317

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

requested_port="${JOINERY_PORT:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --port) [ $# -ge 2 ] || die "--port needs a number"; requested_port="$2"; shift 2 ;;
    --port=*) requested_port="${1#--port=}"; shift ;;
    *) die "unknown argument: $1 (usage: install.sh [--port <number>])" ;;
  esac
done

valid_port() {
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  [ "$1" -ge 1024 ] && [ "$1" -le 65535 ]
}

# Free, or already held by this install's own Joinery server (a re-run or
# upgrade while the service is up), recognised by answering our bearer token.
port_usable() {
  nc -z 127.0.0.1 "$1" >/dev/null 2>&1 || return 0
  [ -f "$DATA_DIR/token" ] || return 1
  curl -fsS -o /dev/null -m 2 -H "authorization: Bearer $(cat "$DATA_DIR/token")" \
    "http://127.0.0.1:$1/api/version" >/dev/null 2>&1
}

random_port() {
  echo $((20000 + $(od -An -N2 -tu2 /dev/urandom | tr -d ' ') % 20000))
}

retry_hint="re-run with --port <number>, e.g.
  curl -fsSL https://raw.githubusercontent.com/$REPO/main/scripts/install.sh | sh -s -- --port 8123"

[ "$(uname -s)" = "Darwin" ] || die "Joinery only supports macOS for now."
[ "$(uname -m)" = "arm64" ] || die "Joinery only supports Apple Silicon (arm64) for now."

command -v git >/dev/null 2>&1 || warn "git not found on PATH (install Xcode command line tools: xcode-select --install)"
command -v gh >/dev/null 2>&1 || warn "gh not found on PATH (brew install gh && gh auth login)"
command -v claude >/dev/null 2>&1 || warn "claude not found on PATH (install Claude Code and log in)"

if [ -n "$requested_port" ]; then
  valid_port "$requested_port" || die "invalid port: $requested_port (use 1024-65535)"
  port_usable "$requested_port" || die "port $requested_port is already in use; $retry_hint"
  port="$requested_port"
else
  port="$DEFAULT_PORT"
  if [ -f "$PORT_FILE" ] && valid_port "$(cat "$PORT_FILE")"; then port="$(cat "$PORT_FILE")"; fi
  if ! port_usable "$port"; then
    tried="$port"
    port=""
    for _ in 1 2 3; do
      candidate="$(random_port)"
      if port_usable "$candidate"; then port="$candidate"; break; fi
      tried="$tried, $candidate"
    done
    [ -n "$port" ] || die "could not find a free port (tried $tried); $retry_hint"
    say "Port ${tried%%,*} is in use; using $port instead."
  fi
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

if [ -n "${JOINERY_RELEASE_TARBALL:-}" ]; then
  tarball="$JOINERY_RELEASE_TARBALL"
  [ -f "$tarball" ] || die "no such file: $tarball"
  say "Using local tarball $tarball"
else
  version="${JOINERY_VERSION:-}"
  if [ -z "$version" ]; then
    say "Looking up the latest release..."
    version="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
      | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1)"
    [ -n "$version" ] || die "could not determine the latest release"
  fi
  version="${version#v}"
  asset="joinery-$version-darwin-arm64.tar.gz"
  url="https://github.com/$REPO/releases/download/v$version/$asset"
  say "Downloading Joinery $version..."
  curl -fsSL -o "$tmp/$asset" "$url" || die "download failed: $url"
  curl -fsSL -o "$tmp/$asset.sha256" "$url.sha256" || die "download failed: $url.sha256"
  expected="$(awk '{print $1}' "$tmp/$asset.sha256")"
  actual="$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')"
  [ "$expected" = "$actual" ] || die "sha256 mismatch (expected $expected, got $actual)"
  tarball="$tmp/$asset"
fi

# Extract next to the final location, then rename, so the swap is atomic.
mkdir -p "$HOME_DIR/versions"
staging="$(mktemp -d "$HOME_DIR/versions/.staging-XXXXXX")"
trap 'rm -rf "$tmp" "$staging"' EXIT INT TERM
tar -xzf "$tarball" -C "$staging"
[ -f "$staging/release.json" ] || die "tarball has no release.json"
installed="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$staging/release.json" | head -n 1)"
[ -n "$installed" ] || die "could not read the version from release.json"
rm -rf "$HOME_DIR/versions/$installed"
mv "$staging" "$HOME_DIR/versions/$installed"

ln -sfn "versions/$installed" "$HOME_DIR/.current-new"
mv -fh "$HOME_DIR/.current-new" "$HOME_DIR/current"

mkdir -p "$BIN_DIR"
ln -sfn "$HOME_DIR/current/joinery" "$BIN_DIR/joinery"
say "Installed Joinery $installed to $HOME_DIR"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on your PATH. Add this to your shell profile:
    export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

mkdir -p "$DATA_DIR"
printf '%s\n' "$port" > "$PORT_FILE"

if [ "${JOINERY_SKIP_SERVICE:-}" = "1" ]; then
  say "Skipping service install (JOINERY_SKIP_SERVICE=1)."
else
  JOINERY_HOME="$HOME_DIR" "$HOME_DIR/current/joinery" service install
  say ""
  say "Joinery is running at http://127.0.0.1:$port"
fi
say "  joinery open     open the web UI"
say "  joinery update   update to the latest release"
