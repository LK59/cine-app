// Ce que la chaîne « Son par Lumen » (essai demux-son, 19/11/2026) a utilisé pour la dernière piste
// ouverte — pour la ligne `start`. Un module à part, sans rien d'autre : la page le lit sans charger
// le lecteur de paquets ni les décodeurs (ownAudio.ts l'écrit).
export interface LumenFacts {
  decoder: string;
  thread?: "worker" | "principal";
  workerRefusal?: string;
}

let last: LumenFacts | null = null;

export function noteLumenFacts(facts: LumenFacts): void {
  last = facts;
}

/** Lu (et oublié) par qui écrit la ligne `start` : rien quand ce chemin n'a pas servi. */
export function takeLumenFacts(): LumenFacts | null {
  const facts = last;
  last = null;
  return facts;
}
