// Le relais des salons du chalet (DECISIONS.md §146) : les connexions WebSocket de `/api/salons/ws`, prises
// avant Next et passées au service `laterna-salons` sur le réseau Docker.
//
// Pourquoi ici : les navigateurs ne parlent qu'à l'adresse de Laterna (même domaine, même HTTPS, même
// politique de sécurité — `connect-src 'self'`) ; le relais inverse laisse déjà passer les WebSockets jusqu'à
// ce conteneur ; et Next ne sait pas tenir une connexion permanente. Le service, lui, n'est publié nulle part.
//
// L'adresse du service vient de l'application elle-même (réglages → `.env` → défaut, relus à chaque demande de
// laissez-passer : `src/lib/salons/relay.ts`), publiée sous un symbole partagé — même processus, comme les
// autres états que l'application partage par `Symbol.for`. Pas d'adresse publiée (fonction coupée, jamais
// demandée) : la connexion est refusée en 503.
//
// Ce relais ne juge pas qui entre : c'est le laissez-passer, vérifié par le service. Il refuse seulement une
// connexion venue d'une autre origine (une page tierce n'a de toute façon pas de laissez-passer : elle ne peut
// pas lire la réponse de `/api/salons/pass`) et borne le nombre de connexions relayées.

import http from "node:http";

export const SALONS_RELAY_KEY = Symbol.for("cine-app.salons.relay");
export const SALONS_SOCKET_PATH = "/api/salons/ws";
/** Connexions relayées en même temps, au plus (8 personnes par salon : il y a de la marge). */
export const SALONS_MAX_SOCKETS = 256;
const CONNECT_TIMEOUT_MS = 5000;

let relayed = 0;

/** Les en-têtes d'une poignée de main WebSocket que le service doit voir, et eux seuls. */
const FORWARDED = ["upgrade", "connection", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-protocol", "user-agent"];

function refuse(socket, status, text) {
  try {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    /* déjà fermée */
  }
}

/**
 * Prend une connexion montante si elle est pour les salons. Rend `true` quand elle est prise (relayée ou refusée),
 * `false` sinon — le serveur la passe alors à Next comme avant.
 */
export function relaySalonsUpgrade(req, socket, head, target = globalThis[SALONS_RELAY_KEY]) {
  const url = req.url ?? "";
  const query = url.indexOf("?");
  const path = query >= 0 ? url.slice(0, query) : url;
  if (path !== SALONS_SOCKET_PATH) return false;
  socket.on("error", () => socket.destroy());

  const origin = req.headers.origin;
  if (origin) {
    let sameHost = false;
    try {
      sameHost = new URL(origin).host === req.headers.host;
    } catch {
      sameHost = false;
    }
    if (!sameHost) {
      refuse(socket, 403, "Forbidden");
      return true;
    }
  }
  if (!target?.url || relayed >= SALONS_MAX_SOCKETS) {
    refuse(socket, 503, "Service Unavailable");
    return true;
  }
  let upstream;
  try {
    upstream = new URL(target.url);
  } catch {
    refuse(socket, 503, "Service Unavailable");
    return true;
  }

  const headers = {};
  for (const name of FORWARDED) if (req.headers[name] !== undefined) headers[name] = req.headers[name];
  headers.host = upstream.host;
  const proxyReq = http.request({
    hostname: upstream.hostname,
    port: upstream.port || 80,
    path: `/ws${query >= 0 ? url.slice(query) : ""}`,
    method: "GET",
    headers,
    timeout: CONNECT_TIMEOUT_MS,
  });
  proxyReq.on("upgrade", (res, upstreamSocket, upstreamHead) => {
    relayed += 1;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      relayed -= 1;
      socket.destroy();
      upstreamSocket.destroy();
    };
    // La réponse 101 du service, recopiée telle quelle (dont `Sec-WebSocket-Accept`).
    let response = `HTTP/1.1 101 ${res.statusMessage || "Switching Protocols"}\r\n`;
    for (let i = 0; i < res.rawHeaders.length; i += 2) response += `${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}\r\n`;
    socket.write(`${response}\r\n`);
    if (upstreamHead?.length) socket.write(upstreamHead);
    if (head?.length) upstreamSocket.write(head);
    socket.setNoDelay?.(true);
    upstreamSocket.setNoDelay?.(true);
    socket.pipe(upstreamSocket);
    upstreamSocket.pipe(socket);
    socket.on("close", finish);
    upstreamSocket.on("close", finish);
    socket.on("error", finish);
    upstreamSocket.on("error", finish);
  });
  // Le service a répondu sans accepter (il n'aurait pas dû : un laissez-passer refusé est fermé après la poignée
  // de main, pas avant) ou n'a pas répondu : 502.
  proxyReq.on("response", (res) => {
    res.resume();
    refuse(socket, 502, "Bad Gateway");
  });
  proxyReq.on("timeout", () => proxyReq.destroy(new Error("délai dépassé")));
  proxyReq.on("error", () => refuse(socket, 502, "Bad Gateway"));
  proxyReq.end();
  return true;
}

/** Branche le relais sur un serveur : ses connexions montantes pour les salons ne vont jamais à Next. */
export function installSalonsRelay(server) {
  const emit = server.emit;
  server.emit = function (event, ...args) {
    if (event === "upgrade" && relaySalonsUpgrade(args[0], args[1], args[2])) return true;
    return emit.call(this, event, ...args);
  };
}
