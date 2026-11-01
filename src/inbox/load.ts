/**
 * Load a caller-supplied inbox module.
 *
 * The module's default export may be an InboxProvider or a function that
 * returns one (sync or async). Use this for IMAP or any other mailbox.
 * The engine does not bundle a hosted inbox.
 */

import { pathToFileURL } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import type { InboxProvider } from '../types.js';

export async function loadInboxProvider(specifier: string): Promise<InboxProvider> {
  const trimmed = specifier.trim();
  if (!trimmed) throw new Error('--inbox requires a module path.');
  const href = trimmed.startsWith('file:') || /^[a-z]+:\/\//i.test(trimmed)
    ? trimmed
    : pathToFileURL(isAbsolute(trimmed) ? trimmed : resolve(trimmed)).href;
  const loaded = await import(href) as { default?: unknown; createInbox?: unknown };
  const exported = loaded.default ?? loaded.createInbox;
  const provider = typeof exported === 'function'
    ? await (exported as () => InboxProvider | Promise<InboxProvider>)()
    : exported;
  if (!isProvider(provider)) {
    throw new Error('Inbox module must default-export an InboxProvider ({ allocate, waitFor }) or a function that returns one.');
  }
  return provider;
}

function isProvider(value: unknown): value is InboxProvider {
  if (!value || typeof value !== 'object') return false;
  const record = value as { allocate?: unknown; waitFor?: unknown };
  return typeof record.allocate === 'function' && typeof record.waitFor === 'function';
}
