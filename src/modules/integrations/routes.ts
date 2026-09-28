import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { API_KEY_SCOPES, SCOPE_LABELS } from "../../lib/scopes.js";
import * as integrations from "./service.js";

export const integrationRoutes = Router();

const apiKeysRouter = Router();

apiKeysRouter.use(requireAuth, requireRole("admin"));

const scopesSchema = z
  .array(z.enum(API_KEY_SCOPES))
  .min(1, "Elegí al menos un permiso para la integración.")
  .optional();

apiKeysRouter.get("/", async (req, res) => {
  res.json({ data: await integrations.listApiKeys(req.auth!) });
});

apiKeysRouter.post("/", async (req, res) => {
  const { nombre, scopes } = z
    .object({
      nombre: z.string().trim().min(1, "El nombre es obligatorio.").max(100),
      scopes: scopesSchema
    })
    .parse(req.body);
  const { apiKey, key } = await integrations.createApiKey(req.auth!, nombre, scopes);
  // `key` viaja UNA sola vez; después solo se lista el prefix.
  res.status(201).json({ api_key: apiKey, key });
});

apiKeysRouter.delete("/:id", async (req, res) => {
  await integrations.revokeApiKey(req.auth!, z.string().uuid().parse(req.params.id));
  res.status(204).end();
});

integrationRoutes.use("/integrations/api-keys", apiKeysRouter);

// Alias de compatibilidad: el panel todavía pega a /v1/api-keys. Se mantiene
// hasta que migre a /v1/integrations/api-keys (regla 12: /v1 no rompe).
integrationRoutes.use("/api-keys", apiKeysRouter);

// Catálogo para armar el formulario del panel sin hardcodear los scopes.
integrationRoutes.get(
  "/integrations/scopes",
  requireAuth,
  requireRole("admin"),
  (_req, res) => {
    res.json({
      data: API_KEY_SCOPES.map((scope) => ({ scope, label: SCOPE_LABELS[scope] }))
    });
  }
);
