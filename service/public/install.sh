#!/bin/sh
# inskit installer: adds the plugin to Codex. Source: https://github.com/brunoqgalvao/inskit
set -eu

REPO="brunoqgalvao/inskit"
MARKETPLACE="inskit"
PLUGIN="inskit@inskit"

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

echo "Adding the inskit marketplace..."
if ! "$CODEX" plugin marketplace add "$REPO" >/dev/null 2>&1; then
  "$CODEX" plugin marketplace upgrade "$MARKETPLACE" >/dev/null 2>&1 || true
fi

echo "Installing the plugin..."
"$CODEX" plugin add "$PLUGIN"

cat <<'EOF'

inskit is installed. Restart Codex, then try:

  @inskit download my last invoice from my phone carrier

The first task sets everything up. A free cloud browser is used by default;
settings live in ~/.instinct/config.json.
EOF
