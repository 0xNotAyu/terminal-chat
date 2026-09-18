#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { Command } from 'commander';

import { decode, encode, type WireMessage } from './protocol.js';

interface ConnectedClient {
  socket: WebSocket;
  user: string;
  nodeId: string;
}

/**
 * A hub, not a peer: clients only ever dial *out* to this process, so nobody
 * needs an open inbound port or a public IP. Every message a client sends is
 * broadcast to every other connected client, unmodified. There is no gossip,
 * no dedupe, no mesh-healing logic here — a star has none of that complexity
 * because everyone is one hop from everyone else.
 */
function main(): void {
  const program = new Command()
    .name('chat-server')
    .description('Relay server for terminal chat — run this once, publicly, so clients on any network can find each other.')
    .option('-p, --port <number>', 'port to listen on', process.env.PORT ?? '8080')
    .parse();

  const port = Number(program.opts<{ port: string }>().port) || 8080;
  const clients = new Map<WebSocket, ConnectedClient>();

  const wss = new WebSocketServer({ port });

  wss.on('listening', () => {
    console.log(`[chat-server] listening on :${port}`);
  });

  wss.on('connection', (socket) => {
    socket.on('message', (raw: Buffer | string) => {
      const message = decode(raw.toString());
      if (!message) return;

      if (message.type === 'hello') {
        clients.set(socket, { socket, user: message.user, nodeId: message.nodeId });
        console.log(`[chat-server] ${message.user} joined (${clients.size} online)`);
        broadcast(socket, message);
        return;
      }

      // Anything else from a socket that never said hello is ignored.
      if (!clients.has(socket)) return;

      if (message.type === 'chat' || message.type === 'typing') {
        broadcast(socket, message);
      } else if (message.type === 'bye') {
        const client = clients.get(socket);
        clients.delete(socket);
        if (client) console.log(`[chat-server] ${client.user} left (${clients.size} online)`);
        broadcast(socket, message);
      }
    });

    socket.on('close', () => announceDisconnect(socket));
    socket.on('error', () => socket.terminate());
  });

  function announceDisconnect(socket: WebSocket): void {
    const client = clients.get(socket);
    if (!client) return;
    clients.delete(socket);
    console.log(`[chat-server] ${client.user} disconnected (${clients.size} online)`);
    broadcast(socket, {
      type: 'bye',
      id: randomUUID(),
      nodeId: client.nodeId,
      user: client.user,
      ts: Date.now(),
    });
  }

  function broadcast(from: WebSocket, message: WireMessage): void {
    const payload = encode(message);
    for (const socket of clients.keys()) {
      if (socket === from) continue;
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
  }

  process.on('SIGINT', () => {
    wss.close(() => process.exit(0));
    for (const socket of clients.keys()) socket.close();
  });
}

main();
