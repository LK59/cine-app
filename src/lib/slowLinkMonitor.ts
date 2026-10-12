// Le tableau en direct du simulateur de connexion (page de test, DECISIONS.md §78) : le fil `slowLink`
// des lecteurs, horodaté, au fur et à mesure. Allumé seulement par la page de test ; éteint, `SlowLog`
// n'y écrit rien. Sans dépendance au navigateur : `slowLinkPolicy.ts` est aussi lu côté serveur.

export interface MonitorEvent {
  at: number;
  text: string;
}

let on = false;
const events: MonitorEvent[] = [];
const listeners = new Set<() => void>();

export function setSlowLinkMonitor(enabled: boolean): void {
  on = enabled;
  if (!enabled) events.length = 0;
  for (const l of listeners) l();
}

export function slowLinkMonitorOn(): boolean {
  return on;
}

export function pushSlowLinkEvent(text: string): void {
  if (!on) return;
  events.push({ at: Date.now(), text });
  if (events.length > 200) events.splice(0, events.length - 200);
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* rien */
    }
  }
}

export function slowLinkEvents(): readonly MonitorEvent[] {
  return events;
}

export function subscribeSlowLinkMonitor(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
