# chat — terminal chat, two ways to connect

A CLI chat room with two transports:

- **Relay mode** (`--server`) — for chatting with anyone on the internet. One person runs the
  server once, publicly; everyone else just dials out to it. No port-forwarding on any client.
- **Mesh mode** (default) — for a LAN, no server at all. Every instance listens **and** dials,
  so there's no privileged node — kill anyone and the rest keep talking.

If you and the other person are on different networks (the normal internet case — different
homes, different wifi), **use relay mode**. Mesh mode only works because everyone can dial
everyone directly, which is true on one LAN and essentially never true across two home
routers.

```
 ██████╗██╗  ██╗ █████╗ ████████╗
██╔════╝██║  ██║██╔══██╗╚══██╔══╝
██║     ███████║███████║   ██║
██║     ██╔══██║██╔══██║   ██║
╚██████╗██║  ██║██║  ██║   ██║
 ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝

╭─────────────────────────────────╮
│ you     ayuneko                 │
│ server  wss://chat.example.com  │
╰─────────────────────────────────╯

11:42 AM ayuneko    anyone around?
→ kai joined
11:42 AM kai        just got here
⠹ kai is thinking...
ayuneko › |
```

## Chat over the internet (relay mode)

One person runs the server, once, somewhere reachable:

```bash
npm install
npm run server -- --port 8080
```

Anyone else — on any network — runs the client pointed at it:

```bash
npm run dev -- --user ayuneko --server ws://SERVER_IP:8080
```

`SERVER_IP` needs to actually be reachable by the other person, which is the one thing to get
right:

- **Both of you are on the same network right now** (testing on one wifi) — the server's LAN
  IP works as-is.
- **You're on different networks** (the real internet case) — the machine running the server
  needs either a port forwarded on its router to a public IP, or to *be* a public machine: a
  $5/mo VPS, or a free tier on Render / Fly.io / Railway. Those platforms terminate TLS for
  you, so you'd connect with `wss://` instead of `ws://`:

  ```bash
  npm run dev -- --user ayuneko --server wss://your-app.onrender.com
  ```

The server has no persistence and no auth — it's a broadcast hub, nothing more. Anyone who
knows the address can join and pick any username.

### Server flags

| Flag | Meaning |
|---|---|
| `-p, --port <n>` | Port to listen on. Falls back to `$PORT`, then `8080` — most platforms set `$PORT` for you, so often no flag is needed. |

## Chat on a LAN (mesh mode, no server)

Leave off `--server` entirely:

```bash
npm run dev                 # prompts for a username
```

On a second machine on the same wifi, just run it again — LAN discovery finds the first one.
If broadcast is blocked, point at the address printed in the box:

```bash
npm run dev -- --user kai --connect 192.168.1.14:8080
```

Two instances on **one** machine need different ports (the port auto-increments if taken,
but being explicit is clearer):

```bash
npm run dev -- --user ayuneko --port 8080
npm run dev -- --user kai --port 8081 --connect localhost:8080
```

### Client flags

| Flag | Meaning |
|---|---|
| `-u, --user <name>` | Username, 2–16 of `a-z 0-9 - _`. Prompted if omitted. |
| `-s, --server <url>` | Relay server to connect through. Switches to relay mode; `--port`, `--connect`, `--no-discovery` are ignored. |
| `-p, --port <n>` | *(mesh mode)* Port to listen on, default `8080`. Walks upward if busy. |
| `-c, --connect <addr...>` | *(mesh mode)* Peers to dial. `host:port` or `ws://host:port`. |
| `--no-discovery` | *(mesh mode)* Stay off the LAN broadcast; manual dialing only. |

### Commands

`/who` connected peers · `/dial host:port` add a peer (mesh mode only) · `/help` · `/quit` (or Ctrl+C)

### Build

```bash
npm run build
npm start                       # client
npm run start:server            # server
npm test                        # mesh + relay smoke tests, no TTY needed
```

## The thinking indicator, and message streaming

The moment you press a key, a `typing:start` goes out — gossiped through the mesh, or relayed
by the server, depending on mode. Everyone *else* sees:

```
⠹ ayuneko is thinking...
```

on a dedicated line above their prompt — a braille spinner plus a bright crest that sweeps
left-to-right across the text every 80 ms. It lives for **6 seconds**, refreshed by further
keystrokes and cut short by whichever comes first: your message arriving, a `typing:stop` after
1.5 s of idleness, or you disconnecting. Multiple typists collapse into one line: `ayuneko and
kai are thinking...`.

**You never see your own indicator.** Your keystrokes only ever send `typing` events outward —
nothing loops them back to your own screen, in either mode (the relay smoke test asserts this
directly: your own `typing('start')` never reaches your own `typing` listener). You already
know you're typing; the point of the indicator is telling everyone *else*.

