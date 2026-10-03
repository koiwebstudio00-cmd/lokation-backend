import { localStorageRouter } from "./lib/local-storage.js";
import { notificationRoutes } from "./modules/notifications/routes.js";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { config, corsOrigins } from "./config.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";
import { requestLogger } from "./middleware/logging.js";
import { agentRoutes, conversationRoutes } from "./modules/agent/routes.js";
import { analyticsRoutes } from "./modules/analytics/routes.js";
import { platformRoutes } from "./modules/platform/routes.js";
import { authRoutes } from "./modules/auth/routes.js";
import { crmRoutes } from "./modules/crm/routes.js";
import { feedbackRoutes } from "./modules/feedback/routes.js";
import { exportRoutes } from "./modules/export/routes.js";
import { healthRoutes } from "./modules/health/routes.js";
import { imageRoutes } from "./modules/images/routes.js";
import { channelRoutes } from "./modules/integrations/channels.routes.js";
import { integrationRoutes } from "./modules/integrations/routes.js";
import { zernioWebhookRoutes } from "./modules/integrations/zernioWebhook.routes.js";
import { propertyRoutes } from "./modules/properties/routes.js";
import { publicSiteRoutes } from "./modules/public-site/routes.js";
import { tenantRoutes } from "./modules/tenants/routes.js";
import { userRoutes } from "./modules/users/routes.js";
import { webhookRoutes } from "./modules/webhooks/routes.js";

export function buildApp() {
  const app = express();

  app.disable("x-powered-by");
  // Detras de Traefik/Dokploy hay un reverse proxy: sin esto express-rate-limit
  // ve el X-Forwarded-For y tira ValidationError, y ademas toma la IP equivocada.
  // 1 = confiar solo en el primer hop (Traefik).
  app.set("trust proxy", 1);
  // Primero de todo: así queda registrada también la request que rebota por
  // CORS o por payload demasiado grande.
  app.use(requestLogger());
  app.use(helmet());
  // En producción, allowlist explícita (config.ts la exige). En desarrollo se
  // refleja el origen para no pelear con localhost:3000 / :3001 / :5173.
  app.use(
    cors({
      origin: corsOrigins.length > 0 ? corsOrigins : config.NODE_ENV !== "production",
      credentials: true
    })
  );
  // Antes del express.json() global: necesita el body crudo para verificar la
  // firma HMAC de Zernio contra los mismos bytes que mandaron, no contra un
  // JSON re-serializado. Fuera de /v1 a propósito (regla 12: /v1 es el
  // contrato versionado; esto es transporte de un proveedor externo).
  app.use("/webhooks/zernio", express.raw({ type: "*/*", limit: "1mb" }), zernioWebhookRoutes);
  if (config.STORAGE_DRIVER === "local") app.use("/media", localStorageRouter());
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  const v1 = express.Router();
  v1.use(healthRoutes);
  v1.use(notificationRoutes);
  v1.use(authRoutes);
  v1.use(platformRoutes);
  v1.use(tenantRoutes);
  v1.use(userRoutes);
  v1.use(propertyRoutes);
  v1.use(publicSiteRoutes);
  v1.use(imageRoutes);
  v1.use(crmRoutes);
  v1.use(feedbackRoutes);
  v1.use(webhookRoutes);
  v1.use(conversationRoutes);
  v1.use(agentRoutes);
  v1.use(analyticsRoutes);
  v1.use(integrationRoutes);
  v1.use(channelRoutes);
  v1.use(exportRoutes);
  app.use("/v1", v1);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
