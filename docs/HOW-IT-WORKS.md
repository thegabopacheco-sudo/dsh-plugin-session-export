# How dsh-plugin-session-export works

Exporta sesiones de DeepSeek Harness a Markdown o JSON: cabecera con metricas, turnos prompt/respuesta y transcripcion, con preview sin escribir, confirmacion y rutas permitidas.

## Architecture

```
DSH ──MCP stdio──► server.mjs (single-file bundle)
                    └─ local plugin logic
```

## Safety

- Read by default; actions require `confirm:true`.
- `read-only` mode via environment variable.
- Allowlists where applicable.
- Audit at `<DSH_HOME>\cache\session-export\audit.jsonl`.
- Action rate limit.

## Validation

End-to-end tests with the official MCP client (`@modelcontextprotocol/client@2.2.0`)
and the packaged artifact (`npm pack` → `postinstall` → deployed server).
