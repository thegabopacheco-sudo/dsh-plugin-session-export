// Test end-to-end de session-export con sesiones sintéticas.
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { zstdCompressSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const packageDir = path.resolve(import.meta.dirname, '..');
const tmpDir = path.join(packageDir, 'test', 'tmp');
rmSync(tmpDir, { recursive: true, force: true });
const home = path.join(tmpDir, 'dsh-home');
const sessionsRoot = path.join(home, 'sessions');
const proj = path.join(home, 'storages', 'session_projcache', 'sessions');
mkdirSync(proj, { recursive: true });
mkdirSync(path.join(home, 'session-export'), { recursive: true });
writeFileSync(path.join(home, 'session-export', 'config.json'), JSON.stringify({ allowedPaths: [home] }), 'utf8');

function frames(events) { return Buffer.concat(events.map((event) => zstdCompressSync(Buffer.from(JSON.stringify(event) + '\n', 'utf8')))); }
function writeSession(sessionId, events) {
  const dir = path.join(sessionsRoot, '--proj--', sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), frames(events));
}
writeSession('aaaa-buena', [
  { type: 'user', text: 'arreglemos el export' },
  { type: 'tool_result', text: 'listo' },
]);
writeSession('bbbb-sin-proj', [{ type: 'user', text: 'sesión sin proyección' }]);
writeFileSync(path.join(proj, 'aaaa-buena.json'), JSON.stringify({ version: 7, record: { rows: {
  title: { ver: 1, seq: 2, val: 'Sesión de export' },
  workingDirectory: { ver: 1, seq: 2, val: 'C:\\proj' },
  sessionStats: { ver: 1, seq: 2, val: { turns: 2, steps: 5, llmMs: 1000, toolMs: 500 } },
  tokenUsage: { ver: 1, seq: 2, val: { totals: { uncachedInputTokens: 100, outputTokens: 200, cacheReadTokens: 50 } } },
  turnOutline: { ver: 1, seq: 2, val: { turns: [{ turn: 1, prompt: 'arreglemos el export', response: 'Vamos a revisar el writer.' }, { turn: 2, prompt: 'probemos', response: 'Falta probar el formato JSON.' }] } },
  sessionListMetadata: { ver: 1, seq: 2, val: { lastPromptAt: 1794454320800 } },
} } }), 'utf8');

function makeClient(extraEnv = {}) {
  const entry = process.env.EXPORT_SERVER ? path.resolve(process.env.EXPORT_SERVER) : path.join(packageDir, 'server.mjs');
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env: { SystemRoot: process.env.SystemRoot || 'C:\\Windows', PATH: process.env.PATH, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME || process.env.USERPROFILE, TEMP: process.env.TEMP, TMP: process.env.TMP, DSH_HOME: home, ...extraEnv }, stderr: 'pipe' });
  transport.stderr?.on('data', (c) => process.stderr.write(`[server] ${c}`));
  const client = new Client({ name: 'export-test', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } });
  return client.connect(transport).then(() => ({ client, transport }));
}
const textOf = (r) => (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');

const { client, transport } = await makeClient();
console.log('tools:', (await client.listTools()).tools.map((t) => t.name).join(', '));
console.log('--- status ---'); console.log(textOf(await client.callTool({ name: 'status', arguments: {} })));
const preview = textOf(await client.callTool({ name: 'preview', arguments: { sessionId: 'aaaa' } }));
console.log('preview trae título y turnos:', preview.includes('Sesión de export') && preview.includes('Turno 2') && preview.includes('formato JSON'));
const previewJson = await client.callTool({ name: 'preview', arguments: { sessionId: 'aaaa', format: 'json' } });
const json = JSON.parse(textOf(previewJson));
console.log('json parseable:', json.turns.length === 2 && json.stats.turns === 2);
const noConfirm = await client.callTool({ name: 'export', arguments: { sessionId: 'aaaa' } });
console.log('export sin confirm isError:', noConfirm.isError === true);
const exported = await client.callTool({ name: 'export', arguments: { sessionId: 'aaaa', confirm: true } });
const exportedText = textOf(exported);
console.log('--- export ---'); console.log(exportedText);
const file = exportedText.replace('Exportado: ', '').split(' (')[0];
console.log('archivo existe:', existsSync(file), '| contenido:', readFileSync(file, 'utf8').includes('formato JSON'));
const exported2 = textOf(await client.callTool({ name: 'export', arguments: { sessionId: 'aaaa', confirm: true } }));
console.log('segundo export no sobrescribe:', exported2.includes('.md') && exported2 !== exportedText);
const jsonExport = textOf(await client.callTool({ name: 'export', arguments: { sessionId: 'aaaa', format: 'json', confirm: true } }));
console.log('export json:', jsonExport.includes('.json'));
const outside = await client.callTool({ name: 'export', arguments: { sessionId: 'aaaa', output: 'C:\\Windows\\Temp\\fuera.md', confirm: true } });
console.log('ruta fuera isError:', outside.isError === true);
const sinProj = textOf(await client.callTool({ name: 'preview', arguments: { sessionId: 'bbbb' } }));
console.log('sin proyección usa transcripción:', sinProj.includes('Transcripción') && sinProj.includes('sesión sin proyección'));
await client.close(); try { await transport.close?.(); } catch {}
const { client: roClient, transport: roTransport } = await makeClient({ DSH_EXPORT_MODE: 'read-only' });
const roExport = await roClient.callTool({ name: 'export', arguments: { sessionId: 'aaaa', confirm: true } });
console.log('read-only export isError:', roExport.isError === true);
const roPreview = await roClient.callTool({ name: 'preview', arguments: { sessionId: 'aaaa' } });
console.log('read-only preview ok:', roPreview.isError !== true);
await roClient.close(); try { await roTransport.close?.(); } catch {}
console.log('OK');
