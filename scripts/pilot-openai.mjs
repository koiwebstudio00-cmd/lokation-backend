// Piloto explícito: dos tenants ficticios en la BD local de test, API real y
// OpenAI real. runTurn(live:false) impide despachos y handoffs a WhatsApp.
/* global fetch */
import { randomBytes, randomUUID, createHash } from "node:crypto";
import console from "node:console";
import { once } from "node:events";
import process from "node:process";
import { URL } from "node:url";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

dotenv.config({ path: ".env" });
dotenv.config({ path: "../agent-ia/.env" });

const testUrl = process.env.DATABASE_URL_TEST;
const url = testUrl && new URL(testUrl);
if (!url || !["localhost", "127.0.0.1"].includes(url.hostname) || !url.pathname.includes("test")) {
  throw new Error("El piloto exige DATABASE_URL_TEST en una base local cuyo nombre incluya test.");
}
if (!process.env.OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY en agent-ia/.env.");
process.env.NODE_ENV = "test";
process.env.AGENT_SERVICE_SECRET = randomBytes(32).toString("hex");
url.username = "app_rt";
url.password = "app_rt_dev";
process.env.DATABASE_URL = url.toString();

const [{ buildApp }, { getPrisma }, { signAgentServiceToken }, { createBackendClient }, { createAgentService }] = await Promise.all([
  import("../src/app.ts"), import("../src/lib/prisma.ts"), import("../src/lib/agent-service-token.ts"),
  import("../../agent-ia/src/turn.mjs"), import("../../agent-ia/src/service.mjs")
]);

const db = new PrismaClient({ datasources: { db: { url: testUrl } } });
const ids = [];
let server;
let agentServer;

async function fixture(label, marker) {
  const slug = `pilot-${label}-${marker}`;
  const tenant = await db.tenant.create({ data: {
    nombre: `Inmobiliaria piloto ${label}`, slug, agentEnabled: true,
    agentConfig: {
      model: process.env.OPENAI_MODEL || "gpt-5-mini",
      instructions: "Sos un asistente inmobiliario. Respondé en español, con brevedad. Ante una consulta sobre inmuebles, buscá propiedades reales con la herramienta antes de contestar. Solo mencioná inmuebles encontrados para esta inmobiliaria."
    }
  } });
  ids.push(tenant.id);
  const user = await db.user.create({ data: {
    tenantId: tenant.id, nombre: `Piloto ${label}`,
    email: `${slug}@example.test`, passwordHash: "piloto-sin-login", rol: "admin"
  } });
  const channel = await db.channelAccount.create({ data: {
    tenantId: tenant.id, canal: "whatsapp", zernioProfileId: `pilot-profile-${marker}-${label}`,
    zernioAccountId: `pilot-account-${marker}-${label}`, conectadaPor: user.id
  } });
  const property = await db.property.create({ data: {
    tenantId: tenant.id, userId: user.id, titulo: `Casa piloto ${label} ${marker}`,
    slug: `casa-piloto-${label}-${marker}`, operacion: "venta", tipo: "casa",
    precio: label === "a" ? 90000 : 150000, moneda: "USD", ciudad: "San Miguel de Tucumán"
  } });
  const key = `ilk_${randomBytes(24).toString("hex")}`;
  await db.apiKey.create({ data: {
    tenantId: tenant.id, createdBy: user.id, nombre: "Piloto OpenAI",
    keyHash: createHash("sha256").update(key).digest("hex"), prefix: key.slice(0, 12),
    scopes: ["agent:read", "agent:write"]
  } });
  return { tenant, channel, property, key };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function cleanup() {
  for (const tenantId of ids.reverse()) {
    await db.conversationMessage.deleteMany({ where: { tenantId } });
    await db.conversation.deleteMany({ where: { tenantId } });
    await db.lead.deleteMany({ where: { tenantId } });
    await db.property.deleteMany({ where: { tenantId } });
    await db.apiKey.deleteMany({ where: { tenantId } });
    await db.channelAccount.deleteMany({ where: { tenantId } });
    await db.user.deleteMany({ where: { tenantId } });
    await db.tenant.delete({ where: { id: tenantId } });
  }
}

try {
  const app = buildApp();
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  agentServer = createAgentService({ secret: process.env.AGENT_SERVICE_SECRET, backendApiUrl: base });
  agentServer.listen(0, "127.0.0.1");
  await once(agentServer, "listening");
  const agentBase = `http://127.0.0.1:${agentServer.address().port}`;
  const marker = randomBytes(5).toString("hex");
  const A = await fixture("a", marker);
  const B = await fixture("b", marker);

  for (const [own, other, label] of [[A, B, "A"], [B, A, "B"]]) {
    const backend = createBackendClient({ apiBaseUrl: base, apiKey: own.key });
    const catalog = await backend.searchProperties({ operacion: "venta" });
    assert(catalog.meta.total === 1 && catalog.data[0]?.id === own.property.id,
      `Catálogo de ${label} no corresponde a su tenant`);
    assert(!JSON.stringify(catalog).includes(other.property.id), `Fuga de propiedad del otro tenant en ${label}`);

    const envelope = {
      tenant_id: own.tenant.id, channel_account_id: own.channel.id,
      provider_conversation_id: `pilot-conversation-${marker}-${label}`,
      turn_id: randomBytes(32).toString("hex"), canal: "whatsapp",
      data: [{ message: {
        id: randomUUID(), sender: { id: `549381555${label === "A" ? "0001" : "0002"}`, name: `Cliente piloto ${label}` },
        text: "Hola, busco una casa en venta en San Miguel de Tucumán. ¿Qué opciones tienen?"
      } }]
    };
    const response = await fetch(`${agentBase}/preview`, { method: "POST",
      headers: { "Content-Type": "application/json",
        "X-Agent-Service-Token": signAgentServiceToken(own.tenant.id) },
      body: JSON.stringify(envelope) });
    assert(response.ok, `Servicio del agente respondió ${response.status} para ${label}`);
    const result = await response.json();
    assert(result.status === "preview" && result.replies.length > 0, `OpenAI no produjo vista previa para ${label}`);
    assert(!result.replies.join(" ").includes(other.property.titulo), `Respuesta de ${label} menciona propiedad ajena`);
    const messages = await db.conversationMessage.findMany({ where: { tenantId: own.tenant.id } });
    assert(messages.length === 1 && messages[0].rol === "lead", `El turno de ${label} no registró exactamente una entrada`);
    assert(await db.handoff.count({ where: { tenantId: own.tenant.id } }) === 0,
      `El piloto creó una derivación para ${label}`);
    assert(await db.outboundMessageAttempt.count({ where: { tenantId: own.tenant.id } }) === 0,
      `El piloto intentó enviar un mensaje para ${label}`);
    console.log(`${label}: catálogo aislado, entrada registrada, respuesta de OpenAI en vista previa.`);
    console.log(`Respuesta ${label}: ${result.replies.join(" ").slice(0, 600)}`);
  }
  console.log("Piloto completo. Sin envíos de WhatsApp.");
} finally {
  try { await cleanup(); }
  finally {
    await db.$disconnect();
    await getPrisma().$disconnect();
    if (agentServer) await new Promise((resolve) => agentServer.close(resolve));
    if (server) await new Promise((resolve) => server.close(resolve));
  }
}
