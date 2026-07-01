#!/bin/sh
# Symlink (or copy) this skill into your Claude Code skills directory.
# Re-run after moving the repo. On Linux/macOS/WSL a git pull keeps it current.
set -e

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
DEST="$DEST_DIR/rizzdev-detective"

mkdir -p "$DEST_DIR"

if [ -L "$DEST" ] || [ -e "$DEST" ]; then
  rm -rf "$DEST"
fi

if ln -s "$SRC" "$DEST" 2>/dev/null; then
  echo "linked  rizzdev-detective -> $DEST"
else
  cp -R "$SRC" "$DEST"
  echo "copied  rizzdev-detective -> $DEST (symlink not permitted; re-run after each pull)"
fi

echo "Done. Restart Claude Code (or /reload-skills) to pick up the skill."
