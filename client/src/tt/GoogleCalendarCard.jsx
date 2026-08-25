import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Button, SurfaceCard } from './ui';

// Google Calendar（唯讀）。
//
// 前端只做三件事：連結、看狀態、中斷。忙碌時段的判讀全部在伺服器，
// 這裡拿不到、也不需要拿到任何行事曆內容或 token。
//
// 講清楚「會拿什麼、不會拿什麼」是刻意的：我們只要「哪些時段是忙的」，
// 拿不到事件標題、地點或參與者。使用者要授權一個帳號給你，
// 至少該知道自己交出去的是什麼。
export default function GoogleCalendarCard() {
  const [status, setStatus] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(() => {
    api('/integrations/google-calendar/status')
      .then(s => { setStatus(s); setErr(''); })
      .catch(e => setErr(e.message || '讀不到連結狀態'));
  }, []);
  useEffect(() => { load(); }, [load]);

  // OAuth 走完會導回 /?go=settings&google=connected|failed
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const g = p.get('google');
    if (!g) return;
    setNotice(g === 'connected' ? '已連結 Google Calendar' : '連結沒有完成，請再試一次');
    window.history.replaceState({}, '', window.location.pathname);
    load();
  }, [load]);

  const connect = async () => {
    setBusy(true); setErr('');
    try {
      const { authorization_url } = await api('/integrations/google-calendar/connect', { method: 'POST' });
      window.location.href = authorization_url;   // 授權頁在 Google 那邊
    } catch (e) {
      setErr(e.message || '目前無法連結');
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true); setErr('');
    try {
      await api('/integrations/google-calendar', { method: 'DELETE' });
      setNotice('已中斷連結');
      load();
    } catch (e) { setErr(e.message || '中斷連結失敗'); }
    setBusy(false);
  };

  const md = iso => {
    if (!iso) return '還沒讀取過';
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  return (
    <SurfaceCard>
      <b>Google 日曆</b>
      <div className="ui-meta" style={{ marginTop: 'var(--sp-2)' }}>
        排程時會自動避開 Google Calendar 行程。只會讀「哪些時段是忙的」，
        讀不到行程名稱、地點或參與者，也不會在你的 Google 日曆上新增或修改任何東西。
      </div>

      {err && <div className="error" role="alert" style={{ marginTop: 'var(--sp-3)' }}>{err}</div>}
      {notice && <div className="ui-meta" role="status" style={{ marginTop: 'var(--sp-2)' }}>{notice}</div>}

      {!status ? (
        <div className="ui-meta" style={{ marginTop: 'var(--sp-3)' }}>載入中…</div>
      ) : status.configured === false ? (
        // 伺服器沒設好 Google 憑證時，給一顆按了會失敗的按鈕只是浪費使用者的時間
        <div className="ui-meta" style={{ marginTop: 'var(--sp-3)' }}>
          這個功能還沒在伺服器上啟用。
        </div>
      ) : status.connected ? (
        <>
          <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
            <span style={{ flex: 1 }}>已連結（主要日曆）</span>
            <span className="ui-meta">上次讀取 {md(status.last_success_at)}</span>
          </div>
          <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
            <Button size="sm" variant="tertiary" disabled={busy} onClick={disconnect}>
              {busy ? '處理中…' : '中斷連結'}
            </Button>
          </div>
        </>
      ) : (
        <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
          <Button size="sm" variant="primary" disabled={busy} onClick={connect}>
            {busy ? '前往 Google…' : '連結 Google 日曆'}
          </Button>
        </div>
      )}
    </SurfaceCard>
  );
}
