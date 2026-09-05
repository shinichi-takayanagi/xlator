# xlator

[![CI](https://github.com/shinichi-takayanagi/xlator/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/shinichi-takayanagi/xlator/actions/workflows/ci.yml)

A local web app that captures Japanese and English conversations from a shared microphone and displays each utterance in both languages. Speech recognition and translation require an internet connection to the OpenAI Realtime API.

![xlator interface](docs/images/xlator-current.jpg)

## Setup

The required Node.js version is specified in [.nvmrc](.nvmrc). If you use nvm, run `nvm use` first.

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Set the server API key as `OPENAI_API_KEY` in `.env.local`, then open [http://localhost:3000](http://localhost:3000) in your browser. Do not expose the API key through a `NEXT_PUBLIC_*` variable.

For specialized vocabulary, optionally set recording context and literal term hints in `.env.local`:

```dotenv
OPENAI_TRANSCRIPTION_PROMPT="A Japanese and English discussion about live translation software."
OPENAI_TRANSCRIPTION_KEYWORDS='["xlator", "OpenAI", "WebRTC"]'
```

Restart the server and reload the browser after changing these values so prefetched client secrets are replaced. Blank values send no hints. Keywords must be a JSON array of non-empty strings without line breaks or `<` / `>`; surrounding whitespace and duplicates are removed. These are recognition hints, not mandatory output or a translation dictionary. They are sent to OpenAI and may be included in upstream session metadata. The default transcription model, bilingual language hints, and `minimal` delay remain unchanged. Real-audio accuracy gains require evaluation with representative vocabulary; see the [official transcription guide](https://developers.openai.com/api/docs/guides/realtime-transcription).

## Development commands

```bash
npm run dev        # Start the local development server
npm run verify     # Run lint, type checking, build, and tests
npm run start      # Start the production build
npm run test:smoke:api -- --fixture <manifest.json> # Real audio and API smoke test (manual)
```

See [docs/realtime-smoke.md](docs/realtime-smoke.md) for the real-audio fixture format, local execution instructions, GitHub Actions workflow, and physical microphone checks. See [docs/spec.md](docs/spec.md) for current behavior, architecture, and unsupported features.
