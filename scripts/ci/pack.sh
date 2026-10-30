#!/usr/bin/env bash
#MISE description="Packs the npm package, checks its file list and loads the tarball in a headless Pi"
#MISE tools={node="24.22.2"}
set -euo pipefail
# Nothing listens there, so the check sends no telemetry to a local otel-lgtm
unreachable_endpoint=http://127.0.0.1:9
pi="$PWD/node_modules/.bin/pi"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
tarball="$work/$(npm pack --silent --pack-destination "$work")"

expected="$({
  printf '%s\n' LICENSE README.md package.json
  git ls-files src
} | sort)"
actual="$(tar -tzf "$tarball" | sed 's|^package/||' | sort)"
if [[ $actual != "$expected" ]]; then
  printf 'The package must hold LICENSE, README.md, package.json and the tracked files of src only:\n' >&2
  diff <(printf '%s\n' "$expected") <(printf '%s\n' "$actual") >&2 || true
  exit 1
fi
printf '%s\n' "$actual"

export PI_CODING_AGENT_DIR="$work/agent"
export PI_SKIP_VERSION_CHECK=1
export OTEL_EXPORTER_OTLP_ENDPOINT="$unreachable_endpoint"
name="$(node -p 'require("./package.json").name')"
# Pi finds an installed npm package by the name in its source, so a bare tarball path installs but never loads
"$pi" install "npm:$name@file:$tarball"
if ! grep -q "node_modules/$name\$" <<<"$("$pi" list)"; then
  printf 'Pi did not resolve the installed %s.\n' "$name" >&2
  exit 1
fi

# Outside the repository, so that Pi loads no project extension
cd "$work"
if ! output="$(printf '{"type":"get_state","id":"1"}\n' | "$pi" --mode rpc --offline --no-session)"; then
  printf 'Pi failed to start:\n%s\n' "$output" >&2
  exit 1
fi
if grep -q '"type":"extension_error"' <<<"$output"; then
  printf 'Pi reported an extension error:\n%s\n' "$output" >&2
  exit 1
fi
printf 'Pi loaded %s from %s with no extension error.\n' "$name" "$(basename "$tarball")"
