import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { signPass } from "./pass.ts";
import { Lobby } from "./rooms.ts";
import { CLOSE, createSalonsServer } from "./server.ts";
import type { ServerMessage } from "./protocol.ts";

const KEY = "une-clé-de-test-suffisamment-longue-0123456789";

/** Tout ce qu'un test ouvre, refermé à la fin même s'il échoue : sinon le processus de test ne finit jamais. */
const open = new Set<WebSocket>();
let stopping: (() => Promise<void>) | null = null;
afterEach(async () => {
  for (const ws of open) ws.terminate();
  open.clear();
  await stopping?.();
  stopping = null;
});

async function start() {
  const server = createSalonsServer({ key: KEY, lobby: new Lobby({ log: () => {} }), version: "test", log: () => {} });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  let stopped: Promise<void> | null = null;
  const stop = () => (stopped ??= new Promise<void>((resolve) => server.shutdown(resolve)));
  stopping = stop;
  return { server, port, stop };
}

/** Un client : ses messages reçus, et de quoi attendre le prochain d'un type. */
function client(port: number, pass: string, resume?: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?pass=${encodeURIComponent(pass)}${resume ? `&resume=${resume}` : ""}`);
  open.add(ws);
  const inbox: ServerMessage[] = [];
  /** Les messages pas encore rendus par `next` : un message arrivé avant qu'on l'attende n'est pas perdu. */
  const unread: ServerMessage[] = [];
  const waiters: { t: string; resolve: (m: ServerMessage) => void }[] = [];
  ws.on("message", (data) => {
    const m = JSON.parse(data.toString()) as ServerMessage;
    inbox.push(m);
    const i = waiters.findIndex((w) => w.t === m.t);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
    else unread.push(m);
  });
  const next = <T extends ServerMessage["t"]>(t: T) =>
    new Promise<Extract<ServerMessage, { t: T }>>((resolve, reject) => {
      const i = unread.findIndex((m) => m.t === t);
      if (i >= 0) return resolve(unread.splice(i, 1)[0] as Extract<ServerMessage, { t: T }>);
      const timer = setTimeout(() => reject(new Error(`pas de « ${t} »`)), 3000);
      waiters.push({ t, resolve: (m) => (clearTimeout(timer), resolve(m as Extract<ServerMessage, { t: T }>)) });
    });
  const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  return { ws, inbox, next, closed, send };
}

const passFor = (name: string, exp = Date.now() + 60_000) => signPass({ sub: `compte-${name}`, name, admin: false, exp }, KEY);

test("deux clients dans un salon privé, un objet partagé, l'horloge", async () => {
  const { port, stop } = await start();
  const a = client(port, passFor("Alice"));
  await a.next("welcome");
  a.send({ t: "create", visibility: "private", name: "Ciné" });
  const { room } = await a.next("joined");
  const b = client(port, passFor("Bob"));
  await b.next("welcome");
  b.send({ t: "join", code: room.code });
  assert.deepEqual((await b.next("joined")).room.members.map((m) => m.name), ["Alice", "Bob"]);
  assert.equal((await a.next("enter")).member.name, "Bob");
  b.send({ t: "set", key: "feu", value: false });
  assert.deepEqual(await a.next("state"), { t: "state", key: "feu", v: 1, value: false, by: (b.inbox[0] as Extract<ServerMessage, { t: "welcome" }>).you.id });
  const before = Date.now();
  a.send({ t: "ping", c: 42 });
  const pong = await a.next("pong");
  assert.equal(pong.c, 42);
  assert.ok(pong.s >= before - 5 && pong.s <= Date.now() + 5);
  a.ws.close();
  b.ws.close();
  await stop();
});

test("sans laissez-passer valable : la connexion s'ouvre puis se ferme en 4401, jamais une réponse HTTP 4xx", async () => {
  const { port, stop } = await start();
  for (const pass of ["", "v1.faux.faux", passFor("Alice", Date.now() - 1), signPass({ sub: "x", name: "x", admin: false, exp: Date.now() + 60_000 }, "une-autre-clé-0123456789abcdef0123")]) {
    const c = client(port, pass);
    let upgraded = false;
    c.ws.on("upgrade", () => (upgraded = true));
    assert.equal(await c.closed, CLOSE.pass);
    assert.equal(upgraded, true);
    assert.equal(c.inbox.length, 0);
  }
  await stop();
});

test("une rafale au-delà du débit permis : coupé en 4429", async () => {
  const { port, stop } = await start();
  const c = client(port, passFor("Bavard"));
  await c.next("welcome");
  for (let i = 0; i < 200; i++) c.send({ t: "ping", c: i });
  assert.equal(await c.closed, CLOSE.rate);
  await stop();
});

test("un message trop gros ferme la connexion ; un message illisible est refusé sans fermer", async () => {
  const { port, stop } = await start();
  const c = client(port, passFor("Alice"));
  await c.next("welcome");
  c.ws.send("pas du json");
  assert.equal((await c.next("error")).code, "malformed");
  c.ws.send(JSON.stringify({ t: "create", visibility: "public", name: "x".repeat(10_000) }));
  assert.equal(await c.closed, 1009);
  await stop();
});

test("une coupure puis une reprise avec le jeton : même place, même salon", async () => {
  const { port, stop } = await start();
  const a = client(port, passFor("Alice"));
  const welcome = await a.next("welcome");
  a.send({ t: "create", visibility: "public", name: "" });
  const { room } = await a.next("joined");
  a.ws.terminate();
  await a.closed;
  const again = client(port, passFor("Alice"), welcome.resume);
  const back = await again.next("welcome");
  assert.equal(back.you.id, welcome.you.id);
  assert.equal(back.room?.code, room.code);
  again.ws.close();
  await stop();
});

test("/health : refusé sans la clé, chiffres avec", async () => {
  const { port, stop } = await start();
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 401);
  const res = await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${KEY}` } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; service: string; rooms: number };
  assert.equal(body.ok, true);
  assert.equal(body.service, "laterna-salons");
  assert.equal(body.rooms, 0);
  await stop();
});

test("un arrêt du service ferme chaque client en 4503 (« reconnectez-vous »)", async () => {
  const { port, stop } = await start();
  const c = client(port, passFor("Alice"));
  await c.next("welcome");
  const stopping = stop();
  assert.equal(await c.closed, CLOSE.restart);
  await stopping;
});
