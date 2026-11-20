#!/usr/bin/env bash
#MISE description="Adds the SPDX license header to every TypeScript file that has none, or to the files given. Pass --check to list those files instead"
#MISE hide=true
set -euo pipefail

header='// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT'

check=false
if [[ ${1:-} == --check ]]; then
  check=true
  shift
fi

# The header counts when it sits in the leading block of // comments
has_header() {
  local line
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line == '// SPDX-License-Identifier: '* ]] && return 0
    [[ $line == //* ]] || return 1
  done <"$1"
  return 1
}

missing=()
handle() {
  [[ -f $1 ]] || return 0
  has_header "$1" && return 0
  missing+=("$1")
  [[ $check == true ]] && return 0
  { printf '%s\n\n' "$header" && cat "$1"; } >"$1.tmp"
  mv "$1.tmp" "$1"
}

if (($# > 0)); then
  for file in "$@"; do
    handle "$file"
  done
else
  while IFS= read -r -d '' file; do
    handle "$file"
  done < <(git ls-files -z --cached --others --exclude-standard -- '*.ts')
fi

if [[ $check == true ]] && ((${#missing[@]} > 0)); then
  printf "These files lack the SPDX license header. Run \`mise run fmt\` to add it.\n" >&2
  printf '  %s\n' "${missing[@]}" >&2
  exit 1
fi
