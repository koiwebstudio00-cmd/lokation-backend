// Migración de datos: Supabase (MVP Lamelas) → BD del backend.
// - Idempotente: `on conflict do nothing` en todo; re-ejecutable sin duplicar.
// - Usuarios: TODOS como 'agente' con password aleatoria irrecuperable — cada
//   vendedor define la suya vía el flujo de reset (decisión 2026-07-26; el rol
//   admin lo asigna después el super admin).
// - Propiedades: ids, estados y fechas preservados. El slug NO se copia: lo
//   genera el trigger de la migración 0010 con la misma fórmula que Supabase
//   (ids preservados ⇒ slugs idénticos ⇒ URLs públicas intactas).
// - Fotos: descarga del bucket público `property-images` → sube a R2 con la
//   convención nueva ({tenant_id}/{property_id}/{archivo}) → URL de R2 en BD.
// Corre con DATABASE_URL_MIGRATE (bypassa RLS a propósito: es carga de datos).
// Uso: npm run migrate:supabase
import "dotenv/config";
import { randomBytes, randomUUID } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

// Tenant destino. El default es el id fijo pensado para una BD vacía; si el
// tenant ya existe (por ejemplo, creado desde el panel o por API, que le
// asignan un uuid aleatorio), pasá su id por MIGRATE_TENANT_ID en vez de
// borrarlo y volver a crearlo.
//
// OJO: el id elegido queda dentro de las keys de las fotos en R2
// ({tenant_id}/{property_id}/{archivo}) y en las URLs guardadas en la BD.
// Cambiarlo después de migrar obliga a resubir todas las fotos.
const TENANT_ID =
  process.env.MIGRATE_TENANT_ID?.trim() || "fa20ac8b-53d1-4420-8f57-5af576e1c053";
const TENANT_SLUG = process.env.MIGRATE_TENANT_SLUG?.trim() || "lamelas-chaumont";
const TENANT_NOMBRE = process.env.MIGRATE_TENANT_NOMBRE?.trim() || "Inmobiliaria Lamelas";

function env(name: string, optional = false): string {
  const v = process.env[name]?.trim();
  if (!v && !optional) throw new Error(`Falta ${name} en .env`);
  return v ?? "";
}

const SUPABASE_DB_URL = env("SUPABASE_DB_URL");
const DEST_DB_URL = env("DATABASE_URL_MIGRATE");
const SUPABASE_PROJECT_URL = env("SUPABASE_PROJECT_URL", true).replace(/\/+$/, "");
const R2_BUCKET = env("R2_BUCKET");
const R2_PUBLIC_URL = env("R2_PUBLIC_URL").replace(/\/+$/, "");

const source = new PrismaClient({ datasources: { db: { url: SUPABASE_DB_URL } } });
const dest = new PrismaClient({ datasources: { db: { url: DEST_DB_URL } } });
const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env("R2_ACCESS_KEY_ID"),
    secretAccessKey: env("R2_SECRET_ACCESS_KEY")
  }
});

interface SourceUser {
  id: string;
  nombre: string | null;
  email: string;
  created_at: Date;
}

interface SourceProperty {
  id: string;
  user_id: string;
  titulo: string;
  operacion: string;
  tipo: string;
  precio: string;
  moneda: string;
  descripcion: string | null;
  direccion: string | null;
  zona: string | null;
  ciudad: string | null;
  ambientes: number | null;
  dormitorios: number | null;
  banios: number | null;
  sup_cubierta: string | null;
  sup_total: string | null;
  estado: string;
  notas: string | null;
  created_at: Date;
  updated_at: Date;
}

interface SourceImage {
  id: string;
  property_id: string;
  url: string;
  es_portada: boolean;
  orden: number;
  created_at: Date;
}

const CONTENT_TYPES: Record<string, string> = {
  webp: "image/webp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif"
};

