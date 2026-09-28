import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import * as channels from "./channels.service.js";

export const channelRoutes = Router();

channelRoutes.use("/integrations/channels", requireAuth, requireRole("admin"));

const canalParam = z.enum(channels.CHANNEL_CANALES);
const idParam = () => z.string().uuid();

channelRoutes.get("/integrations/channels", async (req, res) => {
  res.json(await channels.listChannels(req.auth!));
});

channelRoutes.get("/integrations/channels/:canal/connect-url", async (req, res) => {
  const canal = canalParam.parse(req.params.canal);
  res.json(await channels.getConnectUrl(req.auth!, canal));
});

channelRoutes.get("/integrations/channels/callback", async (req, res) => {
  const { canal, account_id } = z
    .object({ canal: canalParam, account_id: z.string().min(1).optional() })
    .parse(req.query);
  res.json(await channels.completeConnection(req.auth!, canal, account_id));
});

channelRoutes.delete("/integrations/channels/:id", async (req, res) => {
  await channels.disconnectChannel(req.auth!, idParam().parse(req.params.id));
  res.status(204).end();
});

channelRoutes.get("/integrations/channels/:id/health", async (req, res) => {
  res.json(await channels.getChannelHealth(req.auth!, idParam().parse(req.params.id)));
});
