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

Use the pairing URL printed by T3. In **Settings > Providers**, enable OpenCode
and refresh provider status. Leave its **Server URL** empty so T3 starts its
own OpenCode helper. That setting expects an OpenCode server, not the MTPLX
inference endpoint. Select the displayed `mtplx/<model-id>` model as the
project default to use it for autonomous board tasks.

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

## Task-selection gap

The board currently has no per-card agent/model selection. Automated launches,
continuations, and reviews use the project's default model. Manual **Run**
opens a draft thread; select its model in Chat before sending.

A per-task picker requires a persisted card selection, a dialog control, and
selection handling in both manual and automated launch paths. The dialog must
save a changed selection before claiming the card: the server launches the
saved card, not an unsaved dialog draft. The launcher does not add this feature.

Upstream setup reference: [MTPLX's OpenCode guide](https://mtplx.com/docs/opencode/).
The launcher uses JSON output because older installed versions of
`mtplx connect opencode` print config without writing it.
