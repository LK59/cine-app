import { redirect } from "next/navigation";

// L'ancienne adresse de « Réglages serveur » (05/10/2026) : la Configuration commence maintenant
// par ses Connexions, à `/parametres` (DECISIONS.md §81). Gardée pour les liens déjà donnés —
// l'assistant de premier lancement, la documentation.
export default function OldConnexionsPage() {
  redirect("/parametres");
}
