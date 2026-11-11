import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { verifyPass } from "./pass.ts";
import { LIMITS, parseClientMessage, type ServerMessage } from "./protocol.ts";
import type { Lobby } from "./rooms.ts";

/**
 * Le transport : une route de santé pour l'application, et la WebSocket des salons.
 *
 * Le service n'est jamais exposé directement : l'application relaie vers lui les connexions montantes de
 * `/api/salons/ws` (`server-boot/salonsRelay.mjs`), sur le réseau Docker. Ici `/ws`.
 *
 * Deux choix qui viennent du pare-feu du serveur (CrowdSec bannit une adresse sur des réponses 4xx répétées) :
 * un laissez-passer refusé n'est **pas** une réponse HTTP 401 — la connexion est acceptée puis fermée avec un
 * code à nous (4401), qu'aucune règle ne compte ; et un client trop bavard est coupé (4429), pas laissé
 * réessayer en boucle.
 */
export const CLOSE = {
  /** Laissez-passer absent, mal signé ou expiré : en demander un autre. */
  pass: 4401,
  /** Débit dépassé. */
  rate: 4429,
  /** Le service s'arrête (redémarrage) : se reconnecter. */
  restart: 4503,
} as const;

/** Toutes les 15 s, un `ping` de la WebSocket ; une connexion qui n'a pas répondu au précédent est morte. */
const HEARTBEAT_MS = 15_000;

export interface SalonsServerOptions {
  key: string;
  lobby: Lobby;
  version: string;
  log?: (line: string) => void;
}

function bearerMatches(header: string | undefined, key: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7));
  const expected = Buffer.from(key);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function createSalonsServer({ key, lobby, version, log = (line) => console.log(`[salons] ${line}`) }: SalonsServerOptions): http.Server & { shutdown(done?: () => void): void } {
  const startedAt = Date.now();
  const sockets = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxMessageBytes, perMessageDeflate: false });

  const server = http.createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/health") {
      if (!bearerMatches(req.headers.authorization, key)) {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "clé refusée" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, service: "laterna-salons", version, uptimeS: Math.round((Date.now() - startedAt) / 1000), ...lobby.stats() }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "introuvable" }));
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://salons");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      const claims = verifyPass(url.searchParams.get("pass") ?? "", key);
      if (!claims) {
        ws.close(CLOSE.pass, "laissez-passer refusé");
        return;
      }
      attach(ws, claims, url.searchParams.get("resume"));
    });
  });

  function attach(ws: WebSocket, claims: NonNullable<ReturnType<typeof verifyPass>>, resume: string | null) {
    const send = (message: ServerMessage) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    };
    const member = lobby.connect(claims, { send }, resume);
    let tokens: number = LIMITS.bucketSize;
    let refilledAt = Date.now();
    let alive = true;

    ws.on("pong", () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, HEARTBEAT_MS);
    heartbeat.unref();

    ws.on("message", (data, isBinary) => {
      const now = Date.now();
      tokens = Math.min(LIMITS.bucketSize, tokens + ((now - refilledAt) / 1000) * LIMITS.bucketPerSecond);
      refilledAt = now;
      if (tokens < 1) {
        member.reject("rate", "Trop de messages : connexion coupée.");
        ws.close(CLOSE.rate, "débit dépassé");
        return;
      }
      tokens -= 1;
      const message = isBinary ? null : parseClientMessage(data.toString());
      if (!message) {
        member.reject("malformed", "Message illisible.");
        return;
      }
      member.receive(message);
    });
    ws.on("close", () => {
      clearInterval(heartbeat);
      member.disconnected();
    });
    ws.on("error", () => ws.terminate());
  }

  log(`prêt (version ${version})`);
  return Object.assign(server, {
    /** Ferme chaque WebSocket avec « redémarrage » (les clients se reconnectent), puis le serveur. */
    shutdown(done?: () => void) {
      for (const ws of sockets.clients) ws.close(CLOSE.restart, "redémarrage du service");
      server.close(() => done?.());
    },
  });
}
