#!/bin/bash
# Kanban demo terminal: imitates a coding agent's choice dialog (Claude Code's question dialog) and waits for one key.
# The OSC 7501 message must be base64.
q='Deploy the change to staging now?'
msg=$(printf 'answer: %s (Yes, deploy now · Wait until tomorrow)' "$q" | base64 | tr -d '\n')
printf '\033]7501;state=blocked:kind=question:msg=%s\007' "$msg"
printf '⏺ The changes are done and the tests pass.\n'
printf '─────────────────────────────────────\n ☐ Deploy\n%s\n' "$q"
printf '❯ 1. Yes, deploy now\n     The change goes to staging right away.\n  2. Wait until tomorrow\n     It is deployed at 8:00 tomorrow.\n  3. Type something.\n'
printf '─────────────────────────────────────\n  4. Chat about this\nEnter to select · ↑/↓ to navigate · Esc to cancel\n'
IFS= read -r -n 1 c
printf '\033]7501;state=working\007'
if [ "$c" = "3" ]; then IFS= read -r t; printf '\nTyped: %s\n' "$t"; else printf '\nPicked: %s\n' "$c"; fi
printf '\033]7501;state=idle\007'
sleep 3600
