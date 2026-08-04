#!/usr/bin/env bash
set -euo pipefail

skill_name="${1:-}"
git_ref="${2:-main}"

if [[ ! "$skill_name" =~ ^[a-z0-9-]+$ ]]; then
  echo "usage: $0 <skill-name> [git-ref]" >&2
  exit 2
fi

if [[ ! "$git_ref" =~ ^[A-Za-z0-9._/-]+$ ]]; then
  echo "invalid git ref: $git_ref" >&2
  exit 2
fi

command -v git >/dev/null 2>&1 || {
  echo "git is required to fetch trailofbits/skills" >&2
  exit 1
}

checkout_root="$(mktemp -d "${TMPDIR:-/tmp}/trailofbits-skills.XXXXXX")"
checkout_path="$checkout_root/repository"

git clone --quiet --depth 1 --no-checkout \
  https://github.com/trailofbits/skills.git "$checkout_path"
git -C "$checkout_path" fetch --quiet --depth 1 origin "$git_ref"
git -C "$checkout_path" checkout --quiet --detach FETCH_HEAD

matches=()
while IFS= read -r path; do
  matches+=("$path")
done < <(find "$checkout_path/plugins" -type f -path "*/skills/$skill_name/SKILL.md" -print)

if [[ "${#matches[@]}" -ne 1 ]]; then
  echo "expected one upstream skill named '$skill_name'; found ${#matches[@]}" >&2
  exit 1
fi

printf 'checkout=%s\n' "$checkout_path"
printf 'commit=%s\n' "$(git -C "$checkout_path" rev-parse HEAD)"
printf 'skill=%s\n' "${matches[0]}"
