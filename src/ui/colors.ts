import chalk, { type ChalkInstance } from 'chalk';

/** Readable on both light and dark terminals. */
const PALETTE: ChalkInstance[] = [
  chalk.hex('#7aa2f7'),
  chalk.hex('#9ece6a'),
  chalk.hex('#e0af68'),
  chalk.hex('#bb9af7'),
  chalk.hex('#2ac3de'),
  chalk.hex('#f7768e'),
  chalk.hex('#ff9e64'),
  chalk.hex('#73daca'),
];

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/**
 * Same name always yields the same colour, on every machine — the palette
 * index is derived from the name itself rather than from join order.
 */
export function colorFor(user: string): ChalkInstance {
  const index = hash(user.toLowerCase()) % PALETTE.length;
  return PALETTE[index] ?? chalk.white;
}

export const dim = chalk.hex('#6b7280');
export const accent = chalk.hex('#7aa2f7');
export const notice = chalk.hex('#9ece6a');
export const warn = chalk.hex('#e0af68');
