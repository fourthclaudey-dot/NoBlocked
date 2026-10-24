# NoBlocked

A [Kettu](https://codeberg.org/cocobo1/Kettu) plugin (also works on other Vendetta-compatible
Discord mobile mods) that takes blocked and ignored users out of your Discord.

**Install:** Kettu → Settings → Plugins → **+** → paste `https://fourthclaudey-dot.github.io/NoBlocked/`

- **Idea:** Imperator
- **Code:** Claude (Anthropic)

## What it does

- **Chat** — messages from blocked/ignored users become a bar you can open, a bar that
  can't be opened, or disappear completely. Global switch plus separate choices for
  blocked and ignored users.
- **Replies to them** — replies from other people to blocked/ignored users can be folded the
  same way (off by default).
- **Merged bars** — a back-and-forth between hidden users (blocked, ignored, replies
  alternating) becomes one bar; opening it shows the original bars as Discord would.
- **No "new message" noise** — their messages don't mark chats unread, don't ping, don't move
  DMs up and don't show in-app notifications. Chats that only got hidden messages are also
  marked read on the server, so other devices and the next app start agree. "Passive" guild
  updates (a new last message id with no author) are checked before they can light a channel
  up. Configurable per category.
- **Reactions** — their reactions are subtracted from reaction counters and they are removed
  from the "who reacted" list (the plugin asks the API who reacted; costs extra requests, can
  be turned off).
- **No flash on start** — Discord learns who is blocked ~1.5 s after launch, but shows cached
  messages earlier; the plugin keeps its own copy of the list so nothing flickers.
- **History never gets stuck** — when a whole page of older messages is hidden, the plugin
  keeps loading until something visible arrives.
- **Total exclusion** — one switch that overrides everything above to "hide completely".

Languages: English, Deutsch, Français, Español, Italiano, Português, Polski, Nederlands,
Svenska, Русский, 中文. The plugin follows Discord's language.

## Building

```
npm install
npm test           # locale checks
npm run build      # dist/manifest.json + dist/index.js
```

Pushing to `main` publishes `dist/` to GitHub Pages (see `.github/workflows/pages.yml`).

## Developing on a device (Android, USB)

```
npm run dev                      # dev server on 127.0.0.1:4041: plugin + Kettu debug WebSocket
node tools/adb.mjs restart       # adb reverse + restart Kettu
node tools/eval.mjs "vendetta.metro.findByStoreName('RelationshipStore').getBlockedIDs()"
node tools/eval.mjs --reload     # hot-reload the plugin after editing src/
node tools/eval.mjs --logs       # device logs (also logs/device.log)
node tools/adb.mjs shot          # screenshot -> logs/shot.png
```

Install the plugin on the phone from `http://localhost:4041/`. Dev builds attach Kettu's
debugger to the dev server whenever it is reachable, so the REPL comes back after every
restart. `tools/snippets/rows.js` dumps the rows the native chat list receives.
Set `ADB` if adb is not on your PATH.

## License

MIT
