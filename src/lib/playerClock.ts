/**
 * Une position de lecture écrite comme une horloge : « 4:07 », « 1:02:09 ». Celle des commandes du
 * lecteur et de la télécommande Chromecast — une seule écriture, pour que les deux disent la même
 * heure de la même façon.
 */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
