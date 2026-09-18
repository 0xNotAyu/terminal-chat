/**
 * The wire protocol every peer speaks.
 *
 * There is no server, so both sides of a socket send and receive the same
 * shapes. `hello` is the handshake, everything else is gossiped through the
 * mesh and de-duplicated by `id`.
 */

export const PROTOCOL_VERSION = 1;

export interface HelloMessage {
  type: 'hello';
  v: number;
  nodeId: string;
  user: string;
  /** Address other peers can dial us on, e.g. ws://192.168.1.14:8080 */
  address: string | null;
  /** Addresses of peers we already know about, so the mesh heals itself. */
  peers: string[];
}

export interface ChatMessage {
  type: 'chat';
  id: string;
  nodeId: string;
  user: string;
  text: string;
  ts: number;
}

export interface TypingMessage {
  type: 'typing';
  id: string;
  nodeId: string;
  user: string;
  state: 'start' | 'stop';
  ts: number;
}

export interface ByeMessage {
  type: 'bye';
  id: string;
  nodeId: string;
  user: string;
  ts: number;
}

export type WireMessage = HelloMessage | ChatMessage | TypingMessage | ByeMessage;

/** Messages that get forwarded across the mesh (everything except the handshake). */
export type GossipMessage = ChatMessage | TypingMessage | ByeMessage;

export function encode(message: WireMessage): string {
  return JSON.stringify(message);
}

export function decode(raw: string): WireMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const message = parsed as Partial<WireMessage>;
  switch (message.type) {
    case 'hello':
      return typeof message.nodeId === 'string' && typeof message.user === 'string'
        ? (message as HelloMessage)
        : null;
    case 'chat':
      return typeof message.id === 'string' && typeof message.text === 'string'
        ? (message as ChatMessage)
        : null;
    case 'typing':
      return typeof message.id === 'string' &&
        (message.state === 'start' || message.state === 'stop')
        ? (message as TypingMessage)
        : null;
    case 'bye':
      return typeof message.id === 'string' ? (message as ByeMessage) : null;
    default:
      return null;
  }
}
