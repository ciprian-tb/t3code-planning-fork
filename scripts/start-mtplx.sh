#!/usr/bin/env bash
# Start T3 with OpenCode configured for MTPLX, or OpenCode directly.
set -euo pipefail

if [[ "${1:-}" == --help ]]; then
  cat <<'HELP'
Usage: start-mtplx.sh [--opencode [PROJECT_DIR]]
Default: start this checkout's T3 dev app (run `vp i` in it first).
--opencode: launch OpenCode CLI in PROJECT_DIR, or the current directory.
Environment: MTPLX_PORT (8000), MTPLX_MODEL (optional local path/HF model),
MTPLX_START_TIMEOUT (300 seconds). Uses a local server without API-key auth.
Reuses a responding server; otherwise starts MTPLX and stops that process on exit.
OpenCode configuration is temporary; global configuration is not rewritten.
HELP
  exit 0
fi

mode=t3
project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
if [[ "${1:-}" == --opencode ]]; then
  mode=opencode
  shift
  project_dir=${1:-$PWD}
  if [[ $# -gt 0 ]]; then shift; fi
fi
[[ $# == 0 ]] || { echo "Unexpected arguments. Use --help." >&2; exit 2; }
cd -- "$project_dir"
for tool in mtplx opencode curl python3; do
  command -v "$tool" >/dev/null || { echo "Missing executable: $tool" >&2; exit 1; }
done
if [[ "$mode" == t3 ]]; then
  command -v vp >/dev/null || { echo "Install Vite+ (vp) first." >&2; exit 1; }
  [[ -d node_modules ]] || { echo "Run 'vp i' in $project_dir first." >&2; exit 1; }
fi
# Inline config outranks the temporary file and could silently redirect MTPLX.
[[ -z "${OPENCODE_CONFIG_CONTENT:-}" ]] || {
  echo "Unset OPENCODE_CONFIG_CONTENT for this launcher; it overrides file config." >&2
  exit 1
}
port=${MTPLX_PORT:-8000}
timeout=${MTPLX_START_TIMEOUT:-300}
[[ "$port" =~ ^[0-9]{1,5}$ && "$timeout" =~ ^[0-9]{1,5}$ ]] || {
  echo "Port and timeout must be positive integers." >&2; exit 2;
}
port=$((10#$port))
timeout=$((10#$timeout))
((port > 0 && port < 65536 && timeout > 0)) || exit 2

scratch=$(mktemp -d "${TMPDIR:-/tmp}/t3-mtplx.XXXXXX")
server_pid=
app_pid=
cleanup() {
  if [[ -n "$app_pid" ]]; then
    kill "$app_pid" 2>/dev/null || true
    wait "$app_pid" 2>/dev/null || true
  fi
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf -- "$scratch"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
models() { curl --noproxy '*' -fsS --max-time 3 "http://127.0.0.1:$port/v1/models"; }
if ! models > "$scratch/models.json" 2>/dev/null; then
  args=(quickstart --host 127.0.0.1 --port "$port" --profile sustained --no-stats-footer)
  if [[ -n "${MTPLX_MODEL:-}" ]]; then args+=(--model "$MTPLX_MODEL"); fi
  mtplx "${args[@]}" > "$scratch/server.log" 2>&1 &
  server_pid=$!
  echo "Waiting for MTPLX on port $port..."
  deadline=$((SECONDS + timeout))
  until models > "$scratch/models.json" 2>/dev/null; do
    if ! kill -0 "$server_pid" 2>/dev/null || ((SECONDS >= deadline)); then
      cat "$scratch/server.log" >&2
      echo "MTPLX did not become ready within the startup window." >&2
      exit 1
    fi
    sleep 1
  done
fi
model_id=$(python3 - "$scratch/models.json" <<'PY'
import json, sys
models = json.load(open(sys.argv[1])).get("data", [])
if not models or not isinstance(models[0].get("id"), str) or not models[0]["id"].strip():
    sys.exit("The local server returned no model ID.")
print(models[0]["id"])
PY
)
export MTPLX_OPENCODE_CONFIG="$scratch/opencode.json"
mtplx connect opencode --host 127.0.0.1 --port "$port" --model-id "$model_id" --json > "$scratch/connect.json"
# Older MTPLX releases only print config; newer releases also write it.
python3 - "$scratch/connect.json" "$MTPLX_OPENCODE_CONFIG" <<'PY'
import json, sys
config = json.load(open(sys.argv[1]))["config"]
if not isinstance(config, dict) or "mtplx" not in config.get("provider", {}):
    sys.exit("MTPLX did not return an OpenCode provider configuration.")
with open(sys.argv[2], "w") as output:
    json.dump(config, output)
PY
export OPENCODE_CONFIG="$MTPLX_OPENCODE_CONFIG"
echo "OpenCode model: mtplx/$model_id"
if [[ "$mode" == opencode ]]; then
  opencode --model "mtplx/$model_id" <&0 &
else
  python3 - "$project_dir/.t3/userdata/settings.json" "$model_id" <<'PYSETTINGS'
import json, os, sys, tempfile
from pathlib import Path
path = Path(sys.argv[1])
settings = json.loads(path.read_text()) if path.exists() else {}
providers = settings.setdefault("providers", {})
providers.setdefault("opencode", {}).update(enabled=True, serverUrl="")
instances = settings.setdefault("providerInstances", {})
instance = instances.setdefault("opencode", {"driver": "opencode"})
if instance["driver"] != "opencode":
    sys.exit("The opencode instance ID belongs to another driver; choose another instance in T3.")
instance["enabled"] = True
instance.setdefault("config", {}).update(serverUrl="")
settings["defaultModelSelection"] = {"instanceId": "opencode", "model": "mtplx/" + sys.argv[2], "options": []}
path.parent.mkdir(parents=True, exist_ok=True)
with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as output:
    json.dump(settings, output, indent=2)
os.replace(output.name, path)
PYSETTINGS
  echo "OpenCode enabled; MTPLX selected as this dev server's default model."
  echo "Open a task to choose its agent/model, or inherit the project/server default."
  vp run dev --home-dir "$project_dir/.t3" <&0 &
fi
app_pid=$!
wait "$app_pid"
app_pid=
