# terminal-chat

Chat over the terminal. Run a server, others connect from anywhere.

```
████████╗    ██████╗██╗  ██╗ █████╗ ████████╗
╚══██╔══╝   ██╔════╝██║  ██║██╔══██╗╚══██╔══╝
   ██║█████╗██║     ███████║███████║   ██║   
   ██║╚════╝██║     ██╔══██║██╔══██║   ██║   
   ██║      ╚██████╗██║  ██║██║  ██║   ██║   
   ╚═╝       ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝ 

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



## Install

```bash
npm install -g terminal-chat
```

## Quick start (internet chat)

**1. One person runs the server:**

```bash
chat-server --port 8080
```

**2. Expose it to the internet with ngrok** (separate terminal):

```bash
ngrok http 8080
```

Copy the forwarding URL it prints (e.g. `https://xxxx.ngrok-free.dev`).

**3. Everyone connects:**

```bash
chat --user ayuneko --server wss://xxxx.ngrok-free.dev
```

(`https` or `wss` both work — either scheme gets converted automatically.)

## Commands

### Server

```bash
chat-server                    # listen on port 8080
chat-server --port 3000        # custom port
```

### Client — relay mode (internet)

```bash
chat                                          # prompts for username
chat --user ayuneko --server wss://your-url   # connect directly
chat -u ayuneko -s wss://your-url             # short flags
```

### Client — mesh mode (same LAN, no server needed)

```bash
chat                                          # auto-discovers peers on wifi
chat --user kai --connect 192.168.1.14:8080   # manual connect
chat -u kai -p 8081 -c localhost:8080         # custom port + connect
chat --no-discovery                           # disable LAN auto-discovery
```

### In-app

```
/who              list connected peers
/dial host:port   connect to a peer (mesh mode only)
/help             show commands
/quit             leave (or Ctrl+C)
```

## Flags

| Flag | Used by | Meaning |
|---|---|---|
| `-u, --user <name>` | both | username, 2–16 chars |
| `-s, --server <url>` | client | relay server URL — switches to relay mode |
| `-p, --port <n>` | server / mesh client | port to listen on |
| `-c, --connect <addr>` | mesh client | peer to dial |
| `--no-discovery` | mesh client | disable LAN broadcast discovery |