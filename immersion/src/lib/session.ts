import { isLang, type Lang } from "./i18n";

/**
 * Ce que la page demande à l'application avant d'entrer : la session est-elle vivante, et dans
 * quelle langue parle ce compte.
 *
 * Le proxy de l'application a déjà refusé la page à qui n'a pas de session ; mais elle peut prendre
 * fin pendant la visite. Une réponse 401 marquée `x-session-expired` est la seule qui le dise (un
 * 401 nu peut venir d'un service amont) — même règle que dans l'application.
 */
export class SessionExpired extends Error {
  constructor() {
    super("session expirée");
    this.name = "SessionExpired";
  }
}

let onExpired: (() => void) | null = null;

/** Branche ce qui doit se passer quand une réponse annonce la fin de la session. */
export function watchSession(handler: () => void): void {
  onExpired = handler;
}

/** `fetch` vers l'application, avec le cookie de session, qui reconnaît la fin de session. */
export async function api(input: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, { credentials: "same-origin", ...init });
  if (res.status === 401 && res.headers.get("x-session-expired") === "1") {
    onExpired?.();
    throw new SessionExpired();
  }
  return res;
}

export async function apiJson<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await api(input, init);
  if (!res.ok) throw new Error(`${input} → ${res.status}`);
  return (await res.json()) as T;
}

export async function accountLang(): Promise<Lang | null> {
  try {
    const prefs = await apiJson<{ lang?: unknown }>("/api/user/preferences");
    return isLang(prefs.lang) ? prefs.lang : null;
  } catch (err) {
    if (err instanceof SessionExpired) throw err;
    return null;
  }
}

/** Retour au cinéma : une navigation ordinaire, la page libère tout en partant (`pagehide`). */
export function leaveToLaterna(): void {
  window.location.assign("/");
}

export function goToLogin(): void {
  window.location.assign("/login?next=" + encodeURIComponent("/immersion"));
}
