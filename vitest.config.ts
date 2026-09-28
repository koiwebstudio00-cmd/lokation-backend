import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    testTimeout: 15000,
    // Tests de integración comparten la BD de test: sin paralelismo entre archivos.
    fileParallelism: false
  }
});
