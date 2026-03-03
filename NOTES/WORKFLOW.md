# WORKFLOW — Coordinación Claude Code / genesia-agent-service

## Objetivo

Cambios pequeños, verificables y PR-friendly. Sin sorpresas en producción.

## Regla de producción

No tocar producción desde el repo. El deploy se ejecuta aparte (VPS / CI),
nunca como parte de un cambio de código o documentación.
Si un paso requiere acceso al VPS o a prod, preparar los pasos y pedir OK
al humano antes de ejecutar cualquier cosa.

## Seguridad

- Nunca commitear secretos (tokens, API keys, hashes, passwords).
- No imprimir ni copiar valores reales en outputs, chats, PRs ni issues.
- `.env` siempre en `.gitignore`; `.env.example` con placeholders `REPLACE_ME`.
- **No imprimir `DATABASE_URL` completa ni credenciales de base de datos**,
  ni parcialmente. Mencionarlas solo por nombre de variable.
- Si se detectan secretos en el historial de git, notificar al humano y
  recomendar rotación antes de continuar. No intentar reescribir el historial
  sin instrucción explícita.

## Base de datos y migraciones

- Preferir migraciones **aditivas** (agregar columnas/tablas) sobre destructivas.
- **Nunca ejecutar migraciones destructivas** (DROP TABLE, DROP COLUMN, truncate,
  cambios de tipo con pérdida de datos) sin confirmación explícita del humano.
- Si una migración puede afectar datos existentes, presentar el SQL propuesto
  y esperar OK antes de aplicarlo.
- No asumir esquema de base de datos; leer los archivos de migración existentes
  antes de proponer cambios.

## Proceso estándar para cada tarea

1. **Confirmar objetivo** — leer el pedido, identificar alcance y restricciones.
2. **Inspeccionar código** — leer los archivos relevantes antes de proponer cambios.
3. **Plan 5–8 pasos** — presentar plan concreto; esperar OK si hay decisiones de diseño.
4. **Cambios mínimos** — solo lo necesario para el objetivo; no refactorizar de paso.
5. **Verificación** — correr lint/tests si existen; si no, smoke check
   (ej: `docker compose config`, verificación de sintaxis, dry-run de migración).
6. **Resumen final** — listar archivos tocados, diff stat, commit y resultado del push.
7. **Rollback** — indicar cómo revertir si algo sale mal (`git revert`, `git checkout`,
   o script de rollback de migración si aplica).

## Stop conditions — pedir confirmación humana antes de continuar

- Cualquier acción destructiva: `rm -rf`, `git reset --hard`, `git push --force`.
- Cambios en archivos de runtime de la aplicación sin instrucción explícita.
- Cualquier interacción con Docker en producción.
- Migraciones destructivas o con riesgo de pérdida de datos.
- Modificación de CI/CD o pipelines de deploy.
- Reescritura de historial de git (`filter-repo`, `rebase -i` con drops).
- Apertura de PRs (preparar el texto sí; crear el PR solo si se pide).
- Cualquier paso que requiera acceso SSH al VPS o ejecución remota.
