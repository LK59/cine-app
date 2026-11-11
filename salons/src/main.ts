import { readFileSync } from "node:fs";
import { Lobby } from "./rooms.ts";
import { createSalonsServer } from "./server.ts";

/**
 * Le point d'entrée du conteneur `laterna-salons`.
 *
 * Deux variables : `SALONS_KEY`, la clé partagée avec l'application (elle signe les laissez-passer et protège
 * `/health`) — obligatoire, 32 caractères au moins, le démarrage est refusé sinon : une clé faible permettrait de
 * fabriquer des laissez-passer ; et `PORT` (8090 par défaut).
 */
const key = process.env.SALONS_KEY ?? "";
if (key.length < 32) {
  console.error("[salons] démarrage refusé : SALONS_KEY absente ou trop courte (32 caractères au moins — voir docs/DEPLOIEMENT.md)");
  process.exit(1);
}
const port = Number(process.env.PORT ?? 8090);
const version = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

const server = createSalonsServer({ key, lobby: new Lobby({ key }), version });
server.listen(port, () => console.log(`[salons] à l'écoute sur le port ${port}`));

// Un arrêt propre : chaque client reçoit « redémarrage » et se reconnecte de lui-même.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`[salons] arrêt (${signal})`);
    server.shutdown(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
