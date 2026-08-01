import assert from 'node:assert/strict';
import test from 'node:test';
import { esc, sendTelegram } from '../src/lib/telegram.ts';

function withTelegramEnv<T>(run: () => Promise<T>): Promise<T> {
  const oldToken = process.env.TELEGRAM_BOT_TOKEN;
  const oldChat = process.env.TELEGRAM_CHAT_ID;
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_CHAT_ID = 'test-chat';
  return run().finally(() => {
    if (oldToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = oldToken;
    if (oldChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = oldChat;
  });
}

test('Telegram sender retries a transient transport failure', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) throw new TypeError('network unavailable');
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    await withTelegramEnv(() => sendTelegram('hello'));
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Telegram sender does not retry permanent client failures', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response('bad request', { status: 400 });
  }) as typeof fetch;
  try {
    await assert.rejects(withTelegramEnv(() => sendTelegram('hello')), /HTTP 400/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Telegram sender splits messages and escapes HTML values', async () => {
  const originalFetch = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    bodies.push(String(init?.body));
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    await withTelegramEnv(() => sendTelegram(`${'x'.repeat(4096)}\nnext`));
    assert.equal(bodies.length, 2);
    assert.equal(esc('<a&b>'), '&lt;a&amp;b&gt;');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
