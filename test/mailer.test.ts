import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { mailConfigured, sendMail } from "../src/lib/mailer.js";
const original = config.RESEND_API_KEY;
afterEach(() => { config.RESEND_API_KEY = original; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("Resend", () => {
  it("envía desde backend y exige confirmación con id", async () => {
    config.RESEND_API_KEY = "test-only";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "message-id" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(mailConfigured()).toBe(true);
    expect(await sendMail({ to: "test@example.test", subject: "Prueba", text: "Contenido" })).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers.Authorization).toBe("Bearer test-only");
    expect(JSON.parse(init.body)).toEqual({ from: config.EMAIL_FROM, to: "test@example.test", subject: "Prueba", text: "Contenido" });
  });
  it.each([400,401,429,500])("no reporta éxito ni registra datos sensibles con HTTP %s", async status => {
    config.RESEND_API_KEY = "test-only";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret-token", { status })));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await sendMail({ to: "secret@example.test", subject: "s", text: "secret-token" })).toBe(false);
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
  });
  it("dev sin proveedor omite envío", async () => {
    config.RESEND_API_KEY = "";
    expect(await sendMail({ to: "test@example.test", subject: "s", text: "t" })).toBe(false);
  });
});
