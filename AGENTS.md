# AGENTS.md

## Project

This repository contains **xlator**, a local-first Japanese/English live conversation translator built with TypeScript and OpenAI Realtime APIs.

## Required context

- Read `docs/spec.md` at the start of every task, including code, configuration, CI/CD, test, refactoring, and documentation changes.
- Consult other files under `docs/` when they are relevant to the task. Do not load every document by default.

## Language

- Write all repository content in English, including documentation, code comments, test descriptions, and commit and pull request text.
- Communicate with the user in the language they use. Use Japanese for progress updates and handoff reports when the user writes in Japanese.
- Use Japanese only where the product requires it, such as Japanese UI copy, Japanese speech or transcript samples, localization data, and related test fixtures.

## Specification maintenance

- Treat `docs/spec.md` as the authoritative description of the current product behavior and implementation decisions.
- Before editing, identify the relevant current behavior, implementation status, verification status, and remaining work described in `docs/spec.md`.
- After editing, inspect the complete diff and compare every code, configuration, CI/CD, test, refactoring, and documentation change with `docs/spec.md`.
- Update `docs/spec.md` in the same change whenever behavior, architecture, data models, Realtime processing, UI, testing, CI/CD, operational setup, implementation status, verification status, or remaining work differs.
- Keep current behavior and future candidates clearly separated in `docs/spec.md`; never describe planned behavior as already implemented.
- Keep `implemented`, `implemented but not verified`, and `not implemented` states explicit. Never mark an API, real-device, or manual test complete unless it was actually run successfully.
- Record unresolved prerequisites and concrete completion conditions in the current-status or remaining-work section of `docs/spec.md`.
- If a change does not require a specification edit, explicitly confirm during handoff that the implementation-to-spec comparison was performed and no divergence was found.
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
- Before handoff, run `npm run verify`, inspect `git diff --check`, and perform the implementation-to-spec comparison above. Add focused tests when behavior changes.
