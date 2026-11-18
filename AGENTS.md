<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Third-party code

Copy third-party code only as fragments under MIT, BSD, ISC, or Apache-2.0. Above each fragment, comment the project, URL, author, license, and commit. Do not copy GPL, LGPL, or AGPL code; ideas from those projects may be reimplemented. A new dependency must use a compatible license (MIT, BSD, ISC, Apache-2.0, or a permissive equivalent such as 0BSD or CC0). Record every used project in `THIRD_PARTY_NOTICES.md`: authors, links, the full license text, and the Apache `NOTICE` when the package has one. Every copied fragment is listed there too. The README thanks projects whose ideas were used.

The allowlist checked on 2026-11-18 is in `THIRD_PARTY_NOTICES.md`. Do not copy `localsend/protocol` (no license): implement LocalSend v2 yourself. Do not vendor CompactGUI `database.json`. Do not use Tdarr, FileFlows, or leovp/steamfiles. Krokiet and Cedinia are GPL; only `czkawka_core` (MIT) may be copied. Abandoned `fsnotify` / `fsevents` bindings are not a source.
