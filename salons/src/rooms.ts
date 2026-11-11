import { randomBytes, randomInt } from "node:crypto";
import type { PassClaims } from "./pass.ts";
import { CODE_ALPHABET, CODE_LENGTH, LIMITS, SHARED_OBJECTS, type ClientMessage, type ErrorCode, type MemberView, type RoomView, type ServerMessage, type Visibility } from "./protocol.ts";
import { QuizGame } from "./quiz.ts";
import { openAnswers, signValue, verifyValue, type Roster, type SignedResult, type TvTicket } from "./seal.ts";
import { READY_TIMEOUT_MS, SharedTv, type Look } from "./tv.ts";

/**
 * Les salons, sans réseau : qui est où, ce qui est partagé, et ce qui arrive à une coupure.
 *
 * Rien ici ne connaît la WebSocket : un participant reçoit ses messages par une `Connection` (une fonction
 * d'envoi), et le temps passe par une horloge et un minuteur qu'on peut remplacer — c'est ce qui permet aux
 * tests de jouer une coupure de soixante secondes en un instant.
 *
 * Trois règles portent tout le reste :
 * - **le service fait foi** : un changement d'objet n'existe qu'une fois appliqué ici, numéroté (sa version) et
 *   diffusé à tous, le demandeur compris ;
 * - **une coupure n'est pas un départ** : la place est gardée `LIMITS.resumeMs`, marquée « absent », et le jeton
 *   de reprise rendu à l'arrivée la rend à qui revient (même compte, nouvelle connexion) — un redéploiement de
 *   l'application coupe toutes les connexions d'un coup, et personne ne doit perdre son salon pour autant ;
 * - **un salon vidé par une coupure n'est fermé qu'après `LIMITS.emptyRoomMs`**, pour la même raison ; vidé par un
 *   départ voulu (« Quitter », un autre salon), il ferme aussitôt — et un salon où personne n'est connecté ne figure
 *   plus dans la liste publique.
 */
export interface Connection {
  send(message: ServerMessage): void;
}

export interface LobbyOptions {
  /** La clé partagée avec l'application : elle ouvre les réponses d'une partie et signe présents et résultats. */
  key?: string;
  now?: () => number;
  /** Planifie `fn` dans `ms` ; rend de quoi l'annuler. */
  schedule?: (fn: () => void, ms: number) => () => void;
  log?: (line: string) => void;
}

interface Member {
  id: string;
  account: string;
  name: string;
  admin: boolean;
  resume: string;
  conn: Connection | null;
  room: Room | null;
  /** Annule la fin de la place gardée (la personne est revenue). */
  cancelExpiry: (() => void) | null;
  /** Dernière position connue (`pos`), pour qui arrive ensuite. */
  p: number[] | null;
  /** Les instants des derniers messages du chat (débit borné). */
  chatTimes: number[];
  look: Look | null;
}

interface Room {
  code: string;
  name: string;
  visibility: Visibility;
  members: Map<string, Member>;
  state: Map<string, { v: number; value: unknown }>;
  openedAt: number;
  peak: number;
  cancelClose: (() => void) | null;
  /** La partie en cours, ou la dernière finie (montrée jusqu'à la suivante). */
  game: QuizGame | null;
  /** Le bilan signé de la partie finie, rendu à qui arrive après. */
  result: string | null;
  cancelGameTick: (() => void) | null;
  /** La télévision commune, et le délai au-delà duquel une préparation démarre sans les retardataires. */
  tv: SharedTv | null;
  cancelTvTimeout: (() => void) | null;
}

const defaultSchedule = (fn: () => void, ms: number) => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

export class Lobby {
  private readonly rooms = new Map<string, Room>();
  private readonly byResume = new Map<string, Member>();
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly log: (line: string) => void;
  private readonly key: string;

  constructor(options: LobbyOptions = {}) {
    this.key = options.key ?? "";
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? defaultSchedule;
    this.log = options.log ?? ((line) => console.log(`[salons] ${line}`));
  }

