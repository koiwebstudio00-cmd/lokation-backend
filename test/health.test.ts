import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("GET /v1/health", () => {
  it("responde con el estado de la app y la BD", async () => {
    const res = await request(buildApp()).get("/v1/health");
    // Sin BD levantada responde 503; con BD, 200. Ambos son contratos válidos.
    expect([200, 503]).toContain(res.status);
    expect(res.body).toHaveProperty("ok");
    expect(res.body).toHaveProperty("db");
  });

  it("devuelve 404 con formato uniforme para rutas inexistentes", async () => {
    const res = await request(buildApp()).get("/v1/no-existe");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});
