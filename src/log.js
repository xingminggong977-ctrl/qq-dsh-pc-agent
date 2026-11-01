/**
 * JSON-lines 日志，token 必须打码。pc-agent 常年在后台跑，日志是唯一现场。
 */
export function createLogger({ secrets = [], write, now = () => Date.now(), level = 'info' } = {}) {
  const hidden = secrets.filter((secret) => typeof secret === 'string' && secret.length > 0);
  const sink = write ?? ((line) => process.stdout.write(`${line}\n`));
  const order = { debug: 10, info: 20, warn: 30, error: 40 };
  const floor = order[level] ?? 20;

  function redact(input) {
    let out = String(input);
    for (const secret of hidden) out = out.split(secret).join('***');
    return out
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***')
      .replace(/("token"\s*:\s*")[^"]*(")/gi, '$1***$2');
  }

  function emit(levelName, msg, fields) {
    if ((order[levelName] ?? 20) < floor) return;
    const record = { ts: new Date(now()).toISOString(), level: levelName, msg: String(msg) };
    if (fields && typeof fields === 'object') {
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        record[key] = value;
      }
    }
    let line;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ ts: record.ts, level: levelName, msg: record.msg });
    }
    sink(redact(line));
  }

  return {
    redact,
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  };
}
