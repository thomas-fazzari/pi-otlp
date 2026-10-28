# Dear Clanker

pi-otlp is an extension for the Pi coding agent that exports OpenTelemetry metrics, traces and logs over OTLP. Pi loads `src/index.ts` directly, the project has no build step.

## Repo layout

- `src`: the extension. `src/index.ts` is the entry point that `package.json` declares to Pi.
- `test`: tests that `bun test` runs.
- `scripts`: repository scripts, also run as mise tasks.

## Code guidelines

- Prefer plain control flow: early returns, small helpers, `if` / `switch` over nested ternaries. Never pack several conditions, ternaries and template strings into one expression.
- Write almost no comments: add one only for a constraint the code cannot show, in one line.
- Do not write interim code that a later step will delete. Let the unfinished path fail with its normal error until the real implementation lands.
- Change only what the task needs. Report unrelated problems instead of fixing them.

### TypeScript conventions

- Pi runs extensions under Bun through jiti. Use only erasable syntax and import relative files with their `.ts` extension.
- Pi provides `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` at runtime, so runtime imports from them are allowed. Never list them in `dependencies`.

### Tests

- Add a test only when its failure would reveal a real bug in logic. Do not add tests that only prove wiring.
- Test through public behavior, not private helpers.

## Validation

Before reporting work as done, run `mise run check`.

## Instruction files

- Add a rule only for a trap that recurs and that neighboring code cannot show. Do not restate what the code already does.
- Change this file only when the task asks for it. Suggest new rules in your report instead.

## Prose

- Write for someone unfamiliar with this repository. Give enough context to understand behavior and find the relevant details.
- Use short sentences and common words. You may expand uncommon abbreviations on first use. No semicolons, em dashes, filler, repetition and long parentheses.
- Lead with the behavior, responsibility or decision the reader needs. Use concrete names and active verbs. Remove generic claims about quality.
- Write standalone prose. Preserve the reason for a decision without referring to conversations, agent activity or the sequence of edits.
