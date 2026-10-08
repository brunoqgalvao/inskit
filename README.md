# inskit

**Let Codex get things done on real websites**: log in, fill forms, compare and buy, book, download invoices and statements.

[Website](https://inskit.agenturl.dev) · Apache-2.0 · macOS and Linux

- **A browser that stays logged in.** Codex gets its own browser. By default it runs in the cloud on a free hosted service, so nothing opens on your machine. You can also use your own [Browser Use](https://browser-use.com) key or Chrome on your computer, which copies each site's logins from your everyday browser (Chrome, Arc, Brave, Edge or Chromium) the first time Codex visits it.
- **A vault Codex never sees.** Cards, passwords and ID numbers are typed by you into one-time local pages and stored encrypted on your computer. Codex can ask the vault to type a value into a field; the value never appears in what the model reads.
- **Nothing is bought without you.** Codex fills the cart and stops. You approve the exact items, total, address and card. The pay button only works for that order, on that store, while that total is on screen.

## Install

    curl -fsSL https://inskit.agenturl.dev/install.sh | sh

or by hand:

    codex plugin marketplace add brunoqgalvao/inskit
    codex plugin add inskit@inskit

The installer also puts an `inskit` command in `~/.local/bin` and runs `inskit check`, which opens example.com in the agent browser to prove it works. Restart Codex and ask: *"@inskit download my last 3 invoices from my phone carrier"*. Requirements: Codex (app or CLI) on macOS or Linux. Node and Playwright ship inside the plugin.

Setting this up with a coding agent? Point it at [AGENTS.md](AGENTS.md). Running your own cloud browser service: [docs/self-host.md](docs/self-host.md).

## Where the browser runs

| Option | How to choose it | Logins |
|---|---|---|
| Free hosted cloud browser | Default when no key is configured | Imported per site on request, or sign in once through the live preview |
| Your own Browser Use account | `BROWSER_USE_API_KEY`, or a key in `~/.instinct/browser-use.key` (0600) | Same as above, in a profile on your account |
| Chrome on your computer | `"INSTINCT_BROWSER_PROVIDER": "local"` | Copied from your everyday browser on first visit (macOS) |
| An existing Chrome | `INSTINCT_CDP_URL` (e.g. a VM's headless Chromium) | `inskit logins push <ssh-host>` |

Settings go in `~/.instinct/config.json`, using the same names as the environment variables below, for example `{"INSTINCT_BROWSER_PROVIDER": "local"}`. Environment variables take precedence.

### The free hosted cloud browser

The first time Codex needs a browser, the plugin registers an anonymous install with the service in [`service/`](service) and gets a browser from it. The service holds one Browser Use key, opens and stops browsers for each install, and keeps a cloud profile per install so you stay logged in. Browsing traffic goes straight from your machine to the browser over CDP; it does not pass through the service.

- Limits: 60 browser minutes per install per day, sessions up to 30 minutes, closed after 5 idle minutes, recording off. The service also has a global daily budget.
- What the service keeps: the install ID, a hash of its token and of the registering IP, and session times and costs. Cookies of sites you sign in to live in the install's cloud profile on the operator's Browser Use account.
- `inskit cloud status` shows today's usage. `inskit cloud forget` stops your browser and deletes the cloud profile and its cookies.
- The vault and purchase approvals never leave your computer in any mode.

## How it works

    Codex chat ──stdio──> MCP shim (per chat) ──HTTP+token──> daemon (one per machine)
                                                               ├─ browser: hosted cloud, your Browser Use key, local Chrome or CDP
                                                               ├─ vault (AES-256-GCM, ~/.instinct)
                                                               ├─ purchase gate
                                                               └─ local pages: /v/<token> vault, /a/<token> approval, / home

The shim starts the daemon on first use and replaces it when a newer plugin build is installed. Data lives in `~/.instinct` (vault, profile, purchases, audit log, `daemon.log`). Downloads go to `~/Downloads/inskit`.

## CLI

The CLI ships inside the plugin: `node ~/.codex/plugins/cache/inskit/inskit/<version>/dist/cli.js`.

    inskit status | check | open | browsers | stop
    inskit cloud status | forget
    inskit logins import [--sites a.com,b.com | --all] [--browser chrome] [--profile "Work"]
    inskit logins push <ssh-host> [--sites a.com,b.com | --all] [--cdp http://127.0.0.1:9222]
    inskit login-stats | recipes

## Settings

| Variable | Default | |
|---|---|---|
| `INSTINCT_BROWSER_PROVIDER` | auto | `hosted`, `browser-use`, `local` or `cdp`. Auto: CDP if set, then your key, then hosted |
| `INSTINCT_HOSTED_URL` | https://inskit.justmade.page | Hosted service; `0` disables it (then local Chrome is the default) |
| `BROWSER_USE_API_KEY` | – | Your Browser Use key; or `INSTINCT_BROWSER_USE_KEY_FILE` / `~/.instinct/browser-use.key` |
| `INSTINCT_PROXY_COUNTRY` | br | Cloud proxy country |
| `INSTINCT_HEADLESS` | 0 | `1` on servers without a screen |
| `INSTINCT_CDP_URL` | – | Attach to an existing Chrome (`--remote-debugging-port`) |
| `INSTINCT_PUBLIC_URL` | http://127.0.0.1:17700 | Where vault and approval pages are reachable (e.g. a Tailscale address for a VM) |
| `INSTINCT_APPROVAL` | chat | `page` asks for purchase approval on a local page |
| `INSTINCT_COOKIE_SYNC` | 1 with local Chrome on macOS | Copy each site's logins on first visit |
| `INSTINCT_CHROME_PROFILE`, `INSTINCT_CHROME_PATH` | – | Which profile to copy logins from; browser binary |
| `INSKIT_LUNA_BASE_URL` / `ANTHROPIC_API_KEY` | – | Optional inner model for unclear login pages and `browser_delegate` (an OpenAI-compatible Responses endpoint, or Claude Haiku). Off when neither is set |
| `INSTINCT_PORT`, `INSTINCT_HOME` | 17700, `~/.instinct` | |

## Troubleshooting

- **`inskit check` fails with a limit message.** The free cloud browser has daily limits per install and a global budget. Wait for the reset at 00:00 UTC, use your own Browser Use key, or switch to local Chrome with `{"INSTINCT_BROWSER_PROVIDER": "local"}` in `~/.instinct/config.json`.
- **@inskit tools do not show up in Codex.** Plugins load in new chats: restart Codex or open a new chat. `codex plugin list` should show `inskit@inskit`.
- **"Could not start a browser" in local mode.** Install Google Chrome, or set `INSTINCT_CHROME_PATH`.
- **Keychain prompt in local mode.** Choose "Always Allow" for "<Browser> Safe Storage" so later login imports stay silent.
- **Logged out on a site after importing logins.** Some sites bind a session to one browser; sign in once in the agent browser (`browser_hand_over` gives the live view in cloud mode) and it persists.
- **Anything else.** `~/.instinct/daemon.log` has the details. `inskit stop` restarts the background service on next use.

## Security model, honestly

The vault and the gate protect against the model seeing or leaking secrets and against prompt injection on web pages: page text is never treated as instructions, and the gate checks the store, the approval and the on-screen total in code. They are not a sandbox against code running as your user. Codex itself can run shell commands, and a process with your permissions could read `~/.instinct`. Imported cookies give the agent browser the same access you have on those sites; import only the sites you need. With the hosted browser, the cookies of sites you sign in to are stored in a cloud profile on the operator's Browser Use account; use your own key or local Chrome if that is not acceptable.

Limitations: Windows login import is not supported (Chrome's app-bound encryption). Some sites bind sessions to one browser and ask you to sign in once inside the agent browser; that session then persists.

Report vulnerabilities privately, see [SECURITY.md](SECURITY.md).

## Repository

- `src/`, `plugin/`: the plugin (MCP server, daemon, CLI) and its built bundle. `npm run build` regenerates `plugin/dist`.
- `service/`: the hosted cloud browser service and the website (Cloudflare Worker + Durable Object).
- `inbox-worker/`: optional catch-all mailbox for accounts the agent creates (Cloudflare Email Routing).
- `bench/`: login benchmark against public demo sites and real login pages with nonexistent accounts.

## Develop

    npm install
    npm run typecheck && npm test
    npm run e2e          # real Chrome, full purchase on a local fixture store, no model
    npm run build        # bundles plugin/dist and vendors playwright-core

    cd service && npm install
    echo "BROWSER_USE_API_KEY=..." > .dev.vars && npx wrangler dev --port 8795
    INSTINCT_HOSTED_URL=http://127.0.0.1:8795 node --import tsx test/hosted-live.ts

The login flow, two-factor challenges and verification are described in [docs/login.md](docs/login.md).
