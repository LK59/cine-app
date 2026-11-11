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

import { openAnswers, sealAnswers, verifyValue, type Roster, type SignedResult } from "./seal.ts";
import { INTRO_MS } from "./quiz.ts";

const KEY = "clé-des-tests-du-salon-0123456789abcdef";

function keyed() {
  let now = 1000;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const lobby = new Lobby({
    key: KEY,
    now: () => now,
    schedule: (fn, ms) => {
      const t = { at: now + ms, fn, live: true };
      timers.push(t);
      return () => void (t.live = false);
    },
    log: () => {},
  });
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const next = timers.filter((t) => t.live && t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      now = Math.max(now, next.at);
      next.live = false;
      next.fn();
    }
    now = until;
  };
  const join = (name: string) => {
    const inbox: ServerMessage[] = [];
    const handle = lobby.connect({ sub: `compte-${name}`, name, admin: false, exp: Infinity }, { send: (m) => inbox.push(m) });
    const last = <T extends ServerMessage["t"]>(t: T) => [...inbox].reverse().find((m) => m.t === t) as Extract<ServerMessage, { t: T }> | undefined;
    return { inbox, handle, last };
  };
  return { lobby, advance, join, now: () => now };
}

test("la position va aux autres seulement, et reste connue de qui arrive ensuite", () => {
  const { join } = keyed();
  const a = join("Alice");
  const b = join("Bob");
  a.handle.receive({ t: "create", visibility: "private", name: "" });
  const code = a.last("joined")!.room.code;
  b.handle.receive({ t: "join", code });
  a.handle.receive({ t: "pos", p: [100, 0, -250, 1571, 0, 1] });
  assert.deepEqual(b.last("pos"), { t: "pos", id: a.handle.id, p: [100, 0, -250, 1571, 0, 1] });
  assert.equal(a.inbox.filter((m) => m.t === "pos").length, 0);
  const c = join("Chloé");
  c.handle.receive({ t: "join", code });
  assert.deepEqual(c.last("joined")!.room.members.find((m) => m.name === "Alice")!.p, [100, 0, -250, 1571, 0, 1]);
});

test("le chat : diffusé à tous avec le nom ; cinq messages par dix secondes au plus", () => {
  const { join, advance } = keyed();
  const a = join("Alice");
  const b = join("Bob");
  a.handle.receive({ t: "create", visibility: "private", name: "" });
  b.handle.receive({ t: "join", code: a.last("joined")!.room.code });
  for (let i = 0; i < 6; i++) a.handle.receive({ t: "chat", text: `message ${i}` });
  assert.equal(b.inbox.filter((m) => m.t === "chat").length, 5);
  assert.equal(a.last("error")!.code, "rate");
  assert.equal(b.last("chat")!.name, "Alice");
  advance(10_000);
  a.handle.receive({ t: "chat", text: "encore" });
  assert.equal(b.last("chat")!.text, "encore");
});

test("la liste des présents est signée par le service, pour cet usage seulement", () => {
  const { join } = keyed();
  const a = join("Alice");
  const b = join("Bob");
  a.handle.receive({ t: "create", visibility: "private", name: "" });
  b.handle.receive({ t: "join", code: a.last("joined")!.room.code });
  a.handle.receive({ t: "roster" });
  const token = a.last("roster")!.token;
  assert.deepEqual(verifyValue<Roster>(token, KEY, "roster")!.subs.sort(), ["compte-Alice", "compte-Bob"]);
  assert.equal(verifyValue(token, KEY, "result"), null);
  assert.equal(verifyValue(token, KEY + "x", "roster"), null);
});

test("une partie à deux, de bout en bout : réponses scellées ouvertes par le service, révélation, bilan signé", () => {
  const { join, advance, now } = keyed();
  const a = join("Alice");
  const b = join("Bob");
  a.handle.receive({ t: "create", visibility: "private", name: "" });
  b.handle.receive({ t: "join", code: a.last("joined")!.room.code });
  const game = { id: "partie-test-01", variant: "mixte" as const, rounds: [0, 1, 2].map((i) => ({ kind: "tagline" as const, text: `n${i}`, choices: ["A", "B", "C", "D"] as [string, string, string, string] })) };
  // Scellée pour une autre partie : refusée.
  a.handle.receive({ t: "game.start", game, sealed: sealAnswers({ gameId: "autre", answers: [0, 0, 0], exp: now() + 60_000 }, KEY) });
  assert.equal(a.last("error")!.code, "bad-game");
  a.handle.receive({ t: "game.start", game, sealed: sealAnswers({ gameId: game.id, answers: [2, 0, 1], exp: now() + 60_000 }, KEY) });
  assert.equal(b.last("game")!.game!.phase, "intro");
  b.handle.receive({ t: "game.start", game, sealed: sealAnswers({ gameId: game.id, answers: [2, 0, 1], exp: now() + 60_000 }, KEY) });
  assert.equal(b.last("error")!.code, "game-running");
  advance(INTRO_MS);
  assert.equal(a.last("game")!.game!.phase, "question");
  assert.equal(a.last("game")!.game!.answer, null);
  for (let r = 0; r < 3; r++) {
    const answer = [2, 0, 1][r];
    a.handle.receive({ t: "game.answer", round: r, choice: answer });
    b.handle.receive({ t: "game.answer", round: r, choice: (answer + 1) % 4 });
    const view = b.last("game")!.game!;
    assert.equal(view.phase, "reveal");
    assert.equal(view.answer, answer);
    advance(view.endsAt - now());
  }
  const end = a.last("game")!;
  assert.equal(end.game!.phase, "end");
  const result = verifyValue<SignedResult>(end.result, KEY, "result")!;
  assert.equal(result.gameId, game.id);
  const alice = result.players.find((p) => p.sub === "compte-Alice")!;
  assert.equal(alice.correct, 3);
  assert.ok(alice.score > 3000);
  assert.equal(result.players.find((p) => p.sub === "compte-Bob")!.score, 0);
  // Qui arrive après la fin voit le bilan.
  const c = join("Chloé");
  c.handle.receive({ t: "join", code: a.last("joined")!.room.code });
  assert.equal(c.last("game")!.result, end.result);
  // Le sceau ne s'ouvre qu'avec la clé, et pas après son heure.
  assert.equal(openAnswers(sealAnswers({ gameId: "x", answers: [1], exp: 5000 }, KEY), KEY, 6000), null);
  assert.equal(openAnswers(sealAnswers({ gameId: "x", answers: [1], exp: 5000 }, KEY), "autre-clé", 1000), null);
});

