#!/usr/bin/env bash
#MISE description="Installs pi-subagents for the e2e, exports PI_SUBAGENTS_DIR and puts the Pi devDependency and its Node on the CI job's PATH"
#MISE tools={node="24.22.2"}
set -euo pipefail
pi_subagents_version=0.22.0
agent_dir="$RUNNER_TEMP/pi-agent"

PI_CODING_AGENT_DIR="$agent_dir" PI_SKIP_VERSION_CHECK=1 \
  node_modules/.bin/pi install "npm:@tintinweb/pi-subagents@$pi_subagents_version"

printf 'PI_SUBAGENTS_DIR=%s\n' "$agent_dir/npm/node_modules/@tintinweb/pi-subagents" >> "$GITHUB_ENV"
# The pi bin of the devDependency runs on Node
printf '%s\n' "$PWD/node_modules/.bin" "$(dirname "$(command -v node)")" >> "$GITHUB_PATH"
