export async function api(path, opts = {}) {
  const token = localStorage.getItem('token');
  const res = await fetch('/api' + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    localStorage.removeItem('token');
    window.location.href = '/login';
    throw new Error('未登入');
  }
  const data = await res.json();
  if (!res.ok) {
    // 後端在 409 之類的情況會一起回 conflicts（例如手動調整放不下的原因）。
    // 只留 message 的話，畫面就只能說「失敗」，說不出到底哪裡卡住。
    const err = new Error(data.error || '發生錯誤');
    err.status = res.status;
    err.payload = data;
    if (data.conflicts) err.conflicts = data.conflicts;
    throw err;
  }
  return data;
}
