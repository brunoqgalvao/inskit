# Login benchmark

Measures how fast and how reliably inskit logs in, and what it costs.

## Run

```sh
node --no-warnings --import tsx bench/run.ts --tier A --env local --fallback off
node --no-warnings --import tsx bench/run.ts --tier B --env local --fallback luna
node --no-warnings --import tsx bench/run.ts --tier all --env cloud --fallback luna --only github,amazon-br
```

Results go to `bench/results/<run>/`: `results.json`, `summary.md` and one snapshot per failing case.

## Tiers

- **A** — public demo sites with published test credentials. Full end-to-end: `logged_in` must also show the site's success text. Includes wrong-password cases that must end in `rejected` after a single submission.
- **B** — real login pages of popular sites, using a nonexistent account. Pass means the outcome was understood: `rejected`, `code_requested`, `method_choice` or `needs_human` (CAPTCHA, passkey, bot wall). `no_login_form`, `no_response` and `error` are failures.
- **C** — the user's real accounts; manual only, never part of a run.

## Login chain

1. **Recipe** (`src/login/recipes.ts`, plus JSON files in `~/.instinct/recipes/`): tuned selectors and signals for common sites.
2. **Heuristics** (`src/login/page-scripts.ts`): any site, deterministic.
3. **Model fallback** (`src/login/model.ts`): only when the page is unclear. `luna` goes through the Codex app's local router (ChatGPT subscription, no per-token charge); `haiku` uses the Anthropic API ($1/MTok in, $5/MTok out).

Every attempt is recorded in the `login_runs` table. When the model succeeds, the button it used is learned for that site and the next run stays deterministic.

## Cost model

Browser Use Cloud (https://browser-use.com, checked Oct 2026): $0.02 per browser-hour, billed by the minute, and $5/GB of managed residential proxy traffic. The summary estimates cloud cost per login from wall time and bytes transferred; with the proxy on, traffic dominates.

