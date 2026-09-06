#!/usr/bin/env bash
set -euo pipefail

project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd -- "$project_dir"

case "${1:-}" in
  --help|-h)
    echo "Usage: start-t3-planning.sh [--mtplx]"
    echo "Starts T3 Planning with checkout-local state in .t3."
    echo "--mtplx enables OpenCode with the local MTPLX model."
    exit 0
    ;;
  --mtplx)
    shift
    exec "$project_dir/scripts/start-mtplx.sh" "$@"
    ;;
esac
[[ $# == 0 ]] || { echo "Unexpected arguments. Use --help." >&2; exit 2; }
command -v vp >/dev/null || { echo "Install Vite+ (vp) first." >&2; exit 1; }
[[ -d node_modules ]] || { echo "Run 'vp i' in $project_dir first." >&2; exit 1; }

echo "Starting T3 Planning. Use the URL printed below; press Ctrl+C to stop."
exec vp run dev --home-dir "$project_dir/.t3"
