import { z } from "zod";
import { config } from "../../config.js";
import { ApiError } from "../../lib/errors.js";
import { runWithContext } from "../../lib/prisma.js";
import { TIPOS } from "../../lib/property-opciones.js";

const optionalText = z.string().trim().max(160).nullish();
const optionalNumber = z.number().finite().nonnegative().nullish();

export const copyDraftInput = z.object({
  operacion: z.enum(["venta", "alquiler", "ambos"]),
  tipo: z.enum(TIPOS),
  zona: optionalText,
  ciudad: optionalText,
  ambientes: z.number().int().nonnegative().nullish(),
  dormitorios: z.number().int().nonnegative().nullish(),
  banios: z.number().int().nonnegative().nullish(),
  sup_cubierta: optionalNumber,
  sup_total: optionalNumber,
  precio: optionalNumber,
  moneda: z.enum(["ARS", "USD"]).nullish(),
  precio_alquiler: optionalNumber,
  moneda_alquiler: z.enum(["ARS", "USD"]).nullish(),
  mascotas: z.enum(["se_permiten", "no_se_permiten", "sin_especificar"]).nullish(),
  amoblado: z.enum(["amoblado", "sin_amoblar", "sin_especificar"]).nullish()
}).strict();

export type CopyDraftInput = z.infer<typeof copyDraftInput>;
export type CopyDraftContext = { tenantId: string; userId: string; rol: "admin" | "agente" };

const draftSchema = z.object({
  titulo: z.string().trim().min(10).max(120),
  descripcion: z.string().trim().min(30).max(1800)
}).strict();

type OpenAIResponse = {
  status?: string;
  output?: { type?: string; content?: { type?: string; text?: string }[] }[];
  usage?: { input_tokens?: number; output_tokens?: number };
};

async function saveUsage(context: CopyDraftContext, usage: OpenAIResponse["usage"]) {
  await runWithContext(context, (tx) => tx.propertyCopyUsage.create({ data: {
    tenantId: context.tenantId,
    userId: context.userId,
    model: config.OPENAI_PROPERTY_MODEL,
    inputTokens: usage?.input_tokens ?? null,
    outputTokens: usage?.output_tokens ?? null
  } }));
}

export async function generateCopyDraft(
  input: CopyDraftInput,
  context: CopyDraftContext,
  request: typeof fetch = fetch,
  recordUsage: typeof saveUsage = saveUsage
) {
  if (!config.OPENAI_API_KEY) {
    throw new ApiError("CONFLICT", "La generación con IA todavía no está configurada.");
  }

  let response: Response;
  try {
    response = await request("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: config.OPENAI_PROPERTY_MODEL,
        store: false,
        max_output_tokens: 1200,
        instructions: "Redactá en español de Argentina un título y una descripción inmobiliaria claros. Usá exclusivamente los datos estructurados de la ficha. No inventes ubicación exacta, amenities, estado, orientación, superficies, condiciones, servicios ni valores. Omití cualquier dato ausente o incierto. No incluyas frases de presión comercial. Devolvé sólo el JSON solicitado.",
        input: JSON.stringify(input),
        text: {
          format: {
            type: "json_schema",
            name: "property_copy_draft",
            strict: true,
            schema: {
              type: "object",
              properties: {
                titulo: { type: "string" },
                descripcion: { type: "string" }
              },
              required: ["titulo", "descripcion"],
              additionalProperties: false
            }
          }
        }
      }),
      signal: AbortSignal.timeout(20_000)
    });
  } catch {
    throw new ApiError("INTERNAL", "No pudimos conectar con el generador. Intentá de nuevo.");
  }
  if (!response.ok) {
    throw new ApiError("INTERNAL", "El generador no está disponible. Intentá más tarde.");
  }
  const result = await response.json() as OpenAIResponse;
  const output = result.output?.flatMap((item) => item.content ?? [])
    .find((item) => item.type === "output_text")?.text;
  if (result.status !== "completed" || !output) {
    throw new ApiError("INTERNAL", "El generador no devolvió un borrador completo.");
  }
  let draft: unknown;
  try {
    draft = JSON.parse(output);
  } catch {
    throw new ApiError("INTERNAL", "El generador devolvió un borrador inválido.");
  }
  const parsed = draftSchema.safeParse(draft);
  if (!parsed.success) {
    throw new ApiError("INTERNAL", "El generador devolvió un borrador inválido.");
  }
  await recordUsage(context, result.usage);
  // Métrica de consumo sin texto ni datos de la ficha en logs.
  console.info(JSON.stringify({
    event: "property_copy_draft",
    tenantId: context.tenantId,
    userId: context.userId,
    model: config.OPENAI_PROPERTY_MODEL,
    inputTokens: result.usage?.input_tokens ?? null,
    outputTokens: result.usage?.output_tokens ?? null
  }));
  return parsed.data;
}
