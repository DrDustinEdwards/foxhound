#!/usr/bin/env bash
# Blocks any Write or Edit whose incoming content carries an em dash or en dash.
#
# Canon: capsid/conventions.md, no em dashes anywhere, including code, copy,
# comments, and commit messages.
#
# Why PreToolUse and not PostToolUse: a PostToolUse hook fires after the write has
# already landed. Exit 2 there does not undo anything, it only surfaces stderr to
# the model. PreToolUse plus exit 2 is the only combination that actually blocks the
# tool call. (The older foxing hook is PostToolUse on exit 1, which is a logged
# warning and enforces nothing.)
#
# The dash characters are built from their UTF-8 bytes rather than typed literally,
# so this file passes its own rule and does not trip the grep on itself. printf
# '\xNN' works on bash 3.2, which is what macOS ships; the '\uNNNN' form does not.
set -uo pipefail

input=$(cat)

# Write sends tool_input.content; Edit sends tool_input.new_string. Check both.
payload=$(printf '%s' "$input" | jq -r '[.tool_input.content, .tool_input.new_string] | map(select(. != null)) | add // ""' 2>/dev/null)
[ -z "$payload" ] && exit 0

em=$(printf '\xe2\x80\x94')
en=$(printf '\xe2\x80\x93')

if printf '%s' "$payload" | grep -q -e "$em" -e "$en"; then
  file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // "this file"' 2>/dev/null)
  {
    echo "Blocked: an em dash or en dash is present in the content for $file."
    echo "Canon (capsid/conventions.md): no em dashes anywhere, including code, copy, comments, and commit messages."
    echo "Use a comma, a colon, parentheses, or split the sentence. Then retry the write."
  } >&2
  exit 2
fi

exit 0
