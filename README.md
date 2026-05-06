# Maximus

**Open, browse, edit and search files of any size** — even hundreds of GB — directly in VS Code, without loading them into memory.

VS Code refuses to open files larger than ~50 MB. Maximus removes this limit entirely with streaming I/O and virtual rendering: your editor stays responsive no matter how big the file is.

## Features

- **Instant open** — A 2 GB file opens in ~3 seconds. No waiting, no memory spike.
- **Full-text search** — Find any needle across the entire file in seconds, with regex, case-sensitivity and whole-word options.
- **Find & Replace** — Replace all occurrences across the file with live progress.
- **In-place editing** — Click anywhere to type. Edits are stored in memory and only touch the disk when you save.
- **Smart save** — If your edits don't change line sizes, Maximus patches the file in place (< 50 ms). Otherwise it performs a surgical binary rewrite.
- **Go to Line** (`Ctrl+G`) — Jump to any line/column instantly, even in a 40-million-line file.
- **Syntax highlighting** — 35+ languages highlighted on visible lines only — no overhead.
- **Works everywhere** — Linux, macOS, Windows. No native dependencies.

## How to use

1. Right-click any file in the Explorer
2. Select **Open With...** then choose **Maximus**
3. That's it — browse, search and edit as you would in any text editor

Maximus never replaces your default editor. It's always available via "Open With..." for any file.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+F` | Search |
| `Ctrl+H` / `Ctrl+Shift+F` | Search & Replace |
| `Ctrl+G` | Go to line |
| `Ctrl+S` | Save |
| `Ctrl+A` | Select all |
| `Double-click` | Select word |
| `Shift+Click` / `Shift+Arrows` | Extend selection |

## Configuration

| Setting | Default | Description |
|---|---|---|
| `maximus.indexEveryNLines` | 1000 | Indexing granularity (lower = more RAM, faster line access) |
| `maximus.bufferLines` | 20 | Extra lines pre-loaded above/below the viewport |
| `maximus.searchWorkers` | auto | Number of CPU cores used for search and indexing |

## Supported languages (syntax highlighting)

JSON, YAML, TOML, XML, HTML, CSS, SQL, Markdown, JavaScript, TypeScript, Python, Java, C/C++, C#, Go, Rust, Ruby, PHP, Swift, Kotlin, Scala, Lua, R, Dart, Shell scripts, Dockerfiles, Makefiles, and more.

Any file without a recognized extension is displayed as plain text with no performance cost.

## Known limitations

- Encoding: UTF-8 only (for now)
- Very long lines (> 64 KB) may be visually truncated
- Line insertion/deletion is not yet supported (only content modification within existing lines)

## Install

Search **"Maximus"** in the VS Code Extensions panel, or [install from the Marketplace](https://marketplace.visualstudio.com/items?itemName=maximus1.maximus).

## Links

- [GitHub](https://github.com/WilliamL92/Maximus)
- [Changelog](https://github.com/WilliamL92/Maximus/releases)
- [Report an issue](https://github.com/WilliamL92/Maximus/issues)
