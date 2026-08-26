# AGENTS.md

## Project

This repository contains **xlator**, a local-first Japanese/English live conversation translator built with TypeScript and OpenAI Realtime APIs.

## Required context

- Read `docs/spec.md` before making product, data-model, realtime, or UI changes.
- Consult other files under `docs/` when they are relevant to the task. Do not load every document by default.

## Specification maintenance

- Treat `docs/spec.md` as the authoritative description of the current product behavior and implementation decisions.
- Before handing off any change, compare the implementation with `docs/spec.md` and update the specification in the same change whenever behavior, architecture, data models, Realtime processing, or UI decisions differ.
- Keep current behavior and future candidates clearly separated in `docs/spec.md`; never describe planned behavior as already implemented.
- Do not merge a change while the implementation and `docs/spec.md` disagree.

## Product invariants

- Japanese and English may alternate on every utterance.
- Store one aligned utterance row with both `ja` and `en`; never model the two language logs as unrelated arrays.
- On desktop, the Japanese log is left and the English log is right; narrow screens stack them vertically.
- Keep source speech as the source-side text and translate only the opposite side. Minor ASR normalization is expected.
- Speaker diarization is a future feature and must not block the MVP.
- OpenAI API keys stay server-side. Browser connections must use short-lived client secrets.

## Implementation conventions

- Use TypeScript for both browser and local server code.
- Keep UI copy primarily in Japanese; use plain, accessible labels and visible focus states.
- Treat the current sample transcript as deterministic initial-screen fixture data. Starting a Realtime session replaces it with live rows.
- Prefer small components and explicit types over framework abstractions.
- Before handoff, run `npm run build`. Run lint or focused tests when the change warrants them.
