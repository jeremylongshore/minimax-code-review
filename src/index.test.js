'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { requestReviewJson } = require('./review-request');
const source = readFileSync(require.resolve('./index'), 'utf8');
const encoder = new TextEncoder();
const SECRET = 'synthetic-private-canary';
async function flush() {
  for (let i = 0; i < 80; i++) await Promise.resolve();
}
function fixture(options = {}) {
  const logs = [],
    failures = [],
    requests = [],
    posts = [],
    api = [],
    masks = [];
  const timers = new Map();
  let nextTimer = 0;
  let time = 0;
  const inputReads = [];
  const inputs = {
    MINIMAX_API_KEY: SECRET,
    GITHUB_TOKEN: SECRET + '-github',
    MINIMAX_MODEL: '',
    MINIMAX_BASE_URL: '',
    MINIMAX_SYSTEM_PROMPT: 'synthetic system policy',
    MINIMAX_REVIEWER_NAME: '',
    MAX_DIFF_CHARS: '100000',
    INCLUDE_PR_BODY: '',
    EXCLUDE_PATTERNS: '',
    ...options.inputs,
  };
  const files = options.files || [
    { filename: 'src/synthetic.js', status: 'modified', patch: '+ synthetic-diff-canary' },
  ];
  const core = {
    getInput: (name) => {
      inputReads.push(name);
      return inputs[name] || '';
    },
    setSecret: (value) => masks.push(value),
    info: (line) => logs.push(line),
    setFailed: (message) => failures.push(message),
  };
  const octokit = {
    rest: {
      pulls: {
        listFiles: async (args) => {
          api.push({ name: 'files', args });
          if (options.githubError) throw options.githubError;
          return { data: files };
        },
        get: async (args) => {
          api.push({ name: 'context', args });
          return { data: { title: 'fresh-title-canary', body: 'fresh-body-canary' } };
        },
      },
      issues: {
        listComments: async (args) => {
          api.push({ name: 'comments', args });
          return { data: options.comments || [] };
        },
        createComment: async (args) => {
          posts.push({ method: 'create', ...args });
        },
        updateComment: async (args) => {
          posts.push({ method: 'update', ...args });
        },
      },
    },
  };
  const github = {
    getOctokit: (token) => {
      assert.equal(token, SECRET + '-github');
      return octokit;
    },
    context: {
      eventName: options.event || 'pull_request',
      repo: { owner: 'synthetic-owner', repo: 'synthetic-repo' },
      payload: { pull_request: { number: 7, title: 'stale-title', body: 'stale-body' } },
    },
  };
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    if (options.hang) return new Promise(() => {});
    const status = options.status || 200;
    const text =
      options.raw === undefined
        ? JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    options.content === undefined
                      ? '<think>synthetic-private-reasoning</think>lgtm'
                      : options.content,
                },
              },
            ],
          })
        : options.raw;
    let read = false;
    return {
      status,
      body: {
        cancel: async () => {},
        getReader: () => ({
          read: async () =>
            read ? { done: true } : ((read = true), { done: false, value: encoder.encode(text) }),
          cancel: async () => {},
          releaseLock() {},
        }),
      },
    };
  };
  const context = vm.createContext(
    {
      performance: { now: () => time },
      require(name) {
        if (name === '@actions/core') return core;
        if (name === '@actions/github') return github;
        if (name === './review-request')
          return {
            requestReviewJson: (args) =>
              requestReviewJson({
                ...args,
                fetchImpl,
                now: () => time,
                setTimeoutImpl: (fn, ms) => {
                  const id = ++nextTimer;
                  timers.set(id, { at: time + ms, fn });
                  return id;
                },
                clearTimeoutImpl: (id) => timers.delete(id),
              }),
          };
        throw new Error('Unexpected dependency in isolated index fixture');
      },
    },
    { codeGeneration: { strings: false, wasm: false } },
  );
  new vm.Script(source, { filename: 'isolated-index.js' }).runInContext(context, { timeout: 1000 });
  return {
    inputReads,
    logs,
    failures,
    requests,
    posts,
    api,
    masks,
    timers,
    async deadline() {
      await flush();
      time = 300000;
      for (const [id, timer] of timers)
        if (timer.at <= time) {
          timers.delete(id);
          timer.fn();
        }
      await flush();
    },
  };
}
function events(f) {
  return f.logs.filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
}
function safeDiagnostics(f) {
  assert(!JSON.stringify({ logs: f.logs, failures: f.failures }).includes(SECRET));
  assert(!f.logs.join('\n').includes('synthetic-diff-canary'));
  assert(!f.logs.join('\n').includes('fresh-body-canary'));
  assert(!f.logs.join('\n').includes('synthetic-private-reasoning'));
  assert(
    events(f).every((event) =>
      Object.keys(event).every((key) =>
        ['component', 'phase', 'stage', 'attempt', 'elapsedMs', 'status', 'failureClass'].includes(
          key,
        ),
      ),
    ),
  );
}

