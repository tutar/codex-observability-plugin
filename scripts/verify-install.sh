#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--" ]]; then
  shift
fi

ref="${1:-}"
if [[ -z "$ref" ]]; then
  echo "usage: pnpm run verify:install -- <tag-or-full-commit>" >&2
  exit 2
fi

release_json="$(node scripts/verify-release.mjs --json)"
expected_version="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).version)' "$release_json")"
expected_digest="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).bundleSha256)' "$release_json")"
expected_hook="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).hookIdentity)' "$release_json")"
verification_home="$(mktemp -d /tmp/codex-plugin-install.XXXXXX)"
trap 'rm -rf "$verification_home"' EXIT

marketplace_json="$(
  CODEX_HOME="$verification_home" codex plugin marketplace add \
    tutar/codex-observability-plugin --ref "$ref" --json
)"
marketplace_name="$(
  node -e 'process.stdout.write(JSON.parse(process.argv[1]).marketplaceName)' "$marketplace_json"
)"
install_json="$(
  CODEX_HOME="$verification_home" codex plugin add "tracing@$marketplace_name" --json
)"
installed_root="$(
  node -e 'process.stdout.write(JSON.parse(process.argv[1]).installedPath)' "$install_json"
)"

node scripts/verify-installed-plugin.mjs \
  "$installed_root" "$expected_version" "$expected_digest" "$expected_hook"
