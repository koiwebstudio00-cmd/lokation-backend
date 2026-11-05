import { afterEach, expect, it, vi } from "vitest";
import { openTransfer, sealTransfer } from "../src/lib/file-transfer-tickets.js";
import { shouldSkipLog } from "../src/middleware/logging.js";
afterEach(()=>vi.restoreAllMocks());
it("cifra credenciales, limita operación y vence a los cinco minutos",()=>{
  const start=Date.now();
  const grant=sealTransfer({operation:"upload",path:"/rental-documents",credential:"sesion-privada",portal:false,size:8});
  expect(Buffer.from(grant.token!,"base64url").toString()).not.toContain("sesion-privada");
  expect(openTransfer(grant.token!,"upload").size).toBe(8);
  expect(()=>openTransfer(grant.token!,"download")).toThrow();
  vi.spyOn(Date,"now").mockReturnValue(start+301000);
  expect(()=>openTransfer(grant.token!,"upload")).toThrow();
});
it("no registra autorizaciones temporales en URLs",()=>{
  expect(shouldSkipLog("/v1/file-transfers/download?ticket=secreto")).toBe(true);
  expect(shouldSkipLog("/v1/file-transfers/upload")).toBe(true);
});