  /**
   * Une connexion ouverte avec un laissez-passer valable. Avec un jeton de reprise encore bon, pour le même
   * compte, et dont la place n'est tenue par personne : la place est rendue, salon compris.
   */
  connect(claims: PassClaims, conn: Connection, resume?: string | null): MemberHandle {
    const kept = resume ? this.byResume.get(resume) : undefined;
    if (kept && kept.account === claims.sub && kept.conn === null) {
      kept.conn = conn;
      kept.name = claims.name;
      kept.cancelExpiry?.();
      kept.cancelExpiry = null;
      if (kept.room) this.broadcast(kept.room, { t: "away", id: kept.id, away: false });
      conn.send({ t: "welcome", you: { id: kept.id, name: kept.name }, resume: kept.resume, now: this.now(), room: kept.room ? this.view(kept.room) : null });
      return new MemberHandle(this, kept, conn);
    }
    const member: Member = { id: token(8), account: claims.sub, name: claims.name, admin: claims.admin, resume: token(18), conn, room: null, cancelExpiry: null, p: null, chatTimes: [], look: null };
    this.byResume.set(member.resume, member);
    conn.send({ t: "welcome", you: { id: member.id, name: member.name }, resume: member.resume, now: this.now(), room: null });
    return new MemberHandle(this, member, conn);
  }

  /** Les chiffres du moment, pour `/health` et le journal. */
  stats(): { rooms: number; members: number; connected: number } {
    let members = 0;
    let connected = 0;
    for (const room of this.rooms.values()) {
      members += room.members.size;
      for (const m of room.members.values()) if (m.conn) connected += 1;
    }
    return { rooms: this.rooms.size, members, connected };
  }

  /**
   * @internal — appelé par `MemberHandle`. Seulement pour la connexion qui tient la place : une vieille socket
   * qui se ferme en retard ne marque pas « absent » quelqu'un qui est déjà revenu par une autre.
   */
  disconnect(member: Member, conn: Connection): void {
    if (member.conn !== conn) return;
    member.conn = null;
    if (member.room) this.broadcast(member.room, { t: "away", id: member.id, away: true });
    // Une préparation n'attend pas quelqu'un qui vient de partir : les autres sont peut-être tous prêts.
    if (member.room?.tv?.phase === "preparing") this.tvChanged(member.room);
    member.cancelExpiry = this.schedule(() => {
      member.cancelExpiry = null;
      this.byResume.delete(member.resume);
      if (member.room) this.removeFromRoom(member);
    }, LIMITS.resumeMs);
  }

