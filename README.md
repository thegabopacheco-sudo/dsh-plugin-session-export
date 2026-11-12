# dsh-plugin-session-export — Session Export

Exporta sesiones de DeepSeek Harness a Markdown o JSON: cabecera con metricas, turnos prompt/respuesta y transcripcion, con preview sin escribir, confirmacion y rutas permitidas.

## Herramientas

| Tool | Qué hace |
|---|---|
| `status` | Estado |
| `preview` | Previsualizar |
| `export` | Exportar |

## Instalación

Desde **DSH → Settings → Plugins** instala `github:thegabopacheco-sudo/dsh-plugin-session-export` y permite el script de instalación.

```
dsh plugin --profile <perfil> add github:thegabopacheco-sudo/dsh-plugin-session-export
```

## Seguridad

- Lectura por defecto; escritura solo con `confirm:true` y pedido explícito.
- `DSH_SESSION_EXPORT_MODE=read-only` desactiva acciones.
- Listas blancas y auditoría en `<DSH_HOME>\cache\session-export\audit.jsonl`.

## Licencia

MIT © thegabopacheco-sudo
