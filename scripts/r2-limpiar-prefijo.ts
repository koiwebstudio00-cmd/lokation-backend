// Lista (y opcionalmente borra) los objetos de R2 bajo un prefijo.
//
// Para qué: si una migración se corrió más de una vez con distinto tenant_id,
// las fotos viejas quedan bajo el prefijo del tenant anterior sin que ninguna
// fila de la BD las referencie. Esto las encuentra y las limpia.
//
// Uso:
//   npx tsx scripts/r2-limpiar-prefijo.ts                    ← lista TODO el bucket
//   npx tsx scripts/r2-limpiar-prefijo.ts <prefijo>          ← lista ese prefijo
//   npx tsx scripts/r2-limpiar-prefijo.ts <prefijo> --borrar ← borra (pide confirmación)
//
// Sin --borrar no toca nada: siempre mirá primero.
import "dotenv/config";
import { createInterface } from "node:readline/promises";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client
} from "@aws-sdk/client-s3";

function env(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Falta ${name} en .env`);
  return v;
}

const BUCKET = env("R2_BUCKET");
const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env("R2_ACCESS_KEY_ID"),
    secretAccessKey: env("R2_SECRET_ACCESS_KEY")
  }
});

const args = process.argv.slice(2);
const borrar = args.includes("--borrar");
const prefix = args.find((a) => !a.startsWith("--")) ?? "";

interface Obj {
  key: string;
  size: number;
}

async function listar(): Promise<Obj[]> {
  const out: Obj[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token })
    );
    for (const o of res.Contents ?? []) {
      if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0 });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

function agruparPorPrefijo(objs: Obj[]): Map<string, { n: number; bytes: number }> {
  const m = new Map<string, { n: number; bytes: number }>();
  for (const o of objs) {
    const top = o.key.split("/")[0] ?? "(raíz)";
    const acc = m.get(top) ?? { n: 0, bytes: 0 };
    acc.n++;
    acc.bytes += o.size;
    m.set(top, acc);
  }
  return m;
}

const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;

async function main(): Promise<void> {
  console.log(`Bucket: ${BUCKET}${prefix ? ` · prefijo: ${prefix}` : " · TODO el bucket"}\n`);

  const objs = await listar();
  if (objs.length === 0) {
    console.log("No hay objetos. Nada que hacer.");
    return;
  }

  // Sin prefijo, el resumen por carpeta de primer nivel es lo que responde la
  // pregunta "¿de qué tenants hay fotos acá?".
  if (!prefix) {
    console.log("Objetos por prefijo de primer nivel:\n");
    for (const [top, { n, bytes }] of agruparPorPrefijo(objs)) {
      console.log(`  ${top}  →  ${n} archivos, ${mb(bytes)}`);
    }
    console.log(
      `\nTotal: ${objs.length} archivos, ${mb(objs.reduce((s, o) => s + o.size, 0))}`
    );
    console.log("\nPara limpiar uno: npx tsx scripts/r2-limpiar-prefijo.ts <prefijo>/ --borrar");
    return;
  }

  const total = objs.reduce((s, o) => s + o.size, 0);
  console.log(`${objs.length} archivos, ${mb(total)}`);
  console.log("\nPrimeros 10:");
  for (const o of objs.slice(0, 10)) console.log(`  ${o.key}`);
  if (objs.length > 10) console.log(`  ... y ${objs.length - 10} más`);

  if (!borrar) {
    console.log("\n(modo lectura — agregá --borrar para eliminarlos)");
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ok = await rl.question(
    `\n¿Borrar ${objs.length} archivos bajo '${prefix}'? Esto no se puede deshacer. Escribí BORRAR: `
  );
  rl.close();
  if (ok.trim() !== "BORRAR") {
    console.log("Cancelado.");
    return;
  }

  // La API borra de a 1000 como máximo.
  let borrados = 0;
  for (let i = 0; i < objs.length; i += 1000) {
    const lote = objs.slice(i, i + 1000);
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: { Objects: lote.map((o) => ({ Key: o.key })) }
      })
    );
    borrados += lote.length;
    console.log(`  borrados ${borrados}/${objs.length}`);
  }
  console.log(`\n✔ Listo: ${borrados} archivos eliminados.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
