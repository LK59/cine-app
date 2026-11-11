import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { relaySalonsUpgrade, installSalonsRelay, SALONS_RELAY_KEY } from "../../server-boot/salonsRelay.mjs";

/**
 * Le relais des WebSockets des salons (`server-boot/salonsRelay.mjs`, DECISIONS.md §146) : une connexion montante
 * de `/api/salons/ws` part vers le service et les octets passent dans les deux sens ; toute autre connexion
 * montante reste à Next ; sans adresse publiée, ou depuis une autre origine, refusée.
 *
 * Le « service » ici répond la poignée de main à la main et renvoie ce qu'il reçoit — c'est le relais qu'on
 * éprouve, pas le protocole WebSocket.
 */
const closers: (() => void)[] = [];
afterEach(() => {
  while (closers.length) closers.pop()!();
  (globalThis as Record<symbol, unknown>)[SALONS_RELAY_KEY] = null;
});

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => server.close());
  return (server.address() as AddressInfo).port;
}

/** Un faux service : accepte la poignée de main sur `/ws`, note le chemin demandé, renvoie en écho. */
async function fakeService() {
  const seen: string[] = [];
  const server = http.createServer();
  server.on("upgrade", (req, socket: Socket) => {
    seen.push(req.url ?? "");
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: abc\r\n\r\n");
    socket.on("data", (chunk: Buffer) => socket.write(Buffer.concat([Buffer.from("écho:"), chunk])));
  });
  return { port: await listen(server), seen };
}

/** Le serveur de l'application : le relais branché, et un écouteur « Next » qui note ce qui lui arrive. */
async function appServer() {
  const reachedNext: string[] = [];
  const server = http.createServer();
  installSalonsRelay(server);
  server.on("upgrade", (req, socket: Socket) => {
    reachedNext.push(req.url ?? "");
    socket.destroy();
  });
  return { port: await listen(server), reachedNext };
}

function connect(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; socket?: Socket; head?: string }>((resolve) => {
    const req = http.request({ port, host: "127.0.0.1", path, headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": "x", "Sec-WebSocket-Version": "13", ...headers } });
    req.on("upgrade", (res, socket) => {
      closers.push(() => socket.destroy());
      resolve({ status: res.statusCode ?? 0, socket, head: res.headers["sec-websocket-accept"] as string });
    });
    req.on("response", (res) => resolve({ status: res.statusCode ?? 0 }));
    req.on("error", () => resolve({ status: -1 }));
    req.end();
  });
}

describe("le relais des salons", () => {
  it("relaie la poignée de main (requête comprise) et les octets dans les deux sens", async () => {
    const service = await fakeService();
    (globalThis as Record<symbol, unknown>)[SALONS_RELAY_KEY] = { url: `http://127.0.0.1:${service.port}` };
    const app = await appServer();
    const res = await connect(app.port, "/api/salons/ws?pass=v1.a.b&resume=r");
    expect(res.status).toBe(101);
    expect(res.head).toBe("abc");
    expect(service.seen).toEqual(["/ws?pass=v1.a.b&resume=r"]);
    const reply = await new Promise<string>((resolve) => {
      res.socket!.once("data", (d) => resolve(d.toString()));
      res.socket!.write("bonjour");
    });
    expect(reply).toBe("écho:bonjour");
    expect(app.reachedNext).toEqual([]);
  });

  it("les autres connexions montantes vont à Next, comme avant", async () => {
    const app = await appServer();
    await connect(app.port, "/_next/webpack-hmr");
    expect(app.reachedNext).toEqual(["/_next/webpack-hmr"]);
  });

  it("sans adresse publiée (fonction coupée) : 503 ; service injoignable : 502", async () => {
    const app = await appServer();
    expect((await connect(app.port, "/api/salons/ws?pass=x")).status).toBe(503);
    (globalThis as Record<symbol, unknown>)[SALONS_RELAY_KEY] = { url: "http://127.0.0.1:1" };
    expect((await connect(app.port, "/api/salons/ws?pass=x")).status).toBe(502);
    expect(app.reachedNext).toEqual([]);
  });

  it("depuis une autre origine : refusée sans contacter le service", async () => {
    const service = await fakeService();
    (globalThis as Record<symbol, unknown>)[SALONS_RELAY_KEY] = { url: `http://127.0.0.1:${service.port}` };
    const app = await appServer();
    const res = await connect(app.port, "/api/salons/ws?pass=x", { Origin: "https://ailleurs.example", Host: "app.example" });
    expect(res.status).toBe(403);
    expect(service.seen).toEqual([]);
    const same = await connect(app.port, "/api/salons/ws?pass=x", { Origin: "https://app.example", Host: "app.example" });
    expect(same.status).toBe(101);
  });

  it("n'avale pas un chemin voisin", () => {
    const fake = { url: "/api/salons/wsx", headers: {} } as unknown as http.IncomingMessage;
    expect(relaySalonsUpgrade(fake, {} as Socket, Buffer.alloc(0), { url: "http://x" })).toBe(false);
  });
});
