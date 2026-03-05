# genesia-agent-service

MVP brain for Valeria:
- Memory/CRM per contact (Postgres)
- KB/RAG (next milestone)
- Policy gates (e.g., honorarios only if verified doctor)

## Runtime env (on VPS host)
Create: `/opt/stacks/genesia-agent-service/.env.runtime` (chmod 600)

Minimal:
- `DATABASE_URL=postgres://genesia_app:<PASSWORD>@genesia-postgres:5432/genesia`

LLM:
- `ANTHROPIC_API_KEY=...` (primary)
- `OPENAI_API_KEY=...` (fallback)

Escalación a admin vía WhatsApp (requerido para notificaciones):
- `WA_TOKEN=...` — access token de Meta (mismo que en wa-bridge)
- `PHONE_NUMBER_ID=...` — ID del número en Meta Business (mismo que en wa-bridge)
- `ADMIN_NUMBER=...` — número destino sin `+` (ej: `5491112345678`)

Sin estas vars el sistema funciona normalmente; solo omite el envío WA y loguea un warning.

## Endpoints
- `GET /health`
- `POST /reply` (MVP: stub response)

## Deploy
We deploy to `/opt/stacks/genesia-agent-service` and restart the container.
