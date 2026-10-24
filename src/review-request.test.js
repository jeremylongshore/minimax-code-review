'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { requestReviewJson } = require('./review-request');
const encoder = new TextEncoder();
const LIMIT = 1024 * 1024;
class Clock {
  time = 0;
  id = 0;
  tasks = new Map();
  now = () => this.time;
  set = (fn, ms) => {
    const id = ++this.id;
    this.tasks.set(id, { at: this.time + ms, fn });
    return id;
  };
  clear = (id) => this.tasks.delete(id);
  async flush() {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  }
  async advance(ms) {
    const target = this.time + ms;
    for (let count = 0; count < 100; count++) {
      await this.flush();
      const next = [...this.tasks].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) {
        this.time = target;
        await this.flush();
        return;
      }
      this.tasks.delete(next[0]);
      this.time = next[1].at;
      next[1].fn();
    }
    assert.fail('virtual task bound');
  }
}
function response(text = '{"ok":true}', status = 200, options = {}) {
  const stats = { canceled: 0, released: 0, reads: 0 };
  const chunks = options.chunks || [encoder.encode(text)];
  let offset = 0;
  const reader = {
    read() {
      stats.reads++;
      if (options.hang) return new Promise(() => {});
      if (options.error) return Promise.reject(options.error);
      return Promise.resolve(
        offset < chunks.length ? { done: false, value: chunks[offset++] } : { done: true },
      );
    },
    cancel() {
      stats.canceled++;
      return options.cancelHang ? new Promise(() => {}) : Promise.resolve();
    },
    releaseLock() {
      stats.released++;
    },
  };
  return { status, body: { getReader: () => reader, cancel: reader.cancel }, stats };
}
function start(fetchImpl, onEvent) {
  const clock = new Clock();
  const events = [];
  const signals = [];
  let state = 'pending';
  let value;
  let error;
  const promise = requestReviewJson({
    url: 'https://synthetic.invalid/private-canary',
    apiKey: 'private-key-canary',
    requestBody: 'private-prompt-canary',
    fetchImpl: (...args) => {
      signals.push(args[1].signal);
      return fetchImpl(...args);
    },
    now: clock.now,
    setTimeoutImpl: clock.set,
    clearTimeoutImpl: clock.clear,
    onEvent: (event) => {
      events.push(event);
      if (onEvent) return onEvent(event);
    },
  });
  promise.then(
    (result) => {
      state = 'fulfilled';
      value = result;
    },
    (caught) => {
      state = 'rejected';
      error = caught;
    },
  );
  return {
    clock,
    events,
    signals,
    promise,
    state: () => state,
    value: () => value,
    error: () => error,
  };
}
async function terminal(h) {
  for (let i = 0; i < 20 && h.state() === 'pending'; i++) await h.clock.flush();
  assert.notEqual(h.state(), 'pending');
  assert.equal(h.clock.tasks.size, 0);
}
function safe(h) {
  const serialized = JSON.stringify({
    events: h.events,
    error: h.error() && { name: h.error().name, code: h.error().code, message: h.error().message },
  });
  for (const text of [
    'private-key-canary',
    'private-prompt-canary',
    'synthetic.invalid',
    'private-provider-canary',
    'private-header-canary',
  ])
    assert(!serialized.includes(text));
  for (const event of h.events) {
    assert(['request', 'headers', 'body', 'backoff', 'complete', 'failure'].includes(event.phase));
    assert(
      Object.keys(event).every((key) =>
        ['phase', 'attempt', 'elapsedMs', 'status', 'failureClass'].includes(key),
      ),
    );
    if (event.status !== undefined)
      assert(Number.isInteger(event.status) && event.status >= 100 && event.status <= 599);
    if (event.failureClass)
      assert(
        ['deadline', 'transport', 'http', 'status', 'response', 'size', 'json'].includes(
          event.failureClass,
        ),
      );
  }
}

