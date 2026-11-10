/**
 * Les lignes que l'Immersion écrit dans le journal du lecteur de l'application (`player.log`, par
 * `POST /api/player/log`) : une ouverture, un arrêt, et l'erreur quand la lecture renonce.
 *
 * **Toutes portent `player: "immersion"`** — jamais la marque du lecteur serveur, dont elles
 * empruntent pourtant la négociation. L'Activité les range à part : une lecture transcodée pour la
 * télévision du chalet (stéréo, parfois SDR) ne dit rien du fichier tel que le lecteur le lit, et ne
 * doit ni innocenter ni accuser un titre dans son diagnostic (`src/lib/activity/diagnosis.ts`).
 *
 * `sdr: "serveur"` marque une séance dont l'image HDR a été convertie par Jellyfin : c'est le
 * transcodage lourd, et le journal doit dire quand il a tourné.
 */
type Kind = "start" | "stop" | "error";

let session: string | null = null;

/** Un identifiant par lecture : toutes ses lignes le portent, c'est par lui que l'Activité les réunit. */
export function newLogSession(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  session = "im-" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return session;
}

export function logLine(kind: Kind, fields: Record<string, unknown>, lastGasp = false): void {
  if (!session) return;
  void fetch("/api/player/log", {
    method: "POST",
    credentials: "same-origin",
    // L'arrêt doit partir même si la page se ferme.
    keepalive: lastGasp,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, fields: { player: "immersion", session, agent: navigator.userAgent, ...fields } }),
  }).catch(() => {});
}
