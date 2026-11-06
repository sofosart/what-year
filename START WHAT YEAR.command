#!/bin/bash
# Double-click this file to play WHAT YEAR? on this computer (to test it before it goes online)
cd "$(dirname "$0")"
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
lsof -ti:3200 | xargs kill -9 2>/dev/null
node server.js
