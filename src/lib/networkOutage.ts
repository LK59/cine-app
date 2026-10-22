/**
 * La borne d'une coupure en pleine lecture : 48 s après son premier signe, l'écran « La lecture a été
 * interrompue » (décision de Louis du 15/10/2026, DECISIONS.md §97).
 *
 * Une seule valeur pour les deux lecteurs : le lecteur serveur (`PlayerHost`, hls.js) et le lecteur
 * natif (`MseSource`), dont §97 dit que la borne *est* celle du lecteur serveur. Elle était écrite deux
 * fois, sous le même nom, sans rien qui les attache l'une à l'autre. Pourquoi 48 s plutôt qu'une autre
 * valeur : voir les commentaires de chaque lecteur, là où la borne est armée.
 */
export const NETWORK_OUTAGE_GIVE_UP_MS = 48_000;
