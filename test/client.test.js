/**
 * HTTP 客户端的用例：三个端点的请求体形状（协议 §1）、waitSeconds 夹取、
 * 以及结果投递失败时的指数退避重试（同一个 id 重投，服务端按 id 去重）。
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { BridgeError, PcBridgeClient, clampWaitSeconds } from '../src/client.js';
import { makeTempDir, removeTempDir } from './helpers/tmp.js';

const created = [];
after(() => {
  for (const dir of created) removeTempDir(dir);
});
void makeTempDir;

const TOKEN = 'test-token-1234567890';
const BASE = 'http://127.0.0.1:18787';

function okJson(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function recordingFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: init?.body === undefined ? undefined : JSON.parse(init.body) });
    return handler(calls.length, calls[calls.length - 1]);
  };
  return { impl, calls };
}

describe('client · heartbeat', () => {
  it('POST /node/pc/heartbeat，带 Bearer 与自述体', async () => {
    const { impl, calls } = recordingFetch(() => okJson({ ok: true, now: 1, serverVersion: '0.1.0' }));
    const client = new PcBridgeClient({ baseUrl: BASE, token: TOKEN, fetchImpl: impl });
    const body = {
      agentId: 'pc-host',
      hostname: 'host',
      platform: 'win32',
      version: '1.0.0',
      capabilities: { exec: true, read: true, write: true },
      policy: { roots: ['C:\\Users\\x\\Documents'], execAllow: ['dir'] },
    };
    const reply = await client.heartbeat(body);
    assert.equal(reply.ok, true);

    assert.equal(calls[0].url, `${BASE}/node/pc/heartbeat`);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(calls[0].init.headers['content-type'], 'application/json');
    assert.deepEqual(calls[0].body, body);
  });

  it('HTTP 4xx 抛 BridgeError 且不可重试', async () => {
    const { impl } = recordingFetch(() => okJson({ ok: false, error: 'unauthorized' }, 401));
    const client = new PcBridgeClient({ baseUrl: BASE, token: TOKEN, fetchImpl: impl });
    await assert.rejects(
      () => client.heartbeat({ agentId: 'a' }),
      (error) => {
        assert.ok(error instanceof BridgeError);
        assert.equal(error.status, 401);
        assert.equal(error.retryable, false);
        return true;
      },
    );
  });

  it('响应不是 JSON 也算失败', async () => {
    const client = new PcBridgeClient({
      baseUrl: BASE,
      token: TOKEN,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad'); } }),
    });
    await assert.rejects(() => client.heartbeat({}), /不是 JSON/);
  });
});

describe('client · poll', () => {
  it('请求体是 {agentId, waitSeconds}', async () => {
    const { impl, calls } = recordingFetch(() => okJson({ ok: true, command: null }));
    const client = new PcBridgeClient({ baseUrl: BASE, token: TOKEN, fetchImpl: impl });
    const reply = await client.poll({ agentId: 'pc-host', waitSeconds: 25 });
    assert.equal(reply.command, null);
    assert.equal(calls[0].url, `${BASE}/node/pc/poll`);
    assert.deepEqual(calls[0].body, { agentId: 'pc-host', waitSeconds: 25 });
  });

  it('waitSeconds 夹在 1..30', async () => {
    assert.equal(clampWaitSeconds(99), 30);
    assert.equal(clampWaitSeconds(0), 1);
    assert.equal(clampWaitSeconds(-5), 1);
    assert.equal(clampWaitSeconds(undefined), 25);
    assert.equal(clampWaitSeconds('abc'), 25);
    assert.equal(clampWaitSeconds(7.9), 7);

    const { impl, calls } = recordingFetch(() => okJson({ ok: true, command: null }));
    const client = new PcBridgeClient({ baseUrl: BASE, token: TOKEN, fetchImpl: impl });
    await client.poll({ agentId: 'a', waitSeconds: 999 });
    assert.equal(calls[0].body.waitSeconds, 30);
  });

  it('拿到的 command 原样返回', async () => {
    const command = { id: 'c1', kind: 'exec', deadlineAt: 123, payload: { command: 'dir /b' } };
    const { impl } = recordingFetch(() => okJson({ ok: true, command }));
    const client = new PcBridgeClient({ baseUrl: BASE, token: TOKEN, fetchImpl: impl });
    const reply = await client.poll({ agentId: 'a' });
    assert.deepEqual(reply.command, command);
  });
});

describe('client · result', () => {
  const resultBody = {
    id: 'c1',
    ok: true,
    exitCode: 0,
    stdout: 'a.txt\n',
    stderr: '',
    truncated: false,
    bytes: 6,
    durationMs: 12,
    error: null,
    errorCode: null,
  };

  it('POST /node/pc/result，结果体原样送出', async () => {
    const { impl, calls } = recordingFetch(() => okJson({ ok: true, accepted: true }));
    const client = new PcBridgeClient({ baseUrl: BASE, token: TOKEN, fetchImpl: impl });
    const reply = await client.deliverResult(resultBody);
    assert.equal(reply.accepted, true);
    assert.equal(calls[0].url, `${BASE}/node/pc/result`);
    assert.deepEqual(calls[0].body, resultBody);
  });

  it('服务端说 accepted:false（重复 id）不算失败', async () => {
    const { impl } = recordingFetch(() => okJson({ ok: true, accepted: false }));
    const client = new PcBridgeClient({ baseUrl: BASE, token: TOKEN, fetchImpl: impl });
    const reply = await client.deliverResult(resultBody);
    assert.equal(reply.accepted, false);
  });

  it('投递失败按指数退避重试，且始终用同一个 id', async () => {
    const { impl, calls } = recordingFetch((index) => {
      if (index < 3) throw new Error('ECONNREFUSED');
      return okJson({ ok: true, accepted: true });
    });
    const sleeps = [];
    const client = new PcBridgeClient({
      baseUrl: BASE,
      token: TOKEN,
      fetchImpl: impl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const reply = await client.deliverResult(resultBody);
    assert.equal(reply.accepted, true);
    assert.equal(calls.length, 3);
    assert.deepEqual(sleeps, [500, 1000]);
    assert.equal(new Set(calls.map((call) => call.body.id)).size, 1);
    assert.deepEqual(calls[2].body, resultBody);
  });

  it('退避有上限，重试用完就抛', async () => {
    const { impl, calls } = recordingFetch(() => {
      throw new Error('boom');
    });
    const sleeps = [];
    const client = new PcBridgeClient({
      baseUrl: BASE,
      token: TOKEN,
      fetchImpl: impl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await assert.rejects(() => client.deliverResult(resultBody, { attempts: 4, maxDelayMs: 1200 }), /boom/);
    assert.equal(calls.length, 4);
    assert.deepEqual(sleeps, [500, 1000, 1200]);
  });

  it('4xx 不重试，一次就放弃', async () => {
    const { impl, calls } = recordingFetch(() => okJson({ ok: false }, 400));
    const client = new PcBridgeClient({ baseUrl: BASE, token: TOKEN, fetchImpl: impl, sleep: async () => {} });
    await assert.rejects(() => client.deliverResult(resultBody), /HTTP 400/);
    assert.equal(calls.length, 1);
  });

  it('5xx 与 429 会重试', async () => {
    for (const status of [500, 503, 429]) {
      const { impl, calls } = recordingFetch((index) => (index === 1 ? okJson({ ok: false }, status) : okJson({ ok: true, accepted: true })));
      const client = new PcBridgeClient({ baseUrl: BASE, token: TOKEN, fetchImpl: impl, sleep: async () => {} });
      const reply = await client.deliverResult(resultBody);
      assert.equal(reply.accepted, true);
      assert.equal(calls.length, 2, String(status));
    }
  });
});

describe('client · 构造', () => {
  it('baseUrl 去掉尾部斜杠', () => {
    const client = new PcBridgeClient({ baseUrl: 'http://127.0.0.1:18787/', token: TOKEN, fetchImpl: async () => okJson({}) });
    assert.equal(client.baseUrl, 'http://127.0.0.1:18787');
  });

  it('缺少 baseUrl / token 直接抛', () => {
    assert.throws(() => new PcBridgeClient({ token: TOKEN }), /baseUrl/);
    assert.throws(() => new PcBridgeClient({ baseUrl: BASE }), /token/);
  });
});
