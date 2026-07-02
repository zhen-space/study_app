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
  if (!res.ok) throw new Error(data.error || '發生錯誤');
  return data;
}
