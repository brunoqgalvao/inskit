# Running your own cloud browser service

The plugin works without this: by default it uses the free hosted service. Run your own when you want browsers and their cookies on your own Browser Use account, or different limits.

The service in `service/` is a Cloudflare Worker with one Durable Object (SQLite). It keeps your Browser Use key, registers anonymous installs, opens and stops browsers for them, enforces limits and serves the website. Browsing traffic goes straight from the plugin to the browser over CDP.

## Locally

    cd service && npm install
    printf 'BROWSER_USE_API_KEY=%s\n' "$(cat /path/to/browser-use.key)" > .dev.vars   # gitignored; never print the key
    cd .. && npm run service:dev            # http://127.0.0.1:8795, cron emulated every 10 minutes

Point the plugin at it in `~/.instinct/config.json`:

    { "INSTINCT_HOSTED_URL": "http://127.0.0.1:8795" }

Then `inskit stop` (the daemon restarts with the new setting on next use) and `inskit check`.

`wrangler dev` does not run cron triggers by itself; `npm run service:dev` calls the scheduled handler every 10 minutes so expired sessions are closed and costs are reconciled.

## On Cloudflare

    cd service
    # edit wrangler.toml: the Worker name and the custom domain in routes (or remove routes to use workers.dev)
    npx wrangler deploy
    npx wrangler secret put BROWSER_USE_API_KEY
    openssl rand -hex 32 | tee ~/.config/inskit-admin-token | npx wrangler secret put ADMIN_TOKEN

Set `INSTINCT_HOSTED_URL` to your URL on each machine, or change `HOSTED_URL` in `src/config.ts` and rebuild if you distribute your own build.

## Limits and operations

Limits are Worker variables in `wrangler.toml`: `INSTALL_DAILY_MINUTES` (60), `INSTALL_DAILY_USD` (0.5), `MAX_SESSION_MINUTES` (30), `MAX_ACTIVE` (10), `DAILY_BUDGET_USD` (10), `INSTALLS_PER_IP_PER_DAY` (20). `SERVICE_ENABLED = "0"` pauses new browsers.

    curl -s https://<your-host>/v1/stats -H "authorization: Bearer $(cat ~/.config/inskit-admin-token)"

Browser Use finalizes proxy costs a few minutes after a browser stops; the cron keeps refreshing recent sessions until then, so today's spend can rise slightly after the fact.
