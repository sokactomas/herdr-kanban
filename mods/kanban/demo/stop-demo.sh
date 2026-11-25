#!/bin/sh
# Ends and removes every kanban-demo-* terminal; the board drops their cards once they are gone.
names=$(hc ls --all --json | grep -o '"name":"kanban-demo-[^"]*"' | cut -d'"' -f4 | sort -u)
for n in $names; do hc kill "$n" >/dev/null 2>&1; hc rm "$n" >/dev/null 2>&1; done
echo "removed: $(echo "$names" | grep -c . || true), left: $(hc ls --all --json | grep -o '"name":"kanban-demo-' | wc -l | tr -d ' ')"
