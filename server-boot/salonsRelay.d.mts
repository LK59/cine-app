import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
export const SALONS_RELAY_KEY: unique symbol;
export const SALONS_SOCKET_PATH: "/api/salons/ws";
export const SALONS_MAX_SOCKETS: number;
export function relaySalonsUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, target?: { url: string } | null): boolean;
export function installSalonsRelay(server: Server): void;
