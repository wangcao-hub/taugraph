# Contributing

Thanks for helping. taugraph stays useful only while the kernel stays small, so please read the rules below before opening a PR.

## Kernel rules

- **No runtime dependencies.** `package.json` must keep `dependencies` empty. CI enforces this.
- **`src/core` imports only `src/core`.** No plugins, no `node:*` modules, no platform globals beyond what browsers also have.
- **No domain features in the kernel.** LLMs, tools, memory, retrieval and persistence belong in plugin nodes or separate packages.
- **The trace format is a public contract.** Any breaking change to [docs/trace-format.md](./docs/trace-format.md) bumps `TRACE_VERSION`.
- Plugin nodes in `src/nodes` import only `../index.js`, the same public API third-party plugins use.

If a feature seems to need a kernel change, open an issue first and describe the smallest hook that would let it live outside the kernel.

## Setup

Node ≥ 22 and pnpm 9.

```
pnpm install
pnpm check      # tsc --noEmit, biome check, vitest run
pnpm build
```

`pnpm format` applies formatting and import sorting.

## Pull requests

- One change per PR, with tests. Type-level guarantees go in `test/types.test.ts`.
- Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).
- Add a line under "Unreleased" in [CHANGELOG.md](./CHANGELOG.md) for user-visible changes.

## Releasing (maintainers)

1. Move the "Unreleased" entries in `CHANGELOG.md` under a new `## [x.y.z] - YYYY-MM-DD` heading, add its compare link at the bottom, and bump `version` in `package.json`.
2. Commit, push, and wait for CI to pass.
3. `npm publish --auth-type=web`. It runs `pnpm check` and `pnpm build` first. npm requires two-factor authentication for publishing; approve the request in the browser. A new version can take a few minutes to become installable.
4. Tag and release: `git tag -a vx.y.z -m "taugraph x.y.z" && git push origin vx.y.z`, then `gh release create vx.y.z --notes-file <the changelog section>`.
