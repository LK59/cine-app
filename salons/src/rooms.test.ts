import { test } from "node:test";
import assert from "node:assert/strict";
import { Lobby, type MemberHandle } from "./rooms.ts";
import { LIMITS, type ServerMessage } from "./protocol.ts";

/** Une horloge et un minuteur à la main : on fait passer soixante secondes d'un coup. */
function harness() {
  let now = 1000;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const lobby = new Lobby({
    now: () => now,
    schedule: (fn, ms) => {
      const t = { at: now + ms, fn, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
    log: () => {},
  });
  const advance = (ms: number) => {
    now += ms;
    for (const t of timers.filter((t) => t.live && t.at <= now)) {
      t.live = false;
      t.fn();
    }
  };
  const join = (name: string, resume?: string) => {
    const inbox: ServerMessage[] = [];
    const conn = { send: (m: ServerMessage) => inbox.push(m) };
    const handle = lobby.connect({ sub: `compte-${name}`, name, admin: false, exp: Infinity }, conn, resume);
    const last = <T extends ServerMessage["t"]>(t: T) => [...inbox].reverse().find((m) => m.t === t) as Extract<ServerMessage, { t: T }> | undefined;
    return { inbox, handle, last };
  };
  return { lobby, advance, join };
}

const codeOf = (c: { last: (t: "joined") => Extract<ServerMessage, { t: "joined" }> | undefined }) => c.last("joined")!.room.code;

test("créer, rejoindre par le code, se voir l'un l'autre, quitter", () => {
  const { join } = harness();
  const a = join("Alice");
  const b = join("Bob");
  a.handle.receive({ t: "create", visibility: "private", name: "" });
  const code = codeOf(a);
  assert.equal(a.last("joined")!.room.name, "Salon de Alice");
  b.handle.receive({ t: "join", code });
  assert.deepEqual(b.last("joined")!.room.members.map((m) => m.name), ["Alice", "Bob"]);
  assert.equal(a.last("enter")!.member.name, "Bob");
  b.handle.receive({ t: "leave" });
  assert.equal(b.last("left")!.t, "left");
  assert.equal(a.last("exit")!.id, b.handle.id);
});

test("seuls les salons publics sont listés", () => {
  const { join } = harness();
  const a = join("Alice");
  const b = join("Bob");
  const c = join("Chloé");
  a.handle.receive({ t: "create", visibility: "public", name: "Soirée" });
  b.handle.receive({ t: "create", visibility: "private", name: "Secret" });
  c.handle.receive({ t: "list" });
  assert.deepEqual(c.last("rooms")!.rooms.map((r) => r.name), ["Soirée"]);
});

test("un salon complet refuse le suivant ; un code inconnu dit qu'il n'existe pas", () => {
  const { join } = harness();
  const host = join("Hôte");
  host.handle.receive({ t: "create", visibility: "public", name: "" });
  const code = codeOf(host);
  for (let i = 1; i < LIMITS.maxMembers; i++) join(`P${i}`).handle.receive({ t: "join", code });
  const late = join("Tard");
  late.handle.receive({ t: "join", code });
  assert.equal(late.last("error")!.code, "full");
  late.handle.receive({ t: "join", code: "ZZZZZZ" });
  assert.equal(late.last("error")!.code, "no-room");
});

test("un objet partagé : appliqué par le service, numéroté, diffusé à tous, demandeur compris", () => {
  const { join } = harness();
  const a = join("Alice");
  const b = join("Bob");
  a.handle.receive({ t: "create", visibility: "private", name: "" });
  b.handle.receive({ t: "join", code: codeOf(a) });
  a.handle.receive({ t: "set", key: "lampes.salon", value: false });
  a.handle.receive({ t: "set", key: "lampes.salon", value: true });
  assert.deepEqual(b.last("state"), { t: "state", key: "lampes.salon", v: 2, value: true, by: a.handle.id });
  assert.equal(a.last("state")!.v, 2);
  // Qui arrive ensuite reçoit l'état avec sa version.
  const c = join("Chloé");
  c.handle.receive({ t: "join", code: codeOf(a) });
  assert.deepEqual(c.last("joined")!.room.state["lampes.salon"], { v: 2, value: true });
  // Un objet inconnu ou une valeur hors forme : refusés, rien ne change.
  a.handle.receive({ t: "set", key: "chat", value: true });
  assert.equal(a.last("error")!.code, "unknown");
  a.handle.receive({ t: "set", key: "porte", value: "grande" });
  assert.equal(a.last("error")!.code, "bad-value");
  assert.equal(b.inbox.filter((m) => m.t === "state").length, 2);
});

test("une coupure garde la place : absent, puis rendu avec le salon à qui revient", () => {
  const { join, advance } = harness();
  const a = join("Alice");
  const b = join("Bob");
  a.handle.receive({ t: "create", visibility: "private", name: "" });
  const code = codeOf(a);
  b.handle.receive({ t: "join", code });
  const resume = b.last("welcome")!.resume;
  b.handle.disconnected();
  assert.deepEqual(a.last("away"), { t: "away", id: b.handle.id, away: true });
  advance(LIMITS.resumeMs - 1000);
  const again = join("Bob", resume);
  const welcome = again.last("welcome")!;
  assert.equal(welcome.you.id, b.handle.id);
  assert.equal(welcome.room?.code, code);
  assert.deepEqual(a.last("away"), { t: "away", id: b.handle.id, away: false });
  // L'ancienne socket qui se ferme en retard ne touche plus à la place.
  b.handle.disconnected();
  assert.equal(a.last("away")!.away, false);
});

test("sans retour dans le délai, la place est rendue au salon ; un jeton d'un autre compte ne prend rien", () => {
  const { join, advance } = harness();
  const a = join("Alice");
  const b = join("Bob");
  a.handle.receive({ t: "create", visibility: "private", name: "" });
  b.handle.receive({ t: "join", code: codeOf(a) });
  const resume = b.last("welcome")!.resume;
  b.handle.disconnected();
  const thief = join("Mallory", resume);
  assert.notEqual(thief.last("welcome")!.you.id, b.handle.id);
  assert.equal(thief.last("welcome")!.room, null);
  advance(LIMITS.resumeMs);
  assert.equal(a.last("exit")!.id, b.handle.id);
  assert.notEqual(join("Bob", resume).last("welcome")!.you.id, b.handle.id);
});

test("un salon vide se ferme après le délai, pas avant, et pas si quelqu'un revient", () => {
  const { lobby, join, advance } = harness();
  const a = join("Alice");
  a.handle.receive({ t: "create", visibility: "public", name: "" });
  const code = codeOf(a);
  a.handle.receive({ t: "leave" });
  advance(LIMITS.emptyRoomMs - 1);
  assert.equal(lobby.stats().rooms, 1);
  join("Bob").handle.receive({ t: "join", code });
  advance(LIMITS.emptyRoomMs);
  assert.equal(lobby.stats().rooms, 1);
  const c = join("Chloé");
  c.handle.receive({ t: "join", code });
  assert.equal(lobby.stats().members, 2);
});

test("créer en étant déjà dans un salon : on quitte le premier", () => {
  const { join } = harness();
  const a = join("Alice");
  const b = join("Bob");
  a.handle.receive({ t: "create", visibility: "private", name: "" });
  b.handle.receive({ t: "join", code: codeOf(a) });
  b.handle.receive({ t: "create", visibility: "private", name: "" });
  assert.equal(a.last("exit")!.id, b.handle.id);
  assert.notEqual(codeOf(b), codeOf(a));
});

// Garde de type : le harnais rend des poignées.
const _typeCheck: MemberHandle | null = null;
void _typeCheck;
