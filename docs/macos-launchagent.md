# macOS LaunchAgent

Run `codex-proxy` at login with a user LaunchAgent. This keeps the service local to your account and preserves the default localhost bind.

## 1. Build the proxy

```bash
cd ~/.openclaw/projects/codex-proxy
npm install
npm run build
```

Make sure the same macOS user has authenticated Codex:

```bash
codex login
codex exec "Reply OK only."
```

## 2. Create the plist

Reusable plist templates are provided for the proxy and weekly pricing refresh:

- `launchagents/com.mehdic.codex-proxy.plist`
- `launchagents/com.mehdic.codex-proxy-pricing-refresh.plist` (Mondays 07:00 local time)

You can install both with the provided script:

```bash
scripts/install-launchagent.sh
```

Or copy the template manually:

```bash
cp launchagents/com.mehdic.codex-proxy.plist ~/Library/LaunchAgents/
cp launchagents/com.mehdic.codex-proxy-pricing-refresh.plist ~/Library/LaunchAgents/
```

> The install script auto-detects your nvm Node path and home directory. If you prefer a manual setup, replace `__NODE_PATH__` and `__HOME__` in the template before loading.

## Sandbox and approval policy

The reusable LaunchAgent template leaves Codex Proxy on its safe defaults unless you add environment variables:

- `CODEX_PROXY_SANDBOX=read-only` (default), `workspace-write`, or `danger-full-access`
- `CODEX_PROXY_APPROVAL_POLICY=never` (default), `on-request`, `on-failure`, or `untrusted`

For a trusted, localhost-only Mac mini instance where Codex-native shell/network tools should behave like the direct OpenClaw exec path, add the following under `EnvironmentVariables` in the installed plist:

```xml
<key>CODEX_PROXY_SANDBOX</key>
<string>danger-full-access</string>
<key>CODEX_PROXY_APPROVAL_POLICY</key>
<string>never</string>
```

Do not use `danger-full-access` for a network-exposed proxy or an instance serving untrusted users. The proxy still does not handle Codex OAuth tokens; official `codex app-server` owns auth/session either way.

## 3. Load and inspect

```bash
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.mehdic.codex-proxy.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.mehdic.codex-proxy-pricing-refresh.plist
launchctl kickstart -k "gui/$(id -u)/com.mehdic.codex-proxy"
launchctl print "gui/$(id -u)/com.mehdic.codex-proxy"
launchctl print "gui/$(id -u)/com.mehdic.codex-proxy-pricing-refresh"
```

Check liveness:

```bash
curl -s http://127.0.0.1:3466/health
```

Unload:

```bash
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.mehdic.codex-proxy.plist
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.mehdic.codex-proxy-pricing-refresh.plist
```

## Log locations

The plist routes logs to `~/.openclaw/logs/`:

- `~/.openclaw/logs/codex-proxy-stdout.log`
- `~/.openclaw/logs/codex-proxy-stderr.log`
- `~/.openclaw/logs/codex-proxy-pricing-refresh-stdout.log`
- `~/.openclaw/logs/codex-proxy-pricing-refresh-stderr.log`

## Notes

- Do not put Codex OAuth tokens or auth files in the plist.
- Keep `CODEX_PROXY_HOST=127.0.0.1` unless you add your own network-layer access control. This is especially important when `CODEX_PROXY_SANDBOX=danger-full-access`.
- `/health` is cheap. `/healthz/deep` starts Codex and runs a tiny turn, so use it for manual readiness checks rather than high-frequency polling.
- The plist uses the nvm-managed Node path by convention. If you use a different Node installation, update `ProgramArguments` accordingly.
- The pricing refresh script fetches public pricing into the local cache and restarts whichever known Codex Proxy LaunchAgent label is loaded (`com.mehdic.codex-proxy` or Mehdi's existing `fr.chaouachi.tradingagents.codex-proxy`).
