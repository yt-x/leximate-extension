# Leximate

A Chrome/Edge (Manifest V3) vocabulary notebook for reading English on the web: select a word on any page, get its Chinese definition and phonetics instantly from a bundled offline dictionary, and keep the word together with the sentence you met it in — stored locally, with no account, no server, and no network request from the page.

Not affiliated with MetWord (遇见单词) or any other product.

Release: **0.2.0**. This branch contains functional source code and user-facing documentation. Internal specifications, change records and verification evidence are not published on this branch.

## Status

M0 (the standalone export script), M1 (the selection-to-notebook loop) and M2 (example capture, MetWord/JSON import, diagnostics, backup health) are implemented. The word list holds 3004 entries, the high-frequency ones built into a resident shard and queried in-process. M3 is implemented in code — WebDAV sync (`utils/sync`) and the translation pipeline (`utils/translate`) — and still needs verification against a real WebDAV account and a real translation service.

## Development

Requires **Node 22.18+** and pnpm 11+. The build scripts are TypeScript, executed through Node's native type stripping (enabled by default from Node 22.18). Development happens on Node 26; CI runs Node 22, so 22.18 is the real floor.

```bash
pnpm install
pnpm dev          # Chrome with the extension loaded and hot reload
pnpm build        # production build into .output/chrome-mv3
pnpm compile      # type check only
pnpm test         # unit tests
pnpm verify       # all three drift gates plus the content-script boundary gate
pnpm dict         # regenerate phonetics, shards and the inflection index
pnpm dict:pron    # regenerate the phonetic column from the pinned CMUdict
pnpm dict:check   # fail if the TSV or the built shards drifted from their sources
pnpm zip          # packaged zip for store submission
```

The dictionary source of truth is [data/core-words.tsv](data/core-words.tsv). Two of its columns are hand-written (`pos`, `defZh`); the phonetic column is **generated** from the pinned CMUdict copy under `data/pronunciation/` via a project-authored ARPAbet-to-IPA mapping, so it can be recomputed and audited offline. `public/dict/` is generated from the TSV. Both are committed, and `pnpm dict:check` gates drift in CI.

Phonetic data comes from the CMU Pronouncing Dictionary (BSD-2-equivalent, commercial use unrestricted); see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Chinese definitions are written by this project and are not taken from any third-party dictionary.

To load a build manually: open `chrome://extensions`, enable Developer mode, choose "Load unpacked", and select `.output/chrome-mv3`.

## Your data lives only on this machine

This extension keeps everything local: words, example sentences, settings and the dictionary shards all live in the extension's own IndexedDB / bundled files. There is no account and no server-side copy.

**Uninstalling the extension (or clearing browser data for it) deletes all of it, and it cannot be recovered.** Export a JSON backup from the 生词 (Words) page's toolbar before uninstalling or switching machines.

The first-run guide shows this warning too, and the same text is repeated on the Settings page.

## Release documentation

| Topic | Covers | Link |
|---|---|---|
| Privacy | Local data and optional outbound paths | [PRIVACY.md](PRIVACY.md) |
| Release history | Versioned changes and verification | [CHANGELOG.md](CHANGELOG.md) |
| Contributing | Setup, checks, and change workflow | [CONTRIBUTING.md](CONTRIBUTING.md) |
| License | Project license | [LICENSE](LICENSE) |

Chinese version: [README.zh-CN.md](README.zh-CN.md).
