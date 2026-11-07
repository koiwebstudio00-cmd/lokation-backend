import { Router } from "express";
import { openTransfer } from "../../lib/file-transfer-tickets.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { ACCESS_COOKIE, CSRF_COOKIE } from "../../lib/cookies.js";
import { runWithContext } from "../../lib/prisma.js";
import { ApiError } from "../../lib/errors.js";
import { rentalDocumentRoutes } from "./documents.js";
import { rentalPortalRoutes } from "./portal.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express { interface Request { fileTransfer?: ReturnType<typeof openTransfer> } }
}
export const fileTransferRoutes = Router();
fileTransferRoutes.use("/file-transfers", (req,res,next) => {
  res.set({"Cache-Control":"no-store", "Referrer-Policy":"no-referrer", "Cross-Origin-Resource-Policy":"cross-origin"});
  if (req.method === "POST" && req.path === "/upload") {
    req.fileTransfer = openTransfer(req.get("authorization")?.replace(/^Bearer /,"") ?? "", "upload");
  } else if (req.method === "GET" && req.path === "/download") {
    req.fileTransfer = openTransfer(typeof req.query.ticket === "string" ? req.query.ticket : "", "download");
  } else { throw new ApiError("NOT_FOUND", "Transferencia no disponible."); }
  const ticket = req.fileTransfer;
  if (ticket.portal) req.headers.authorization = `Bearer ${ticket.credential}`;
  else {
    req.cookies = { [ACCESS_COOKIE]: ticket.credential, [CSRF_COOKIE]: "file-transfer" };
    req.headers["x-csrf-token"] = "file-transfer";
  }
  next();
});
fileTransferRoutes.post("/file-transfers/upload", requireAuth, requireRole("admin", "agente", "community"), async (req,res,next) => {
  const ticket = req.fileTransfer!;
  if (req.get("content-type") !== "application/octet-stream" && req.get("content-type") !== "application/pdf") throw new ApiError("VALIDATION_ERROR", "Formato de transferencia inválido.");
  if (Number(req.get("content-length")) !== ticket.size) throw new ApiError("VALIDATION_ERROR", "El tamaño no coincide con el archivo autorizado.");
  await runWithContext({rol:"auth"}, tx => tx.$executeRaw`DELETE FROM file_upload_uses WHERE expires_at < now()`);
  const inserted = await runWithContext({rol:"auth"}, tx => tx.$executeRaw`INSERT INTO file_upload_uses(id, expires_at) VALUES (${ticket.id}::uuid, ${new Date(ticket.expires)}) ON CONFLICT DO NOTHING`);
  if (!inserted) throw new ApiError("CONFLICT", "La autorización de carga ya fue utilizada.");
  req.url = ticket.path;
  rentalDocumentRoutes(req,res,next);
});
fileTransferRoutes.get("/file-transfers/download", (req,res,next) => {
  const ticket = req.fileTransfer!;
  req.url = ticket.path;
  (ticket.portal ? rentalPortalRoutes : rentalDocumentRoutes)(req,res,next);
});
