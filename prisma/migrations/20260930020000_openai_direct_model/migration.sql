-- Configuraciones guardadas con el formato de AI Gateway pasan a OpenAI directo.
-- Sólo se transforma el prefijo openai/; otros proveedores requieren revisión manual.
update tenants
set agent_config = jsonb_set(agent_config, '{model}', to_jsonb(substr(agent_config->>'model', 8)))
where agent_config->>'model' like 'openai/%'
  and substr(agent_config->>'model', 8) !~ '/';
