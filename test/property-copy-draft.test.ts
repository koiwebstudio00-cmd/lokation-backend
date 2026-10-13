import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { copyDraftInput, generateCopyDraft } from "../src/modules/properties/copy-draft.js";

const input = copyDraftInput.parse({
  operacion: "alquiler", tipo: "departamento", ciudad: "San Miguel de Tucumán",
  ambientes: 2, precio: 400000, moneda: "ARS"
});
const context = { tenantId: "tenant-a", userId: "user-a", rol: "admin" as const };
const originalKey = config.OPENAI_API_KEY;

afterEach(() => {
  config.OPENAI_API_KEY = originalKey;
  vi.restoreAllMocks();
});

describe("borrador de ficha con IA", () => {
  it("requiere clave del backend y no llama al proveedor si falta", async () => {
    config.OPENAI_API_KEY = "";
    const request = vi.fn();
    await expect(generateCopyDraft(input, context, request)).rejects.toThrow("no está configurada");
    expect(request).not.toHaveBeenCalled();
  });

  it("solo admite datos estructurados de la ficha", () => {
    expect(copyDraftInput.safeParse({ ...input, notas: "Dato interno" }).success).toBe(false);
  });

  it("devuelve un borrador estructurado sin almacenar el contenido en OpenAI", async () => {
    config.OPENAI_API_KEY = "test-key";
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const request = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.store).toBe(false);
      expect(body.text.format.type).toBe("json_schema");
      expect(body.input).not.toContain("notas");
      return new Response(JSON.stringify({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
          titulo: "Departamento de 2 ambientes en San Miguel de Tucumán",
          descripcion: "Departamento de 2 ambientes en alquiler en San Miguel de Tucumán. Precio informado: ARS 400.000."
        }) }] }],
        usage: { input_tokens: 100, output_tokens: 50 }
      }), { status: 200 });
    });
    const recordUsage = vi.fn(async () => undefined);
    const result = await generateCopyDraft(input, context, request as typeof fetch, recordUsage);
    expect(result.titulo).toContain("Departamento");
    expect(request).toHaveBeenCalledOnce();
    expect(recordUsage).toHaveBeenCalledWith(context, { input_tokens: 100, output_tokens: 50 });
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('"tenantId":"tenant-a"'));
  });
});
