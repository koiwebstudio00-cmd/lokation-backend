import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import express from "express";
import { config, jwtSecret } from "../config.js";

// Sólo las claves generadas por el backend; nunca rutas proporcionadas libremente.
const uuid = "[0-9a-f-]{36}";
const keyPattern = new RegExp(`^${uuid}/(?:feedback/)?${uuid}/${uuid}\\.webp$`);
export function localPath(key: string) {
  if (!keyPattern.test(key)) throw new Error("Clave de imagen inválida");
  return resolve(config.LOCAL_STORAGE_DIR, key);
}
function signature(key: string, expires: number) {
  return createHmac("sha256", jwtSecret).update(`local-upload\n${key}\n${expires}`).digest("hex");
}
export function localUploadUrl(key: string) {
  localPath(key);
  const expires = Math.floor(Date.now() / 1000) + 600;
  return `${config.LOCAL_STORAGE_URL}/upload?key=${encodeURIComponent(key)}&expires=${expires}&signature=${signature(key, expires)}`;
}
export async function deleteLocalObjects(keys: string[]) {
  for (const key of keys) {
    await unlink(localPath(key)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
export async function assertLocalObject(key: string) {
  // No aceptar confirmaciones de archivos inexistentes.
  const { stat } = await import("node:fs/promises");
  const info = await stat(localPath(key));
  if (!info.isFile() || !info.size) throw new Error("La imagen no fue subida");
}
function imageType(data: Buffer): string | null {
  if (data.length >= 12 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  // Canvas puede producir PNG/JPEG en navegadores sin encoder WebP.
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
  return null;
}
export function localStorageRouter() {
  const router = express.Router();
  router.put("/upload", (req, res, next) => {
    const { key, expires, signature: supplied } = req.query;
    const expiry = Number(expires);
    if (typeof key !== "string" || !keyPattern.test(key) || typeof supplied !== "string" ||
        !/^[a-f0-9]{64}$/.test(supplied) || !Number.isSafeInteger(expiry) ||
        expiry <= Date.now() / 1000 || expiry > Date.now() / 1000 + 600 ||
        !timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(signature(key, expiry), "hex"))) {
      res.status(403).json({ error: "Autorización de subida inválida o vencida" }); return;
    }
    next();
  }, express.raw({ type: "image/webp", limit: "10mb" }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !imageType(req.body)) {
      res.status(415).json({ error: "El archivo debe ser una imagen WebP, PNG o JPEG" }); return;
    }
    const path = localPath(req.query.key as string);
    await mkdir(dirname(path), { recursive: true });
    try {
      // Una URL no puede sobrescribir una imagen ya subida.
      await writeFile(path, req.body, { flag: "wx", mode: 0o640 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        res.status(409).json({ error: "La imagen ya fue subida" }); return;
      }
      throw error;
    }
    res.status(201).end();
  });
  router.get("/{*key}", async (req, res) => {
    const key = Array.isArray(req.params.key) ? req.params.key.join("/") : req.params.key;
    if (!key || !keyPattern.test(key)) { res.sendStatus(404); return; }
    try {
      const data = await readFile(localPath(key));
      res.set({ "Content-Type": imageType(data) ?? "application/octet-stream",
        "Cache-Control": "public, max-age=3600", "Cross-Origin-Resource-Policy": "cross-origin" });
      res.send(data);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { res.sendStatus(404); return; }
      throw error;
    }
  });
  return router;
}
