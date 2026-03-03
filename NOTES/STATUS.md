# STATUS — Template de estado de sesión

> Actualizar al cierre de cada sesión de trabajo.

## Fecha / hora

<!-- ej: 2026-03-03 14:30 ART -->

## Rama

<!-- ej: chore/some-change -->

## Cambios realizados

| Archivo | Tipo de cambio |
|---|---|
|  |  |

## Comandos ejecutados y resultados clave

```
# pegar aquí los comandos relevantes y su output resumido
```

## Riesgos / rollback

<!-- Qué puede salir mal y cómo revertir. -->

- Rollback: `git revert <commit>` o `git checkout main`
- Si hubo migración: indicar script/comando de rollback de migración

## Estado al cierre

- [ ] Working tree limpio
- [ ] Push realizado
- [ ] PR preparado (si aplica)
- [ ] Humano notificado de acciones pendientes (rotación de secrets, deploy, migraciones pendientes, etc.)
