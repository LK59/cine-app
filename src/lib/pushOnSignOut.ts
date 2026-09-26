"use client";

/**
 * Les notifications d'un appareil suivent la personne connectée, pas l'appareil.
 *
 * Un abonnement push est celui du navigateur, et le serveur le range sous le compte qui l'a envoyé
 * en dernier. Se déconnecter ne le touchait pas : sur un iPad partagé, le compte suivant recevait
 * les « votre demande est disponible » et les réponses aux signalements du précédent, jusqu'à ce
 * qu'il ouvre son propre panneau Compte (audit du 26/09/2026).
 *
 * La déconnexion coupe donc l'abonnement — côté navigateur d'abord, c'est ce qui arrête vraiment
 * les envois (un point de terminaison désabonné répond 410 et le serveur l'oublie de lui-même),
 * puis côté serveur. Et elle retient, pour ce compte sur cet appareil, qu'il était activé : à la
 * reconnexion, la question est reposée (`PushResumePrompt`) plutôt que de laisser la personne
 * découvrir des jours plus tard qu'elle ne reçoit plus rien. Pas de réabonnement silencieux : iOS
 * exige un geste pour s'abonner, et c'est à la personne de dire oui.
 */

const WAS_ON_PREFIX = "cine:push-was-on:";

/** Coupe l'abonnement de cet appareil. Ne lève jamais : c'est une étape de la déconnexion. */
export async function dropPushOnSignOut(account: string | null): Promise<void> {
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    // `getRegistration` et non `ready` : `ready` attend indéfiniment un worker qui ne vient pas.
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager?.getSubscription();
    if (!sub) return;
    if (account) {
      try {
        localStorage.setItem(WAS_ON_PREFIX + account, String(Date.now()));
      } catch {
        // Sans stockage, la question ne sera pas reposée ; les notifications sont coupées quand même.
      }
    }
    const endpoint = sub.endpoint;
    await sub.unsubscribe().catch(() => false);
    await fetch("/api/push/subscribe", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    }).catch(() => {});
  } catch {
    // Rien ici ne doit retenir la déconnexion.
  }
}

/** Ce compte avait-il les notifications sur cet appareil avant de se déconnecter ? */
export function pushWasOn(account: string | null): boolean {
  if (!account) return false;
  try {
    return localStorage.getItem(WAS_ON_PREFIX + account) !== null;
  } catch {
    return false;
  }
}

/** La question a eu sa réponse — oui ou « plus tard » : on ne la repose plus. */
export function forgetPushWasOn(account: string | null): void {
  if (!account) return;
  try {
    localStorage.removeItem(WAS_ON_PREFIX + account);
  } catch {
    // Rien à faire.
  }
}
