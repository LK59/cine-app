import type { IncomingMessage, ServerResponse } from "node:http";
export const ENCODING_MARKER: "x-cine-encoding";
export const LENGTH_MARKER: "x-cine-length";
export const FRAMING_ENV: "CINE_FRAMING_HEADERS";
export function framingHeaderFor(name: string, value: unknown): { name: "Content-Encoding" | "Content-Length"; value: string } | null | undefined;
export function installResponseFraming(req: Pick<IncomingMessage, "method"> | null | undefined, res: ServerResponse): void;
