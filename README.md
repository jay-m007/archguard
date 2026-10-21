# ArchGuard

**Architecture drift detection for JavaScript and TypeScript codebases.**

ArchGuard reads a project's source code, builds a dependency graph of every file, and finds the structural problems that make codebases hard to change: circular dependencies, imports that break your intended layering, oversized "god files", and dead code. It gives the project a health score so you can see architecture improve or decay over time.

> College project by [@bytebyjay](https://github.com/bytebyjay). It rebuilds the idea behind **CodeSee** (a code-visualisation startup that shut down in 2024): static diagrams go stale, so ArchGuard focuses on detecting *drift* continuously.

```
$ archguard analyze .

ArchGuard v0.1.0  ~/projects/my-next-app
config: defaults (Next.js preset) · aliases: tsconfig.json · 54 ms

Health 42/100 grade D   (15.5 drift points across 11 files)
11 files · 10 internal imports · 4 external packages · 1 unresolved

Circular dependencies (0)
  ✓ none

Layer violations (3)
  ✗ routes -> api  src/app/dashboard/page.tsx:1 → src/app/api/users/route.ts
  ✗ components -> api  src/components/Card.tsx:1 → src/app/api/users/route.ts
  ✗ lib -> components  src/lib/format.ts:1 → src/components/Card.tsx
...
```

## Status

| Phase | Scope | Status |
|---|---|---|
| 1 | Core engine + CLI: parsing, alias resolution, cycles, layers, metrics, score, JSON report | ✅ Done |
| 2 | Dashboard: interactive dependency graph (Next.js + React Flow) | ⏳ Next |
| 3 | GitHub Action: comment on PRs with *newly introduced* violations, plus LLM-written explanations | Planned |
| 4 | Drift over time: score every commit in git history and chart it | Planned |

## Quick start

```bash
git clone https://github.com/bytebyjay/archguard.git
cd archguard
npm install
npm run build
npm test

# analyse any project
node packages/cli/dist/index.js analyze /path/to/your/project

# create a config to customise layers and rules
node packages/cli/dist/index.js init /path/to/your/project
```

### CLI options

```
archguard analyze [path] [options]
  -c, --config <file>     Config file (default: <path>/archguard.config.json, else the Next.js preset)
  -o, --out <file>        JSON report location (default: <path>/archguard-report.json)
      --no-report         Don't write a JSON report
      --json              Print the JSON report to stdout
      --fail-on <level>   error | warning | none  (default: error). Exit code 1 if issues at that level exist
      --limit <n>         Items listed per section (default: 10)
archguard init [path]     Write a starter archguard.config.json
```

Exit codes: `0` passed · `1` issues at the `--fail-on` level · `2` could not run. That makes it usable in CI.

## What it detects

| Check | Severity | Meaning |
|---|---|---|
| Circular dependency | error | A group of files that (indirectly) import each other. This causes `undefined` imports at runtime, breaks tree-shaking, and makes modules impossible to change in isolation. |
| Layer violation | error | An import that breaks a rule, e.g. a reusable component importing an API route handler. |
| God file | warning | A file that imports too many modules, is a high-traffic hub (high fan-in **and** fan-out), or is too long. |
| Orphan file | info | A file nothing imports that the framework doesn't load either. Usually dead code. |
| Unresolved import | listed | A relative path or alias that points to a file that doesn't exist. |

## How it works

```
 discover files ──► parse to AST ──► resolve specifiers ──► dependency graph ──► analyzers ──► score ──► report
  (fast-glob)       (TS compiler)     (TS module resolver)    (adjacency list)     │
                                                                                  ├─ Tarjan SCC → cycles
                                                                                  ├─ layer rules → violations
                                                                                  └─ coupling metrics → god files, orphans
```

### 1. Parsing with an AST, not regex
Each file is parsed into an **Abstract Syntax Tree** using the TypeScript compiler API, which also understands plain JavaScript and JSX. ArchGuard walks the tree and collects every module reference:

`import x from`, `import "./side-effect"`, `export * from`, `export { a } from`, `import()`, `require()`, `import x = require()` and `import("./x").Type`.

Working on the AST means commented-out imports and strings that only *look* like imports are ignored. It also lets ArchGuard tell **type-only imports** (`import type`, `import { type A }`) apart from runtime imports. Type-only imports are erased during compilation, so by default they can't create a runtime cycle.

### 2. Resolving paths like a bundler
`"@/components/Button"`, `"../utils"` and `"react"` are resolved with TypeScript's own module resolver, configured from the project's `tsconfig.json` or `jsconfig.json`. That gives correct handling of `paths` aliases, `baseUrl`, `extends` chains, extensionless imports, `index` files and `package.json` exports, the same way editors and Next.js resolve them. Each import becomes an internal edge, an external package, an asset (CSS, images…), or *unresolved*.

### 3. The dependency graph
Files are nodes and imports are directed edges (`A → B` means "A imports B"), stored as an **adjacency list** (`Map<file, Set<file>>`). That's O(V + E) memory, and each node's neighbours can be looked up in time proportional to how many there are.

### 4. Cycle detection: Tarjan's strongly connected components
A **strongly connected component (SCC)** is a maximal set of nodes where every node can reach every other node. Every SCC with more than one file, or a file that imports itself, is a circular dependency.

Tarjan's algorithm finds all SCCs in a single depth-first search:

1. Give every node an `index` in the order it is first visited, and push it onto a stack.
2. Track `lowlink[v]`: the smallest index reachable from `v` through its DFS subtree, plus at most one back edge to a node still on the stack.
3. When `v` finishes and `lowlink[v] == index[v]`, `v` is the root of an SCC. Pop the stack down to `v`; those nodes form the component.

It runs in **O(V + E)**. ArchGuard's implementation is *iterative* (an explicit work stack instead of recursion), so a 20,000-file import chain cannot overflow the call stack; there's a test for exactly that. For each cycle, a **breadth-first search** inside the component then finds the *shortest* concrete loop (`a.ts → b.ts → a.ts`), so developers see the easiest edge to cut. It runs one BFS from every file in the component. For tangles of more than 300 files it falls back to a single BFS, which still gives a valid loop but not necessarily the shortest.

### 5. Layer rules
Files are assigned to layers by glob patterns, where the first match wins. With no config, ArchGuard uses a Next.js preset:

| Layer | Folders (root or `src/`) | Must not import |
|---|---|---|
| `api` | `app/api/**`, `pages/api/**` | — |
| `services` | `app/**/actions/**`, `app/**/actions.ts` (Server Actions), `services/**`, `server/**`, `actions/**` | `routes`, `components`, `hooks` |
| `routes` | `app/**`, `pages/**` | `api` |
| `components` | `components/**` | `routes`, `api` |
| `hooks` | `hooks/**` | `routes`, `api`, `components` |
| `lib` | `lib/**`, `utils/**`, `helpers/**`, `config/**`, `constants/**`, `types/**` | everything above |

Server Actions colocated under `app/` count as `services`, not `routes`: components are meant to import them, so that isn't flagged. Rules can be `disallow` lists (blacklist) or `allow` lists (whitelist).

### 6. Coupling metrics
For each file, ArchGuard computes **fan-in** (afferent coupling, Ca: how many files depend on it) and **fan-out** (efferent coupling, Ce: how many files it depends on). From those it calculates Robert C. Martin's **instability**:

```
I = Ce / (Ca + Ce)        0 = stable (e.g. lib/utils.ts)   1 = unstable (e.g. a page)
```

In a healthy architecture, dependencies point from unstable code toward stable code.

### 7. Health score

```
driftPoints = 10 × (files in cycles) + 5 × (layer violations) + 3 × (god files) + 0.5 × (orphans)
density     = driftPoints / (number of files)
health      = 100 / (1 + density)
```

Dividing by the number of files makes a 20-file project and a 2,000-file project comparable. The `100 / (1 + x)` curve gives 100 for a clean codebase and 50 at one drift point per file, and it never goes negative. Grades: A ≥ 90, B ≥ 75, C ≥ 60, D ≥ 40, F below that.

## Configuration

Run `archguard init` to generate `archguard.config.json`, then edit it:

```json
{
  "exclude": ["**/*.test.ts", "scripts/**"],
  "layers": [
    { "name": "ui", "patterns": ["src/components/**"] },
    { "name": "domain", "patterns": ["src/domain/**"] },
    { "name": "infra", "patterns": ["src/db/**", "src/api/**"] }
  ],
  "rules": [
    { "from": "domain", "allow": [], "reason": "Domain logic must be framework-independent." },
    { "from": "ui", "disallow": ["infra"], "reason": "UI talks to infra through the domain layer." }
  ],
  "thresholds": { "maxFanOut": 15, "hubFanInOut": 10, "maxLoc": 500 },
  "ignoreTypeOnlyImports": true,
  "reportOrphans": true
}
```

Arrays you provide replace the defaults, except `exclude`, which adds to the built-in excludes (`node_modules`, `.next`, `*.d.ts`…). Build-output folders (`dist`, `build`, `out`, `coverage`) are skipped only when they sit next to a `package.json`, so a source folder like `src/lib/build/` is still analysed.

## Known limitations

- Only the root `tsconfig.json`/`jsconfig.json` is read. In a monorepo, aliases defined in a nested package's tsconfig aren't applied, so analyse that package's folder directly.
- A violation's identity (`key`) for a cycle is its whole set of files. If a cycle grows by one file, comparing two reports shows it as one resolved cycle plus one new cycle.
- Shadowed `require` is detected per file, not per scope (a deliberate simplification).
- Imports built from variables (`import(\`./${name}\`)`) can't be followed statically and are skipped.

## Tested on real projects

| Project | Files | Imports | Time | Result |
|---|---|---|---|---|
| [shadcn/taxonomy](https://github.com/shadcn-ui/taxonomy) | 129 | 258 | 0.4 s | A (91). No cycles. Finds unused shadcn/ui components and an unbuilt `contentlayer/generated` alias. |
| [vercel/commerce](https://github.com/vercel/commerce) | 66 | 120 | 0.2 s | A (96). One hub file: `lib/shopify/index.ts`. |
| [excalidraw](https://github.com/excalidraw/excalidraw) | 702 | 3,732 | 2.2 s | F (24). 7 cycles, the largest spanning 105 files through barrel `index.ts` re-exports. Each was verified by hand. |

## Project structure

```
packages/
  core/                  # the analysis engine (library)
    src/
      analyze.ts         # pipeline orchestrator
      config.ts          # defaults (Next.js preset), loading, validation
      discover.ts        # file discovery
      extract.ts         # AST import extraction
      resolve.ts         # specifier → file resolution (tsconfig aware)
      graph.ts           # adjacency-list dependency graph
      analyzers/
        cycles.ts        # Tarjan SCC + shortest-loop BFS
        layers.ts        # layer matching + rule checking
        metrics.ts       # fan-in/out, instability, god files, orphans
      score.ts           # health score
      diff.ts            # compare two reports (for PR checks)
    test/                # Vitest unit + fixture tests
      fixtures/          # small sample projects: cycles, Next.js app, plain JS
  cli/                   # `archguard` command-line tool
```

## Development

```bash
npm test            # run all tests
npm run test:watch  # watch mode
npm run typecheck   # strict TypeScript check
npm run build       # compile to dist/
```

## License

MIT
