import { randomBytes, randomInt } from "node:crypto";
import type { PassClaims } from "./pass.ts";
import { CODE_ALPHABET, CODE_LENGTH, LIMITS, SHARED_OBJECTS, type ClientMessage, type ErrorCode, type MemberView, type RoomView, type ServerMessage, type Visibility } from "./protocol.ts";

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
 * - **un salon vide n'est fermé qu'après `LIMITS.emptyRoomMs`**, pour la même raison.
 */
export interface Connection {
  send(message: ServerMessage): void;
}

export interface LobbyOptions {
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

  constructor(options: LobbyOptions = {}) {
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
    const member: Member = { id: token(8), account: claims.sub, name: claims.name, admin: claims.admin, resume: token(18), conn, room: null, cancelExpiry: null };
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
            .filter((room) => room.visibility === "public")
            .map((room) => ({ code: room.code, name: room.name, count: room.members.size, max: LIMITS.maxMembers })),
        });
      case "create": {
        if (this.rooms.size >= LIMITS.maxRooms) return this.fail(member, "too-many-rooms", "Trop de salons ouverts en ce moment.");
        if (member.room) this.removeFromRoom(member);
        const room: Room = {
          code: this.freeCode(),
          name: message.name || `Salon de ${member.name}`,
          visibility: message.visibility,
          members: new Map(),
          state: new Map(),
          openedAt: this.now(),
          peak: 0,
          cancelClose: null,
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
        if (member.room) this.removeFromRoom(member);
        return this.enter(member, room);
      }
      case "leave": {
        if (!member.room) return this.fail(member, "not-in-room", "Pas de salon à quitter.");
        this.removeFromRoom(member);
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
    }
  }

  private enter(member: Member, room: Room): void {
    room.cancelClose?.();
    room.cancelClose = null;
    room.members.set(member.id, member);
    member.room = room;
    room.peak = Math.max(room.peak, room.members.size);
    this.broadcast(room, { t: "enter", member: this.memberView(member) }, member);
    this.send(member, { t: "joined", room: this.view(room), now: this.now() });
  }

  private removeFromRoom(member: Member): void {
    const room = member.room;
    if (!room) return;
    room.members.delete(member.id);
    member.room = null;
    this.broadcast(room, { t: "exit", id: member.id });
    if (room.members.size === 0 && !room.cancelClose) {
      room.cancelClose = this.schedule(() => {
        room.cancelClose = null;
        if (room.members.size > 0 || this.rooms.get(room.code) !== room) return;
        this.rooms.delete(room.code);
        this.log(`salon fermé ${room.code} après ${Math.round((this.now() - room.openedAt) / 60_000)} min, ${room.peak} participant(s) au plus`);
      }, LIMITS.emptyRoomMs);
    }
  }

  private freeCode(): string {
    for (;;) {
      let code = "";
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
  }

  private memberView(member: Member): MemberView {
    return { id: member.id, name: member.name, away: member.conn === null };
  }

  private view(room: Room): RoomView {
    return {
      code: room.code,
      name: room.name,
      visibility: room.visibility,
      members: [...room.members.values()].map((m) => this.memberView(m)),
      state: Object.fromEntries(room.state),
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
