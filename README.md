# xlator

[![CI](https://github.com/shinichi-takayanagi/xlator/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/shinichi-takayanagi/xlator/actions/workflows/ci.yml)

A local web app that captures Japanese and English conversations from a shared microphone and displays each utterance in both languages. Speech recognition and translation require an internet connection to the OpenAI Realtime and Responses APIs.

![xlator interface](docs/images/xlator-current.jpg)

## Setup

The required Node.js version is specified in [.nvmrc](.nvmrc). If you use nvm, run `nvm use` first.

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Set the server API key as `OPENAI_API_KEY` in `.env.local`, then open [http://localhost:3000](http://localhost:3000) in your browser. Do not expose the API key through a `NEXT_PUBLIC_*` variable.

## Development commands

```bash
npm run dev        # Start the local development server
npm run verify     # Run lint, type checking, build, and tests
npm run start      # Start the production build
npm run test:smoke:api -- --fixture <manifest.json> # Real audio and API smoke test (manual)
```

See [docs/realtime-smoke.md](docs/realtime-smoke.md) for the real-audio fixture format, local execution instructions, GitHub Actions workflow, and physical microphone checks. See [docs/spec.md](docs/spec.md) for current behavior, architecture, and unsupported features.
