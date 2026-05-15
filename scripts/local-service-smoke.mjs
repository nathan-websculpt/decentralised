#!/usr/bin/env node
import { spawn } from 'child_process';
import { createServer } from 'net';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const ENTRYPOINT_CANDIDATES = [
  'relay-server/relay-server-enhanced.js',
];

function formatCandidateList() {
  return ENTRYPOINT_CANDIDATES.map((path) => `- ${path}`).join('\n');
}

function findRelayEntrypoint() {
  for (const candidate of ENTRYPOINT_CANDIDATES) {
    const fullPath = resolve(REPO_ROOT, candidate);
    if (existsSync(fullPath)) {
      return fullPath;
    }
  }
  return null;
}

async function chooseAvailablePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Could not resolve ephemeral port.'));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve(port);
        }
      });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeWebSocket(url) {
  return new WebSocket(url, { handshakeTimeout: 3000 });
}

function waitForWebSocketOpen(ws, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('WebSocket did not open before timeout'));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      ws.removeAllListeners();
    }

    ws.once('open', () => {
      cleanup();
      resolve(ws);
    });
    ws.once('error', (error) => {
      cleanup();
      reject(error);
    });
    ws.once('close', () => {
      cleanup();
      reject(new Error('WebSocket closed before opening'));
    });
  });
}

function createWebSocketClient(url, peerId) {
  const ws = makeWebSocket(url);
  ws.peerId = peerId;
  return waitForWebSocketOpen(ws, 3000);
}

function sendJson(ws, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    ws.send(body, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function waitForRelayAcceptingConnections(url, relayInfo, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (relayInfo.exited) {
      throw new Error(`Relay process exited early with code=${relayInfo.code} signal=${relayInfo.signal}`);
    }
    try {
      const ws = makeWebSocket(url);
      await waitForWebSocketOpen(ws, 1000);
      ws.terminate();
      return;
    } catch (error) {
      lastError = error;
      await sleep(200);
    }
  }
  throw new Error(`Relay did not accept WebSocket connections at ${url} within ${timeoutMs}ms. Last error: ${lastError?.message || 'none'}`);
}

function cleanupWebSocket(ws) {
  if (!ws || ws.readyState === WebSocket.CLOSED) {
    return;
  }
  try {
    ws.close();
  } catch {
    try {
      ws.terminate();
    } catch {
      // ignore
    }
  }
}

async function killProcess(proc, name) {
  if (!proc || proc.killed) {
    return;
  }
  proc.kill('SIGINT');
  const timeoutMs = 2000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.killed || proc.exitCode !== null) {
      return;
    }
    await sleep(100);
  }
  proc.kill('SIGKILL');
}

async function main() {
  const entrypoint = findRelayEntrypoint();
  if (!entrypoint) {
    console.error('ERROR: Could not locate the expected relay entrypoint in the repository checkout.');
    console.error('Expected the real relay source at relay-server/relay-server-enhanced.js.');
    console.error('This checkout does not currently contain that path.');
    console.error('The root relay-server.js file is legacy/stale and should not be restored as the preferred fix.');
    console.error('The correct repo fix is to commit the real relay source or update package/docs/scripts to point to a tracked dev relay entrypoint.');
    console.error('Looked for one of:');
    console.error(formatCandidateList());
    process.exitCode = 1;
    return;
  }

  const port = await chooseAvailablePort('127.0.0.1');
  const targetUrl = `ws://127.0.0.1:${port}`;

  console.log(`Using relay entrypoint: ${entrypoint}`);
  console.log(`Starting relay on ${targetUrl}`);

  const relayInfo = { exited: false, code: null, signal: null };
  const relayProcess = spawn(process.execPath, [entrypoint], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      BIND_ADDRESS: '127.0.0.1',
      LISTEN_HOST: '127.0.0.1',
      WEBSOCKET_HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  relayProcess.stdout.on('data', (chunk) => {
    process.stdout.write(`[relay stdout] ${chunk}`);
  });
  relayProcess.stderr.on('data', (chunk) => {
    process.stderr.write(`[relay stderr] ${chunk}`);
  });

  relayProcess.on('exit', (code, signal) => {
    relayInfo.exited = true;
    relayInfo.code = code;
    relayInfo.signal = signal;
  });

  const cleanupResources = [];
  const cleanup = async () => {
    for (const item of cleanupResources) {
      try {
        await item();
      } catch {
        // continue cleanup
      }
    }
    await killProcess(relayProcess, 'relay');
  };

  process.on('SIGINT', async () => {
    await cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', async () => {
    await cleanup();
    process.exit(143);
  });

  try {
    await waitForRelayAcceptingConnections(targetUrl, relayInfo, 5000);

    console.log('Relay accepted a WebSocket connection. Creating smoke clients...');

    const client1 = await createWebSocketClient(targetUrl, 'smoke-peer-1');
    cleanupResources.push(async () => cleanupWebSocket(client1));
    await sendJson(client1, { type: 'register', peerId: 'smoke-peer-1' });
    await sendJson(client1, { type: 'join-room', roomId: 'smoke-room' });
    await sleep(100);
    if (client1.readyState !== WebSocket.OPEN) {
      throw new Error('Client1 disconnected unexpectedly after valid messages.');
    }

    const client2 = await createWebSocketClient(targetUrl, 'smoke-peer-2');
    cleanupResources.push(async () => cleanupWebSocket(client2));
    await sendJson(client2, { type: 'register', peerId: 'smoke-peer-2' });
    await sendJson(client2, { type: 'request-sync', lastIndex: 0 });
    await sleep(100);
    if (client2.readyState !== WebSocket.OPEN) {
      throw new Error('Client2 disconnected unexpectedly after valid messages.');
    }

    console.log('Sending malformed payload to verify relay resilience...');
    client1.send('not-json', (error) => {
      if (error) {
        console.warn('Malformed payload send error (expected if connection is closed):', error.message);
      }
    });

    await sleep(500);
    if (relayInfo.exited) {
      throw new Error(`Relay exited after malformed payload with code=${relayInfo.code} signal=${relayInfo.signal}`);
    }

    console.log('Relay stayed alive after malformed payload. Smoke test passed.');
    await cleanup();
    process.exitCode = 0;
  } catch (error) {
    console.error('Smoke test failed:', error instanceof Error ? error.message : String(error));
    await cleanup();
    process.exitCode = 1;
  }
}

main();
