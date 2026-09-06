# Launch with MTPLX through OpenCode

MTPLX supplies the local model; the existing OpenCode provider runs the coding
agent. No additional T3 provider adapter is required.

Install MTPLX, OpenCode 1.14.19 or newer, Python 3, and Vite+ (`vp`). Configure
a model in MTPLX first. The launcher does not download models. From this
checkout, install T3's dependencies once and start it:

```bash
vp i
./scripts/start-mtplx.sh
```

Use the pairing URL printed by T3. The launcher enables OpenCode, clears its
helper Server URL, and selects the discovered `mtplx/<model-id>` as the server
default in this checkout's `.t3/userdata/settings.json`. Starting T3 refreshes
the provider/model inventory using the generated OpenCode configuration.
Existing project defaults still take precedence over the server default.

Open a board task and use **Agent and model** to select OpenCode and MTPLX for
that task. **Save**, **Run**, and state changes persist the selection. Run opens
a prepared Chat draft; send it to begin. Moving a card to Ready lets the enabled
runner launch it automatically. **Configure agents** opens provider settings
if you need to refresh provider status again.

To launch OpenCode's terminal interface directly in a project:

```bash
./scripts/start-mtplx.sh --opencode /path/to/project
```

The launcher probes `http://127.0.0.1:8000/v1/models`, reuses a responding
server, or starts MTPLX with the sustained profile. It uses the first advertised
model ID and MTPLX's native JSON configuration output. The generated OpenCode
config exists only for the launcher session; it does not rewrite global config.
Unset `OPENCODE_CONFIG_CONTENT` before launching because it overrides file
configuration. Existing OpenCode config files can still contribute settings.

Set `MTPLX_PORT` to change the local port, `MTPLX_MODEL` to choose the model
when starting a new server, and `MTPLX_START_TIMEOUT` to change the 300-second
startup wait. A running server keeps its loaded model. This launcher expects
a localhost server without API-key authentication.

Keep the launcher terminal open. On exit it removes its temporary config and
stops only the MTPLX process it started; an existing server is left running.
T3 uses this checkout's `.t3` directory for development state.

## Task selection

Task selection overrides the project default, which overrides the server
default. Implementation, repair, and review use this precedence. Select
**Use project default** to remove a task override. Selection is locked while
the task is Running, Diagnosing, or Reviewing.

Upstream setup reference: [MTPLX's OpenCode guide](https://mtplx.com/docs/opencode/).
The launcher uses JSON output because older installed versions of
`mtplx connect opencode` print config without writing it.
