// Fades the SHARP copy of the backdrop out by ~72% of the *whole screen's* height (not just the
// hero pane's own box) — a blurred, darkened duplicate sits behind it (see CinemaClient's own
// note), so wherever this one has faded to transparent, the blurred one shows through instead of
// hitting solid slate-950. (Il servait aussi à la bande-annonce de fond, qui recouvrait l'image
// avec le même masque ; retirée le 13/10/2026.)
export const BACKDROP_MASK =
  "linear-gradient(to bottom, rgba(0,0,0,0.97) 0%, rgba(0,0,0,0.82) 18%, rgba(0,0,0,0.50) 35%, rgba(0,0,0,0.18) 52%, rgba(0,0,0,0.04) 65%, rgba(0,0,0,0) 72%)";
