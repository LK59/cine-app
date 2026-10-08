// L'adresse de qui nous parle vraiment (08/10/2026, DECISIONS.md §57).
//
// `X-Forwarded-For` est écrit par le relais (nginx-proxy-manager)… ou par n'importe qui. L'adresse
// lue jusqu'ici était le dernier maillon de cet en-tête, faute de mieux : les gestionnaires de route de
// Next ne donnent pas l'adresse de la connexion. Mais le cinéma est aussi joignable sans le relais,
// par tout conteneur du même réseau Docker : un tel voisin pouvait écrire l'en-tête qu'il voulait à
// chaque essai, et la limite des tentatives de connexion (par adresse) ne le freinait plus.
//
// Le démarrage (`server-boot/boot.mjs`) pose désormais l'adresse de la connexion dans
// `x-cine-peer`, en écrasant toute valeur envoyée. `X-Forwarded-For` n'est cru que si cette connexion
// vient d'un relais déclaré dans `TRUSTED_PROXIES` — une adresse, un réseau (`172.20.0.0/16`) ou un
// nom de conteneur, résolu toutes les cinq minutes (les adresses Docker changent à chaque recréation).
//
// Sans `TRUSTED_PROXIES`, ou sous `next dev` (sans le démarrage), rien ne change : le dernier maillon.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { config } from "@/lib/config";

const RESOLVE_EVERY_MS = 5 * 60_000;

/** Le démarrage l'a-t-il posé ? Sans lui, `x-cine-peer` pourrait venir du client. */
function peerHeaderTrusted(): boolean {
  return process.env.CINE_PEER_HEADER === "1";
}

/** `::ffff:172.20.0.16` et `172.20.0.16` sont la même adresse. */
export function normalizeAddress(address: string): string {
  const trimmed = address.trim();
  return trimmed.toLowerCase().startsWith("::ffff:") && isIP(trimmed.slice(7)) === 4 ? trimmed.slice(7) : trimmed;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

/** Une adresse dans une entrée : égale, ou dans le réseau IPv4 `a.b.c.d/n`. */
export function addressMatches(address: string, entry: string): boolean {
  const ip = normalizeAddress(address);
  if (!entry.includes("/")) return normalizeAddress(entry) === ip;
  const [base, bitsRaw] = entry.split("/");
  const bits = Number(bitsRaw);
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(base);
  if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

let resolved: { raw: string; at: number; entries: string[] } | null = null;
let resolving = false;

/** Les entrées de `TRUSTED_PROXIES`, les noms remplacés par leurs adresses (résolus en arrière-plan). */
function trustedEntries(raw: string): string[] {
  const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const literal = items.filter((s) => isIP(s.split("/")[0]) !== 0);
  const names = items.filter((s) => isIP(s.split("/")[0]) === 0);
  const fresh = resolved && resolved.raw === raw && Date.now() - resolved.at < RESOLVE_EVERY_MS;
  if (names.length > 0 && !fresh && !resolving) {
    resolving = true;
    void Promise.all(names.map((name) => lookup(name, { all: true }).then((all) => all.map((a) => a.address)).catch(() => [] as string[])))
      .then((lists) => {
        resolved = { raw, at: Date.now(), entries: lists.flat() };
      })
      .finally(() => {
        resolving = false;
      });
  }
  // Un nom pas encore résolu ne fait confiance à personne : l'adresse de la connexion fait foi.
  return [...literal, ...(resolved && resolved.raw === raw ? resolved.entries : [])];
}

/** Pour les tests : oublier les noms résolus. */
export function forgetResolvedProxies(): void {
  resolved = null;
}

function lastForwarded(header: string | null): string | null {
  const last = header?.split(",").map((p) => p.trim()).filter(Boolean).at(-1);
  return last ?? null;
}

/**
 * L'adresse du client : celle de la connexion si elle ne vient pas d'un relais de confiance ; sinon,
 * en remontant `X-Forwarded-For` de droite à gauche, la première qui n'en est pas un.
 */
export function clientAddressOf(headers: { get(name: string): string | null }, rawProxies?: string): string | null {
  // Lu sans pouvoir lever : une configuration incomplète (des tests, une installation ancienne) garde
  // l'ancienne règle plutôt que de faire tomber une connexion.
  const raw = rawProxies ?? config.network?.trustedProxies ?? "";
  const peerRaw = peerHeaderTrusted() ? headers.get("x-cine-peer") : null;
  const forwarded = headers.get("x-forwarded-for");
  if (!raw.trim() || !peerRaw) return lastForwarded(forwarded);
  const peer = normalizeAddress(peerRaw);
  const trusted = trustedEntries(raw);
  const isTrusted = (address: string) => trusted.some((entry) => addressMatches(address, entry));
  if (!isTrusted(peer)) return peer;
  const chain = (forwarded ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  for (let i = chain.length - 1; i >= 0; i--) {
    if (!isTrusted(chain[i])) return normalizeAddress(chain[i]);
  }
  return chain[0] ? normalizeAddress(chain[0]) : peer;
}

/** La connexion vient-elle de la machine elle-même (le préchauffage des affiches) ? `null` : on ne sait pas. */
export function fromLoopback(headers: { get(name: string): string | null }): boolean | null {
  const peer = peerHeaderTrusted() ? headers.get("x-cine-peer") : null;
  if (!peer) return null;
  const ip = normalizeAddress(peer);
  return ip === "127.0.0.1" || ip === "::1";
}
