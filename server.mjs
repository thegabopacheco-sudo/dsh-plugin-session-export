#!/usr/bin/env node
// dsh-plugin-session-export — exporta sesiones del harness a Markdown/JSON.
// Tools: status, preview, export.

import path from 'node:path';
import os from 'node:os';
import { zstdDecompressSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const VERSION = '0.1.0';
const DSH_HOME = (() => {
  const v = process.env.DSH_HOME && process.env.DSH_HOME.trim();
  return v || path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.dsh');
})();
const SESSIONS_ROOT = path.join(DSH_HOME, 'sessions');
const PROJ_ROOT = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions');
const CACHE_DIR = path.join(DSH_HOME, 'cache', 'session-export');
const CONFIG_FILE = path.join(DSH_HOME, 'session-export', 'config.json');
const READ_ONLY = String(process.env.DSH_EXPORT_MODE || '').toLowerCase() === 'read-only';
const log = (m) => process.stderr.write(`[export] ${m}\n`);

function loadConfig() {
  try { if (existsSync(CONFIG_FILE)) return { allowedPaths: [], ...(JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) || {}) }; } catch { /* defaults */ }
  return { allowedPaths: [] };
}
function allowedRoots() {
  const configured = loadConfig().allowedPaths;
  return (Array.isArray(configured) && configured.length ? configured : [DSH_HOME]).map((item) => path.resolve(item));
}
function isAllowed(target) {
  const resolved = path.resolve(target);
  return allowedRoots().some((root) => resolved === root || resolved.startsWith(root + path.sep));
}
function uniquePath(target) {
  if (!existsSync(target)) return target;
  const parsed = path.parse(target);
  for (let index = 1; index < 1000; index++) {
    const candidate = path.join(parsed.dir, `${parsed.name}-${index}${parsed.ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error('no se pudo generar un nombre único');
}
function unwrap(value) { return value && typeof value === 'object' && 'val' in value ? value.val : value; }
function num(value) { return typeof value === 'number' && Number.isFinite(value) ? value : 0; }

function frameLength(buffer, offset) {
  if (buffer.length - offset < 8) return -1;
  if (buffer.readUInt32LE(offset) !== 0xFD2FB528) return -1;
  let pos = offset + 4;
  const descriptor = buffer[pos++];
  const fcsFlag = (descriptor >> 6) & 3;
  const singleSegment = (descriptor >> 5) & 1;
  const checksum = (descriptor >> 2) & 1;
  const dictIdFlag = descriptor & 3;
  if (!singleSegment) pos += 1;
  if (dictIdFlag === 1) pos += 1; else if (dictIdFlag === 2) pos += 2; else if (dictIdFlag === 3) pos += 4;
  if (fcsFlag === 0 && singleSegment) pos += 1; else if (fcsFlag === 1) pos += 2; else if (fcsFlag === 2) pos += 4; else if (fcsFlag === 3) pos += 8;
  for (;;) {
    if (buffer.length - pos < 3) return -1;
    const header = buffer.readUIntLE(pos, 3);
    pos += 3;
    const lastBlock = header & 1;
    const blockType = (header >> 1) & 3;
    const blockSize = header >> 3;
    if (blockType === 1) pos += 1; else if (blockType === 2 || blockType === 0) pos += blockSize; else return -1;
    if (lastBlock) break;
  }
  if (checksum) pos += 4;
  return pos - offset;
}
function decodeSession(file) {
  const buffer = readFileSync(file);
  const parts = [];
  let offset = 0;
  while (offset < buffer.length) {
    const length = frameLength(buffer, offset);
    if (length <= 0) break;
    try { parts.push(zstdDecompressSync(buffer.subarray(offset, offset + length))); } catch { /* frame roto */ }
    offset += length;
  }
  return Buffer.concat(parts).toString('utf8');
}
function extractTexts(text, limit = 300) {
  const texts = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event = null;
    try { event = JSON.parse(trimmed); } catch { continue; }
    const found = [];
    const walk = (value, depth = 0) => { if (found.length >= 3 || depth > 8 || value === null || value === undefined) return; if (typeof value === 'string') { if (value.trim().length > 1) found.push(value.trim()); return; } if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return; } if (typeof value === 'object') { for (const key of ['text', 'content', 'message', 'input', 'output']) if (key in value) walk(value[key], depth + 1); for (const item of Object.values(value)) walk(item, depth + 1); } };
    walk(event);
    const joined = found.join(' ').replace(/\s+/g, ' ').trim();
    if (joined.length > 2) texts.push({ type: typeof event.type === 'string' ? event.type : 'event', text: joined.slice(0, 1200) });
    if (texts.length >= limit) break;
  }
  return texts;
}
function listSessions() {
  const sessions = [];
  for (const workspace of (() => { try { return readdirSync(SESSIONS_ROOT, { withFileTypes: true }); } catch { return []; } })()) {
    if (!workspace.isDirectory()) continue;
    for (const entry of (() => { try { return readdirSync(path.join(SESSIONS_ROOT, workspace.name), { withFileTypes: true }); } catch { return []; } })()) {
      if (!entry.isDirectory()) continue;
      const file = path.join(SESSIONS_ROOT, workspace.name, entry.name, 'session.v4.jsonl.zstd');
      if (!existsSync(file)) continue;
      const stat = statSync(file);
      sessions.push({ sessionId: entry.name, workspace: workspace.name, file, size: stat.size, mtime: stat.mtimeMs });
    }
  }
  return sessions.sort((a, b) => b.mtime - a.mtime);
}
function readProjection(sessionId) {
  const file = path.join(PROJ_ROOT, `${sessionId}.json`);
  if (!existsSync(file)) return {};
  try {
    const rows = JSON.parse(readFileSync(file, 'utf8'))?.record?.rows || {};
    const title = unwrap(rows.title);
    const cwd = unwrap(rows.workingDirectory);
    const stats = unwrap(rows.sessionStats) || {};
    const usage = unwrap(rows.tokenUsage) || {};
    const outline = unwrap(rows.turnOutline) || {};
    const meta = unwrap(rows.sessionListMetadata) || {};
    return {
      title: typeof title === 'string' ? title : null,
      cwd: typeof cwd === 'string' ? cwd : null,
      turns: Array.isArray(outline.turns) ? outline.turns.filter((turn) => turn && typeof turn === 'object').map((turn) => ({ turn: num(turn.turn), prompt: typeof turn.prompt === 'string' ? turn.prompt : '', response: typeof turn.response === 'string' ? turn.response : '' })) : [],
      stats: { turns: num(stats.turns), steps: num(stats.steps), llmMs: num(stats.llmMs), toolMs: num(stats.toolMs) },
      usage: { input: num(usage.totals?.uncachedInputTokens), output: num(usage.totals?.outputTokens), cacheRead: num(usage.totals?.cacheReadTokens) },
      lastPromptAt: num(meta.lastPromptAt),
    };
  } catch { return {}; }
}
function findSession(ref) {
  const sessions = listSessions();
  if (!ref) return sessions[0];
  const wanted = String(ref).toLowerCase();
  return sessions.find((session) => session.sessionId.toLowerCase() === wanted) || sessions.find((session) => session.sessionId.toLowerCase().startsWith(wanted));
}
function buildExport(session, format) {
  const projection = readProjection(session.sessionId);
  const title = projection.title || '(sin título)';
  const turns = Array.isArray(projection.turns) ? projection.turns : [];
  const stats = projection.stats || { turns: 0, steps: 0 };
  const usage = projection.usage || { input: 0, output: 0 };
  if (format === 'json') {
    const transcript = extractTexts(decodeSession(session.file), 200);
    return JSON.stringify({ sessionId: session.sessionId, title, cwd: projection.cwd, stats, usage, turns, transcript }, null, 2);
  }
  const lines = [`# ${title}`, '', `- **Sesión:** ${session.sessionId}`, projection.cwd ? `- **Directorio:** ${projection.cwd}` : '', `- **Fecha:** ${new Date(session.mtime).toISOString()}`, `- **Métricas:** ${stats.turns} turnos · ${stats.steps} pasos · tokens ${usage.input} input / ${usage.output} output`, ''];
  if (turns.length > 0) {
    for (const turn of turns) lines.push(`## Turno ${turn.turn}`, '', `> ${turn.prompt.replace(/\n/g, '\n> ')}`, '', turn.response, '');
  } else {
    lines.push('## Transcripción', '');
    for (const entry of extractTexts(decodeSession(session.file), 100)) lines.push(`- **${entry.type}:** ${entry.text}`);
  }
  return lines.filter((line) => line !== undefined).join('\n');
}
function textResult(text) { return { content: [{ type: 'text', text }] }; }

function buildInstructions() {
  return [
    'Session Export: exporta sesiones del harness a Markdown o JSON.',
    '',
    `Sesiones: ${SESSIONS_ROOT}`,
    `Salidas: ${CACHE_DIR} o ruta permitida`,
    '',
    'Herramientas: status, preview, export.',
    '',
    'Reglas:',
    '- preview es solo lectura; export escribe y requiere confirm:true.',
    '- Respeta allowedPaths (config del plugin); nunca sobrescribe: agrega sufijo único.',
    '- En DSH_EXPORT_MODE=read-only solo funciona preview.',
    '- Exporta el contenido real; no inventes turnos ni texto.',
  ].join('\n');
}

function buildServer() {
  const server = new McpServer({ name: 'dsh-plugin-session-export', version: VERSION }, { capabilities: { tools: {} }, instructions: buildInstructions() });

  server.registerTool(
    'status',
    { title: 'Estado', description: 'Sesiones exportables, rutas permitidas y modo.', inputSchema: z.object({}) },
    async () => {
      const sessions = listSessions();
      return textResult([`Sesiones: ${sessions.length}`, `Rutas permitidas: ${allowedRoots().join(', ')}`, `Salida por defecto: ${CACHE_DIR}`, `Modo: ${READ_ONLY ? 'read-only' : 'normal'}`].join('\n'));
    },
  );

  server.registerTool(
    'preview',
    { title: 'Previsualizar', description: 'Devuelve el Markdown de una sesión sin escribir.', inputSchema: z.object({ sessionId: z.string().optional(), format: z.enum(['md', 'json']).optional() }) },
    async (args) => {
      const session = findSession(args.sessionId);
      if (!session) throw new Error(`sesión no encontrada: ${args.sessionId || '(ninguna)'}`);
      return textResult(buildExport(session, args.format || 'md'));
    },
  );

  server.registerTool(
    'export',
    { title: 'Exportar', description: 'Escribe la sesión a Markdown/JSON. Requiere confirm:true.', inputSchema: z.object({ sessionId: z.string().optional(), format: z.enum(['md', 'json']).optional(), output: z.string().optional(), confirm: z.boolean().optional() }) },
    async (args) => {
      if (READ_ONLY) throw new Error('modo read-only: export deshabilitado');
      if (args.confirm !== true) throw new Error('export requiere confirm:true y pedido explícito');
      const session = findSession(args.sessionId);
      if (!session) throw new Error(`sesión no encontrada: ${args.sessionId || '(ninguna)'}`);
      const format = args.format || 'md';
      const target = args.output ? path.resolve(args.output) : path.join(CACHE_DIR, `${session.sessionId}.${format}`);
      if (!isAllowed(target)) throw new Error(`ruta no permitida: ${target}`);
      mkdirSync(path.dirname(target), { recursive: true });
      const file = uniquePath(target);
      writeFileSync(file, buildExport(session, format), 'utf8');
      return textResult(`Exportado: ${file} (${format})`);
    },
  );

  return server;
}

try { if (!READ_ONLY) mkdirSync(CACHE_DIR, { recursive: true }); } catch { /* ignora */ }
log(`sesiones: ${SESSIONS_ROOT} · modo: ${READ_ONLY ? 'read-only' : 'normal'}`);
serveStdio(buildServer, { onerror: (e) => log(`serveStdio: ${e.message}`) });
process.on('uncaughtException', (e) => log(`excepción: ${e.message}`));
process.on('unhandledRejection', (e) => log(`rechazo: ${e && e.message ? e.message : String(e)}`));
