---
name: inskit-setup
description: First-run setup for inskit — check the agent browser, choose which browser and profile to copy logins from, optionally add a card and save the user's delivery details. Use right after the plugin is installed, or when the user asks to set up, check or fix inskit, logins, the vault, or using it on a remote machine.
---

# inskit setup

## Browser location

Check `agent_status` before describing where the browser runs. When it says Browser Use Cloud, the browser runs remotely and no local Chrome window is opened. Playwright controls that remote browser through CDP. Login import is manual by default in cloud mode: import only the domains the user wants to use there. Cloud sessions share this plugin's dedicated persistent profile. `browser_hand_over` returns a live preview link for the user to interact with the remote browser. The vault and approval pages still run locally. A cloud failure must never be worked around by launching local Chrome unless the user requests that change.

"Browser Use Cloud, free hosted" means the free hosted service: nothing to configure, 60 browser minutes a day. Tell the user once, in one sentence, that the cookies of sites they sign in to are kept in a cloud browser profile on the inskit service so they stay logged in, that their vault and approvals stay on this computer, and that `inskit cloud forget` deletes the profile. If they prefer, they can switch to Chrome on this computer by putting {"INSTINCT_BROWSER_PROVIDER": "local"} in ~/.instinct/config.json, or use their own Browser Use key. When a limit is reached, relay the message as is; do not switch providers on your own.

The local Chrome workflow below applies when the status says window/headless. With cloud mode, use the live preview instead of referring to an agent window.


Keep it short: it works with zero setup, so only offer what helps. Mirror the user's language.

1. Call agent_status. It starts the background service and reports the browser, login import and vault.
2. Logins: call logins_import with list=true. If there is more than one browser or profile, ask which one they use for personal accounts (show the names) and call logins_import with that browser/profile and sites=["google.com"] to save the choice. Tell them macOS will ask once for access to "<Browser> Safe Storage" and that "Always Allow" keeps future imports silent. After that, each site's logins are copied on first visit.
3. Offer, don't push:
   - Save a card now (vault_request kind=card) so purchases need no interruption later. Mention the card is encrypted on this computer and Codex never sees the number.
   - Save name, email, phone and delivery address with profile_update.
4. Show the home page from agent_status, where they can add or remove cards and see purchases.
5. Suggest a first task, e.g. "download my last invoice from <a site they use>".

## Codex on a remote machine (VM, devbox)

The agent browser runs where Codex runs. On a server without a screen:

- Set INSTINCT_HEADLESS=1, or point INSTINCT_CDP_URL at an existing Chrome/Chromium started with --remote-debugging-port.
- From the user's own computer, send logins to that browser over SSH (the CLI ships with the plugin, next to this skill at ../../dist/cli.js):
  node <plugin>/dist/cli.js logins push <ssh-host> --sites amazon.com,github.com
  Use --all only if they want every login, and --cdp if the remote debugging port is not 127.0.0.1:9222.
- Vault and approval pages then open at INSTINCT_PUBLIC_URL (for example a Tailscale address); without it, Codex shows the one-time link in chat.

## Troubleshooting

- "Could not start a browser": install Google Chrome, or set INSTINCT_CHROME_PATH.
- Keychain access denied: run logins_import again and click "Always Allow".
- Logged out on a site after import: some sites tie sessions to one browser; log in once in the agent browser window (it stays logged in).
- Logs: ~/.instinct/daemon.log. Restart: node <plugin>/dist/cli.js stop (it restarts on the next tool call).
