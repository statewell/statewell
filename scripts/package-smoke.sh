#!/usr/bin/env bash
# Check the local package with disposable installation and data directories.
set -euo pipefail

project_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
bun_binary=${STATEWELL_BUN:-$(command -v bun || true)}
if [[ -z "$bun_binary" ]]; then
  bun_binary=/tmp/statewell-bun-storage-prototype/tooling/node_modules/.bin/bun
fi
if [[ ! -x "$bun_binary" || ! -x "$project_dir/dist/statewell" ]]; then
  printf '%s\n' 'Build dist/statewell first. Set STATEWELL_BUN if Bun is not available.' >&2
  exit 1
fi
bun_binary=$(realpath -- "$bun_binary")
node_binary=$(command -v node)
npm_binary=$(command -v npm)
smoke_dir=$(mktemp -d /tmp/statewell-package-smoke-XXXXXXXX)
smoke_state=
cleanup() {
  [[ -z "$smoke_state" ]] || rm -rf -- "$smoke_state"
  rm -rf -- "$smoke_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
smoke_state=$(mktemp -d /dev/shm/statewell-package-smoke-XXXXXXXX)
mkdir -- "$smoke_dir/home" "$smoke_dir/install" "$smoke_dir/cache" "$smoke_dir/tmp"
smoke_path="$(dirname -- "$node_binary"):$(dirname -- "$bun_binary"):/usr/local/bin:/usr/bin:/bin"
smoke_env=(env -i "HOME=$smoke_dir/home" "PATH=$smoke_path" "TMPDIR=$smoke_dir/tmp" LANG=C.UTF-8)
npm_env=("${smoke_env[@]}" "npm_config_cache=$smoke_dir/cache" "npm_config_userconfig=$smoke_dir/user.npmrc" "npm_config_globalconfig=$smoke_dir/global.npmrc")

cd -- "$project_dir"
"${npm_env[@]}" "$npm_binary" pack --ignore-scripts --offline --json --pack-destination "$smoke_dir" > "$smoke_dir/pack.json"
archive=$("${smoke_env[@]}" "$node_binary" --input-type=module - "$smoke_dir" <<'JS'
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const directory = process.argv[2];
const records = JSON.parse(readFileSync(join(directory, 'pack.json'), 'utf8'));
if (records.length !== 1 || !/^[a-zA-Z0-9._-]+\.tgz$/.test(records[0].filename)) {
  throw new Error('The package archive name is not valid.');
}
const archive = join(directory, records[0].filename);
const allowed = new Set(['package/package.json', 'package/dist/statewell', 'package/docs/INSTANCE-CLI.md', 'package/README.md']);
const members = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
if (members.length !== allowed.size || new Set(members).size !== allowed.size || members.some(name => !allowed.has(name))) {
  throw new Error('The package contains missing or unexpected files.');
}
const details = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8' }).trim().split('\n');
if (details.some(line => !line.startsWith('-'))) throw new Error('The package contains a link or a special file.');
console.error('Checked archive files: ' + members.join(', '));
console.log(archive);
JS
)
"${npm_env[@]}" "$npm_binary" install "$archive" --prefix "$smoke_dir/install" --offline --ignore-scripts --omit=dev --no-audit --no-fund
installed_binary="$smoke_dir/install/node_modules/.bin/statewell"
[[ -x "$installed_binary" ]]
cmp -- "$project_dir/dist/statewell" "$installed_binary"
"${smoke_env[@]}" "STATEWELL_HOME=$smoke_state" "STATEWELL_TEST_BINARY=$installed_binary" \
  "$bun_binary" test tests/instances.test.ts --timeout 15000
