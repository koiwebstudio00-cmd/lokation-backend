import { describe, expect, it } from "vitest";
import { shouldSkipLog } from "../src/middleware/logging.js";

describe("filtro del log de requests", () => {
  it("saltea el health check, con y sin query string", () => {
    expect(shouldSkipLog("/v1/health")).toBe(true);
    expect(shouldSkipLog("/v1/health?deep=1")).toBe(true);
  });

  it("loguea el resto de las rutas", () => {
    expect(shouldSkipLog("/v1/properties")).toBe(false);
    expect(shouldSkipLog("/v1/properties?operacion=venta")).toBe(false);
    expect(shouldSkipLog("/v1/export/site")).toBe(false);
    // Prefijo parecido pero ruta distinta: no se saltea.
    expect(shouldSkipLog("/v1/healthz")).toBe(false);
  });
});
