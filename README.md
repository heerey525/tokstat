# tokstat

A Hermes Desktop plugin: live token usage for the focused session, pinned to the
right of the status bar.

```
Total 1.1M · Turn 32K · Last 31K · Context 97% · Cache 56%
```

- **Total** — cumulative tokens for the session (compact).
- **Turn** — the reply *currently generating*, counting up in real time.
- **Last** — the previous completed turn (appears when the live counter settles).
- **Context** — context-window occupancy.
- **Cache** — prompt-cache hit rate.

Hover for the exact figures (input / output / total, plus model name).

Labels and tooltips ship in **English and Chinese** — the readout follows the
Hermes Desktop locale (Settings → Language); English is the default.

## How it works

No polling, no RPC. The plugin listens to three gateway events:

| Event | Role |
|---|---|
| `session.usage` | mid-turn ticker (~1/s), carries the session-cumulative usage dict |
| `message.start` | turn boundary — snapshots the cumulative total as the turn baseline |
| `message.complete` | turn boundary — finalizes `Turn − baseline` as the last turn |

Both `payload.usage` (gateway ticker) and top-level `total_tokens` /
`context_tokens` (local viewer) payload shapes are normalized, so the plugin
works on either gateway flavor. If a `message.complete` carries no usage, the
last ticker snapshot is used instead.

After a plugin hot-reload (or a brand-new session) the baseline is unknown, so
the *first* ticker snapshot of that turn becomes the baseline — "Turn" counts
up from that point rather than mirroring "Total".

## Install

**From the catalog** (once listed):

```bash
hermes plugins install tokstat
```

**From Git** (in the meantime): Settings → Plugins → **Install from Git**, or:

```bash
mkdir -p ~/.hermes/desktop-plugins/tokstat
cp desktop/plugin.js ~/.hermes/desktop-plugins/tokstat/plugin.js
```

Then **⌘K → Reload desktop plugins** (or just wait — the directory is watched).

## Disclosure

- Desktop-only, single-file plugin. No gateway-side code, no network calls of
  its own, no `requires_env`.
- Reads usage figures that the gateway already reports; does not re-measure.
- Per-turn numbers are cumulative-diff snapshots, not provider metering.
- On builds where the `session.usage` ticker is absent the chip stays on its
  idle placeholder ("no usage reported yet") instead of showing stale data.

## Tests

```bash
node --test tests/plugin.test.mjs
```

Tests import the real `desktop/plugin.js` with stubbed SDK (the official
single-file desktop-plugin test pattern); no build step.
