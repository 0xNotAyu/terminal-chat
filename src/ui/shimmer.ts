import chalk from 'chalk';

/** Braille dots — the same frames ora's default spinner uses. */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export const FRAME_INTERVAL_MS = 80;

const BASE: [number, number, number] = [90, 96, 110];
const HIGHLIGHT: [number, number, number] = [226, 232, 240];
/** How many characters either side of the crest still catch the light. */
const FALLOFF = 4;

/**
 * Sweeps a bright crest left-to-right across the text, fading either side of it.
 * `phase` should advance by one per animation frame; it wraps on its own.
 */
export function shimmer(text: string, phase: number): string {
  const characters = [...text];
  const span = characters.length + FALLOFF * 4;
  const crest = phase % span;

  return characters
    .map((character, index) => {
      const distance = Math.abs(index - crest);
      const weight = Math.max(0, 1 - distance / FALLOFF);
      const eased = weight * weight * (3 - 2 * weight); // smoothstep
      const [r, g, b] = BASE.map((channel, k) =>
        Math.round(channel + (HIGHLIGHT[k]! - channel) * eased),
      ) as [number, number, number];
      return chalk.rgb(r, g, b)(character);
    })
    .join('');
}

/** "ayuneko is thinking…" / "ayuneko and kai are thinking…" */
export function thinkingLabel(users: string[]): string {
  if (users.length === 0) return '';
  if (users.length === 1) return `${users[0]} is thinking...`;
  if (users.length === 2) return `${users[0]} and ${users[1]} are thinking...`;
  return `${users.slice(0, -1).join(', ')} and ${users.at(-1)} are thinking...`;
}
