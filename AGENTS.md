# Notes for coding agents

## Installing inskit for a user

    curl -fsSL https://inskit.justmade.page/install.sh | sh

This adds the plugin to Codex, writes an `inskit` command to `~/.local/bin` and runs `inskit check`, which opens https://example.com in the agent browser and prints the title. No account or key is needed: the free hosted cloud browser is the default. Codex loads the plugin in new chats only, so in the session that installed it, prove it works with `inskit check` rather than the @inskit tools.

## Working on this repository

- Node 22.13+. `npm install`, then `npm run typecheck && npm test`. `npm run build` regenerates `plugin/dist`, which is committed: rebuild before committing source changes.
- Several tests and `npm run e2e` drive a real Chromium. Without Chrome installed, run `npx playwright-core install chromium` and point `INSTINCT_CHROME_PATH` at the binary it prints. On Linux the browser also needs system libraries and fonts (`npx playwright-core install-deps chromium`, as root).
- Use a throwaway `INSTINCT_HOME` and `INSTINCT_PORT` for manual runs so you do not touch the user's vault in `~/.instinct` or their running daemon on port 17700.
- Install the plugin from a checkout with `npm run install:codex`.
- Bump the version in `package.json` and `plugin/.codex-plugin/plugin.json` (and `src/brand.ts`) when releasing; Codex caches plugins by version.

## Running your own cloud browser service

See [docs/self-host.md](docs/self-host.md). In short: put a Browser Use key in `service/.dev.vars`, run `npm run service:dev`, and set `"INSTINCT_HOSTED_URL": "http://127.0.0.1:8795"` in `~/.instinct/config.json`. `node --import tsx test/hosted-live.ts` (with `INSTINCT_HOSTED_URL` set) checks the whole path.

## Rules that matter

- Never print or commit secrets: `service/.dev.vars`, `~/.instinct/*.key`, `~/.instinct/hosted.json`.
- The vault and the purchase gate are the product. Changes must keep vault values out of anything the model reads and keep payment buttons behind `purchase_submit`.
