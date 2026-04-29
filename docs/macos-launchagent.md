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

Save this as `~/Library/LaunchAgents/com.mehdic.codex-proxy.plist`:

> Replace `/Users/YOUR_USER` with your actual home directory before loading the plist.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.mehdic.codex-proxy</string>

  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/YOUR_USER/.openclaw/projects/codex-proxy/dist/server/standalone.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>/Users/YOUR_USER/.openclaw/projects/codex-proxy</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>CODEX_PROXY_HOST</key>
    <string>127.0.0.1</string>
    <key>CODEX_PROXY_PORT</key>
    <string>3466</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/tmp/codex-proxy.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/codex-proxy.err.log</string>
</dict>
</plist>
```

Adjust the Node path if your machine uses Homebrew on Apple Silicon:

```bash
which node
```

Use the returned path in `ProgramArguments`.

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

## Notes

- Do not put Codex OAuth tokens or auth files in the plist.
- Keep `CODEX_PROXY_HOST=127.0.0.1` unless you add your own network-layer access control.
- `/health` is cheap. `/healthz/deep` starts Codex and runs a tiny turn, so use it for manual readiness checks rather than high-frequency polling.