**Messages over 100 characters stream in**, revealed a couple of characters at a time rather
than appearing all at once — the same look as an AI response typing itself out. Short messages
still appear instantly; this only kicks in past the threshold (`STREAM_THRESHOLD` in
`src/ui/terminal.ts`). It applies to every message, yours and everyone else's, so the whole
room reads consistently. Two things had to be handled carefully to make this safe:

- The spinner ticker redraws the screen every 80ms — without a guard, it would erase characters
  mid-reveal. A `streaming` flag makes it skip its redraw while a message is being written.
- Readline echoes your own keystrokes directly to the terminal — without pausing input, typing
  while someone else's message streams in would interleave garbled characters into the reveal.
  `rl.pause()` / `rl.resume()` bracket each stream.

All output is also serialized through one queue now (`print()` and `printChat()` both go
through it), so a short message arriving while a long one is still streaming waits its turn
instead of interleaving.

## How relay mode works

`src/server.ts` is a star: every client makes one outbound `ws` connection to it, sends a
`hello`, and from then on anything it sends gets broadcast to every *other* connected client,
verbatim. There's no gossip, no forwarding logic, no dedupe — a star has none of that
complexity, because everyone is exactly one hop from everyone else. This is also why it needs
no inbound port on the client side: the client only ever dials *out*, which is what makes it
work across two separate home networks where mesh mode can't.

`src/relay-client.ts` is the client half — same wire protocol (`src/protocol.ts`) as mesh mode,
so the two are interchangeable from `index.ts`'s point of view (see `src/backend.ts`). It
reconnects automatically with a 2s backoff if the server connection drops.

## How mesh mode works

Each node generates a UUID, opens a `ws` listener, and dials whatever it's told about.
On connect both sides exchange a `hello` carrying their id, username, dialable address, and
**the addresses of peers they already know** — so joining one node pulls you into the whole
mesh. Chat and typing frames are gossiped to every socket except the one they arrived on, and
a 2000-entry seen-id set stops them looping around cycles.

When two nodes dial each other simultaneously you get two links for one pair. The tie-break is
deterministic and needs no negotiation: the node with the lexicographically smaller UUID keeps
its outbound socket, the other keeps its inbound, and the loser is closed. Both sides reach the
same verdict independently.

LAN discovery is a UDP broadcast to `255.255.255.255:45678` every 3 s carrying the same address
string. It is pure convenience; `--connect` and `/dial` work regardless.

## Notes on the implementation

**Nothing writes to stdout except `src/ui/terminal.ts`.** A message arriving mid-keystroke would
otherwise shred your half-typed input. The terminal module keeps the screen in a fixed shape —
scrollback, then an optional status line, then the prompt — and every print erases that bottom
region, writes the new line, and redraws. The cursor always ends up back on the prompt line.

**`ora` was removed** along with `dotenv`, `execa`, and `@anthropic-ai/claude-agent-sdk`. Ora hides
the cursor and owns the line it animates, which puts it in a fight with readline over the same
row — the usual result is a duplicated or vanishing prompt. `src/ui/shimmer.ts` uses ora's default
braille frames and adds the gradient sweep, driven by the terminal's own render loop, so there's
one cursor authority instead of two. `dotenv` had nothing to configure once the server went away.

**Colors are derived from the username** by hashing it, so `ayuneko` is the same blue on every
machine in the room without anyone coordinating.

## Known limits

- No auth, in either mode. Anyone who can reach the server (or your port, in mesh mode) can
  join and can claim any username. Use `wss://` (TLS) for a public relay so the *contents*
  aren't plaintext on the wire, but there's still no login.
- Usernames aren't unique — two people can both be `kai` and the display won't distinguish them.
- No history. Messages sent before you joined are gone; nothing stores them, including the relay.
- If the relay server itself goes down, everyone's `RelayClient` retries every 2s until it comes
  back — but messages sent during the outage are simply lost, not queued.
- A message longer than your terminal width, or an input line that wraps, can leave a stray row
  when the status line repaints. Single-row input behaves.
- Mesh-mode discovery is IPv4 broadcast only, and many corporate networks and most VPNs drop it.

## Layout

```
src/
  index.ts            CLI wiring: flags, prompt, backend selection, event plumbing
  backend.ts           shared interface Mesh and RelayClient both satisfy
  mesh.ts              LAN peer mesh — listen, dial, handshake, gossip
  server.ts             relay hub — run this once, publicly, for internet chat
  relay-client.ts       client side of relay mode, with auto-reconnect
  protocol.ts          wire message shapes + validating decoder
  discovery.ts          UDP LAN broadcast (mesh mode only)
  typing-tracker.ts     6s lifetime per typist, remote users only
  ui/
    terminal.ts         sole stdout owner: prompt, printing, status line
    shimmer.ts           spinner frames + gradient sweep
    colors.ts            username → stable colour
    banner.ts            figlet + boxen
test/
  mesh.smoke.ts        3-node mesh relay, dedupe and leave test
  relay.smoke.ts       server + 2 clients; also asserts your own typing never echoes back
```
