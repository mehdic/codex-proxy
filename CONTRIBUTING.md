# Contributing

Thank you for helping improve `codex-proxy`.

## Development loop

```bash
npm install
npm run build
npm test
```

Keep tests that do not require a live Codex session separate from live smoke tests.

## Security rules

- Never commit `~/.codex/auth.json` or any token material.
- Do not add code that reads or copies Codex OAuth tokens.
- Keep localhost as the default bind host.
- Treat Codex as an agent with side-effect potential, not a plain text model.

## Code style

- TypeScript strict mode.
- Prefer small adapters with unit tests.
- Keep protocol parsing tolerant; Codex app-server is evolving.
- Keep metrics label cardinality bounded.

## Release checklist

- `npm run build`
- `npm test`
- local `/health` and `/v1/models` smoke test
- one live `/v1/chat/completions` smoke test if Codex quota is available