  /** @internal — appelé par `MemberHandle`. */
  handle(member: Member, message: ClientMessage): void {
    switch (message.t) {
      case "ping":
        return this.send(member, { t: "pong", c: message.c, s: this.now() });
      case "list":
        return this.send(member, {
          t: "rooms",
          rooms: [...this.rooms.values()]
            // Personne de connecté (tous coupés, en attente de reprise) : le salon n'est plus montré.
            .filter((room) => room.visibility === "public" && [...room.members.values()].some((m) => m.conn))
            .map((room) => ({
              code: room.code,
              name: room.name,
              count: room.members.size,
              max: LIMITS.maxMembers,
              names: [...room.members.values()].slice(0, 4).map((m) => m.name),
              activity: room.game && room.game.phase !== "end" ? ("quiz" as const) : room.tv ? ("tv" as const) : null,
            })),
        });
      case "create": {
        if (this.rooms.size >= LIMITS.maxRooms) return this.fail(member, "too-many-rooms", "Trop de salons ouverts en ce moment.");
        if (member.room) this.removeFromRoom(member, true);
        const room: Room = {
          code: this.freeCode(),
          name: message.name || `Salon de ${member.name}`,
          visibility: message.visibility,
          members: new Map(),
          state: new Map(),
          openedAt: this.now(),
          peak: 0,
          cancelClose: null,
          game: null,
          result: null,
          cancelGameTick: null,
          tv: null,
          cancelTvTimeout: null,
        };
        this.rooms.set(room.code, room);
        this.log(`salon ouvert ${room.code} (${room.visibility === "public" ? "public" : "privé"}) par ${member.name}`);
        return this.enter(member, room);
      }
      case "join": {
        const room = this.rooms.get(message.code);
        if (!room) return this.fail(member, "no-room", "Aucun salon ne porte ce code.");
        if (member.room === room) return this.send(member, { t: "joined", room: this.view(room), now: this.now() });
        if (room.members.size >= LIMITS.maxMembers) return this.fail(member, "full", "Ce salon est complet.");
        if (member.room) this.removeFromRoom(member, true);
        return this.enter(member, room);
      }
      case "leave": {
        if (!member.room) return this.fail(member, "not-in-room", "Pas de salon à quitter.");
        this.removeFromRoom(member, true);
        return this.send(member, { t: "left" });
      }
      case "set": {
        const room = member.room;
        if (!room) return this.fail(member, "not-in-room", "Rejoignez d'abord un salon.");
        const accepts = SHARED_OBJECTS[message.key];
        if (!accepts) return this.fail(member, "unknown", `Objet inconnu : ${message.key}.`);
        if (!accepts(message.value)) return this.fail(member, "bad-value", `Valeur refusée pour ${message.key}.`);
        const v = (room.state.get(message.key)?.v ?? 0) + 1;
        room.state.set(message.key, { v, value: message.value });
        return this.broadcast(room, { t: "state", key: message.key, v, value: message.value, by: member.id });
      }
      case "pos": {
        // Hors d'un salon, une position ne va nulle part : ignorée sans erreur (elle part en continu).
        if (!member.room) return;
        member.p = message.p;
        return this.broadcast(member.room, { t: "pos", id: member.id, p: message.p }, member);
      }
      case "chat": {
        const room = member.room;
        if (!room) return this.fail(member, "not-in-room", "Rejoignez d'abord un salon.");
        const now = this.now();
        member.chatTimes = member.chatTimes.filter((t) => now - t < LIMITS.chatWindowMs);
        if (member.chatTimes.length >= LIMITS.chatPerWindow) return this.fail(member, "rate", "Trop de messages : attendez un instant.");
        member.chatTimes.push(now);
        return this.broadcast(room, { t: "chat", id: member.id, name: member.name, text: message.text, at: now });
      }
      case "roster": {
        const room = member.room;
        if (!room) return this.fail(member, "not-in-room", "Rejoignez d'abord un salon.");
        const roster: Roster = { room: room.code, subs: [...new Set([...room.members.values()].map((m) => m.account))], exp: this.now() + 10 * 60_000 };
        return this.send(member, { t: "roster", token: signValue(roster, this.key, "roster") });
      }
      case "game.start": {
        const room = member.room;
        if (!room) return this.fail(member, "not-in-room", "Rejoignez d'abord un salon.");
        if (room.game && room.game.phase !== "end") return this.fail(member, "game-running", "Une partie est déjà en cours.");
        const opened = this.key ? openAnswers(message.sealed, this.key, this.now()) : null;
        if (!opened || opened.gameId !== message.game.id || opened.answers.length !== message.game.rounds.length) {
          return this.fail(member, "bad-game", "Partie refusée : préparée pour un autre salon, ou trop ancienne.");
        }
        const players = [...room.members.values()].filter((m) => m.conn).map((m) => ({ id: m.id, name: m.name }));
        room.game = new QuizGame(message.game, opened.answers, players, this.now());
        room.result = null;
        // Le jeu prend la télévision.
        if (room.tv) this.setTv(room, null, member);
        this.log(`partie lancée dans ${room.code} (${message.game.variant}, ${message.game.rounds.length} manches, ${players.length} joueur(s))`);
        return this.gameChanged(room);
      }
      case "game.answer": {
        const room = member.room;
        if (!room?.game) return;
        const before = room.game.phase;
        const taken = room.game.answer(member.id, message.round, message.choice, this.now());
        if (taken === null) return;
        // « A répondu » pour tous ; la justesse, seulement à la révélation (qui peut venir de cette réponse).
        return before !== room.game.phase ? this.gameChanged(room) : this.broadcast(room, { t: "game", game: room.game.view() });
      }
      case "tv.open": {
        const room = member.room;
        if (!room) return this.fail(member, "not-in-room", "Rejoignez d'abord un salon.");
        const ticket = this.key ? verifyValue<TvTicket>(message.ticket, this.key, "tv") : null;
        if (!ticket || ticket.room !== room.code || typeof ticket.itemId !== "string" || ticket.exp <= this.now()) {
          return this.fail(member, "bad-ticket", "Ce titre n'est pas autorisé pour ce salon.");
        }
        if (room.game && room.game.phase !== "end") return this.fail(member, "game-running", "Une partie occupe la télévision.");
        // Plusieurs pages demandent souvent la même chose au même instant (l'épisode suivant, à la fin d'un décompte) :
        // une seule préparation.
        if (room.tv && room.tv.itemId === ticket.itemId && room.tv.phase === "preparing") return;
        const now = this.now();
        if (room.tv && room.tv.itemId === ticket.itemId) room.tv.prepare(message.from, now);
        else room.tv = new SharedTv(ticket.itemId, message.title, message.from, now);
        this.log(`télévision de ${room.code} : ${message.title}`);
        return this.tvChanged(room, member);
      }
      case "tv.ready": {
        const room = member.room;
        if (!room?.tv) return;
        if (room.tv.markReady(member.id, message.epoch, this.present(room))) {
          room.tv.start(this.now());
          return this.tvChanged(room, member);
        }
        return this.broadcast(room, { t: "tv", tv: room.tv.view() });
      }
      case "tv.play": {
        const tv = member.room?.tv;
        if (!tv || tv.phase !== "paused") return;
        tv.prepare(tv.position, this.now());
        return this.tvChanged(member.room!, member);
      }
      case "tv.pause": {
        const tv = member.room?.tv;
        if (!tv || tv.phase === "paused") return;
        tv.pause(this.now());
        return this.tvChanged(member.room!, member);
      }
      case "tv.seek": {
        const tv = member.room?.tv;
        if (!tv) return;
        // En pause, on déplace la position sans repartir ; sinon, une préparation à la nouvelle position.
        if (tv.phase === "paused") tv.position = message.to;
        else tv.prepare(message.to, this.now());
        return this.tvChanged(member.room!, member);
      }
      case "tv.stop": {
        const room = member.room;
        if (!room?.tv) return;
        return this.setTv(room, null, member);
      }
      case "look": {
        member.look = message.look;
        if (member.room) this.broadcast(member.room, { t: "look", id: member.id, look: message.look }, member);
        return;
      }
      case "game.stop": {
        const room = member.room;
        if (!room?.game) return;
        room.cancelGameTick?.();
        room.cancelGameTick = null;
        room.game = null;
        room.result = null;
        return this.broadcast(room, { t: "game", game: null });
      }
    }
  }

