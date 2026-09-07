# README style

[Simplified Chinese](i18n/zh-CN/docs/readme-style.md)

This guide keeps every Pi Stuff README concise, navigable, and visually consistent. The root README follows the
structure of [Best README Template](https://github.com/othneildrew/Best-README-Template); Package, Capability, and
index READMEs use smaller variants suited to their scope.

## README roles

| README | Purpose | Sections |
| --- | --- | --- |
| Root | Introduce the Suite and route a new user | Hero, About, Preview, Getting Started, Usage, Documentation, Contributing, Security, Acknowledgments, License |
| Package | Explain the installed Package | Name and purpose, Preview, Capabilities, Installation, Documentation |
| Capability | Introduce one user-facing capability | Name and purpose, Preview, Quick Start, Highlights, Documentation |
| Index | Help readers choose a destination | Name and purpose, visual index, categorized links |
| Test directory (`tests/`) | Explain test layout and execution | Name and purpose, directory guide, commands, benchmark boundary |

Omit a section when it has no useful content. Acknowledgments belongs only in the root README.

## Content boundary

READMEs are entry pages. Keep setup steps, the smallest useful example, primary outcomes, and links to detailed
documentation.

Move these elsewhere:

- full command syntax to [Command reference](reference/commands.md);
- settings fields and defaults to [Settings reference](reference/settings.md);
- terminal and integration recovery to [Troubleshooting](troubleshooting.md);
- detailed capability behavior to `docs/capabilities/`;
- ownership vocabulary to `CONTEXT.md`;
- shared visual rules to `DESIGN.md`;
- durable trade-offs to ADRs;
- dated evidence to research, reports, and release notes.

Do not narrate the documentation process in user copy. Avoid “according to ADR…”, proof-like lifecycle statements,
internal maintenance disclaimers, and repeated rationale already owned by another document.

## Root badges

Use two centered rows in this order:

1. CI, MIT License, GitHub stars, GitHub forks, last commit.
2. Pi `0.85.1`, Bun `1.4.0`, TypeScript `5.9.3`, Linux x64.

Badges link to the workflow, license, repository activity, compatibility reference, or relevant upstream project.
Do not add npm, release, or issue-count badges.

## Screenshots

READMEs under `tests/` are text-only engineering guides and do not require screenshots. Every other README contains at least one unique screenshot. Simplified Chinese mirrors reuse the same PNG and translate only
the surrounding alt text and caption.

Use this exact block for every README image:

```html
<p align="center">
  <a href="docs/assets/readme/root/hero.png">
    <img src="docs/assets/readme/root/hero.png" alt="Pi Stuff in Ghostty" width="100%">
  </a>
  <br>
  <em>Pi Stuff keeps active work visible without crowding the conversation.</em>
</p>
```

Adjust the relative path, alt text, and caption for the owning README. Keep each image in its own vertical block.
Never mix standalone bold labels, tables, `<figure>`, or baked-in callouts with this pattern.

### Capture standard

- Capture a real Pi `0.85.1` session in Ghostty `1.3.1`.
- Use Catppuccin Latte and JetBrainsMono Nerd Font Mono.
- Use English UI and synthetic, disposable demo data.
- Exclude credentials, user Sessions, private paths, and unrelated desktop content.
- Hide OS chrome and frame the terminal on the shared soft-lavender background with the same radius and shadow.
- Capture above the target resolution, then downsample to a final `1600×900` PNG.
- Use `different-ai/openwork@agent-first-screenshots` for vision checks, crop, and framing after the native Ghostty
  capture.
- Keep README previews as PNG. Put any necessary motion demo in the detailed capability guide.

Diagram-oriented READMEs render a real `chart` or `tree` fence inside Pi and capture that terminal state. Diagram labels
are content; editorial arrows and callouts are not baked into the image.

### Asset layout

Store assets under `docs/assets/readme/<readme-slug>/`:

| README | Required asset |
| --- | --- |
| Root | `root/hero.png`, `root/workflow.png`, `root/architecture.png` |
| Engineering docs index | `docs/index.png` |
| Research index | `research/index.png` |
| Reports index | `reports/index.png` |
| Package | `package/suite.png`, `package/commands.png` |
| Themes | `themes/latte.png` |
| Capability Modules | `capabilities/<module>.png` |
| MCP runtime | `runtime/mcp.png` |
| Web runtime | `runtime/web.png` |

## Links and translations

Use repository-relative links for files and HTTPS links for external projects. A Chinese mirror links to mirrored
documentation where available and shares the English source's image asset.

After editing an English Markdown source:

1. Update its mirror under `docs/i18n/zh-CN/<repository path>`.
2. Set the mirror's `translation-source` to the English repository path.
3. Set `translation-source-sha256` to the raw English file's lowercase SHA-256.
4. Run the repository documentation checks.

## Review checklist

- The first screen explains what the component does and shows it in Pi.
- Quick Start contains only the shortest successful path.
- Detailed behavior has one owning document and is linked instead of repeated.
- Commands, settings, names, and versions match the current source.
- Every image uses the standard block, is `1600×900` PNG, has meaningful alt text and a caption, and is clickable.
- English and Simplified Chinese navigation reach equivalent content.
- No link, translation header, screenshot, or indexed document is stale.
