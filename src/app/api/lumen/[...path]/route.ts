import { NextResponse } from "next/server";

/**
 * Lumen serveur est archivé (DECISIONS.md §196, 17/11/2026 ; dernier état : étiquette `lumen-serveur-final-2026-11-17`).
 * Toutes ses adresses — listes, segments, éligibilité, préparation, banc, laissez-passer `tv.`/`cc.` d'un téléviseur —
 * répondent ici, d'une seule route, **410** `{ error: "lumen-archive" }`.
 *
 * Pas 404 : un onglet resté ouvert sur l'ancien code ou un téléviseur qui relit sa liste demanderait des dizaines
 * d'adresses distinctes en quelques secondes, et plus de dix 404/403/400 distincts depuis une adresse la font bannir
 * pour des heures par le pare-feu en amont (CrowdSec, « Known pitfalls » de CLAUDE.md). 410 dit aussi la vérité :
 * l'adresse a existé, elle ne reviendra pas. Sans session (`PUBLIC_PATHS`) : ces requêtes ne lisent rien, et un
 * téléviseur n'a jamais de cookie à présenter — un 401 ne lui apprendrait rien de plus.
 */
const NO_STORE = { "Cache-Control": "no-store" };

function archived(): NextResponse {
  return NextResponse.json({ error: "lumen-archive" }, { status: 410, headers: NO_STORE });
}

export const GET = archived;
export const POST = archived;
export const OPTIONS = archived;
export function HEAD(): NextResponse {
  return new NextResponse(null, { status: 410, headers: NO_STORE });
}
