#!/usr/bin/env bash
#MISE description="Publishes the npm package at VERSION, such as VERSION=0.1.0, from committed files, and leaves package.json unchanged"
#MISE tools={node="24.22.2"}
#USAGE flag "--dry-run" help="Runs npm publish --dry-run, which uploads nothing and accepts uncommitted files"
set -euo pipefail
dry_run="${usage_dry_run:-false}"

if [[ ! "${VERSION:-}" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  printf 'Set VERSION to a release version such as 0.1.0.\n' >&2
  exit 1
fi
name="$(node -p 'require("./package.json").name')"

# A version published by hand must not fail the npm job of its tag
if [[ "$(npm view "$name@$VERSION" version 2>/dev/null)" == "$VERSION" ]]; then
  printf '%s@%s is already on npm, so there is nothing to publish.\n' "$name" "$VERSION"
  exit 0
fi

if [[ "$dry_run" != true ]]; then
  if [[ -n "$(git status --porcelain -- src package.json README.md LICENSE)" ]]; then
    printf 'Commit or remove the changes to the package files before you publish.\n' >&2
    exit 1
  fi
fi

backup="$(mktemp)"
cp package.json "$backup"
trap 'cp "$backup" package.json && rm -f "$backup"' EXIT
npm pkg set "version=$VERSION"

if [[ "$dry_run" == true ]]; then
  npm publish --dry-run
  exit
fi
npm publish
