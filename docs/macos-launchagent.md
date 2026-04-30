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

A reusable plist template is provided at `launchagents/com.mehdic.codex-proxy.plist`. You can install it with the provided script:

```bash
scripts/install-launchagent.sh
```

Or copy the template manually:

```bash
cp launchagents/com.mehdic.codex-proxy.plist ~/Library/LaunchAgents/
```

> The install script auto-detects your nvm Node path and home directory. If you prefer a manual setup, replace `__NODE_PATH__` and `__HOME__` in the template before loading.

## 3. Load and inspect

```bash
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.mehdic.codex-proxy.plist
launchctl kickstart -k "gui/$(id -u)/com.mehdic.codex-proxy"
launchctl print "gui/$(id -u)/com.mehdic.codex-proxy"
```

Check liveness:

```bash
curl -s http://127.0.0.1:3466/health
```

Unload:

```bash
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.mehdic.codex-proxy.plist
```

## Log locations

The plist routes logs to `~/.openclaw/logs/`:

- `~/.openclaw/logs/codex-proxy-stdout.log`
- `~/.openclaw/logs/codex-proxy-stderr.log`

## Notes

- Do not put Codex OAuth tokens or auth files in the plist.
- Keep `CODEX_PROXY_HOST=127.0.0.1` unless you add your own network-layer access control.
- `/health` is cheap. `/healthz/deep` starts Codex and runs a tiny turn, so use it for manual readiness checks rather than high-frequency polling.
- The plist uses the nvm-managed Node path by convention. If you use a different Node installation, update `ProgramArguments` accordingly.