function contentTypeOf(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

async function migrateTenant(): Promise<void> {
  // El slug es único: si ya lo tiene OTRO tenant, el insert de abajo fallaría
  // con una violación de unicidad que no dice nada útil. Mejor avisar acá.
  const [existente] = await dest.$queryRaw<{ id: string }[]>`
    select id::text as id from tenants where slug = ${TENANT_SLUG}`;
  if (existente && existente.id !== TENANT_ID) {
    throw new Error(
      `Ya existe un tenant con slug '${TENANT_SLUG}' e id ${existente.id}, ` +
        `distinto del destino ${TENANT_ID}.\n` +
        `Opciones: (a) correr con MIGRATE_TENANT_ID=${existente.id} para usar ese, ` +
        `o (b) liberar el slug del tenant viejo.`
    );
  }

  await dest.$executeRaw`
    insert into tenants (id, nombre, slug)
    values (${TENANT_ID}::uuid, ${TENANT_NOMBRE}, ${TENANT_SLUG})
    on conflict (id) do nothing`;
  console.log(`Tenant '${TENANT_SLUG}' OK (${TENANT_ID})`);
}

async function migrateUsers(): Promise<void> {
  const users = await source.$queryRaw<SourceUser[]>`
    select id::text as id, nombre, email::text as email, created_at
    from public.users
    order by created_at`;

  let created = 0;
  for (const u of users) {
    // Password aleatoria irrecuperable: el vendedor define la suya por reset.
    const passwordHash = await bcrypt.hash(randomBytes(24).toString("hex"), 12);
    const nombre = u.nombre?.trim() || u.email.split("@")[0];
    created += await dest.$executeRaw`
      insert into users (id, tenant_id, nombre, email, password_hash, rol, estado, created_at)
      values (${u.id}::uuid, ${TENANT_ID}::uuid, ${nombre}, ${u.email}, ${passwordHash},
              'agente'::user_rol, 'activo'::user_estado, ${u.created_at})
      on conflict (id) do nothing`;
  }
  console.log(`Usuarios: ${users.length} en origen, ${created} importados (todos 'agente'), ${users.length - created} ya existían`);
}

async function migrateProperties(): Promise<void> {
  const props = await source.$queryRaw<SourceProperty[]>`
    select id::text as id, user_id::text as user_id, titulo,
           operacion::text as operacion, tipo::text as tipo,
           precio::text as precio, moneda::text as moneda,
           descripcion, direccion, zona, ciudad,
           ambientes, dormitorios, banios,
           sup_cubierta::text as sup_cubierta, sup_total::text as sup_total,
           estado::text as estado, notas, created_at, updated_at
    from public.properties
    order by created_at`;

  let created = 0;
  for (const p of props) {
    // slug: lo completa el trigger de 0010 (misma fórmula que Supabase)
    created += await dest.$executeRaw`
      insert into properties (id, tenant_id, user_id, titulo, operacion, tipo, precio, moneda,
        descripcion, direccion, zona, ciudad, ambientes, dormitorios, banios,
        sup_cubierta, sup_total, estado, notas, created_at, updated_at)
      values (${p.id}::uuid, ${TENANT_ID}::uuid, ${p.user_id}::uuid, ${p.titulo},
        ${p.operacion}::operacion_enum, ${p.tipo}::tipo_enum,
        ${p.precio}::numeric, ${p.moneda}::moneda_enum,
        ${p.descripcion}, ${p.direccion}, ${p.zona}, ${p.ciudad},
        ${p.ambientes}, ${p.dormitorios}, ${p.banios},
        ${p.sup_cubierta}::numeric, ${p.sup_total}::numeric,
        ${p.estado}::estado_enum, ${p.notas}, ${p.created_at}, ${p.updated_at})
      on conflict (id) do nothing`;
  }
  console.log(`Propiedades: ${props.length} en origen, ${created} importadas, ${props.length - created} ya existían`);
}

async function migrateImages(): Promise<{ errors: string[] }> {
  const imgs = await source.$queryRaw<SourceImage[]>`
    select id::text as id, property_id::text as property_id, url, es_portada, orden, created_at
    from public.property_images
    order by property_id, orden`;

  let created = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const img of imgs) {
    const exists = await dest.$queryRaw<{ id: string }[]>`
      select id::text as id from property_images where id = ${img.id}::uuid limit 1`;
    if (exists.length > 0) {
      skipped++;
      continue;
    }

    const isFullUrl = /^https?:\/\//i.test(img.url);
    if (!isFullUrl && !SUPABASE_PROJECT_URL) {
      throw new Error(
        "property_images.url es un path relativo: falta SUPABASE_PROJECT_URL en .env " +
          "(la URL del proyecto, ej. https://xxxx.supabase.co)"
      );
    }
    const sourceUrl = isFullUrl
      ? img.url
      : `${SUPABASE_PROJECT_URL}/storage/v1/object/public/property-images/${img.url.replace(/^\/+/, "")}`;

    const res = await fetch(sourceUrl);
    if (!res.ok) {
      errors.push(`imagen ${img.id} (${sourceUrl}): HTTP ${res.status}`);
      continue;
    }
    const body = Buffer.from(await res.arrayBuffer());
    const fileName = sourceUrl.split("/").pop() || `${randomUUID()}.webp`;
    const key = `${TENANT_ID}/${img.property_id}/${fileName}`;

    await s3.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        Body: body,
        ContentType: contentTypeOf(fileName)
      })
    );

    created += await dest.$executeRaw`
      insert into property_images (id, tenant_id, property_id, r2_key, url, es_portada, orden, created_at)
      values (${img.id}::uuid, ${TENANT_ID}::uuid, ${img.property_id}::uuid, ${key},
              ${`${R2_PUBLIC_URL}/${key}`}, ${img.es_portada}, ${img.orden}, ${img.created_at})
      on conflict (id) do nothing`;
    console.log(`  foto ${created}: ${key} (${Math.round(body.length / 1024)} KB)`);
  }

  console.log(`Fotos: ${imgs.length} en origen, ${created} migradas a R2, ${skipped} ya existían, ${errors.length} con error`);
  return { errors };
}

async function main(): Promise<void> {
  console.log("── Migración Supabase → back-lamelas ──");
  await migrateTenant();
  await migrateUsers();
  await migrateProperties();
  const { errors } = await migrateImages();

  if (errors.length > 0) {
    console.error("\nErrores (re-ejecutar el script reintenta solo lo que falta):");
    for (const e of errors) console.error(`  - ${e}`);
    process.exitCode = 1;
  } else {
    console.log("\n✔ Migración completa sin errores. Re-ejecutable cuando quieras (idempotente).");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await source.$disconnect();
    await dest.$disconnect();
  });
