#!/bin/sh
# inskit installer: adds the plugin to Codex, puts an inskit command on your PATH and checks that it works.
# Source: https://github.com/brunoqgalvao/inskit   Skip the final check with INSKIT_NO_CHECK=1.
set -eu

REPO="brunoqgalvao/inskit"
MARKETPLACE="inskit"
PLUGIN="inskit@inskit"
BIN_DIR="${INSKIT_BIN_DIR:-$HOME/.local/bin}"

find_codex() {
  if command -v codex >/dev/null 2>&1; then command -v codex; return 0; fi
  for p in \
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex" \
    "/Applications/Codex.app/Contents/Resources/codex" \
    "$HOME/.local/bin/codex"; do
    if [ -x "$p" ]; then echo "$p"; return 0; fi
  done
  return 1
}

case "$(uname -s)" in
  Darwin|Linux) ;;
  *) echo "inskit supports macOS and Linux." >&2; exit 1 ;;
esac

CODEX="$(find_codex)" || {
  echo "Codex was not found. Install the Codex app or CLI first: https://developers.openai.com/codex" >&2
  exit 1
}

echo "1/3 Adding the inskit marketplace (downloads about 20 MB from GitHub, up to a minute)..."
LOG="$(mktemp)"
if ! "$CODEX" plugin marketplace add "$REPO" >"$LOG" 2>&1; then
  if ! "$CODEX" plugin marketplace upgrade "$MARKETPLACE" >>"$LOG" 2>&1; then
    grep -qi "already" "$LOG" || { cat "$LOG" >&2; exit 1; }
  fi
fi

echo "2/3 Installing the plugin..."
"$CODEX" plugin add "$PLUGIN"

mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/inskit" <<'SHIM'
#!/bin/sh
# inskit CLI: runs the newest installed plugin's CLI, with the Node that ships with Codex when there is no other.
set -eu
base="${CODEX_HOME:-$HOME/.codex}/plugins/cache/inskit/inskit"
cli=$(ls -d "$base"/*/dist/cli.js 2>/dev/null | sort -V | tail -n 1)
[ -n "$cli" ] || { echo "inskit is not installed. Run: curl -fsSL https://inskit.agenturl.dev/install.sh | sh" >&2; exit 1; }
for n in "${CODEX_MCP_NODE_PATH:-}" /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node "$(command -v node 2>/dev/null || true)"; do
  if [ -n "$n" ] && [ -x "$n" ] && "$n" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null; then
    exec "$n" --no-warnings "$cli" "$@"
  fi
done
echo "inskit needs Node 22.13 or newer. Codex ships one; otherwise install Node from https://nodejs.org" >&2
exit 1
SHIM
chmod +x "$BIN_DIR/inskit"

if [ "${INSKIT_NO_CHECK:-0}" != "1" ]; then
  echo "3/3 Checking that it works (opens example.com in the free cloud browser)..."
  "$BIN_DIR/inskit" check || echo "The check failed; the plugin is installed. Run 'inskit check' again or see https://github.com/$REPO#troubleshooting" >&2
fi

echo
echo "inskit is installed. Restart Codex (or open a new chat), then try:"
echo
echo "  @inskit download my last invoice from my phone carrier"
echo
case ":$PATH:" in
  *":$BIN_DIR:"*) echo "Terminal: inskit status | inskit check --screenshot proof.jpg | inskit cloud status" ;;
  *) echo "Terminal: $BIN_DIR/inskit status  (add $BIN_DIR to your PATH to type just 'inskit')" ;;
esac
echo "Settings live in ~/.instinct/config.json; a free cloud browser is used by default."
