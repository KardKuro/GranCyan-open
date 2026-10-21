# GranCyan

[中文](README.md) | **English**

> A self-hosted, multi-model AI chat app (desktop / Android / browser). Bring your own API key; everything stays local by default.

One codebase, three forms:

| Form | Entry | Notes |
| --- | --- | --- |
| Local dev | `node server.js` | Listens on `:3000` (HTTP) / `:3443` (HTTPS) |
| Desktop exe | `npm run pack:exe` | Electron shell with the server embedded; double-click to run |
| Android APK | `android/build.ps1` | A WebView that loads the frontend copy in `android/assets/` and talks to the server on your computer |

The backend is a single-file Express app (`server.js`). The frontend is a series of plain `<script>` files (`js/01-core.js` … `js/71-*.js`; some numbers are skipped).

> The UI defaults to Chinese. Switch to English under Settings → Appearance → Language. The co-reading bookshelf page is still Chinese-only; what the AI says depends on the model and your prompt.

## Download

If you don't want to build it yourself, grab a package from [Releases](https://github.com/KardKuro/GranCyan-open/releases):

- **Windows**: `GranCyan-*-win-x64.zip`. Unzip it into a folder you can write to (not `C:\Program Files`) and double-click `Grancyan.exe`. No Node install needed.
  - Chat history and settings live in `%APPDATA%\Grancyan`; sticker favorites, the bookshelf and similar files live in `resources\app` inside the unzipped folder. **Copy these out before upgrading** instead of deleting the old folder.
  - The package isn't code-signed, so Windows SmartScreen may warn you the first time. Click "More info → Run anyway".
- **Android**: `GranCyan-*.apk`. It's only the frontend and needs a computer running GranCyan:
  1. Put the phone and the computer on the same LAN, with the exe (or `node server.js`) running on the computer.
  2. In the app, go to Settings → Server address and enter `http://<computer's LAN IP>:3000`.
  3. Settings on the computer shows a pairing code; enter it in the same place on the phone.
  - You can also use a USB cable plus `adb reverse tcp:3000 tcp:3000` and leave the server address empty.

## What it does

- **Chat**: switch between models, streaming Markdown, rich block rendering, visible reasoning, message editing / trash / multi-select
- **Memory**: a local memory store with advanced retrieval (vector recall + weighted re-ranking), with optional cross-device cloud sync
- **Proactive abilities**: no function calling; everything goes through a `[[command]]` text protocol: web search, sending images/stickers, playing songs, checking the weather, peeking at the screen, operating the computer (long-running tasks survive disconnects and can be reattached)
- **Rooms**: diary, dreams, study / vocabulary, a Monopoly-style board game, a nursery, a Pomodoro timer, co-reading (`coread`)
- **Senses**: TTS, voice input, camera / calls, fitness-band vitals (Gadgetbridge, optional, off by default)
- **Other**: a terminal, appearance presets and gestures, document parsing (epub/docx/pdf), suggestion bubbles

## Running it

Requires **Node.js 20 or newer** (needed by `better-sqlite3`; 22 / 24 LTS both work).

```bash
npm i
node server.js          # then open http://127.0.0.1:3000
```

Or run `npm run pack:exe` to build a desktop exe (output in `dist/`) with the server embedded.

- **Local-only by default**: no account needed. Chats, memory and settings are stored on this machine (browser IndexedDB + the project folder / `~/.grancyan/`) and are never uploaded anywhere.
- **Optional: cloud sync.** For multi-device sync, create your own Supabase project and put its URL and anon key in `js/00-config.js` (the desktop server also needs `SUPABASE_URL` / `SUPABASE_ANON_KEY` in `.env`). Leave them empty and login/sync never show up. See `PRIVATE-FILES.md` for details.
- The server listens on `0.0.0.0` by default (so the Android app can reach it over the LAN). If you only use it locally, set `GRANCYAN_HOST=127.0.0.1` (env var or `.env`). Change ports with `GRANCYAN_PORT` / `GRANCYAN_PORT_TLS`.
- On Windows with WSL installed, testing local endpoints via `localhost` may get intercepted by wslrelay and return an empty reply. Always use `127.0.0.1`.

## Connecting models

**Main way: your own API key.** In Settings → Models & API, add a model with its API URL, model name and key. Anthropic, OpenAI, Gemini and any OpenAI-compatible endpoint (DeepSeek, local Ollama, etc.) are supported. The key is stored locally and only sent to the URL you entered.

**Optional: "Subscription Claude" / "Subscription GPT" / "Subscription Gemini".** These let the server on your computer call **the official CLI you have already logged into on that machine**:

