# Kaitox — Obsidian plugin

This is the **distribution repository** for the Kaitox Obsidian plugin, submitted to
the Obsidian community-plugins directory. It only holds the plugin `manifest.json`,
`versions.json`, and the compiled release assets — no source code.

**Source, issues, and development** live in the main monorepo:
<https://github.com/kuangjiajia/kaitox-toolkit> (see `apps/obsidian`).

Kaitox is a personal toolkit. This plugin syncs the active note to X (Twitter) as an
Article draft, via a local relay and a browser extension.

## Install

- **From Obsidian:** Settings → Community plugins → Browse → search **"Kaitox"**.
- **Manual:** download `main.js`, `manifest.json`, and `styles.css` from the latest
  [Release](../../releases/latest) into `<vault>/.obsidian/plugins/kaitox/`, then
  enable the plugin.

## Releases

Releases here are published automatically by the
[`release-obsidian`](https://github.com/kuangjiajia/kaitox-toolkit/blob/main/.github/workflows/release-obsidian.yml)
workflow in the monorepo whenever an `obsidian-v*` tag is pushed. The release tag is
the bare version (e.g. `0.6.1`) so it matches `manifest.version`, as Obsidian requires.

## License

MIT — see [LICENSE](LICENSE).
