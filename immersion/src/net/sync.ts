import type { RoomView } from "../../../salons/src/protocol";
import { cueMusic } from "../media/music";
import { useStore } from "../state/store";

/**
 * Les objets du chalet qui ont un état partagé dans un salon : lampes (trois groupes), porte, feu, musique
 * (`salons/src/protocol.ts`, `SHARED_OBJECTS`). Le reste du chalet est le même pour tous.
 *
 * En salon, un geste n'est **pas** appliqué ici : il part au service (`setShared`), qui le numérote et le renvoie à
 * tous, demandeur compris — c'est ce retour qui change l'état (`applyShared`). Deux personnes qui touchent la même
 * lampe au même instant voient donc la même chose.
 *
 * Un salon neuf ne sait encore rien de ces objets : le premier arrivé y pose l'état de son chalet (`seedShared`).
 */
export type Sender = (key: string, value: unknown) => void;

let send: Sender | null = null;
let clock: () => number = Date.now;

/** Branché par le module réseau : la façon d'envoyer une intention, et l'heure du service. */
export function installSharedSink(sender: Sender, serverNow: () => number): void {
  send = sender;
  clock = serverNow;
  useStore.getState().setSharedSink((key, value) => {
    if (!send || !useStore.getState().net.room) return false;
    // La musique se partage avec son morceau et son départ : chacun reprend au même endroit.
    send(key, key === "musique" ? { on: value === true, track: 0, since: clock() } : value);
    return true;
  });
}

/** Le chalet de la page vers un salon qui n'en sait encore rien. */
export function seedShared(room: RoomView): void {
  if (!send) return;
  const s = useStore.getState();
  const local: Record<string, unknown> = {
    "lampes.salon": s.lamps.salon,
    "lampes.sud": s.lamps.sud,
    "lampes.nuit": s.lamps.nuit,
    porte: s.door,
    feu: s.fire,
    musique: { on: s.music, track: 0, since: clock() },
  };
  for (const [key, value] of Object.entries(local)) if (!(key in room.state)) send(key, value);
}

/** L'état du salon appliqué au chalet de la page. */
export function applyShared(state: RoomView["state"]): void {
  const s = useStore.getState();
  const value = (key: string) => state[key]?.value;
  const lamps = { ...s.lamps };
  for (const group of ["salon", "sud", "nuit"] as const) {
    const v = value(`lampes.${group}`);
    if (typeof v === "boolean") lamps[group] = v;
  }
  const patch: Partial<ReturnType<typeof useStore.getState>> = {};
  if (lamps.salon !== s.lamps.salon || lamps.sud !== s.lamps.sud || lamps.nuit !== s.lamps.nuit) patch.lamps = lamps;
  const door = value("porte");
  if (typeof door === "boolean" && door !== s.door) patch.door = door;
  const fire = value("feu");
  if (typeof fire === "boolean" && fire !== s.fire) patch.fire = fire;
  const music = value("musique") as { on?: boolean; track?: number; since?: number } | undefined;
  if (music && typeof music.on === "boolean") {
    if (music.on !== s.music) patch.music = music.on;
    if (music.on && typeof music.since === "number") cueMusic(music.track ?? 0, Math.max(0, (clock() - music.since) / 1000));
  }
  if (Object.keys(patch).length) useStore.setState(patch);
}
