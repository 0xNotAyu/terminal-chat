import type { EventEmitter } from 'node:events';

/**
 * What index.ts needs from a chat transport, regardless of whether messages
 * travel through the LAN mesh or a relay server. Implemented structurally by
 * both Mesh and RelayClient — no explicit `implements` needed.
 */
export interface ChatBackend extends EventEmitter {
  readonly user: string;
  readonly nodeId: string;
  readonly peerCount: number;
  say(text: string): { text: string; ts: number };
  typing(state: 'start' | 'stop'): void;
  listPeers(): { user: string; address?: string | null }[];
  close(): Promise<void>;

  // Events (documented here, emitted by both implementations):
  //   'chat'   { user, text, ts }
  //   'typing' { user, state }
  //   'join'   { user, nodeId }
  //   'leave'  { user, nodeId }
}
