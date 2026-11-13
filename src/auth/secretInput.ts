/**
 * Read one password line without putting it on argv.
 * A TTY prompt does not echo. A pipe is one line and is still visible to
 * whatever feeds the pipe. The value is not written to the output stream.
 */

import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

export async function readSecretLine(opts: {
  prompt: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  isTTY?: boolean;
}): Promise<string> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const tty = opts.isTTY ?? Boolean((input as { isTTY?: boolean }).isTTY);
  if (!tty) {
    const chunks: Buffer[] = [];
    for await (const chunk of input) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return Buffer.concat(chunks).toString('utf8').split(/\r?\n/, 1)[0] ?? '';
  }
  output.write(opts.prompt);
  const muted = new Writable({
    write(chunk, _enc, callback) {
      const text = String(chunk);
      if (text.includes('\n') || text.includes('\r')) output.write('\n');
      callback();
    },
  });
  const rl = createInterface({ input, output: muted, terminal: true });
  const answer = await new Promise<string>(resolve => { rl.question('', resolve); });
  rl.close();
  return answer;
}

export function rejectCredentialArg(flag: string): string | undefined {
  const name = flag.split('=', 1)[0];
  if (/^--(?:password|pass|passwd|username|user|email)$/.test(name)) {
    return 'Do not pass a password or account name on the command line. Use --username-env NAME and --password-env NAME, or --password-stdin. The command line is visible to other processes and to shell history. Environment variables are also visible to the shell, CI logs, and process listings.';
  }
  return undefined;
}
