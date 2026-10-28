# Security bench of the book reader

The « Livres » option (DECISIONS.md §127) renders untrusted EPUB content. Three independent barriers
keep it inert: the content is sanitized before it becomes a document (`src/lib/books/sanitize.ts`),
the frames that show it have no `allow-scripts` (local foliate-js patch), and the `/livres` page has
its own Content Security Policy, inherited by the `blob:` chapter documents. `books-sanitize.test.ts`
covers the first one in jsdom; this bench proves the whole chain in real browsers.

1. `make-epub.py <out.epub> <spy origin>` writes a trapped EPUB — inline and remote scripts, `on…`
   attributes, `javascript:` links, external images, stylesheets, `@import`, fonts, frames, objects,
   SVG scripts, a meta refresh — every one of them aimed at the spy origin — and the raw trapped
   chapter next to it (`<out.epub>.xhtml`).
2. Put the EPUB in the books library of a **throwaway** Jellyfin, scan it, and start a throwaway
   instance with `BOOKS_ENABLED=true` pointed at it.
3. `BASE=http://localhost:<port> CREDS=<user=/password= file> BOOK=<item id> RAW=<out.epub>.xhtml run.sh <results>`

`run.sh` starts the spy (a listener on `127.0.0.1:18999` that logs every request it receives), opens
the book in Chromium, Firefox and WebKit, and checks in each: the frame's `sandbox` is
`allow-same-origin` only, no script ran (no mark on the page, the frame's title unchanged), no `on…`
attribute and no `<script>` reached the document, tapping the `javascript:` and external links does
nothing, and no request left the application. It then shows the raw chapter (sanitizer skipped) in a
frame like the reader's — nothing may run — and in a frame like upstream foliate-js's
(`allow-scripts`), where the inline script does run and only the page's policy keeps its requests
inside the application; that last case is reported, not failed. The run fails if any browser fails or
if the spy received a single request.
