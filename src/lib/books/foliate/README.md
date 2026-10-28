# foliate-js (vendored)

The EPUB engine of the « Livres » option (DECISIONS.md §127). foliate-js is not published on npm, so
the files the EPUB reader needs are copied here from one commit and nothing else.

- Upstream: https://github.com/johnfactotum/foliate-js (MIT, `LICENSE`)
- Commit: `78914aef4466eb960965702401634c2cb348e9b1` (2026-05-01), also in `UPSTREAM` (read by the tests)
- `vendor/zip.js`: upstream's own build of `@zip.js/zip.js` 2.8.22 (`zip-core`, BSD-3-Clause,
  `vendor/zip.js.LICENSE`), unchanged.

Kept: `view.js`, `epub.js`, `epubcfi.js`, `paginator.js`, `fixed-layout.js`, `progress.js`,
`overlayer.js`, `text-walker.js`, `search.js`, `tts.js`, `vendor/zip.js`. Left out: every other
format (PDF, MOBI, FB2, CBZ), OPDS, dictionaries and the demo reader.

## Local patches (search for `LATERNA PATCH`)

1. `paginator.js`, `fixed-layout.js`: the book's frames get `sandbox="allow-same-origin"`, **without**
   `allow-scripts`. Upstream adds `allow-scripts` only so that listeners set from the parent fire in
   WebKit (bug 218086); the reader here takes every gesture on a layer of its own page instead, so a
   script inside a book can never run, whatever the page's Content Security Policy says.
2. `view.js`: `makeBook` opens EPUB only — the other formats' modules are not here, and their
   dynamic imports would not resolve at build time.

## Updating

Download the tree of the new commit (`https://codeload.github.com/johnfactotum/foliate-js/tar.gz/<sha>`),
copy the files listed above over these ones, re-apply the two patches, update the commit line above,
then open several books in Chromium, Firefox and WebKit and run `books-*.test.ts`. The `.d.ts` next to
`view.js` describes only what `BookReader.tsx` uses; check it still matches.
