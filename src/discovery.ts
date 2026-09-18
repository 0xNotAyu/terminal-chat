import dgram from 'node:dgram';

const DISCOVERY_PORT = 45678;
const BROADCAST_ADDRESS = '255.255.255.255';
const ANNOUNCE_INTERVAL_MS = 3000;

export interface DiscoveryOptions {
  nodeId: string;
  user: string;
  /** Our dialable address, e.g. ws://192.168.1.14:8080 */
  address: string;
  onPeer: (address: string, user: string) => void;
  onError?: (error: Error) => void;
}

interface Announcement {
  kind: 'terminal-chat';
  nodeId: string;
  user: string;
  address: string;
}

/**
 * Shouts our address onto the LAN every few seconds and dials anyone shouting
 * back. Purely a convenience — if broadcast is blocked, `--connect` still works.
 */
export function startDiscovery(options: DiscoveryOptions): () => void {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let timer: NodeJS.Timeout | null = null;
  let closed = false;

  const payload = Buffer.from(
    JSON.stringify({
      kind: 'terminal-chat',
      nodeId: options.nodeId,
      user: options.user,
      address: options.address,
    } satisfies Announcement),
  );

  socket.on('error', (error) => {
    options.onError?.(error);
    stop();
  });

  socket.on('message', (raw) => {
    let announcement: Partial<Announcement>;
    try {
      announcement = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (announcement.kind !== 'terminal-chat') return;
    if (!announcement.address || !announcement.nodeId) return;
    if (announcement.nodeId === options.nodeId) return;
    options.onPeer(announcement.address, announcement.user ?? 'someone');
  });

  socket.bind(DISCOVERY_PORT, () => {
    try {
      socket.setBroadcast(true);
    } catch (error) {
      options.onError?.(error as Error);
      return;
    }
    const announce = () => {
      if (closed) return;
      socket.send(payload, DISCOVERY_PORT, BROADCAST_ADDRESS, (error) => {
        if (error) options.onError?.(error);
      });
    };
    announce();
    timer = setInterval(announce, ANNOUNCE_INTERVAL_MS);
    timer.unref();
  });

  function stop(): void {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  }

  return stop;
}