import { signValue as signTicket } from "./seal.ts";
import { READY_TIMEOUT_MS } from "./tv.ts";

function pair() {
  const h = keyed();
  const a = h.join("Alice");
  const b = h.join("Bob");
  a.handle.receive({ t: "create", visibility: "public", name: "Ciné" });
  const code = a.last("joined")!.room.code;
  b.handle.receive({ t: "join", code });
  const ticket = (itemId: string, room = code) => signTicket({ room, itemId, exp: h.now() + 60_000 }, KEY, "tv");
  return { ...h, a, b, code, ticket };
}

test("télévision commune : un titre autorisé, chacun prêt, départ ensemble à l'heure donnée", () => {
  const { a, b, ticket, now } = pair();
  a.handle.receive({ t: "tv.open", ticket: "faux", title: "Film", from: 0 });
  assert.equal(a.last("error")!.code, "bad-ticket");
  a.handle.receive({ t: "tv.open", ticket: ticket("film-1", "AUTRE1"), title: "Film", from: 0 });
  assert.equal(a.last("error")!.code, "bad-ticket", "un droit signé pour un autre salon");
  a.handle.receive({ t: "tv.open", ticket: ticket("film-1"), title: "Film", from: 42 });
  const prep = b.last("tv")!.tv!;
  assert.equal(prep.phase, "preparing");
  assert.equal(prep.position, 42);
  a.handle.receive({ t: "tv.ready", epoch: prep.epoch });
  assert.equal(b.last("tv")!.tv!.phase, "preparing", "Bob n'est pas encore prêt");
  b.handle.receive({ t: "tv.ready", epoch: prep.epoch });
  const go = a.last("tv")!.tv!;
  assert.equal(go.phase, "playing");
  assert.ok(go.anchor > now());
  // Un second « lancer » du même titre en préparation est ignoré ; un autre titre repart de zéro.
  b.handle.receive({ t: "tv.pause" });
  assert.equal(a.last("tv")!.tv!.phase, "paused");
  b.handle.receive({ t: "tv.play" });
  assert.equal(a.last("tv")!.tv!.phase, "preparing");
});

test("une préparation part sans le retardataire au bout du délai, ou dès qu'il s'en va", () => {
  const { a, b, ticket, advance, join, code } = pair();
  a.handle.receive({ t: "tv.open", ticket: ticket("film-1"), title: "Film", from: 0 });
  a.handle.receive({ t: "tv.ready", epoch: a.last("tv")!.tv!.epoch });
  advance(READY_TIMEOUT_MS);
  assert.equal(b.last("tv")!.tv!.phase, "playing");
  // Une nouvelle préparation ; Bob se coupe : Alice, prête, n'attend plus.
  a.handle.receive({ t: "tv.seek", to: 100 });
  a.handle.receive({ t: "tv.ready", epoch: a.last("tv")!.tv!.epoch });
  b.handle.disconnected();
  assert.equal(a.last("tv")!.tv!.phase, "playing");
  assert.equal(a.last("tv")!.tv!.position, 100);
  // Qui arrive voit la télévision dans l'état du salon.
  const c = join("Chloé");
  c.handle.receive({ t: "join", code });
  assert.equal(c.last("joined")!.room.tv!.itemId, "film-1");
});

test("une partie prend la télévision ; la liste des salons dit qui est là et ce qui s'y passe", () => {
  const { a, b, ticket, now, join } = pair();
  a.handle.receive({ t: "tv.open", ticket: ticket("film-1"), title: "Film", from: 0 });
  const c = join("Chloé");
  c.handle.receive({ t: "list" });
  assert.deepEqual(c.last("rooms")!.rooms[0], { code: a.last("joined")!.room.code, name: "Ciné", count: 2, max: 8, names: ["Alice", "Bob"], activity: "tv" });
  const game = { id: "partie-tv-0001", variant: "mixte" as const, rounds: [0, 1, 2].map((i) => ({ kind: "tagline" as const, text: `n${i}`, choices: ["A", "B", "C", "D"] as [string, string, string, string] })) };
  a.handle.receive({ t: "game.start", game, sealed: sealAnswers({ gameId: game.id, answers: [0, 0, 0], exp: now() + 60_000 }, KEY) });
  assert.equal(b.last("tv")!.tv, null);
  a.handle.receive({ t: "tv.open", ticket: ticket("film-2"), title: "Autre", from: 0 });
  assert.equal(a.last("error")!.code, "game-running");
});

test("l'apparence est relayée aux autres, et connue de qui arrive ensuite", () => {
  const { a, b, code, join } = pair();
  a.handle.receive({ t: "look", look: [2, 1, 3, 1] });
  assert.deepEqual(b.last("look"), { t: "look", id: a.handle.id, look: [2, 1, 3, 1] });
  const c = join("Chloé");
  c.handle.receive({ t: "join", code });
  assert.deepEqual(c.last("joined")!.room.members.find((m) => m.name === "Alice")!.look, [2, 1, 3, 1]);
});