test('actual index preserves default endpoint/model, diff, masking, reasoning removal and sticky create', async () => {
  const f = fixture();
  await flush();
  assert.equal(f.failures.length, 0);
  assert.equal(f.requests.length, 1);
  assert.equal(f.posts.length, 1);
  assert.equal(f.requests[0].url, 'https://api.minimaxi.chat/v1/chat/completions');
  const body = JSON.parse(f.requests[0].init.body);
  assert.equal(body.model, 'MiniMax-M2.5');
  assert.equal(body.messages[0].content, 'synthetic system policy');
  assert(body.messages[1].content.includes('+ synthetic-diff-canary'));
  assert(!body.messages[1].content.includes('fresh-body-canary'));
  assert.equal(f.requests[0].init.headers.Authorization, 'Bearer ' + SECRET);
  assert.deepEqual(f.masks, [SECRET, SECRET + '-github']);
  assert.equal(f.posts[0].method, 'create');
  assert.equal(f.posts[0].issue_number, 7);
  assert.equal(f.posts[0].body, '## MiniMax Code Review\n\nlgtm\n\n<!-- minimax-code-review -->');
  assert.equal(f.timers.size, 0);
  safeDiagnostics(f);
});
test('custom model and fresh author context preserve reviewer-specific sticky update', async () => {
  const f = fixture({
    inputs: {
      MINIMAX_BASE_URL: 'https://synthetic-gateway.invalid/v1///',
      MINIMAX_MODEL: 'synthetic-model',
      INCLUDE_PR_BODY: 'true',
      MINIMAX_REVIEWER_NAME: 'Claims Reviewer',
    },
    comments: [{ id: 42, body: '<!-- minimax-code-review:claims-reviewer -->' }],
  });
  await flush();
  assert.equal(f.requests[0].url, 'https://api.minimaxi.chat/v1/chat/completions');
  const body = JSON.parse(f.requests[0].init.body);
  assert.equal(body.model, 'synthetic-model');
  assert(body.messages[1].content.includes('fresh-title-canary'));
  assert(body.messages[1].content.includes('fresh-body-canary'));
  assert(!body.messages[1].content.includes('stale-body'));
  assert.equal(f.posts[0].method, 'update');
  assert.equal(f.posts[0].comment_id, 42);
  assert(f.posts[0].body.includes('<!-- minimax-code-review:claims-reviewer -->'));
  assert(f.api.some((item) => item.name === 'context'));
  safeDiagnostics(f);
});
test('existing exclude patterns and diff cap remain visible in provider payload', async () => {
  const f = fixture({
    inputs: { EXCLUDE_PATTERNS: 'generated.js', MAX_DIFF_CHARS: '80' },
    files: [
      { filename: 'generated.js', status: 'modified', patch: '+ excluded' },
      { filename: 'small.js', status: 'modified', patch: '+ small' },
      { filename: 'large.js', status: 'modified', patch: '+'.repeat(200) },
    ],
  });
  await flush();
  const content = JSON.parse(f.requests[0].init.body).messages[1].content;
  assert(content.includes('small.js'));
  assert(!content.includes('+ excluded'));
  assert(content.includes('large.js'));
  assert(content.includes('MAX_DIFF_CHARS'));
  safeDiagnostics(f);
});
test('all-excluded or patchless PR never calls provider or posts a comment', async () => {
  for (const options of [
    { files: [{ filename: 'x.js' }] },
    { inputs: { EXCLUDE_PATTERNS: '*.js' } },
  ]) {
    const f = fixture(options);
    await flush();
    assert.equal(f.requests.length, 0);
    assert.equal(f.posts.length, 0);
    assert.equal(f.failures.length, 0);
    safeDiagnostics(f);
  }
});
test('headers/body deadline is classified safely by actual index catch with no post', async () => {
  const f = fixture({ hang: true });
  await f.deadline();
  assert.deepEqual(f.failures, ['Review action failed (REVIEW_DEADLINE); see phase diagnostics.']);
  assert.equal(f.posts.length, 0);
  assert.equal(f.timers.size, 0);
  assert(
    events(f).some((event) => event.component === 'provider' && event.failureClass === 'deadline'),
  );
  assert(
    events(f).some(
      (event) =>
        event.component === 'action' &&
        event.phase === 'failure' &&
        event.stage === 'REVIEW_DEADLINE',
    ),
  );
  safeDiagnostics(f);
});
test('terminal provider401 secret body produces safe HTTP diagnostics and no retry/comment', async () => {
  const f = fixture({ status: 401, raw: SECRET });
  await flush();
  assert.equal(f.requests.length, 1);
  assert.equal(f.posts.length, 0);
  assert.equal(f.failures.length, 1);
  assert(f.failures[0].includes('REVIEW_HTTP'));
  assert(
    events(f).some(
      (event) =>
        event.component === 'provider' && event.phase === 'headers' && event.status === 401,
    ),
  );
  safeDiagnostics(f);
});
test('invalid JSON and missing/nonstring review content fail with fixed codes', async () => {
  for (const [options, code] of [
    [{ raw: SECRET }, 'REVIEW_JSON'],
    [{ raw: 'null' }, 'REVIEW_CONTENT'],
    [{ content: {} }, 'REVIEW_CONTENT'],
    [{ content: '' }, 'REVIEW_CONTENT'],
  ]) {
    const f = fixture(options);
    await flush();
    assert.equal(f.posts.length, 0);
    assert.equal(f.failures.length, 1);
    assert(f.failures[0].includes(code));
    safeDiagnostics(f);
  }
});
test('unknown GitHub failure does not leak error text or malformed status into diagnostics', async () => {
  const error = new Error(SECRET);
  error.status = 'private-header-canary';
  const f = fixture({ githubError: error });
  await flush();
  assert.deepEqual(f.failures, ['Review action failed (ACTION_OPERATION); see phase diagnostics.']);
  assert.equal(f.requests.length, 0);
  assert.equal(events(f).at(-1).status, undefined);
  safeDiagnostics(f);
});
test('success phase ordering makes GitHub/context/provider/comment boundaries observable', async () => {
  const f = fixture({ inputs: { INCLUDE_PR_BODY: 'true' } });
  await flush();
  const phases = events(f)
    .filter((event) => event.component === 'action')
    .map((event) => event.phase + ':' + event.stage);
  assert.deepEqual(phases, [
    'configuration:start',
    'configuration:complete',
    'github_files:start',
    'github_files:complete',
    'github_context:start',
    'github_context:complete',
    'provider:start',
    'provider:complete',
    'github_comments:start',
    'github_comments:complete',
    'github_post:start',
    'github_post:complete',
  ]);
  safeDiagnostics(f);
});
test('reasoning-only review retains the existing fixed notice and never posts reasoning', async () => {
  const f = fixture({ content: '<think>synthetic-private-reasoning' });
  await flush();
  assert.equal(f.failures.length, 0);
  assert.equal(f.posts.length, 1);
  assert(f.posts[0].body.includes('The model returned only reasoning with no review text'));
  assert(!f.posts[0].body.includes('synthetic-private-reasoning'));
  safeDiagnostics(f);
});
test('non-PR invocation retains existing refusal without provider or GitHub operations', async () => {
  const f = fixture({ event: 'push' });
  await flush();
  assert.deepEqual(f.failures, ['This action only works on pull_request events.']);
  assert.equal(f.requests.length, 0);
  assert.equal(f.posts.length, 0);
  assert.equal(f.api.length, 0);
  safeDiagnostics(f);
});

test('legacy action ignores unsolicited base URL input and preserves the fixed endpoint', async () => {
  const f = fixture({
    inputs: {
      MINIMAX_BASE_URL: 'https://unsolicited.invalid/v1',
      MINIMAX_MODEL: 'caller-selected-model',
    },
  });
  await flush();
  assert.equal(f.failures.length, 0);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, 'https://api.minimaxi.chat/v1/chat/completions');
  assert.equal(JSON.parse(f.requests[0].init.body).model, 'caller-selected-model');
  assert(!f.inputReads.includes('MINIMAX_BASE_URL'));
  safeDiagnostics(f);
});
