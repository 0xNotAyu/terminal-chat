import assert from 'node:assert/strict';

import { Mesh } from '../src/mesh.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const a = new Mesh({ user: 'ayuneko', port: 9101 });
  const b = new Mesh({ user: 'kai', port: 9102 });
  const c = new Mesh({ user: 'mira', port: 9103 });

  await Promise.all([a.listen(), b.listen(), c.listen()]);

  const heardByC: string[] = [];
  const typingAtA: string[] = [];
  c.on('chat', (message: { text: string }) => heardByC.push(message.text));
  a.on('typing', (message: { user: string; state: string }) =>
    typingAtA.push(`${message.user}:${message.state}`),
  );

  // Chain them: C -> B -> A. Nobody dials A and C directly.
  b.connect('ws://127.0.0.1:9101');
  c.connect('ws://127.0.0.1:9102');
  await wait(300);

  assert.equal(a.peerCount >= 1, true, 'a should have a peer');
  assert.equal(b.peerCount >= 1, true, 'b should have a peer');

  // A's message must reach C by being relayed through B.
  a.say('hello from the far end');
  await wait(300);
  assert.deepEqual(heardByC, ['hello from the far end'], 'gossip did not relay');

  // Typing travels the same path.
  c.typing('start');
  await wait(200);
  assert.deepEqual(typingAtA, ['mira:start'], 'typing did not relay');

  // No duplicates when the mesh closes a triangle.
  a.connect('ws://127.0.0.1:9103');
  await wait(300);
  b.say('second');
  await wait(300);
  assert.deepEqual(heardByC, ['hello from the far end', 'second'], 'message duplicated');

  const leaves: string[] = [];
  c.on('leave', ({ user }: { user: string }) => leaves.push(user));
  await b.close();
  await wait(300);
  assert.equal(leaves.includes('kai'), true, 'leave was not announced');

  await Promise.all([a.close(), c.close()]);
  console.log('mesh smoke test passed');
  process.exit(0);
}

void main();
