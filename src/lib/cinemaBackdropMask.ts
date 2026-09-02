// Fades the SHARP copy of the backdrop out by ~72% of the *whole screen's* height (not just the
// hero pane's own box) — a blurred, darkened duplicate sits behind it (see CinemaClient's own
// note), so wherever this one has faded to transparent, the blurred one shows through instead of
// hitting solid slate-950. Shared between CinemaClient's own still-image backdrop and
// CinemaTrailerBackdrop's video replacement — both need to fade out identically, since the video
// sits directly on top of (and, once playing, fully occludes) the image using this same mask.
export const BACKDROP_MASK =
  "linear-gradient(to bottom, rgba(0,0,0,0.97) 0%, rgba(0,0,0,0.82) 18%, rgba(0,0,0,0.50) 35%, rgba(0,0,0,0.18) 52%, rgba(0,0,0,0.04) 65%, rgba(0,0,0,0) 72%)";
