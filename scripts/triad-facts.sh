#!/bin/sh
# Read-only facts for triad-check: installed Keel version + content hash, routing.json presence,
# Cindy version, Keel checkout HEAD. Same script runs locally and (via cindy_ssh) remotely.
B=$(ls -d "$HOME/Library/Application Support/Cindy/owners/"*/cindy-brain/keel 2>/dev/null | head -1)
R="$HOME/AI-Agent/Claude/capabilities/source/skills/claude-active/orca-fanout/routing.json"
P="$HOME/AI-Agent/Claude/projects/Project Keel"
if [ -n "$B" ]; then
  V=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$B/ghost.json" | head -1)
  H=$(cd "$B" && find . -type f ! -name .cindy-trust.json ! -name '.DS_Store' | LC_ALL=C sort | xargs -I{} shasum -a 256 "{}" | shasum -a 256 | cut -c1-64)
else V=; H=; fi
RS=$( [ -f "$R" ] && shasum -a 256 "$R" | cut -c1-64 )
CV=$(defaults read /Applications/Cindy.app/Contents/Info.plist CFBundleShortVersionString 2>/dev/null)
KH=$( [ -d "$P/.git" ] && git -C "$P" rev-parse --short HEAD 2>/dev/null )
printf '{"host":"%s","keel_version":"%s","keel_content_sha256":"%s","routing_sha256":"%s","cindy_version":"%s","checkout_head":"%s"}\n' "$(hostname -s)" "$V" "$H" "$RS" "$CV" "$KH"