- Subscription Claude → the official `claude` (Claude Code CLI). Install it and log in first.
- Subscription GPT → the official `codex` (Codex CLI). Install it and run `codex login` first. Without a login you can instead configure your own OpenAI-compatible endpoint in `.env`: `GRANCYAN_GPT_BASE_URL` (Responses API URL) + `GRANCYAN_GPT_API_KEY`. With neither, it errors out; it never falls back to any default relay.
- Subscription Gemini → the official `agy` (Google Antigravity CLI). Requires an account with a Google AI Pro subscription; install it and run `agy` once to log in. In the session bar, turn on ✦ Gemini, then click "🔑 key" to switch to "💳 subscription". Only Gemini 3.8 Flash is available, in three levels (the depth dropdown maps to low/medium/high), with no built-in web access, and the first token takes about ten seconds (the server keeps a pre-warmed process). agy runs in a throwaway empty directory under the system temp folder, so it can't read any `AGENTS.md` in your project or home directory. If you need a proxy to reach Google, set `GRANCYAN_AGY_PROXY=http://127.0.0.1:<port>` in `.env`; if agy isn't in its default location, point to it with `GRANCYAN_AGY_BIN`.

GranCyan only launches these CLIs as child processes. **It does not read, store or forward your login credentials.** Usage counts against your own account; please follow each service's terms.

## Optional features (off by default)

| Feature | How to enable | Notes |
| --- | --- | --- |
| Remote control over MCP | Env var `EXEC_MCP=on` | Mounts an MCP endpoint at `/mcp/<token>/…` that can run commands on this computer (for remote clients such as claude.ai). The token is stored in `.mcp-token` (or set it with `EXEC_MCP_TOKEN`) and **is equivalent to a shell password for this machine**. If unset, the route isn't mounted at all and no token is generated. |
| Fitness band data (Gadgetbridge) | Set `GRANCYAN_BAND_DB_REMOTE` on the computer, then turn on Band data → Auto sync in the UI | The server uses adb to pull the database Gadgetbridge auto-exports on the phone. `GRANCYAN_BAND_DB_REMOTE` is the export path on the phone (e.g. `/storage/emulated/0/Gadgetbridge/Gadgetbridge.db`); pulled files go to `~/.grancyan/band/` (override with `GRANCYAN_BAND_DIR`). Set the adb location with `GRANCYAN_ADB`. If not configured, adb is never called. |

Other optional settings (TLS certificates, paths to external tools, etc.) are in `PRIVATE-FILES.md`.

## Packaging

```bash
npm run pack:exe        # output in dist/, then scripts/slim-dist.js runs automatically to slim it down
```

```powershell
powershell -File android/build.ps1
```

Style changes need `npm run watch` (Tailwind watches `input.css` → `output.css`).

## Layout

```
server.js            the whole backend (API, proxy, SSE, SQLite)
electron-main.js     Electron main process
index.html           single-page shell
js/                  frontend; file number = load order = dependency order
css/ img/            static assets
android/             Android project; assets/ is a build output
coread/              co-reading module
scripts/             one-off scripts (memory import, line-ending repair, package slimming)
tests/               node tests/<name>.test.js
docs/                misc notes
AGENTS.md            read this before changing the project
```

## Before you change anything

Each of these fails **silently**: no error, the change just doesn't take effect.

- **The frontend is not ESM.** All `js/*.js` files share one global lexical scope, and the number is the dependency order. Top-level code that runs immediately can't reference anything from a later file.
- **`android/assets/` is a build output.** Only edit `js/`; `build.ps1` regenerates the Android copy, and hand edits to assets get overwritten on the next build.
- **A new `[[command]]` needs three matching changes**: parsing, display, and its description in the system prompt. Miss one and you get a silent bug.
- **New `state` fields must pass every whitelist**: defaults in `02-state.js`, `idbSet` in `_doSave`, cloud-sync push/merge in `01-core.js`, and startup assignment in `14-boot-brain-hub.js`. Miss one and the field is lost on refresh.
- **The prompt cache is split into stable / volatile.** Data that changes on every message (timestamps, search results) must go into volatile; putting it in stable invalidates the whole cache.
- **In computer-control mode, a client disconnect ≠ stop.** The process keeps running and is reattached via runId; new downstream SSE events must go through `send()`.

The full version is in [AGENTS.md](AGENTS.md) (Chinese).

## Tests

```bash
node tests/prompt-cache.test.js     # a single test
node scripts/run-tests.js           # the full suite
```

Run the full suite after any frontend change. Some tests guard that desktop `js/` and `android/assets/js/` are byte-for-byte identical.

## License

Copyright (C) 2026 KardKuro

Released under the [GNU Affero General Public License v3.0](LICENSE) (or any later version, `AGPL-3.0-or-later`).
In short: you may use, modify and redistribute it; if you let others use a modified version (including over a network), you must publish its source under the same license. See [LICENSE](LICENSE) for the full terms.

Exception: the ideas in [`docs/output-admission.md`](docs/output-admission.md) come from [do-not-safety-me](https://github.com/Gwendolenmave/do-not-safety-me) (Gwendolenmave). That document is released under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/), not the AGPL.

---

Maintained by one person. Issues and PRs are welcome — I read every one, though replies may take a little while.
