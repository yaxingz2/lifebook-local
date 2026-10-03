# LifeBook (local edition)

A voice-first memoir app: warm AI interviews, saved conversations, and manuscripts linked to the original statements. **It runs entirely on your own computer; your data stays on your machine.**

> This is an early prototype. Automated tests cover program behaviour; voice quality, pauses and interruptions need real-microphone testing. Generated manuscripts should be reviewed by the storyteller.

## Quick start

Requires Node.js 24 (see `.nvmrc`).

```sh
git clone https://github.com/yaxingz2/lifebook-local.git
cd lifebook-local
npm ci --ignore-scripts --no-audit --no-fund
npm start
```

Open the local URL printed in the terminal. **Demo mode is the default and needs no API key**, so you can try the interview flow, manuscript assembly, export and backup.

## Real AI and voice

Enter your own Qwen AI platform API key in Settings (create one in the API console linked from the [Qwen AI platform](https://www.qianwen.com/) and enable the required models).

- Voice uses Qwen Audio 3.0 Flash over native WebRTC; text chat and manuscript generation use Qwen text models.
- Once enabled, relevant audio and text are sent to that provider and may incur charges.
- The key lives in a separate file in the local data directory, is excluded from book backups, and must never be committed.

## Data

Stored in `~/LifeBook` by default; override with `LIFEBOOK_DATA_DIR`. The directory holds books, conversations and the key, so never commit or upload it. The server listens on `127.0.0.1` only and has no sign-in; it assumes a trusted OS account.

## Development

```sh
npm test
node scripts/check-repository.mjs
```

Small, clear PRs are welcome. Never commit real recordings, personal stories, passwords or API keys. See [architecture](docs/architecture.md). License: [MIT](LICENSE). [中文](README.md)
