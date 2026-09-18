#!/usr/bin/env node
import { input } from '@inquirer/prompts';
import { Command } from 'commander';

import type { ChatBackend } from './backend.js';
import { Mesh, normalizeAddress } from './mesh.js';
import { RelayClient, normalizeServerUrl } from './relay-client.js';
import { startDiscovery } from './discovery.js';
import { TypingTracker } from './typing-tracker.js';
import { Terminal } from './ui/terminal.js';
import { banner, helpText, sessionBox } from './ui/banner.js';
import { accent, colorFor, dim, notice, warn } from './ui/colors.js';
import { thinkingLabel } from './ui/shimmer.js';

const USERNAME_PATTERN = /^[a-z0-9_-]{2,16}$/i;

interface Options {
  user?: string;
  port: string;
  connect: string[];
  discovery: boolean;
  server?: string;
}

async function main(): Promise<void> {
  const program = new Command()
    .name('chat')
    .description('Terminal chat. LAN peer mesh by default, or --server for chatting over the internet.')
    .option('-u, --user <name>', 'your username, e.g. ayuneko')
    .option('-p, --port <number>', 'port to listen on in mesh mode', '8080')
    .option('-c, --connect <address...>', 'peer addresses to dial in mesh mode, e.g. 192.168.1.14:8080', [])
    .option('--no-discovery', 'do not announce or look for peers on the LAN (mesh mode only)')
    .option('-s, --server <url>', 'relay server to connect through, e.g. wss://chat.example.com — use this to chat over the internet')
    .parse();

  const options = program.opts<Options>();

  console.log(banner());

  const user = options.user ?? (await askForUsername());
  if (!USERNAME_PATTERN.test(user)) {
    console.error(warn(`"${user}" is not a valid username (2-16 letters, digits, - or _).`));
    process.exit(1);
  }

  const terminal = new Terminal(user);
  const me = colorFor(user);
  const tracker = new TypingTracker((users) => {
    terminal.setStatus(users.length > 0 ? thinkingLabel(users) : null);
  });

  let backend: ChatBackend;
  let stopDiscovery: (() => void) | null = null;

  if (options.server) {
    const url = normalizeServerUrl(options.server);
    if (!url) {
      console.error(warn(`"${options.server}" is not a valid server address.`));
      process.exit(1);
    }
    if (options.connect.length > 0) {
      console.log(dim('--connect is ignored in --server mode.'));
    }
    const relay = new RelayClient({ user, url });
    try {
      await relay.connect();
    } catch {
      console.error(warn(`Could not reach ${url}. Is the server running and the address correct?`));
      process.exit(1);
    }
    backend = relay;

    relay.on('disconnect', () => terminal.print(warn('Connection to server lost — retrying...')));
    relay.on('reconnect', () => terminal.print(notice('Reconnected.')));

    console.log(
      sessionBox([
        { label: 'you', value: me(user) },
        { label: 'server', value: url },
      ]),
    );
  } else {
    const mesh = new Mesh({ user, port: Number(options.port) || 8080 });
    await mesh.listen();
    backend = mesh;

    for (const address of options.connect) mesh.connect(address);

    if (options.discovery && mesh.address) {
      stopDiscovery = startDiscovery({
        nodeId: mesh.nodeId,
        user,
        address: mesh.address,
        onPeer: (address) => mesh.connect(address),
        onError: () =>
          terminal.print(dim('LAN discovery unavailable — use /dial host:port instead.')),
      });
    }

    console.log(
      sessionBox([
        { label: 'you', value: me(user) },
        { label: 'listening', value: mesh.address ?? `ws://localhost:${mesh.port}` },
        { label: 'discovery', value: options.discovery ? notice('on (LAN)') : dim('off') },
      ]),
    );
  }

  console.log(dim('Type /help for commands.\n'));

  // --- backend -> screen ------------------------------------------------

  backend.on('chat', (message: { user: string; text: string; ts: number }) => {
    tracker.stop(message.user);
    terminal.printChat(formatPrefix(message.user, message.ts), message.text);
  });

  // Only ever fires for other people — we never send ourselves a typing event.
  backend.on('typing', (message: { user: string; state: 'start' | 'stop' }) => {
    if (message.state === 'start') tracker.start(message.user);
    else tracker.stop(message.user);
  });

  backend.on('join', ({ user: peer }: { user: string }) => {
    terminal.print(`${notice('→')} ${colorFor(peer)(peer)} ${dim('joined')}`);
  });

  backend.on('leave', ({ user: peer }: { user: string }) => {
    tracker.stop(peer);
    terminal.print(`${warn('←')} ${colorFor(peer)(peer)} ${dim('left')}`);
  });

  // --- keyboard -> backend ------------------------------------------------
  // Typing state is only ever sent outward. We never track or display our
  // own "you is thinking..." — that would just be telling ourselves what we
  // already know.

  terminal.on('typing-start', () => backend.typing('start'));
  terminal.on('typing-stop', () => backend.typing('stop'));

  terminal.on('line', (text: string) => {
    if (text.startsWith('/')) {
      handleCommand(text);
      return;
    }
    const message = backend.say(text);
    terminal.printChat(formatPrefix(user, message.ts), message.text);
  });

  terminal.on('exit', () => void shutdown());

  terminal.start();

  function handleCommand(raw: string): void {
    const [command, ...rest] = raw.slice(1).split(/\s+/);
    switch (command) {
      case 'help':
        terminal.print(helpText());
        break;
      case 'who': {
        const peers = backend.listPeers();
        if (peers.length === 0) {
          terminal.print(dim('No peers connected yet.'));
          break;
        }
        terminal.print(
          peers
            .map((peer) => `${colorFor(peer.user)(peer.user)} ${dim(peer.address ?? '')}`.trim())
            .join('\n'),
        );
        break;
      }
      case 'dial': {
        if (options.server) {
          terminal.print(warn('/dial only applies in mesh mode.'));
          break;
        }
        const address = normalizeAddress(rest.join(' '));
        if (!address) {
          terminal.print(warn('Usage: /dial host:port'));
          break;
        }
        (backend as Mesh).connect(address);
        terminal.print(dim(`Dialing ${address}...`));
        break;
      }
      case 'quit':
      case 'exit':
        void shutdown();
        break;
      default:
        terminal.print(warn(`Unknown command: /${command}`));
    }
  }

  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    tracker.clear();
    terminal.setStatus(null);
    stopDiscovery?.();
    await terminal.close();
    await backend.close();
    console.log(dim('Disconnected.'));
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown());
}

/** Time + username badge. Message text is appended separately — printChat
 *  needs the two apart so it can stream just the body, not the metadata. */
function formatPrefix(user: string, ts: number): string {
  const time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${dim(time)} ${colorFor(user)(user.padEnd(10))} `;
}

async function askForUsername(): Promise<string> {
  return input({
    message: 'Pick a username:',
    default: '伟大的阿尤什·夏尔马',
    validate: (value) =>
      USERNAME_PATTERN.test(value.trim()) || '2-16 characters: letters, digits, - or _',
    transformer: (value) => accent(value),
  }).then((value) => value.trim());
}

main().catch((error: unknown) => {
  console.error(warn(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
