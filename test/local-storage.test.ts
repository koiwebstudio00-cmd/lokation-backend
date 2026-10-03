import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { config } from "../src/config.js";
import { localPath, localUploadUrl, localStorageRouter, deleteLocalObjects, assertLocalObject } from "../src/lib/local-storage.js";
const previous = config.LOCAL_STORAGE_DIR;
const key = "11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/33333333-3333-3333-3333-333333333333.webp";
const data = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
const app = express();
app.use("/media", localStorageRouter());
function uploadPath() { const url = new URL(localUploadUrl(key)); return url.pathname + url.search; }
beforeAll(async () => { config.LOCAL_STORAGE_DIR = await mkdtemp(join(tmpdir(), "ubikka-media-")); });
afterAll(async () => { await rm(config.LOCAL_STORAGE_DIR, { recursive: true, force: true }); config.LOCAL_STORAGE_DIR = previous; });
describe("Almacenamiento persistente local", () => {
  it("rechaza traversal, claves alteradas y URL vencida", async () => {
    expect(() => localPath("../secrets")).toThrow();
    const path = uploadPath();
    expect((await request(app).put(path.replace("11111111", "aaaaaaaa")).set("Content-Type", "image/webp").send(data)).status).toBe(403);
    expect((await request(app).put(path.replace(/expires=\d+/, "expires=1")).set("Content-Type", "image/webp").send(data)).status).toBe(403);
  });
  it("rechaza contenido activo y archivos mayores a 10 MB", async () => {
    expect((await request(app).put(uploadPath()).set("Content-Type", "image/webp").send(Buffer.from("<svg></svg>"))).status).toBe(415);
    expect((await request(app).put(uploadPath()).set("Content-Type", "image/webp").send(Buffer.alloc(10 * 1024 * 1024 + 1))).status).toBe(413);
    await expect(assertLocalObject(key)).rejects.toThrow();
  });
  it("sube, sirve, impide sobrescritura y elimina", async () => {
    const path = uploadPath();
    expect((await request(app).put(path).set("Content-Type", "image/webp").send(data)).status).toBe(201);
    await assertLocalObject(key);
    const response = await request(app).get(`/media/${key}`);
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("image/webp");
    expect(response.body).toEqual(data);
    expect((await request(app).put(path).set("Content-Type", "image/webp").send(data)).status).toBe(409);
    await deleteLocalObjects([key]);
    expect((await request(app).get(`/media/${key}`)).status).toBe(404);
    await deleteLocalObjects([key]);
  });
});
