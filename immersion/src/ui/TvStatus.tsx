import { useStore, useT } from "../state/store";

/**
 * La télévision commune d'un salon se prépare (`net/tv.ts`) : chacun charge son flux, la lecture partira quand tout
 * le monde sera prêt. Une ligne discrète en haut, le temps de l'attente — sans elle, un film qui ne démarre pas
 * ressemble à une panne.
 */
export function TvStatus() {
  const t = useT();
  const tv = useStore((s) => s.net.room?.tv ?? null);
  const total = useStore((s) => s.net.room?.members.filter((m) => !m.away).length ?? 0);
  if (!tv || tv.phase !== "preparing") return null;
  const ready = Math.min(total, tv.ready.length);
  return (
    <div className="tv-status" role="status" data-testid="tv-status">
      <strong>{tv.title}</strong>
      <span>{t("tv.preparing").replace("{ready}", String(ready)).replace("{total}", String(total))}</span>
    </div>
  );
}
