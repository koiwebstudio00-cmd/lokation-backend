import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { config, jwtSecret } from "../config.js";
import { ApiError } from "./errors.js";
const key = createHash("sha256").update(`private-file-transfer:${jwtSecret}`).digest();
export type TransferTicket = { id: string; expires: number; operation: "upload" | "download"; path: string; credential: string; portal: boolean; size?: number };
export function sealTransfer(data: Omit<TransferTicket, "id" | "expires">) {
  const ticket: TransferTicket = { ...data, id: randomUUID(), expires: Date.now() + 5 * 60_000 };
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(ticket)), cipher.final()]);
  const token = Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
  const origin = new URL(config.LOCAL_STORAGE_URL).origin;
  return { url: `${origin}/v1/file-transfers/${data.operation}${data.operation === "download" ? `?ticket=${token}` : ""}`, token: data.operation === "upload" ? token : undefined, expiresAt: new Date(ticket.expires).toISOString() };
}
export function openTransfer(token: string, operation: TransferTicket["operation"]): TransferTicket {
  try {
    if (token.length > 12000) throw new Error();
    const raw = Buffer.from(token, "base64url"), decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0,12));
    decipher.setAuthTag(raw.subarray(12,28));
    const ticket = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)),decipher.final()]).toString()) as TransferTicket;
    if (ticket.operation !== operation || ticket.expires <= Date.now()) throw new Error();
    return ticket;
  } catch { throw new ApiError("UNAUTHORIZED", "La autorización del archivo venció o no es válida. Volvé a intentarlo."); }
}
