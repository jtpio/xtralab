#!/usr/bin/env bash
# Start xtralab in a folder with uvx, wait for the server, and print its URL.
# Usage: open.sh [--upgrade] [directory]
set -euo pipefail

upgrade=0
dir=""
for arg in "$@"; do
  case "$arg" in
    --upgrade) upgrade=1 ;;
    -*)
      echo "usage: open.sh [--upgrade] [directory]" >&2
      exit 2
      ;;
    *) dir="$arg" ;;
  esac
done

dir="${dir:-$PWD}"
if [ ! -d "$dir" ]; then
  echo "error: not a folder: $dir" >&2
  exit 1
fi
dir="$(cd "$dir" && pwd -P)"

if ! command -v uvx >/dev/null 2>&1; then
  echo "error: uv is not installed. See https://docs.astral.sh/uv/getting-started/installation/" >&2
  exit 1
fi

from="xtralab"
if [ "$upgrade" = 1 ]; then
  from="xtralab@latest"
fi

# Reuse the server that already serves this folder instead of starting a second one.
here="$(cd "$(dirname "$0")" && pwd)"
existing="$(uvx --from "$from" python "$here/find_server.py" "$dir" 2>/dev/null)"
if [ -n "$existing" ]; then
  port="$(printf '%s' "$existing" | sed -n 's|^http://[^:]*:\([0-9]*\)/.*|\1|p')"
  printf 'xtralab is already running for this folder.\n'
  printf '  URL:     %s\n' "$existing"
  printf '  Folder:  %s\n' "$dir"
  printf '  Stop:    uvx --from xtralab jupyter-lab stop %s\n' "$port"
  exit 0
fi

log="${TMPDIR:-/tmp}/xtralab-$(date +%Y%m%d-%H%M%S)-$$.log"
nohup uvx --from "$from" jupyter-lab "$dir" >"$log" 2>&1 </dev/null &
pid=$!

# The first run downloads xtralab, so allow several minutes.
url=""
for _ in $(seq 1 600); do
  url="$(grep -o -m1 'http://localhost:[0-9]*/lab[^ ]*' "$log" 2>/dev/null || true)"
  if [ -n "$url" ]; then
    break
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "error: xtralab stopped before it printed a URL. Log: $log" >&2
    tail -n 20 "$log" >&2
    exit 1
  fi
  sleep 1
done
if [ -z "$url" ]; then
  echo "error: xtralab did not start in 10 minutes. Log: $log" >&2
  exit 1
fi

port="$(printf '%s' "$url" | sed -n 's|^http://[^:]*:\([0-9]*\)/.*|\1|p')"
printf 'xtralab is running.\n'
printf '  URL:     %s\n' "$url"
printf '  Folder:  %s\n' "$dir"
printf '  Log:     %s\n' "$log"
printf '  Stop:    uvx --from xtralab jupyter-lab stop %s\n' "$port"