  /** Les présents connectés d'un salon : ceux qu'une préparation attend. */
  private present(room: Room): string[] {
    return [...room.members.values()].filter((m) => m.conn).map((m) => m.id);
  }

  private setTv(room: Room, tv: SharedTv | null, by?: Member): void {
    room.cancelTvTimeout?.();
    room.cancelTvTimeout = null;
    room.tv = tv;
    if (!tv) this.broadcast(room, { t: "tv", tv: null, ...(by ? { by: by.id } : {}) });
  }

  /**
   * Diffuse la télévision ; en préparation, planifie le départ sans les retardataires (`READY_TIMEOUT_MS`), ou démarre
   * tout de suite si tous les présents sont déjà prêts (le dernier pas encore prêt vient de partir).
   */
  private tvChanged(room: Room, by?: Member): void {
    const tv = room.tv;
    if (!tv) return;
    room.cancelTvTimeout?.();
    room.cancelTvTimeout = null;
    if (tv.allReady(this.present(room))) tv.start(this.now());
    if (tv.phase === "preparing") {
      const epoch = tv.epoch;
      room.cancelTvTimeout = this.schedule(() => {
        room.cancelTvTimeout = null;
        if (room.tv !== tv || tv.epoch !== epoch || tv.phase !== "preparing") return;
        tv.start(this.now());
        this.tvChanged(room);
      }, READY_TIMEOUT_MS);
    }
    this.broadcast(room, { t: "tv", tv: tv.view(), ...(by ? { by: by.id } : {}) });
  }

  /** Diffuse la partie, et planifie le prochain changement de phase à l'heure du service. */
  private gameChanged(room: Room): void {
    const game = room.game;
    if (!game) return;
    room.cancelGameTick?.();
    room.cancelGameTick = null;
    if (game.phase === "end") {
      if (!room.result) {
        const result: SignedResult = {
          gameId: game.data.id,
          variant: game.data.variant,
          room: room.code,
          at: this.now(),
          players: game.final().map((p) => ({ sub: room.members.get(p.id)?.account ?? "", name: p.name, score: p.score, correct: p.correct, total: p.total, bestStreak: p.bestStreak })).filter((p) => p.sub),
        };
        room.result = signValue(result, this.key, "result");
        this.log(`partie finie dans ${room.code} (${result.players.length} joueur(s))`);
      }
      return this.broadcast(room, { t: "game", game: game.view(), result: room.result });
    }
    this.broadcast(room, { t: "game", game: game.view() });
    room.cancelGameTick = this.schedule(() => {
      room.cancelGameTick = null;
      if (room.game !== game) return;
      game.tick(this.now());
      this.gameChanged(room);
    }, Math.max(0, game.endsAt - this.now()));
  }

