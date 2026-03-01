# genesia-agent-service

MVP brain for Valeria:
- Memory/CRM per contact (Postgres)
- KB/RAG (next milestone)
- Policy gates (e.g., honorarios only if verified doctor)

## Runtime env (on VPS host)
Create: `/opt/stacks/genesia-agent-service/.env.runtime` (chmod 600)

Minimal:
- `DATABASE_URL=postgres://genesia_app:<PASSWORD>@genesia-postgres:5432/genesia`
- (later) `BRAVE_API_KEY=...`

## Endpoints
- `GET /health`
- `POST /reply` (MVP: stub response)

## Deploy
We deploy to `/opt/stacks/genesia-agent-service` and restart the container.
