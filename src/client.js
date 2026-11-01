/**
 * 云端 bridge 的 HTTP 客户端（协议 §1）。
 * 三条端点：heartbeat / poll（长轮询）/ result；result 投递失败按指数退避重试，
 * 用同一个 id 重投——服务端按 id 去重，所以重试永远是安全的。
 */
import {
  POLL_WAIT_MAX,
  POLL_WAIT_MIN,
  POLL_WAIT_SECONDS,
  RESULT_RETRY_ATTEMPTS,
  RESULT_RETRY_BASE_MS,
  RESULT_RETRY_MAX_MS,
} from './policy.js';

export class BridgeError extends Error {
  constructor(message, { status = null, retryable = true } = {}) {
    super(message);
    this.name = 'BridgeError';
    this.status = status;
    this.retryable = retryable;
  }
}

/** waitSeconds 夹在 1..30（协议 §1）。 */
export function clampWaitSeconds(value, fallback = POLL_WAIT_SECONDS) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return Math.min(Math.max(Math.trunc(fallback), POLL_WAIT_MIN), POLL_WAIT_MAX);
  }
  return Math.min(Math.max(Math.trunc(number), POLL_WAIT_MIN), POLL_WAIT_MAX);
}

/** 4xx（429/408 除外）重试也没用，别把 token 错误重投八次。 */
function isRetryableStatus(status) {
  if (status === 408 || status === 429) return true;
  return status >= 500;
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class PcBridgeClient {
  #baseUrl;
  #token;
  #fetch;
  #log;
  #sleep;

  constructor({ baseUrl, token, fetchImpl = null, log = {}, sleep = realSleep } = {}) {
    if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
      throw new TypeError('pc-agent: baseUrl is required');
    }
    if (typeof token !== 'string' || token === '') {
      throw new TypeError('pc-agent: token is required');
    }
    this.#baseUrl = baseUrl.trim().replace(/\/+$/, '');
    this.#token = token;
    this.#fetch = fetchImpl ?? globalThis.fetch;
    this.#log = log;
    this.#sleep = sleep;
  }

  get baseUrl() {
    return this.#baseUrl;
  }

  async #request(pathname, { method = 'POST', body, signal, timeoutMs } = {}) {
    const url = `${this.#baseUrl}${pathname}`;
    const signals = [];
    if (signal !== undefined && signal !== null) signals.push(signal);
    if (timeoutMs !== undefined) signals.push(AbortSignal.timeout(timeoutMs));

    let response;
    try {
      response = await this.#fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.#token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signals.length === 0 ? {} : { signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) }),
      });
    } catch (error) {
      throw new BridgeError(`${method} ${pathname} 失败：${error?.message ?? String(error)}`, { retryable: true });
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new BridgeError(
        `${method} ${pathname} 回了 HTTP ${response.status}${detail === '' ? '' : `：${detail.slice(0, 200)}`}`,
        { status: response.status, retryable: isRetryableStatus(response.status) },
      );
    }

    try {
      return await response.json();
    } catch (error) {
      throw new BridgeError(`${method} ${pathname} 的响应不是 JSON：${error?.message ?? String(error)}`, {
        retryable: true,
      });
    }
  }

  /** 报到。心跳 10s 一次，与 poll 互不阻塞。 */
  async heartbeat(body, { signal, timeoutMs = 10_000 } = {}) {
    return await this.#request('/node/pc/heartbeat', { body, signal, timeoutMs });
  }

  /** 长轮询取一条命令；没有命令时服务端回 command: null。 */
  async poll({ agentId, waitSeconds, signal } = {}) {
    const wait = clampWaitSeconds(waitSeconds);
    return await this.#request('/node/pc/poll', {
      body: { agentId, waitSeconds: wait },
      signal,
      timeoutMs: wait * 1000 + 10_000,
    });
  }

  /** 投一次结果。 */
  async submitResult(body, { signal, timeoutMs = 10_000 } = {}) {
    return await this.#request('/node/pc/result', { body, signal, timeoutMs });
  }

  /**
   * 投结果直到成功：指数退避（500ms→…→30s 封顶），共 attempts 次。
   * body 原样重发，id 不变，服务端去重。
   */
  async deliverResult(body, { attempts = RESULT_RETRY_ATTEMPTS, baseDelayMs = RESULT_RETRY_BASE_MS, maxDelayMs = RESULT_RETRY_MAX_MS, signal } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const reply = await this.submitResult(body, { signal });
        if (reply?.accepted === false) {
          this.#log?.info?.('result already accepted (duplicate id)', { id: body?.id });
        }
        return reply;
      } catch (error) {
        lastError = error;
        if (error?.retryable === false) break;
        if (attempt === attempts - 1) break;
        const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
        this.#log?.warn?.('result delivery failed, retrying', {
          id: body?.id,
          attempt: attempt + 1,
          retryInMs: delay,
          error: error?.message ?? String(error),
        });
        await this.#sleep(delay);
      }
    }
    throw lastError ?? new BridgeError('result delivery failed', { retryable: false });
  }
}
