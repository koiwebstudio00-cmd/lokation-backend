import { buildApp } from "./app.js";
import { config } from "./config.js";
import { startZernioEventsWorker } from "./modules/integrations/zernioWebhook.worker.js";
import { startWebhookWorker } from "./modules/webhooks/worker.js";
import { startFollowupWorker } from "./modules/agent/followup.worker.js";

const app = buildApp();

app.listen(config.PORT, () => {
  console.log(`API escuchando en http://localhost:${config.PORT} (${config.NODE_ENV})`);
  startWebhookWorker();
  startZernioEventsWorker();
  startFollowupWorker();
});
