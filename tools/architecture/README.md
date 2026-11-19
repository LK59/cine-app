# ARCHITECTURE.svg

`ARCHITECTURE.svg`, at the root of the repository, is the « Application map » section of
[`DOC-TECH.md`](../../DOC-TECH.md) drawn on one zoomable page. It is generated, never edited by hand:
change a diagram or the paragraph that follows it in DOC-TECH.md, then run

```sh
tools/architecture/build.sh
```

Docker is the only requirement: every step runs in the `minlag/mermaid-cli` image (Node, Chromium and
`mmdc`, pinned in `build.sh`), as the invoking user, in a temporary folder removed at the end.

| Step | File | What it does |
|---|---|---|
| Extract | `extract.mjs` | Reads every ```` ```mermaid ```` block of the section, in order, with its numbered heading (`3a. …`) and the first paragraph after it (cut before « Details: »). |
| Render | `mermaid.json` | One `mmdc` call per diagram: the colours of the map, and text labels instead of HTML ones (`htmlLabels: false`), so the SVG shows in any viewer, GitHub included. A diagram that does not parse stops the build with Mermaid's message. |
| Assemble | `assemble.mjs` | The title band (version from `package.json`, today's date or `MAP_DATE`), one coloured panel per zone with its prose, the legend. Each diagram keeps its own `<svg>`, with its ids prefixed so that two diagrams never share a marker. |
| Look | `preview.mjs` | Renders the result, or a region of it, to PNG with the same Chromium. |

```sh
# Also write two PNGs to look at: the whole page 2 000 px wide, and a region (x y w h, in the page's units).
PREVIEW=/tmp/map ZOOM="80 470 4000 2400" tools/architecture/build.sh
```

Which zones share a row is the `ROWS` table at the top of `assemble.mjs`: all the diagrams of one row
are drawn at the same scale, chosen to fill the page's width (at most `cap`). When a diagram grows a lot,
look at the preview and move it to another row rather than letting the scale fall — below about 0.7 its
text is hard to read even zoomed in. Mermaid lays out boxes that share a rank side by side; invisible
links (`A ~~~ B`) stack them, as diagram 2 does.

Text widths in the prose are estimated, not measured, and the diagrams are measured with the image's
fonts: a viewer whose system font is narrower sees a little more space around the labels, never less.
