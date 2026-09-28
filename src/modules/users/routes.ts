import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import * as users from "./service.js";

export const userRoutes = Router();

userRoutes.use(["/users", "/invitations"], requireAuth);

userRoutes.get("/users", async (req, res) => {
  const q = z
    .object({ estado: z.enum(["activo", "inactivo"]).optional() })
    .parse(req.query);
  res.json({ data: await users.listUsers(req.auth!, q.estado) });
});

userRoutes.post("/invitations", requireRole("admin"), async (req, res) => {
  const body = z
    .object({ email: z.string().email(), rol: z.enum(["admin", "agente"]) })
    .parse(req.body);
  const inv = await users.inviteUser(req.auth!, body);
  res.status(201).json({ invitation: { id: inv.id, email: inv.email, rol: inv.rol } });
});

userRoutes.get("/invitations", requireRole("admin"), async (req, res) => {
  res.json({ data: await users.listInvitations(req.auth!) });
});

userRoutes.delete("/invitations/:id", requireRole("admin"), async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  await users.revokeInvitation(req.auth!, id);
  res.json({ ok: true });
});

// Rutas propias antes que /users/:id para que "me" no matchee como id.
userRoutes.patch("/users/me", async (req, res) => {
  const body = z.object({ nombre: z.string().min(1) }).parse(req.body);
  res.json({ user: await users.updateMe(req.auth!, body.nombre) });
});

userRoutes.post("/users/me/password", async (req, res) => {
  const body = z
    .object({
      current_password: z.string().min(1),
      new_password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres.")
    })
    .parse(req.body);
  await users.changePassword(req.auth!, body.current_password, body.new_password);
  res.json({ ok: true });
});

userRoutes.post("/users/:id/password", requireRole("admin", "super_admin"), async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const body = z
    .object({
      new_password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres."),
      notify: z.boolean().optional().default(true)
    })
    .parse(req.body);
  await users.adminChangePassword(req.auth!, id, {
    newPassword: body.new_password,
    notify: body.notify
  });
  res.json({ ok: true });
});

userRoutes.patch("/users/:id", requireRole("admin", "super_admin"), async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const body = z
    .object({
      rol: z.enum(["admin", "agente"]).optional(),
      estado: z.enum(["activo", "inactivo"]).optional()
    })
    .refine((b) => b.rol !== undefined || b.estado !== undefined, {
      message: "Nada para actualizar."
    })
    .parse(req.body);
  res.json({ user: await users.updateUser(req.auth!, id, body) });
});
