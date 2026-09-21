// Le décodeur TrueHD tel que la lecture s'en sert : un lot à la fois, en rendant la main au
// navigateur entre deux.
//
// Pas de worker, et c'est voulu. Il y en avait un, et le build de production l'a trahi le
// 21/09/2026 : Next 16 (Turbopack) n'a pas compilé `new Worker(new URL("./….worker.ts", …))`, il
// a copié le fichier TypeScript tel quel dans les ressources statiques — un worker qui n'aurait
// jamais démarré, et chaque TrueHD serait reparti au lecteur serveur sans un mot. Le coût qui le
// justifiait est petit : un quart de seconde de TrueHD 7.1 se décode en ~4 ms dans Node, une
// dizaine sur un téléphone — ce que le décodeur FLAC fait déjà sur le fil principal. Ce qui compte
// est de ne pas enchaîner quarante lots d'un coup quand le lecteur remplit dix secondes de son :
// chaque lot est suivi d'un retour au navigateur, et aucune tâche ne dépasse quelques millisecondes.
import { TrueHdCore, type DecodedBatch } from "./truehdCore";

export type { DecodedBatch };

export interface TrueHdDecoder {
  decode(blocks: Uint8Array[]): Promise<DecodedBatch>;
  reset(): void;
  close(): void;
}

/**
 * Rend la main au navigateur — une vraie tâche, pas une microtâche : une chaîne de promesses
 * résolues tout de suite ne laisse ni peindre ni répondre au doigt. MessageChannel plutôt que
 * setTimeout, que les navigateurs retardent à 4 ms quand on l'enchaîne.
 */
export function yieldToBrowser(): Promise<void> {
  if (typeof MessageChannel === "undefined") return new Promise((resolve) => setTimeout(resolve, 0));
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

export async function openTrueHdDecoder(mlp: boolean): Promise<TrueHdDecoder> {
  const core = await TrueHdCore.create(mlp);
  return {
    async decode(blocks) {
      const batch = core.decode(blocks);
      await yieldToBrowser();
      return batch;
    },
    reset: () => core.reset(),
    close: () => core.close(),
  };
}

/**
 * Télécharge le module (466 Ko, 191 compressés) sans l'instancier : le service worker le garde,
 * et le premier film en TrueHD ne l'attend plus. Pour le préchauffage — voir decoderWarmup.ts.
 */
export async function warmTrueHd(): Promise<void> {
  await import("./truehd-wasm.mjs");
}
