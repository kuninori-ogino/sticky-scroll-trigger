# Contributing

## Setup

Node.js `24.18.1` (see [.nvmrc](.nvmrc)).

```bash
npm ci
npm run dev
```

## Development workflow

| command                                    | description                                                                      |
| ------------------------------------------ | -------------------------------------------------------------------------------- |
| `npm run dev`                              | Starts the Vite dev server for `demo/`                                           |
| `npm run typecheck`                        | Runs `tsc --noEmit` for both the library and the demo                            |
| `npm run lint` / `format` / `format:check` | Lints/formats with ESLint + Prettier                                             |
| `npm test` / `test:watch`                  | Vitest unit tests                                                                |
| `npm run playwright:install`               | First run only: fetches Chromium and WebKit for Playwright into the shared cache |
| `npm run test:e2e`                         | Playwright e2e tests                                                             |

Before opening a PR, run the following command sequence:

`npm run format:check && npm run typecheck && npm test && npm run build:lib && npm run build && npm run test:e2e`

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the same command sequence.

Husky hooks are set up automatically by the `prepare` script during `npm ci`: `pre-commit` runs `lint-staged` (ESLint + Prettier on staged files), and `pre-push` runs `typecheck` and `test`.

Test split:

- Node (Vitest): `position.test.ts`, `freezeWindow.test.ts`
- jsdom (Vitest): `dom.test.ts`, `structure.test.ts`, `index.test.ts`
- Real browser (Playwright): [e2e/StickyScrollTrigger.spec.ts](e2e/StickyScrollTrigger.spec.ts)

Rule of thumb: layout-dependent behavior (for example `documentTop`) belongs in e2e.

## Coding conventions

- Comments should only explain _why_ something is the way it is, never what the code already makes obvious.
- If you change the public API (the exports of `src/index.ts`), update the corresponding part of the README in the same change.

## Commit messages

Use a clear subject line that describes the change (for example: `fix: throw when endTrigger is a forward reference`).
