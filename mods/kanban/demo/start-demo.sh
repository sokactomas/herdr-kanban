#!/bin/sh
# Puts one DEMO card in every column of the Kanban board. Every terminal is labelled team.demo=1 (title "DEMO · …",
# dropped from the board once it ends) and keyed kanban-demo-…. The scripts only print and read; they touch no files.
# Usage: start-demo.sh [project folder]   (default: the current folder; pick a folder of an open Herdr space so the
# cards show that project's name). Stop with stop-demo.sh.
set -e
D=$(cd "$(dirname "$0")" && pwd)
P=${1:-$PWD}
r() { n=$1; shift; hc run --json --bg --no-parent --no-notify --name "$n" --cwd "$P" --label team.demo=1 "$@" >/dev/null && echo "started $n"; }
lead() { k=$1; shift; r "kanban-demo-$k-lead" --label "team=kanban-demo-$k" --label team.lead=1 "$@"; }
help() { k=$1; role=$2; shift 2; r "kanban-demo-$k-$role" --label "team=kanban-demo-$k" --label "role=$role" "$@"; }
lead a --label "team.goal=Add a price filter to the product list" --label team.phase=intake -- "$D/demo.sh" "" "Reading the task…"
lead b --label "team.goal=Find out why search is slow" --label team.phase=plan --label team.dir=/tmp/kanban-demo-b -- "$D/demo.sh" idle
help b researcher --label "team.task=Read the search code and the logs" --label team.model=demo --label team.effort=medium -- "$D/demo.sh" working
lead c --label "team.goal=Send a reminder email before a trial ends" --label team.phase=build --label team.dir=/tmp/kanban-demo-c -- "$D/demo.sh" idle
help c backend --label "team.task=Schedule the reminder job" --label team.model=demo --label team.effort=high -- "$D/demo.sh" working
lead d --label "team.goal=Fix the logout button on mobile" --label team.phase=review --label team.dir=/tmp/kanban-demo-d -- "$D/demo.sh" idle
help d critic --label "team.task=Review the logout fix" --label team.model=demo --label team.effort=high -- "$D/demo.sh" working
lead e --label "team.goal=Update the cookie banner texts" --label team.phase=build --label team.dir=/tmp/kanban-demo-e -- "$D/demo.sh" idle
help e frontend --label "team.task=Change the banner texts and deploy" --label team.model=demo --label team.effort=medium -- "$D/dialog.sh"
lead f --label "team.goal=New footer links to the help pages" --label team.phase=integrate --label team.dir=/tmp/kanban-demo-f \
  --label team.approval=1 --label "team.summary=The footer has three new links to the help pages. Check that they open the right pages on mobile and desktop." \
  -- "$D/demo.sh" idle "Ready for your approval"
lead g --label "team.goal=Translate the contact form" --label team.phase=done --label team.dir=/tmp/kanban-demo-g \
  --label "team.summary=The contact form is translated; all labels and error messages were checked." -- "$D/demo.sh" idle "Done"
lead i --label "team.goal=Move the newsletter signup to the home page" --label team.phase=build --label team.dir=/tmp/kanban-demo-i \
  -- "$D/demo.sh" idle "⏺ The signup form is ready on a test branch." "⏺ Should I move it to the mobile layout too, or only desktop?"
