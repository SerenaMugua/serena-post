# Kaitox for Obsidian

Preview the active note as an **X (Twitter) Article** and push it to your drafts — straight from your vault. Part of the [Kaitox](https://github.com/kuangjiajia/kaitox-toolkit) personal toolkit.

The plugin previews, style-checks, and packages the note, then hands off to the browser: the [Kaitox Chrome extension](https://github.com/kuangjiajia/kaitox-toolkit/tree/main/apps/extension) picks the draft up on `x.com/compose/articles` inside your logged-in session and creates the Article draft there. No official API and no keys.

## Install

**From Community plugins** (once listed): Settings → Community plugins → Browse → search **Kaitox**.

**Manual:** download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/kuangjiajia/kaitox-obsidian/releases) into your vault at `.obsidian/plugins/kaitox/`, then enable **Kaitox** in Settings → Community plugins.

## Build from source

```bash
npm install
npm run build     # → dist/main.js, dist/manifest.json, dist/styles.css
```

## Source of truth

This repository is generated from the [kaitox-toolkit monorepo](https://github.com/kuangjiajia/kaitox-toolkit) (`apps/obsidian`) on each release. Open issues and PRs against the monorepo.

## License

[MIT](LICENSE)