test('abort-ignoring headers are bounded by the one total deadline', async () => {
  let resolveLate;
  const late = response();
  const h = start(
    () =>
      new Promise((resolve) => {
        resolveLate = resolve;
      }),
  );
  await h.clock.advance(300000);
  await terminal(h);
  assert.equal(h.error().code, 'REVIEW_DEADLINE');
  assert.equal(h.signals.length, 1);
  assert(h.signals[0].aborted);
  resolveLate(late);
  await h.clock.flush();
  assert(late.stats.canceled > 0);
  safe(h);
});
test('fast headers and abort-ignoring body stay inside the same deadline', async () => {
  const r = response('', 200, { hang: true, cancelHang: true });
  const h = start(() => Promise.resolve(r));
  await h.clock.advance(299999);
  assert.equal(h.state(), 'pending');
  await h.clock.advance(1);
  await terminal(h);
  assert.equal(h.error().code, 'REVIEW_DEADLINE');
  assert(r.stats.canceled > 0);
  safe(h);
});
test('429 and503 bodies are canceled before bounded backoff and successful third attempt', async () => {
  const responses = [response('private-provider-canary', 429), response('', 503), response()];
  let count = 0;
  const h = start(() => Promise.resolve(responses[count++]));
  await h.clock.advance(3000);
  await terminal(h);
  assert.deepEqual(h.value(), { ok: true });
  assert.equal(count, 3);
  assert(responses[0].stats.canceled > 0 && responses[1].stats.canceled > 0);
  assert.equal(responses[0].stats.reads + responses[1].stats.reads, 0);
  safe(h);
});
test('backoff consumes total budget and cannot start a late second attempt', async () => {
  const h = start(
    () => new Promise((resolve) => h.clock.set(() => resolve(response('', 503)), 299500)),
  );
  await h.clock.flush();
  await h.clock.advance(300000);
  await terminal(h);
  assert.equal(h.error().code, 'REVIEW_DEADLINE');
  assert.equal(h.signals.length, 1);
  safe(h);
});
test('all attempts share300s rather than three independent300s windows', async () => {
  let count = 0;
  const h = start(
    (_url, { signal }) =>
      new Promise((resolve, reject) => {
        count++;
        const aborted = () => {
          h.clock.clear(timer);
          reject(new Error());
        };
        const timer = h.clock.set(() => {
          signal.removeEventListener('abort', aborted);
          resolve(response('', 503));
        }, 150000);
        signal.addEventListener('abort', aborted, { once: true });
      }),
  );
  await h.clock.flush();
  await h.clock.advance(300000);
  await terminal(h);
  assert.equal(h.error().code, 'REVIEW_DEADLINE');
  assert.equal(count, 2);
  safe(h);
});
test('transient rejected fetch is retried at most three times with no raw error disclosure', async () => {
  const h = start(() => Promise.reject(new Error('private-provider-canary private-key-canary')));
  await h.clock.advance(3000);
  await terminal(h);
  assert.equal(h.signals.length, 3);
  assert.equal(h.error().code, 'REVIEW_TRANSPORT');
  safe(h);
});
test('terminal401 discards body without reading, retrying or waiting for cancellation', async () => {
  const r = response('private-provider-canary private-key-canary', 401, { cancelHang: true });
  const h = start(() => Promise.resolve(r));
  await terminal(h);
  assert.equal(h.error().code, 'REVIEW_HTTP');
  assert.equal(h.signals.length, 1);
  assert.equal(r.stats.reads, 0);
  assert(r.stats.canceled);
  safe(h);
});
for (const status of [0, 600, 200.5, '200', undefined])
  test('malformed status is nonretryable: ' + String(status), async () => {
    const r = response();
    r.status = status;
    const h = start(() => Promise.resolve(r));
    await terminal(h);
    assert.equal(h.error().code, 'REVIEW_STATUS');
    assert.equal(h.signals.length, 1);
    assert(r.stats.canceled);
    safe(h);
  });
test('one byte beyond existing JS-character cap is refused and canceled', async () => {
  const r = response(JSON.stringify('x'.repeat(LIMIT - 1)));
  const h = start(() => Promise.resolve(r));
  await terminal(h);
  assert.equal(h.error().code, 'REVIEW_SIZE');
  assert(r.stats.canceled);
  safe(h);
});
test('multibyte split stream preserves exact UTF16-character boundary and decoder state', async () => {
  const text = JSON.stringify('😀'.repeat((LIMIT - 2) / 2));
  assert.equal(text.length, LIMIT);
  const bytes = encoder.encode(text);
  const chunks = [bytes.subarray(0, 3), bytes.subarray(3, 65537), bytes.subarray(65537)];
  const h = start(() => Promise.resolve(response('', 200, { chunks })));
  await terminal(h);
  assert.equal(h.value().length, LIMIT - 2);
  safe(h);
});
test('multibyte payload exceeding character cap is rejected despite chunk boundaries', async () => {
  const h = start(() => Promise.resolve(response(JSON.stringify('😀'.repeat(LIMIT / 2)))));
  await terminal(h);
  assert.equal(h.error().code, 'REVIEW_SIZE');
  safe(h);
});
test('reader error cancels and releases each attempt without leaking raw details', async () => {
  const all = [];
  const h = start(() => {
    const r = response('', 200, { error: new Error('private-provider-canary') });
    all.push(r);
    return Promise.resolve(r);
  });
  await h.clock.advance(3000);
  await terminal(h);
  assert.equal(h.error().code, 'REVIEW_TRANSPORT');
  assert.equal(all.length, 3);
  assert(all.every((r) => r.stats.canceled && r.stats.released));
  safe(h);
});
for (const body of ['', 'private-provider-canary', '{'])
  test('invalid JSON is nonretryable with fixed diagnostic: ' + body.length, async () => {
    const h = start(() => Promise.resolve(response(body)));
    await terminal(h);
    assert.equal(h.error().code, 'REVIEW_JSON');
    assert.equal(h.signals.length, 1);
    safe(h);
  });
