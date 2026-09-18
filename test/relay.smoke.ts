import assert from 'node:assert/strict';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

import { RelayClient } from '../src/relay-client.js';
import { decode, encode, type WireMessage } from '../src/protocol.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Minimal inline copy of server.ts's broadcast logic, so we don't spawn a process. */
function startRelay(port: number): WebSocketServer {
  const clients = new Map<WebSocket, { user: string; nodeId: string }>();
  const wss = new WebSocketServer({ port });
  wss.on('connection', (socket) => {
    socket.on('message', (raw: Buffer | string) => {
      const message = decode(raw.toString());
      if (!message) return;
      if (message.type === 'hello') {
        clients.set(socket, { user: message.user, nodeId: message.nodeId });
        broadcast(socket, message);
        return;
      }
      if (!clients.has(socket)) return;
      if (message.type === 'chat' || message.type === 'typing') broadcast(socket, message);
      else if (message.type === 'bye') {
        clients.delete(socket);
        broadcast(socket, message);
      }
    });
    socket.on('close', () => {
      const client = clients.get(socket);
      if (!client) return;
      clients.delete(socket);
      broadcast(socket, {
        type: 'bye',
        id: randomUUID(),
        nodeId: client.nodeId,
        user: client.user,
        ts: Date.now(),
      });
    });
  });
  function broadcast(from: WebSocket, message: WireMessage): void {
    const payload = encode(message);
    for (const socket of clients.keys()) {
      if (socket === from) continue;
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
  }
  return wss;
}

async function main(): Promise<void> {
  const port = 9601;
  const server = startRelay(port);
  await new Promise((resolve) => server.once('listening', resolve));

  const a = new RelayClient({ user: 'ayuneko', url: `ws://127.0.0.1:${port}` });
  const b = new RelayClient({ user: 'kai', url: `ws://127.0.0.1:${port}` });

  const aChat: string[] = [];
  const bChat: string[] = [];
  const aTyping: string[] = [];
  const aJoins: string[] = [];
  const aLeaves: string[] = [];
  const bLeaves: string[] = [];

  a.on('chat', (m: { text: string }) => aChat.push(m.text));
  b.on('chat', (m: { text: string }) => bChat.push(m.text));
  a.on('typing', (m: { user: string; state: string }) => aTyping.push(`${m.user}:${m.state}`));
  a.on('join', (m: { user: string }) => aJoins.push(m.user));
  a.on('leave', (m: { user: string }) => aLeaves.push(m.user));
  b.on('leave', (m: { user: string }) => bLeaves.push(m.user));

  await a.connect();
  await b.connect();
  await wait(200);

  assert.deepEqual(aJoins, ['kai'], 'a should see kai join');

  b.say('hello from kai');
  await wait(150);
  assert.deepEqual(aChat, ['hello from kai'], 'a should receive b\u2019s chat');
  assert.deepEqual(bChat, [], 'b should not receive its own chat back');

  // b types; a should see it. a's own typing must never come back to a.
  b.typing('start');
  a.typing('start');
  await wait(150);
  assert.deepEqual(aTyping, ['kai:start'], 'a should only see kai typing, never itself');

  await b.close();
  await wait(200);
  assert.deepEqual(bLeaves, [], 'b should not receive its own leave');
  assert.deepEqual(aLeaves, ['kai'], 'a should see kai leave');

  await a.close();
  server.close();
  console.log('relay smoke test passed');
  process.exit(0);
}

void main();
