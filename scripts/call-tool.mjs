#!/usr/bin/env node
/**
 * Calls one MCP tool on the built server and prints the result.
 *
 * WHY THIS EXISTS
 * `npx @modelcontextprotocol/inspector dist/index.js` under `op run` fails with
 * "JAMF_CLIENT_ID is required": the inspector spawns the server as a child
 * process without forwarding the parent environment, so credentials injected into
 * the inspector never reach the server. Passing them with the inspector's -e flag
 * would put the client secret on a command line, where `ps` can read it.
 *
 * This spawns the server itself and inherits the environment, so `op run` injects
 * directly into the process that needs it and the secret never lands on disk or in
 * an argument list.
 *
 * USAGE
 *   op run --env-file=.env.op -- node scripts/call-tool.mjs <toolName> ['<json args>']
 *   op run --env-file=.env.op -- node scripts/call-tool.mjs tools/list
 *
 * OUTPUT MAY CONTAIN LIVE FLEET DATA — device serials, user ids, group names.
 * Redirect to a gitignored path if you intend to keep it.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const [toolName, rawArgs] = process.argv.slice(2);

if (!toolName) {
  console.error('usage: node scripts/call-tool.mjs <toolName|tools/list> [\'{"json":"args"}\']');
  process.exit(2);
}
if (!existsSync('dist/index.js')) {
  console.error('dist/index.js not found — run `npm run build` first.');
  process.exit(2);
}

let toolArgs = {};
if (rawArgs) {
  try {
    toolArgs = JSON.parse(rawArgs);
  } catch (error) {
    console.error(`arguments must be valid JSON: ${error.message}`);
    process.exit(2);
  }
}

const server = spawn('node', ['dist/index.js'], {
  stdio: ['pipe', 'pipe', 'inherit'], // stderr passes through: that is where the server logs
  env: process.env,
});

const send = (msg) => server.stdin.write(`${JSON.stringify(msg)}\n`);

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'call-tool', version: '1.0' },
  },
});

let buffer = '';
let requested = false;
let exitCode = 1;

server.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';

  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error(`non-JSON on stdout (this would corrupt the transport): ${line}`);
      continue;
    }

    // Handshake complete — issue the real request.
    if (msg.id === 1 && msg.result && !requested) {
      requested = true;
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send(
        toolName === 'tools/list'
          ? { jsonrpc: '2.0', id: 2, method: 'tools/list' }
          : { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName, arguments: toolArgs } },
      );
      continue;
    }

    if (msg.id === 2) {
      if (msg.error) {
        console.error(`error: ${msg.error.message ?? JSON.stringify(msg.error)}`);
        exitCode = 1;
      } else if (toolName === 'tools/list') {
        for (const t of msg.result.tools ?? []) console.log(`${t.name}\t${t.title ?? ''}`);
        exitCode = 0;
      } else {
        // isError marks a tool-level failure; the payload still explains why.
        const text = (msg.result?.content ?? []).map((c) => c.text ?? '').join('\n');
        console.log(text);
        exitCode = msg.result?.isError ? 1 : 0;
      }
      server.stdin.end();
      server.kill();
      process.exit(exitCode);
    }
  }
});

server.on('exit', (code) => {
  // Reached when the server dies before answering — e.g. invalid configuration,
  // which it reports on stderr and which passes through above.
  process.exit(code === 0 ? exitCode : (code ?? 1));
});