  private enter(member: Member, room: Room): void {
    room.cancelClose?.();
    room.cancelClose = null;
    room.members.set(member.id, member);
    member.room = room;
    room.peak = Math.max(room.peak, room.members.size);
    // Arrivé en cours de partie : il joue à partir de la manche suivante.
    if (room.game && room.game.phase !== "end") room.game.addPlayer(member.id, member.name);
    // Sa propre apparence, s'il l'a déjà dite : les autres la reçoivent avec son arrivée (`enter`).
    this.broadcast(room, { t: "enter", member: this.memberView(member) }, member);
    this.send(member, { t: "joined", room: this.view(room), now: this.now() });
    if (room.result && room.game?.phase === "end") this.send(member, { t: "game", game: room.game.view(), result: room.result });
    // Un salon vidé en pleine partie avait arrêté son chronomètre : il repart avec le premier qui revient.
    if (room.game && room.game.phase !== "end" && !room.cancelGameTick) this.gameChanged(room);
  }

  /** `left` : un départ voulu — vide, le salon ferme aussitôt ; sinon (place expirée) il attend `emptyRoomMs`. */
  private removeFromRoom(member: Member, left = false): void {
    const room = member.room;
    if (!room) return;
    room.members.delete(member.id);
    member.room = null;
    member.p = null;
    room.game?.removePlayer(member.id);
    this.broadcast(room, { t: "exit", id: member.id });
    if (room.members.size === 0) {
      room.cancelGameTick?.();
      room.cancelGameTick = null;
      room.cancelTvTimeout?.();
      room.cancelTvTimeout = null;
      room.tv = null;
    } else if (room.tv?.phase === "preparing") this.tvChanged(room);
    if (room.members.size > 0) return;
    const close = () => {
      if (room.members.size > 0 || this.rooms.get(room.code) !== room) return;
      this.rooms.delete(room.code);
      this.log(`salon fermé ${room.code} après ${Math.round((this.now() - room.openedAt) / 60_000)} min, ${room.peak} participant(s) au plus`);
    };
    if (left) {
      room.cancelClose?.();
      room.cancelClose = null;
      return close();
    }
    room.cancelClose ??= this.schedule(() => {
      room.cancelClose = null;
      close();
    }, LIMITS.emptyRoomMs);
  }

  private freeCode(): string {
    for (;;) {
      let code = "";
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
  }

  private memberView(member: Member): MemberView {
    return { id: member.id, name: member.name, away: member.conn === null, p: member.p, look: member.look };
  }

  private view(room: Room): RoomView {
    return {
      code: room.code,
      name: room.name,
      visibility: room.visibility,
      members: [...room.members.values()].map((m) => this.memberView(m)),
      state: Object.fromEntries(room.state),
      game: room.game ? room.game.view() : null,
      tv: room.tv ? room.tv.view() : null,
    };
  }

  private send(member: Member, message: ServerMessage): void {
    member.conn?.send(message);
  }

  private fail(member: Member, code: ErrorCode, message: string): void {
    this.send(member, { t: "error", code, message });
  }

  private broadcast(room: Room, message: ServerMessage, except?: Member): void {
    for (const m of room.members.values()) if (m !== except) m.conn?.send(message);
  }
}

/** Ce que le transport tient d'un participant : ses messages, et sa coupure. */
export class MemberHandle {
  private readonly lobby: Lobby;
  private readonly member: Member;
  private readonly conn: Connection;
  constructor(lobby: Lobby, member: Member, conn: Connection) {
    this.lobby = lobby;
    this.member = member;
    this.conn = conn;
  }
  get id(): string {
    return this.member.id;
  }
  receive(message: ClientMessage): void {
    // Une socket remplacée par une reprise ne parle plus au nom de la place.
    if (this.member.conn === this.conn) this.lobby.handle(this.member, message);
  }
  /** Rend une erreur à ce seul participant (message illisible, débit dépassé). */
  reject(code: ErrorCode, message: string): void {
    this.member.conn?.send({ t: "error", code, message });
  }
  disconnected(): void {
    this.lobby.disconnect(this.member, this.conn);
  }
}

function token(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}
