// Corre antes de cada archivo de test (vitest setupFiles).
// La app se conecta a la BD de test como app_rt (para que RLS aplique de verdad).
import "dotenv/config";

if (process.env.DATABASE_URL_TEST) {
  const url = new URL(process.env.DATABASE_URL_TEST);
  url.username = "app_rt";
  url.password = "app_rt_dev";
  process.env.DATABASE_URL = url.toString();
}
process.env.NODE_ENV = "test";
// Fijo y conocido para los tests de firma del webhook de Zernio — no depende
// de si el .env local tiene (o no) un secret real configurado.
process.env.ZERNIO_WEBHOOK_SECRET = "test-zernio-secret";
process.env.ZERNIO_API_KEY = "test-zernio-api-key";
// config.ts lee process.env una sola vez al importarse: el puerto tiene que
// estar fijado ANTES de esa importación, así que no puede ser dinámico como
// el receiver de test/webhooks.test.ts. zernio-channels.test.ts levanta un
// servidor local escuchando exactamente acá.
process.env.N8N_WHATSAPP_WEBHOOK_URL = "http://127.0.0.1:34599/n8n-hook";
