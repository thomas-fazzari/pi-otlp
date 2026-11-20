#!/usr/bin/env bash
#MISE description="Checks a commit message file against the commit rules."
#MISE hide=true
set -euo pipefail

types='fix|feat|test|style|docs|build|ops|chore|perf|refactor'
title_pattern="^($types)(\([a-z0-9-]+\))?!?: [^A-Z[:space:]]"
max_length=50

# Git appends the diff below this line with `commit --verbose`
subject=
has_subject=false
has_body=false
while IFS= read -r line || [[ -n $line ]]; do
  [[ $line =~ ^#\ -+\ \>8\ -+$ ]] && break
  [[ $line == \#* ]] && continue
  if [[ $has_subject == false ]]; then
    subject=$line
    has_subject=true
  elif [[ $line =~ [^[:space:]] ]]; then
    has_body=true
  fi
done <"$1"

# Git writes these itself, and a squash merge takes its title from the pull request
[[ $subject =~ ^(Merge|Revert|fixup!|squash!)\  ]] && exit 0

if ! [[ $subject =~ $title_pattern ]]; then
  printf "Start the commit message with a type (%s), an optional (scope), then ': ', in lowercase. Add ! before ':' for a breaking change.\n" "$types" >&2
  exit 1
fi

if ((${#subject} > max_length)); then
  printf 'Keep the first line within %d characters. It has %d.\n' "$max_length" "${#subject}" >&2
  exit 1
fi

if [[ $has_body == true ]]; then
  printf 'Write only a title. Put the description and any trailer in the pull request.\n' >&2
  exit 1
fi
