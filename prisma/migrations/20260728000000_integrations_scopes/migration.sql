-- 0011 integrations — scopes en las API keys.
--
-- Hasta ahora una API key era una sola cosa: "leer los datos públicos del
-- sitio". Con el agente de IA aparece una segunda integración que necesita
-- acceso distinto (buscar propiedades para responder, y escribir leads y
-- conversaciones). En vez de inventar un segundo esquema de credenciales, la
-- key pasa a llevar scopes y el middleware exige el que corresponde por ruta.
--
-- Las keys que ya existen (el sitio de Lamelas) quedan con {export:read} por
-- el DEFAULT: siguen operando sin tocar lamelas-web.

alter table api_keys
  add column scopes text[] not null default array['export:read'];

-- Una key sin scopes no serviría para nada y una con un scope inventado sería
-- un permiso silencioso: las dos cosas se cierran acá, en la BD.
alter table api_keys
  add constraint api_keys_scopes_no_vacio
    check (array_length(scopes, 1) >= 1);

alter table api_keys
  add constraint api_keys_scopes_validos
    check (scopes <@ array['export:read', 'agent:read', 'agent:write']);

comment on column api_keys.scopes is
  'Permisos de la integración. export:read = datos públicos del sitio (lamelas-web); agent:read = búsqueda de propiedades para el agente de IA; agent:write = leads y conversaciones del agente.';

-- Nota: no cambian las policies de 0007. El contexto interno 'export' sigue
-- siendo el que resuelve la key por hash (lookup cross-tenant); los scopes se
-- verifican en la capa HTTP, sobre el resultado de ese lookup. El contexto RLS
-- 'agent' llega en la migración de las tablas del agente, no acá.
