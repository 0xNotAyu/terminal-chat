import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

import {
  PROTOCOL_VERSION,
  decode,
  encode,
  type ChatMessage,
  type HelloMessage,
  type TypingMessage,
  type WireMessage,
} from './protocol.js';

const RECONNECT_DELAY_MS = 2000;

export interface RelayOptions {
  user: string;
  url: string;
}

/**
 * Talks to one relay server instead of a mesh of peers. There is exactly one
 * hop, so unlike Mesh there is no gossip forwarding and no seen-id dedupe —
 * the server already guarantees each message reaches you at most once.
 */
export class RelayClient extends EventEmitter {
  readonly nodeId = randomUUID();
  readonly user: string;
  private readonly url: string;
  private socket: WebSocket | null = null;
  private closing = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** nodeId -> username, so /who works without the server tracking addresses. */
  private readonly known = new Map<string, string>();

  constructor(options: RelayOptions) {
    super();
    this.user = options.user;
    this.url = options.url;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(this.url);
      this.socket = socket;

      socket.once('open', () => {
        this.send(this.hello());
        settled = true;
        resolve();
      });

      socket.once('error', (error) => {
        if (this.socket === socket) this.socket = null;
        if (!settled) {
          settled = true;
          reject(error);
        }
      });

      socket.on('message', (raw: Buffer | string) => {
        const message = decode(raw.toString());
        if (message) this.handle(message);
      });

      socket.on('close', () => {
        if (this.socket === socket) this.socket = null;
        if (!this.closing && settled) this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.emit('disconnect');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closing) return;
      this.connect()
        .then(() => this.emit('reconnect'))
        .catch(() => this.scheduleReconnect());
    }, RECONNECT_DELAY_MS);
    this.reconnectTimer.unref();
  }

  private hello(): HelloMessage {
    return {
      type: 'hello',
      v: PROTOCOL_VERSION,
      nodeId: this.nodeId,
      user: this.user,
      address: null,
      peers: [],
    };
  }

  private handle(message: WireMessage): void {
    switch (message.type) {
      case 'hello':
        if (message.nodeId === this.nodeId) return;
        this.known.set(message.nodeId, message.user);
        this.emit('join', { user: message.user, nodeId: message.nodeId });
        break;
      case 'chat':
        this.emit('chat', message satisfies ChatMessage);
        break;
      case 'typing':
        this.emit('typing', message satisfies TypingMessage);
        break;
      case 'bye':
        this.known.delete(message.nodeId);
        this.emit('leave', { user: message.user, nodeId: message.nodeId });
        break;
    }
  }

  get peerCount(): number {
    return this.known.size;
  }

  listPeers(): { user: string }[] {
    return [...this.known.values()].map((user) => ({ user }));
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
    this.send(message);
    return message;
  }

  typing(state: 'start' | 'stop'): void {
    this.send({
      type: 'typing',
      id: randomUUID(),
      nodeId: this.nodeId,
      user: this.user,
      state,
      ts: Date.now(),
    });
  }

  private send(message: WireMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(encode(message));
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.socket) {
      this.send({
        type: 'bye',
        id: randomUUID(),
        nodeId: this.nodeId,
        user: this.user,
        ts: Date.now(),
      });
      await new Promise((resolve) => setTimeout(resolve, 60));
      this.socket.close();
    }
  }
}

/** Accepts a bare host, host:port, or a full url — including https/http, which
 *  get mapped to wss/ws since that's almost always what someone means (e.g.
 *  pasting an ngrok/Render URL as-is). Defaults to ws:// with no scheme. */
export function normalizeServerUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^wss?:\/\//.test(trimmed)
    ? trimmed
    : /^https?:\/\//.test(trimmed)
      ? trimmed.replace(/^http/, 'ws')
      : `ws://${trimmed}`;
  try {
    const url = new URL(withScheme);
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}
