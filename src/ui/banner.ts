import boxen from 'boxen';
import figlet from 'figlet';

import { accent, dim } from './colors.js';

export function banner(): string {
  const art = figlet.textSync('T-chat', { font: 'ANSI Shadow' });
  return accent(art.replace(/\n+$/, ''));
}

export function sessionBox(lines: { label: string; value: string }[]): string {
  const width = Math.max(...lines.map((line) => line.label.length));
  const body = lines
    .map(({ label, value }) => `${dim(label.padEnd(width))}  ${value}`)
    .join('\n');

  return boxen(body, {
    padding: { top: 0, bottom: 0, left: 1, right: 1 },
    borderStyle: 'round',
    borderColor: '#7aa2f7',
    dimBorder: true,
  });
}

export function helpText(): string {
  return [
    `${accent('/who')}    ${dim('list connected peers')}`,
    `${accent('/dial')}   ${dim('<host:port> connect to a peer manually')}`,
    `${accent('/help')}   ${dim('show this')}`,
    `${accent('/quit')}   ${dim('leave the room (or press Ctrl+C)')}`,
  ].join('\n');
}
