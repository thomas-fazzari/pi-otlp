#!/usr/bin/env bash
#MISE description="Exports VERSION to the CI job from a release tag such as v1.2.3"
set -euo pipefail

if [[ "$GITHUB_REF_TYPE" != tag ]]; then
  printf 'Expected a tag build, not a %s build.\n' "$GITHUB_REF_TYPE" >&2
  exit 1
fi
if [[ ! "$GITHUB_REF_NAME" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  printf 'Expected a version tag such as v1.2.3, not %s.\n' "$GITHUB_REF_NAME" >&2
  exit 1
fi
printf 'VERSION=%s\n' "${GITHUB_REF_NAME#v}" >> "$GITHUB_ENV"
