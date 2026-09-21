/**
 * Ouvrir l'écran d'accueil depuis n'importe où — le bouton de Compte.
 *
 * Un module à part, minuscule : le panneau Compte n'a pas à embarquer tout l'accueil pour
 * pouvoir le demander. `PlayerOnboardingGate` écoute cet évènement.
 */
export const OPEN_ONBOARDING_EVENT = "cine:onboarding-open";

export function openOnboarding() {
  window.dispatchEvent(new Event(OPEN_ONBOARDING_EVENT));
}
