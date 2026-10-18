import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ApiError } from "./errors.js";
import { config } from "../config.js";

const keyPattern = /^[0-9a-f-]{36}\/rental-documents\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.pdf$/;
const remote = config.STORAGE_DRIVER === "r2" && Boolean(config.R2_PRIVATE_BUCKET);
let s3: S3Client | null = null;
function client() {
  s3 ??= new S3Client({ region: "auto", endpoint: `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.R2_ACCESS_KEY_ID!, secretAccessKey: config.R2_SECRET_ACCESS_KEY! },
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" });
  return s3;
}
function checkConfig() {
  if (config.NODE_ENV === "production" && !remote && config.STORAGE_DRIVER !== "local") {
    throw new ApiError("CONFLICT", "Configurá R2_PRIVATE_BUCKET para guardar documentos privados.");
  }
  if (remote && !(config.R2_ACCOUNT_ID && config.R2_ACCESS_KEY_ID && config.R2_SECRET_ACCESS_KEY)) {
    throw new ApiError("CONFLICT", "Faltan las credenciales del almacenamiento privado.");
  }
}
function localPath(key: string) {
  if (!keyPattern.test(key)) throw new ApiError("VALIDATION_ERROR", "Clave de documento inválida.");
  return resolve(config.LOCAL_STORAGE_DIR, "private", key);
}
export function newDocumentKey(tenantId: string, contractId: string) {
  return `${tenantId}/rental-documents/${contractId}/${randomUUID()}.pdf`;
}
export async function saveRentalPdf(key: string, data: Buffer) {
  checkConfig();
  if (!keyPattern.test(key) || data.length < 8 || data.length > 10 * 1024 * 1024
    || data.toString("ascii", 0, 5) !== "%PDF-") {
    throw new ApiError("VALIDATION_ERROR", "Subí un PDF válido de hasta 10 MB.");
  }
  if (remote) {
    await client().send(new PutObjectCommand({ Bucket: config.R2_PRIVATE_BUCKET, Key: key,
      Body: data, ContentType: "application/pdf" }));
  } else {
    const path = localPath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data, { flag: "wx", mode: 0o640 });
  }
}
export async function readRentalPdf(key: string): Promise<Buffer> {
  checkConfig();
  if (!keyPattern.test(key)) throw new ApiError("NOT_FOUND", "Documento no disponible.");
  if (remote) {
    const result = await client().send(new GetObjectCommand({ Bucket: config.R2_PRIVATE_BUCKET, Key: key }));
    if (!result.Body) throw new ApiError("NOT_FOUND", "Documento no disponible.");
    return Buffer.from(await result.Body.transformToByteArray());
  }
  try { return await readFile(localPath(key)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ApiError("NOT_FOUND", "Documento no disponible.");
    throw error;
  }
}
export async function deleteRentalPdf(key: string) {
  checkConfig();
  if (!keyPattern.test(key)) return;
  if (remote) await client().send(new DeleteObjectCommand({ Bucket: config.R2_PRIVATE_BUCKET, Key: key }));
  else await unlink(localPath(key)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}
