'use strict';

const TOTAL_MS = 300_000;
const MAX_ATTEMPTS = 3;
const MAX_CHARS = 1024 * 1024;
const MESSAGES = {
  DEADLINE: 'Review provider exceeded its total request deadline.',
  TRANSPORT: 'Review provider transport failed.',
  HTTP: 'Review provider returned an unsuccessful HTTP status.',
  STATUS: 'Review provider returned an invalid HTTP status.',
  RESPONSE: 'Review provider returned an invalid response stream.',
  SIZE: 'Review provider response exceeded the character limit.',
  JSON: 'Review provider returned invalid JSON.',
};
class RequestFailure extends Error {
  constructor(kind, status) {
    super(MESSAGES[kind]);
    this.name = 'ReviewRequestError';
    this.code = 'REVIEW_' + kind;
    this.kind = kind;
    if (Number.isInteger(status) && status >= 100 && status <= 599) this.status = status;
  }
}

/** JSON transport only. Caller retains endpoint/model/request and content policy. */
async function requestReviewJson({
  url,
  apiKey,
  requestBody,
  onEvent = () => {},
  fetchImpl = globalThis.fetch,
  now = () => performance.now(),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}) {
  const began = now();
  let controller;
  let reader;
  let response;
  let expired = false;
  let attempt = 0;
  let rejectPending;
  const cancel = (body) => {
    try {
      Promise.resolve(body?.cancel()).catch(() => {});
    } catch {
      /* Best effort, never block budget. */
    }
  };
  const cancelCurrent = () => {
    try {
      cancel(reader || response?.body);
    } catch {
      /* Untrusted response getters must not replace diagnostics. */
    }
  };
  const abort = () => {
    try {
      controller?.abort();
    } catch {
      /* Fixed diagnostics only. */
    }
  };
  const emit = (phase, status, failureClass) => {
    const event = { phase, attempt, elapsedMs: Math.max(0, Math.round(now() - began)) };
    if (Number.isInteger(status) && status >= 100 && status <= 599) event.status = status;
    if (failureClass) event.failureClass = failureClass;
    try {
      Promise.resolve(onEvent(event)).catch(() => {});
    } catch {
      /* An observer cannot change transport semantics. */
    }
  };
  const check = () => {
    if (expired || now() - began >= TOTAL_MS) {
      expired = true;
      throw new RequestFailure('DEADLINE');
    }
  };
  const wait = async (operation) => {
    check();
    let registered;
    try {
      const value = await new Promise((resolve, reject) => {
        registered = reject;
        rejectPending = reject;
        // Handle late resolution/rejection even after the deadline wins.
        Promise.resolve()
          .then(() => {
            check();
            return operation();
          })
          .then(resolve, reject);
      });
      check();
      return value;
    } finally {
      if (rejectPending === registered) rejectPending = undefined;
    }
  };
  const timer = setTimeoutImpl(
    () => {
      expired = true;
      // Reject explicitly even if fetch/read ignores AbortSignal.
      rejectPending?.(new RequestFailure('DEADLINE'));
      abort();
      cancelCurrent();
    },
    Math.max(0, TOTAL_MS - (now() - began)),
  );
  async function readJson() {
    const decoder = new TextDecoder();
    let text = '';
    try {
      if (!response.body || typeof response.body.getReader !== 'function')
        throw new RequestFailure('RESPONSE');
      reader = response.body.getReader();
    } catch {
      throw new RequestFailure('RESPONSE');
    }
    if (!reader || typeof reader.read !== 'function') throw new RequestFailure('RESPONSE');
    for (;;) {
      const chunk = await wait(() => reader.read());
      if (!chunk || typeof chunk.done !== 'boolean') throw new RequestFailure('RESPONSE');
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) throw new RequestFailure('RESPONSE');
      // Bound decoder allocations even when a fetch implementation supplies a huge chunk.
      for (let offset = 0; offset < chunk.value.byteLength; offset += 65_536) {
        check();
        text += decoder.decode(chunk.value.subarray(offset, offset + 65_536), { stream: true });
        if (text.length > MAX_CHARS) throw new RequestFailure('SIZE');
      }
    }
    text += decoder.decode();
    if (text.length > MAX_CHARS) throw new RequestFailure('SIZE');
    check();
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new RequestFailure('JSON');
    }
    check();
    return value;
  }
  try {
    for (attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      check();
      controller = new AbortController();
      response = undefined;
      reader = undefined;
      emit('request');
      try {
        check();
        const operation = Promise.resolve().then(() => {
          check();
          return fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: requestBody,
            signal: controller.signal,
          });
        }).then((received) => {
          // Capture before wait's post-resolution deadline check can throw.
          response = received;
          return received;
        });
        // An abort-ignoring late fetch may still produce an unread body.
        operation
          .then(
            (late) => {
              if (expired) {
                try {
                  cancel(late?.body);
                } catch {
                  /* Late response is untrusted. */
                }
              }
            },
            () => {},
          )
          .catch(() => {});
        response = await wait(() => operation);
        const status = response?.status;
        if (!Number.isInteger(status) || status < 100 || status > 599)
          throw new RequestFailure('STATUS');
        emit('headers', status);
        if (status < 200 || status >= 300) {
          cancelCurrent();
          if ((status === 429 || status >= 500) && attempt < MAX_ATTEMPTS) {
            abort();
            emit('backoff', status);
          } else throw new RequestFailure('HTTP', status);
        } else {
          emit('body', status);
          const json = await readJson();
          emit('complete', status);
          return json;
        }
      } catch (error) {
        cancelCurrent();
        abort();
        const failure = error instanceof RequestFailure ? error : new RequestFailure('TRANSPORT');
        if (failure.kind !== 'DEADLINE') emit('failure', failure.status, failure.kind.toLowerCase());
        if (failure.kind !== 'TRANSPORT' || attempt >= MAX_ATTEMPTS) throw failure;
        emit('backoff');
      } finally {
        try {
          reader?.releaseLock();
        } catch {
          /* Pending reads may still hold the lock. */
        }
      }
      let backoffTimer;
      try {
        await wait(
          () =>
            new Promise((resolve) => {
              backoffTimer = setTimeoutImpl(resolve, 1000 * 2 ** (attempt - 1));
            }),
        );
      } finally {
        clearTimeoutImpl(backoffTimer);
      }
    }
    throw new RequestFailure('TRANSPORT');
  } catch (error) {
    const failure = error instanceof RequestFailure ? error : new RequestFailure('TRANSPORT');
    if (failure.kind === 'DEADLINE') emit('failure', undefined, 'deadline');
    throw failure;
  } finally {
    clearTimeoutImpl(timer);
    abort();
    // Successful readers are released; canceling a completed stream is harmless.
    cancelCurrent();
    try {
      reader?.releaseLock();
    } catch {
      /* Never mask the fixed terminal diagnostic. */
    }
  }
}
module.exports = { requestReviewJson };
