/**
 * A sign-up form that records posts. The engine must not POST a completed
 * account unless an inbox provider allocated the address.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export interface JewelleryFixture {
  url: string;
  posts: () => { email: string; name: string }[];
  close: () => Promise<void>;
}

export async function startJewellery(): Promise<JewelleryFixture> {
  const posts: { email: string; name: string }[] = [];
  const server = createServer((req, res) => handle(req, res, posts));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('jewellery fixture did not bind');
  return {
    url: `http://127.0.0.1:${address.port}`,
    posts: () => posts.slice(),
    close: () => new Promise((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve());
    }),
  };
}

function handle(req: IncomingMessage, res: ServerResponse, posts: { email: string; name: string }[]): void {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/verify') {
    send(res, '<h1>Email verified</h1><p>Your account is confirmed.</p>');
    return;
  }
  if (req.method === 'POST' && url.pathname === '/register') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      posts.push({ email: params.get('email') || '', name: params.get('name') || '' });
      send(res, '<h1>Check your email</h1><p>Account created</p>');
    });
    return;
  }
  send(res, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Create account</title></head><body>
    <h1>Create a New Account</h1>
    <form method="post" action="/register">
      <label>Name <input name="name" required /></label>
      <label>Email <input name="email" type="email" required /></label>
      <label>Password <input name="password" type="password" required /></label>
      <label>Confirm password <input name="confirm" type="password" required /></label>
      <button type="submit">Create account</button>
    </form>
  </body></html>`);
}

function send(res: ServerResponse, html: string): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}
