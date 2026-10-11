import type { DialogueMode } from "@/lib/webcodecs/dialogueEnhance";

/**
 * « Améliorer les dialogues » retenu sur cet appareil (11/10/2026, bêta ; tous les comptes depuis le 12/10).
 *
 * Par appareil, comme le plafond HDR : c'est un réglage d'écoute — un téléphone au lit, une barre de
 * son au salon —, pas une préférence de compte. Retenu d'une séance à l'autre comme sur l'Apple TV.
 * Le traitement vit dans la chaîne audio (`dialogueEnhance.ts`), il n'a besoin d'aucun geste pour
 * démarrer : le retenir ne fait rien jouer de travers à l'ouverture suivante. Une lecture du stockage
 * qui échoue (navigation privée, données bloquées) vaut « off » — le chemin d'avant.
 */
const KEY = "cine-dialogue";

export function readDialogueMode(): DialogueMode {
  try {
    const value = localStorage.getItem(KEY);
    return value === "on" || value === "strong" ? value : "off";
  } catch {
    return "off";
  }
}

export function writeDialogueMode(mode: DialogueMode): void {
  try {
    if (mode === "off") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, mode);
  } catch {
    // Rien de retenu : la séance garde le réglage, la suivante repartira sans.
  }
}
