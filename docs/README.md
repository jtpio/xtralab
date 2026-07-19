# xtralab documentation

The documentation site, built with [Starlight](https://starlight.astro.build)
and deployed to <https://jtpio.github.io/xtralab/> by the `docs` GitHub Actions
workflow whenever `main` changes.

## Develop

```bash
cd docs
pnpm install
pnpm dev
```

`pnpm build` produces the production site in `dist/`, with `/xtralab` as the
base path; `pnpm preview` serves that build locally.

## Content

Pages live in `src/content/docs/` as MDX. Screenshots live in
`src/assets/screenshots/` and are regenerated with the Galata suite in
[`../ui-tests/`](../ui-tests/README.md).
