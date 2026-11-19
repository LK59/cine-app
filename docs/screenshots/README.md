# Screenshots

The images the top-level `README.md` shows — the home screen, the gallery and the animated excerpt
(`demo.webp`) — live here. The full demo video is not stored in the repository.

They were captured from a real installation, in English, with a dedicated demo account and no personal
data on screen: account names replaced by placeholders, no file or torrent names. Desktop shots at
1920×1080, phone shots at 390×844 (×3), dark theme, WebP. The same handful of titles appears across
them so the library reads as one library.

What else still needs capturing is written where it is used — each shot is an HTML comment in
`docs/FEATURES.md` or `DEPLOYMENT.md` naming the file to produce, what to frame, and the `<img>` tag to
uncomment once the file is here. There is no second list to keep in sync:

```sh
grep -n 'CAPTURE :' docs/FEATURES.md DEPLOYMENT.md
```
