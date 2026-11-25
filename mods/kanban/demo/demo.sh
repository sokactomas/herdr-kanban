#!/bin/sh
# Kanban demo terminal: reports a status (OSC 7501), prints its lines, then echoes whatever is sent to it.
# Usage: demo.sh <state: idle|working|done|""> [line…]
st="$1"; shift
[ -n "$st" ] && printf '\033]7501;state=%s\007' "$st"
for l in "$@"; do printf '%s\n' "$l"; done
while IFS= read -r line; do printf 'Received: %s\n' "$line"; done
sleep 3600
