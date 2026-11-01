/**
 * Pages that each deterministic check should notice, plus one clean page.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export interface ChecksFixture {
  url: string;
  close: () => Promise<void>;
}

export async function startChecksFixture(): Promise<ChecksFixture> {
  const server = createServer((req, res) => handle(req, res));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('checks fixture did not bind');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose, reject) => {
      server.close(err => err ? reject(err) : resolveClose());
    }),
  };
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (url.pathname === '/missing.js') {
    res.writeHead(404, { 'content-type': 'text/javascript' });
    res.end('missing');
    return;
  }
  if (url.pathname === '/gone') {
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<!doctype html><html lang="en"><head><title>Gone</title></head><body><h1>Gone</h1></body></html>');
    return;
  }
  const pages: Record<string, string> = {
    '/clean': clean(),
    '/console': consolePage(),
    '/console-noise': noisePage(),
    '/http': httpPage(),
    '/axe': axePage(),
    '/axe-login': loginPage(),
    '/mobile': mobilePage(),
    '/meta': metaPage(),
  };
  const html = pages[url.pathname];
  if (!html) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('missing');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

function shell(title: string, body: string, extraHead = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta name="description" content="${title}"><meta name="viewport" content="width=device-width, initial-scale=1">${extraHead}<style>body{font:16px/1.4 sans-serif;margin:16px;color:#111;background:#fff}a,button,input{min-height:44px;min-width:44px;display:inline-block}</style></head><body>${body}</body></html>`;
}

function clean(): string {
  return shell('Clean page', '<h1>Clean page</h1><p>Nothing is broken.</p><p><a href="/clean">Stay here</a></p><button type="button">Continue</button>');
}

function consolePage(): string {
  return shell('Console', `<h1>Console</h1><script>console.error('TypeError: Cannot read properties of undefined (reading "cart")');throw new Error('checkout exploded');</script>`);
}

function noisePage(): string {
  return shell('Noise', `<h1>Noise</h1><script>
    console.error('ResizeObserver loop completed with undelivered notifications.');
    console.error('Failed to load resource: the server responded with a status of 404 (Not Found) favicon.ico');
    console.error('waiting for locator("#missing")');
  </script><p><a href="/clean">Clean</a></p>`);
}

function httpPage(): string {
  return shell('HTTP', '<h1>HTTP</h1><script src="/missing.js"></script><p><a href="/gone">Missing page</a></p>');
}

function axePage(): string {
  return shell('Axe', '<h1>Axe</h1><button></button><img src="/pixel.png">');
}

function loginPage(): string {
  return shell('Sign in', `<h1>Sign in</h1><form>
    <label for="email">Email</label><input id="email" name="email" type="email">
    <label for="password">Password</label><input id="password" name="password" type="password">
    <button type="submit">Sign in</button>
  </form>`);
}

function mobilePage(): string {
  return shell('Mobile', '<h1>Mobile</h1><div style="width:900px;height:24px;background:#c00">wide</div><button type="button" style="width:10px;height:10px;min-width:0;min-height:0;padding:0">Go</button>');
}

function metaPage(): string {
  return `<!doctype html><html><head></head><body><h1>One</h1><h1>Two</h1><p>No title.</p></body></html>`;
}
