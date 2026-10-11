/**
 * L'application que le Chromecast ouvre pour lire le film — DECISIONS.md §64.
 *
 * Par défaut le « Default Media Receiver » de Google (`CC1AD845`) : public, gratuit, sans
 * inscription, le même pour toute installation. Une installation peut enregistrer son propre
 * récepteur dans la console Google Cast et en mettre l'identifiant dans ses réglages
 * (`CAST_RECEIVER_APP_ID`, réglage de l'application → `.env` → ce défaut, DECISIONS.md §48). Cet
 * identifiant n'a rien de secret : il nomme une page publique, et le navigateur le reçoit pour
 * ouvrir la session.
 */
export const DEFAULT_MEDIA_RECEIVER_APP_ID = "CC1AD845";

/**
 * La forme d'un identifiant Cast : huit caractères hexadécimaux. Toute autre valeur — vide, une
 * faute de frappe — retombe sur le récepteur de Google : un réglage mal recopié ne doit pas faire
 * disparaître la diffusion, il doit la laisser telle qu'elle était sans lui.
 */
export function receiverAppIdOf(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim().toUpperCase();
  return /^[0-9A-F]{8}$/.test(trimmed) ? trimmed : DEFAULT_MEDIA_RECEIVER_APP_ID;
}
