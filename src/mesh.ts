import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';

import {
  PROTOCOL_VERSION,
  decode,
  encode,
  type ChatMessage,
  type GossipMessage,
  type HelloMessage,
  type TypingMessage,
  type WireMessage,
} from './protocol.js';

export interface MeshOptions {
  user: string;
  /** Preferred listening port. If taken, we walk upwards. */
  port: number;
  /** How many ports to try before giving up. */
  portAttempts?: number;
}

interface Peer {
  nodeId: string;
  user: string;
  socket: WebSocket;
  address: string | null;
  /** True when we dialed them, false when they dialed us. */
  outbound: boolean;
}

/** Returns the first non-internal IPv4 address, so peers on the LAN can dial us. */
export function localAddress(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
}

/**
 * A full-mesh peer. Every node listens for inbound connections *and* dials out,
 * so there is no privileged process — killing any node leaves the rest talking.
 */
export class Mesh extends EventEmitter {
  readonly nodeId = randomUUID();
  readonly user: string;

  private server: WebSocketServer | null = null;
  private readonly peers = new Map<string, Peer>();
  /** Sockets that have connected but not yet completed the handshake. */
  private readonly pending = new Set<WebSocket>();
  /** Addresses we have dialed or are dialing, to avoid duplicate attempts. */
  private readonly dialed = new Set<string>();
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly preferredPort: number;
  private readonly portAttempts: number;
  private closing = false;

  port = 0;

  constructor(options: MeshOptions) {
    super();
    this.user = options.user;
    this.preferredPort = options.port;
    this.portAttempts = options.portAttempts ?? 20;
  }

  /** Address other peers should dial to reach us. */
  get address(): string | null {
    const host = localAddress();
    return host && this.port ? `ws://${host}:${this.port}` : null;
  }

  get peerCount(): number {
    return this.peers.size;
  }

  listPeers(): { user: string; address: string | null }[] {
    return [...this.peers.values()].map((peer) => ({
      user: peer.user,
      address: peer.address,
    }));
  }

  async listen(): Promise<number> {
    for (let offset = 0; offset < this.portAttempts; offset += 1) {
      const port = this.preferredPort + offset;
      try {
        this.server = await this.bind(port);
        this.port = port;
        this.server.on('connection', (socket) => this.attach(socket, false));
        return port;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EADDRINUSE') throw error;
      }
    }
    throw new Error(
      `No free port between ${this.preferredPort} and ${this.preferredPort + this.portAttempts - 1}`,
    );
  }

