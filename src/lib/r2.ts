// Cloudflare R2 (S3-compatible): presigned PUT para subida directa desde el
// browser y borrado de objetos. Sin credenciales configuradas (dev/test),
// funciona en modo stub: URLs falsas y borrado no-op, para no acoplar el
// desarrollo local a R2. Ver arquitectura.md §7.
import { DeleteObjectsCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";

const PRESIGN_TTL_SECONDS = 600;

export const r2Enabled = Boolean(
  config.R2_ACCOUNT_ID && config.R2_ACCESS_KEY_ID && config.R2_SECRET_ACCESS_KEY
);

let _client: S3Client | null = null;

function client(): S3Client {
  _client ??= new S3Client({
    region: "auto",
    endpoint: `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    // Desde @aws-sdk/client-s3 3.729 el SDK agrega un checksum CRC32 por
    // defecto (requestChecksumCalculation "WHEN_SUPPORTED"). En una URL
    // prefirmada eso firma el checksum de un body vacío: cuando el navegador
    // hace el PUT con el archivo real el CRC no coincide y R2 rechaza la subida
    // (aunque el CORS del bucket esté bien). WHEN_REQUIRED lo desactiva salvo
    // que la operación lo exija, que no es el caso del PUT de una foto.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: config.R2_ACCESS_KEY_ID!,
      secretAccessKey: config.R2_SECRET_ACCESS_KEY!
    }
  });
  return _client;
}

export function newImageKey(tenantId: string, propertyId: string): string {
  return `${tenantId}/${propertyId}/${randomUUID()}.webp`;
}

export function newAttachmentKey(tenantId: string, feedbackId: string): string {
  return `${tenantId}/feedback/${feedbackId}/${randomUUID()}.webp`;
}

export function publicUrl(key: string): string {
  const base = config.R2_PUBLIC_URL ?? "http://localhost:3000/dev-r2";
  return `${base.replace(/\/$/, "")}/${key}`;
}

export async function presignUpload(key: string): Promise<string> {
  if (!r2Enabled) {
    // Stub local: el front de dev puede detectarlo y saltear la subida real.
    return `http://localhost:3000/dev-r2-upload/${key}?expires=${PRESIGN_TTL_SECONDS}`;
  }
  const cmd = new PutObjectCommand({
    Bucket: config.R2_BUCKET,
    Key: key,
    ContentType: "image/webp"
  });
  return getSignedUrl(client(), cmd, { expiresIn: PRESIGN_TTL_SECONDS });
}

export async function deleteObjects(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  if (!r2Enabled) {
    console.log(`[r2-dev] delete no-op: ${keys.length} objeto(s)`);
    return;
  }
  try {
    await client().send(
      new DeleteObjectsCommand({
        Bucket: config.R2_BUCKET,
        Delete: { Objects: keys.map((Key) => ({ Key })) }
      })
    );
  } catch (err) {
    // No frenar el flujo por un objeto huérfano; se limpia con job (F4).
    console.error("[r2] error borrando objetos:", err);
  }
}
