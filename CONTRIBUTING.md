# Contributing

Thanks for considering a contribution.

## Scope

This plugin is intentionally narrow: it changes how **assistant replies** are rendered in DeepSeek Harness. It does not touch the host's reasoning display, tool-call grouping, image galleries, or session logic.

If your idea falls outside that boundary, open an issue first — it may belong in a separate plugin.

## Adding a new block type

1. Add the type to `KNOWN_TYPES` in `src/parser.js` and `src/parser-reference.ts`
2. Add its default attributes to `DEFAULT_ATTRS`
3. Add a parse branch in `buildBlock` — **every branch must define a degradation level**
4. Add the renderer in `src/client.js`
5. Add styles in `src/rich-response.css`
6. Add test cases to `tests/parser-test.mjs` (both the happy path and the malformed path)
7. Document it in `protocol/rich-render-protocol-v1.md`

### The degradation rule

**Every block type must degrade silently.** A malformed block renders as plain markdown — never as an error, never as a broken card, never as a crash.

The five levels are defined in `protocol/rich-render-protocol-v1.md` §7. Read that section before writing a parser branch.

Unknown block types must fall back to level 2 (plain markdown). A renderer that only understands the types it was born with is not extensible.

### Streaming

Blocks arrive while the model is still writing. The parser must:

- return **no blocks** for a half-open fence — the text renders as ordinary markdown meanwhile
- return the block once the closing fence lands
- never throw on truncated input

## Before you open a pull request

```bash
npm run test:all
```

All three suites must pass:

| Suite | What it guards |
|---|---|
| `tests/parser-test.mjs` | protocol parsing and the degradation matrix |
| `tests/verify-build.mjs` | build output staying in sync with source |
| `tests/check-seam.mjs` | the DSH host API contract |

`check-seam.mjs` is the important one. The first implementation of this plugin guessed three host APIs wrong and would not have rendered at all. Every host API you touch must be confirmed against the DSH source, and the assertion added to that suite.

## Style

- Zero runtime dependencies. Do not add one without explaining why in an issue first.
- The build stays a plain copy + CSS injection — no bundler.
- Comments explain *why*, not *what*. Reference the source file when a host behaviour is non-obvious.

## Reporting bugs

Please include:

- DSH version (`dsh --version`)
- Your OS
- Whether the reply contained block markers
- What you expected versus what happened

A screenshot of the rendered result is worth more than a description.
