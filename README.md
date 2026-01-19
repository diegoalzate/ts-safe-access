# ts-safe-access

`ts-safe-access` is a small utility that scans a TypeScript project for common
"possibly null or undefined" errors and automatically inserts optional chaining
(`?.`) or optional calls (`fn?.()`) where it is safe to do so. It can run against
an on-disk project or against in-memory source text for programmatic use.

## What it fixes

By default it targets the following TypeScript diagnostic codes:

- **TS2531**: Object is possibly 'null'.
- **TS2532**: Object is possibly 'undefined'.
- **TS2533**: Object is possibly 'null' or 'undefined'.
- **TS18048**: 'x' is possibly 'undefined'.
- **TS2722**: Cannot invoke an object which is possibly 'undefined'.

The fixer is conservative: it skips write contexts (assignments, `++`, `delete`),
`super` access, and any chain that already uses non-null assertions (`!`).

## Quick start

### Install dependencies

```bash
bun install
```

> **Note**: TypeScript is a peer dependency. If it is not already in your
> project, add it with `bun add -d typescript` or your package manager of choice.

### Run against a project

```bash
bun run index.ts --project ./tsconfig.json
```

Use `--dry` to see how many edits would be applied without writing files:

```bash
bun run index.ts --project ./tsconfig.json --dry
```

Limit the run to a directory under the project root:

```bash
bun run index.ts --project ./tsconfig.json --dir ./src
```

Override diagnostic codes or max passes:

```bash
bun run index.ts --codes 2531,2532,2533,18048,2722 --maxPasses 5
```

## Programmatic usage

You can call the fixer in-memory (e.g. for editor tooling or CI checks):

```ts
import { fixSourceText } from "./index";

const { text, totalChanges } = fixSourceText({
  text: "const x = maybe?.value;\nconsole.log(maybe.value);\n",
});

console.log(totalChanges);
console.log(text);
```

### Configuration options

`fixSourceText` and `fixInMemoryProject` accept the following options:

- `codes`: `Set<number>` of diagnostic codes to handle.
- `maxPasses`: maximum number of fix passes to perform.
- `compilerOptions`: standard TypeScript compiler options.

## Development

Run the tests with:

```bash
bun test
```