test('empty review content remains caller policy, JSON null and empty objects are valid transport JSON', async () => {
  for (const text of ['null', '{}', '{"choices":[]}']) {
    const h = start(() => Promise.resolve(response(text)));
    await terminal(h);
    assert.deepEqual(h.value(), JSON.parse(text));
    safe(h);
  }
});
test('success returns parsed JSON, clears timers, releases reader and isolates throwing observer', async () => {
  const r = response();
  const h = start(
    () => Promise.resolve(r),
    () => {
      throw new Error('private-provider-canary');
    },
  );
  await terminal(h);
  assert.deepEqual(h.value(), { ok: true });
  assert(r.stats.released);
  assert(h.signals[0].aborted);
  safe(h);
});
test('async rejecting observer never creates an unhandled rejection', async () => {
  const h = start(
    () => Promise.resolve(response()),
    () => Promise.reject(new Error('private-provider-canary')),
  );
  await terminal(h);
  assert.deepEqual(h.value(), { ok: true });
  safe(h);
});
test('late rejecting body after timeout is handled and cancellation errors cannot escape', async () => {
  let rejectRead;
  const r = response();
  r.body.getReader = () => ({
    read: () =>
      new Promise((_, reject) => {
        rejectRead = reject;
      }),
    cancel: () => Promise.reject(new Error('private-provider-canary')),
    releaseLock() {},
  });
  const h = start(() => Promise.resolve(r));
  await h.clock.advance(300000);
  await terminal(h);
  rejectRead(new Error('private-provider-canary'));
  await h.clock.flush();
  assert.equal(h.error().code, 'REVIEW_DEADLINE');
  safe(h);
});
test('malformed stream is nonretryable rather than a transport retry', async () => {
  const r = response();
  r.body.getReader = () => ({
    read: () => Promise.resolve({ done: false, value: 'private-provider-canary' }),
    cancel() {},
    releaseLock() {},
  });
  const h = start(() => Promise.resolve(r));
  await terminal(h);
  assert.equal(h.error().code, 'REVIEW_RESPONSE');
  assert.equal(h.signals.length, 1);
  safe(h);
});

test('deadline crossed before deferred fetch prevents starting a new request', async () => {
  let calls = 0;
  const h = start(
    () => {
      calls++;
      return Promise.resolve(response());
    },
    (event) => {
      if (event.phase === 'request')
        queueMicrotask(() => {
          h.clock.time = 300000;
        });
    },
  );
  await terminal(h);
  assert.equal(calls, 0);
  assert.equal(h.error().code, 'REVIEW_DEADLINE');
  safe(h);
});
test('HTTP retry aborts each old attempt even when body cancellation ignores completion', async () => {
  const responses = [
    response('', 429, { cancelHang: true }),
    response('', 503, { cancelHang: true }),
    response(),
  ];
  let calls = 0;
  const h = start(() => {
    if (calls > 0)
      assert(h.signals[calls - 1].aborted, 'Previous attempt must be aborted before replacement');
    return Promise.resolve(responses[calls++]);
  });
  await h.clock.advance(3000);
  await terminal(h);
  assert.deepEqual(h.value(), { ok: true });
  assert(h.signals.every((signal) => signal.aborted));
  assert(responses[0].stats.canceled && responses[1].stats.canceled);
  safe(h);
});

test('deadline crossed before deferred body read prevents starting reader IO', async () => {
  const r = response();
  const h = start(
    () => Promise.resolve(r),
    (event) => {
      if (event.phase === 'body')
        queueMicrotask(() => {
          h.clock.time = 300000;
        });
    },
  );
  await terminal(h);
  assert.equal(r.stats.reads, 0);
  assert.equal(h.error().code, 'REVIEW_DEADLINE');
  safe(h);
});
