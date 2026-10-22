#!/bin/sh
# Fail if a commit or the tree contains a home path, a non-local IP, an email, or a token.
# This script is excluded from the scan so its own patterns are not matches.

set -eu

root=$(git rev-parse --show-toplevel)
cd "$root"

if [ "${1:-}" = "--cached" ]; then
  files=$(git diff --cached --name-only --diff-filter=ACMR)
else
  files=$(git ls-files)
fi

if [ -z "$files" ]; then
  exit 0
fi

pattern='(/Users/[A-Za-z0-9._-]+|/home/[A-Za-z0-9._-]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|100\.[0-9]+\.[0-9]+\.[0-9]+|192\.168\.[0-9]+\.[0-9]+|(^|[^A-Za-z0-9])(hf_[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9]{8,}|msy_[A-Za-z0-9]{8,}))'

found=0
printf '%s\n' "$files" | while IFS= read -r file; do
  [ -f "$file" ] || continue
  case "$file" in
    scripts/check-no-personal.sh|.github/workflows/no-personal-data.yml) continue ;;
  esac
  if grep -nE "$pattern" "$file" >/dev/null 2>&1; then
    echo "personal data or a secret matched in $file:" >&2
    grep -nE "$pattern" "$file" >&2 || true
    echo "block" >> "$root/.git/check-no-personal.fail"
  fi
done

if [ -f "$root/.git/check-no-personal.fail" ]; then
  rm -f "$root/.git/check-no-personal.fail"
  echo "Commit blocked. Replace home paths, the tailnet address, emails, and tokens with placeholders." >&2
  exit 1
fi
