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
[`../ui-tests/`](../ui-tests/README.md). Show them with the `Screenshot`
component, which displays a capture at the size it has in the app:

```mdx
import Screenshot from '../../../components/Screenshot.astro';
import omnibox from '../../../assets/screenshots/omnibox.png';

<Screenshot src={omnibox} alt="The omnibox with matching commands and files" />
```

## Writing style

- Start each page with one or two sentences that say what the feature is.
- Write procedures as numbered steps (`<Steps>`), one action per step, in the
  imperative. Put the result of an action in the same step.
- Put reference information (settings, shortcuts, fields, supported agents)
  in tables. Name a setting by its label in the Settings Editor and its key.
- Show a feature with a screenshot cropped to that feature, not the whole
  window.
- Write UI labels in bold, exactly as the app shows them. Menu paths start
  from the menu button (☰), for example **View → Appearance → Show Menu
  Bar**.
- State facts in the present tense. Do not tell a story about the feature or
  explain why it is good.
