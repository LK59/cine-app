import { permanentRedirect } from "next/navigation";

// L'ancienne adresse de « Sous-titres générés » (§69), qui tenait toutes les fonctions d'IA. Elles
// sont depuis le 10/11/2026 dans Fonctions intelligentes → Intelligence artificielle (DECISIONS.md
// §142). Gardée pour les liens et les favoris déjà donnés : 308, comme les adresses déplacées du
// proxy (`/player`, `/cinema`) — et réservée à l'administrateur par le même premier segment.
export default function OldSousTitresPage() {
  permanentRedirect("/parametres/ia");
}
