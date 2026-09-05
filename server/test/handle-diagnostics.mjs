// 僅供 CI 使用的 open-handle 診斷。只記錄資源類型與測試內的不透明 id；
// 不記錄 URL、header、body、credential、token、資料庫 row 或應用資料。
const enabled = process.env.CI_HANDLE_DIAGNOSTICS === '1';

const liveChildren = new Map();
const liveDbClients = new Map();
const liveFetches = new Map();
let nextServerId = 1;
let nextDbId = 1;
let nextFetchId = 1;

const write = (event, detail = {}) => {
  if (!enabled) return;
  console.error(`[ci-handle-diag] ${JSON.stringify({ event, ...detail })}`);
};

const countBy = values => values.reduce((counts, value) => {
  counts[value] = (counts[value] || 0) + 1;
  return counts;
}, {});

const classify = type => {
  if (/ChildProcess|ProcessWrap/i.test(type)) return 'child_process';
  if (/TCP|Socket|TLS|HTTP|ConnectWrap/i.test(type)) return 'socket_tcp';
  if (/Timeout|Immediate|Timer/i.test(type)) return 'timer';
  return 'other';
};

export const allocateServerId = () => `server-${nextServerId++}`;

export const trackChild = (id, child, verbose = false) => {
  liveChildren.set(id, { child, verbose });
  if (verbose) write('server_started', { id, pid: child.pid });
  child.once('exit', (code, signal) => {
    if (verbose) write('child_exit', { id, pid: child.pid, code, signal });
  });
  child.once('close', (code, signal) => {
    if (verbose) write('child_close', { id, pid: child.pid, code, signal });
    liveChildren.delete(id);
  });
};

export const logStopStarted = (id, child, verbose = false) => {
  if (verbose) write('stop_started', { id, pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode });
};

export const logStopCompleted = (id, child, verbose = false) => {
  if (verbose) write('stop_completed', { id, pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode });
};

export const trackDbClient = (verbose = false) => {
  const id = `db-${nextDbId++}`;
  liveDbClients.set(id, { verbose });
  if (verbose) write('db_client_opened', { id });
  return id;
};

export const untrackDbClient = id => {
  const entry = liveDbClients.get(id);
  liveDbClients.delete(id);
  if (entry?.verbose) write('db_client_closed', { id });
};

export const diagnosticFetch = async (...args) => {
  const id = `fetch-${nextFetchId++}`;
  liveFetches.set(id, true);
  try {
    return await fetch(...args);
  } finally {
    liveFetches.delete(id);
  }
};

export const logActiveResources = label => {
  if (!enabled) return;
  const resources = typeof process.getActiveResourcesInfo === 'function'
    ? process.getActiveResourcesInfo()
    : [];
  const resourceTypes = countBy(resources);
  const categories = countBy(resources.map(classify));
  // Node 通常只把 fetch / libsql 的底層資源顯示為 socket 或 timer，
  // 所以另外明確追蹤仍在執行中的 fetch 與尚未關閉的 client。
  write('active_resources', {
    label,
    resourceTypes,
    categories,
    tracked: {
      child_process: [...liveChildren.entries()].map(([id, { child }]) => ({
        id, pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode,
      })),
      undici_fetch: [...liveFetches.keys()],
      libsql_db_client: [...liveDbClients.keys()],
    },
  });
};

if (enabled) {
  const interval = setInterval(() => logActiveResources('periodic'), 60_000);
  interval.unref();
}
