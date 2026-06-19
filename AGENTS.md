# Project Instructions

## Language
- Respond in Japanese unless the user explicitly asks for another language.

## First Steps
- Read `PROJECT.md` before substantial work.
- Inspect the existing structure before editing.
- Keep changes small and focused.

## Commands
- Install dependencies: `npm install`
- Run tests: `npm test`
- Run type check: `npx tsc --noEmit`
- Run build: `npm run build`
- Run dev server: `npm run dev`

## Coding Rules
- Keep source event data read-only. Do not add Google or Microsoft write scopes without an explicit requirement change.
- Do not expose secrets in frontend code. Use `NEXT_PUBLIC_` only for values safe to ship to browsers.
- Do not return event bodies, attendees, or meeting join URLs from API responses.
- Preserve the normalized event shape in `src/domain/schedule.ts` unless the API contract is intentionally changed.

## Documentation
- Durable project direction belongs in `PROJECT.md`.
- One-off implementation plans belong in `docs/plans/`.
- Command execution policies belong in `.codex/rules/*.rules` only when needed.

## Completion Criteria
- Run `npm test` after behavior changes.
- Run `npx tsc --noEmit` before claiming TypeScript correctness.
- Run `npm run build` before claiming the app builds.
