#!/bin/bash
# Double-click this file to collect about 1000 real photos (only their links) into bank.json.
# It takes a while. You can close the window any time; next time it carries on.
cd "$(dirname "$0")"
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
node build-bank.js 1000
echo
read -n 1 -s -r -p "Press any key to close this window"