  private bind(port: number): Promise<WebSocketServer> {
    return new Promise((resolve, reject) => {
      const server = new WebSocketServer({ port });
      const onError = (error: Error) => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(server);
      };
      server.once('error', onError);
      server.once('listening', onListening);
    });
  }

  /** Dial a peer. Safe to call repeatedly with the same address. */
  connect(address: string): void {
    const normalized = normalizeAddress(address);
    if (!normalized || this.closing) return;
    if (normalized === this.address) return;
    if (this.dialed.has(normalized)) return;
    if ([...this.peers.values()].some((peer) => peer.address === normalized)) return;

    this.dialed.add(normalized);
    let socket: WebSocket;
    try {
      socket = new WebSocket(normalized);
    } catch {
      this.dialed.delete(normalized);
      return;
    }

    socket.once('open', () => this.attach(socket, true, normalized));
    socket.once('error', () => {
      this.dialed.delete(normalized);
      socket.terminate();
    });
  }

  private attach(socket: WebSocket, outbound: boolean, address?: string): void {
    this.pending.add(socket);

    socket.on('message', (raw: Buffer | string) => {
      const message = decode(raw.toString());
      if (message) this.route(socket, message, outbound, address);
    });

    socket.on('close', () => this.detach(socket, address));
    socket.on('error', () => socket.terminate());

    this.send(socket, this.hello());
  }

  private hello(): HelloMessage {
    return {
      type: 'hello',
      v: PROTOCOL_VERSION,
      nodeId: this.nodeId,
      user: this.user,
      address: this.address,
      peers: [...this.peers.values()]
        .map((peer) => peer.address)
        .filter((value): value is string => value !== null),
    };
  }

  private route(
    socket: WebSocket,
    message: WireMessage,
    outbound: boolean,
    address?: string,
  ): void {
    if (message.type === 'hello') {
      this.onHello(socket, message, outbound, address);
      return;
    }
    // Ignore gossip from a socket that has not introduced itself yet.
    if (this.pending.has(socket)) return;
    if (this.markSeen(message.id)) return;

    this.forward(message, socket);

    if (message.type === 'chat') this.emit('chat', message satisfies ChatMessage);
    else if (message.type === 'typing') this.emit('typing', message satisfies TypingMessage);
    else if (message.type === 'bye') {
      const peer = [...this.peers.values()].find((entry) => entry.nodeId === message.nodeId);
      if (peer) {
        this.peers.delete(peer.nodeId);
        if (peer.address) this.dialed.delete(peer.address);
      }
      this.emit('leave', { user: message.user, nodeId: message.nodeId });
    }
  }

  private onHello(
    socket: WebSocket,
    message: HelloMessage,
    outbound: boolean,
    address?: string,
  ): void {
    this.pending.delete(socket);

    // We dialed ourselves — most likely via LAN discovery echo.
    if (message.nodeId === this.nodeId) {
      socket.close();
      return;
    }

    const existing = this.peers.get(message.nodeId);
    if (existing && existing.socket !== socket) {
      // Both sides dialed at the same time. Deterministic tie-break so exactly
      // one link survives: the node with the smaller id keeps its outbound.
      const keepOutbound = this.nodeId < message.nodeId;
      if (outbound === keepOutbound) {
        existing.socket.removeAllListeners('close');
        existing.socket.close();
      } else {
        socket.close();
        return;
      }
    }

    const peer: Peer = {
      nodeId: message.nodeId,
      user: message.user,
      socket,
      address: message.address ? normalizeAddress(message.address) : (address ?? null),
      outbound,
    };
    this.peers.set(peer.nodeId, peer);
    if (peer.address) this.dialed.add(peer.address);

    if (!existing) this.emit('join', { user: peer.user, nodeId: peer.nodeId });

    // Learn the rest of the mesh from them.
    for (const candidate of message.peers) this.connect(candidate);
  }

  private detach(socket: WebSocket, address?: string): void {
    this.pending.delete(socket);
    if (address) this.dialed.delete(address);

    for (const [nodeId, peer] of this.peers) {
      if (peer.socket !== socket) continue;
      this.peers.delete(nodeId);
      if (peer.address) this.dialed.delete(peer.address);
      this.emit('leave', { user: peer.user, nodeId });
      break;
    }
  }

  /** Returns true if this id has already been handled. */
  private markSeen(id: string): boolean {
    if (this.seen.has(id)) return true;
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > 2000) {
      const oldest = this.seenOrder.shift();
      if (oldest) this.seen.delete(oldest);
    }
    return false;
  }

  private forward(message: GossipMessage, from?: WebSocket): void {
    const payload = encode(message);
    for (const peer of this.peers.values()) {
      if (peer.socket === from) continue;
      if (peer.socket.readyState === WebSocket.OPEN) peer.socket.send(payload);
    }
  }

  private send(socket: WebSocket, message: WireMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(encode(message));
  }

  say(text: string): ChatMessage {
    const message: ChatMessage = {
      type: 'chat',
      id: randomUUID(),
      nodeId: this.nodeId,
      user: this.user,
      text,
      ts: Date.now(),
    };
    this.markSeen(message.id);
    this.forward(message);
    return message;
  }

  typing(state: 'start' | 'stop'): void {
    const message: TypingMessage = {
      type: 'typing',
      id: randomUUID(),
      nodeId: this.nodeId,
      user: this.user,
      state,
      ts: Date.now(),
    };
    this.markSeen(message.id);
    this.forward(message);
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;

    this.forward({
      type: 'bye',
      id: randomUUID(),
      nodeId: this.nodeId,
      user: this.user,
      ts: Date.now(),
    });

    // Give the farewell a moment to flush before tearing the sockets down.
    await new Promise((resolve) => setTimeout(resolve, 60));
    for (const peer of this.peers.values()) peer.socket.close();
    this.peers.clear();
    for (const socket of this.pending) socket.terminate();
    this.pending.clear();

    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      // Inbound sockets keep the server alive, so drop them explicitly.
      for (const client of this.server.clients) client.terminate();
      this.server.close(() => resolve());
    });
  }
}

/** ws://host:port — tolerates a bare host:port or host. */
export function normalizeAddress(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^wss?:\/\//.test(trimmed) ? trimmed : `ws://${trimmed}`;
  try {
    const url = new URL(withScheme);
    const port = url.port || '8080';
    return `ws://${url.hostname}:${port}`;
  } catch {
    return null;
  }
}
