// Scopes de las API keys de integración — ver modules/integrations.
//
// Una API key representa a un sistema externo, no a una persona: el sitio
// público, el agente de IA, mañana un portal inmobiliario. El scope es lo que
// separa "leer lo que ya es público" de "escribir en el CRM".

export const API_KEY_SCOPES = ["export:read", "agent:read", "agent:write"] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** Descripciones para la pantalla de integraciones del panel. */
export const SCOPE_LABELS: Record<ApiKeyScope, string> = {
  "export:read": "Sitio público — leer propiedades y datos de la inmobiliaria",
  "agent:read": "Agente de IA — buscar propiedades para responder consultas",
  "agent:write": "Agente de IA — registrar consultas, conversaciones y derivaciones"
};

export const DEFAULT_SCOPES: ApiKeyScope[] = ["export:read"];

export function isApiKeyScope(value: string): value is ApiKeyScope {
  return (API_KEY_SCOPES as readonly string[]).includes(value);
}
