import { useEffect, useState } from 'react';
import { api } from '../api';
import { Button, PageHeader, SurfaceCard, SegmentedControl, ListRow } from './ui';
import { THEMES, getTheme, setTheme } from './theme';
import { getNotifyPrefs, setNotifyPrefs, permissionState, requestPermission, NOTIFY_KINDS } from './notify';
import GoogleCalendarCard from './GoogleCalendarCard';

// 「設定」。在這頁出現以前，作息時間只能在排程精靈第 2 步裡改——想調睡覺時間
// 得先開一個計畫走到第二步。這裡只收跟「App 怎麼運作」有關的設定，
// 各個計畫自己的排程偏好仍留在該計畫裡，不搬過來。

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export default function SettingsView() {
  const [s, setS] = useState(null);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [theme, setThemeState] = useState(getTheme);
  const [notify, setNotify] = useState(getNotifyPrefs);
  const [perm, setPerm] = useState(permissionState);

  useEffect(() => { api('/settings').then(setS).catch(e => setErr(e.message)); }, []);

  const pickTheme = v => { setThemeState(v); setTheme(v); };

  const toggleNotify = kind => {
    const next = { ...notify, [kind]: !notify[kind] };
    setNotify(next); setNotifyPrefs(next);
  };
  const askPermission = async () => setPerm(await requestPermission());

  const save = async (patch) => {
    setBusy(true); setErr(''); setSaved('');
    try {
      const body = { sleep_start: s.sleep_start, sleep_end: s.sleep_end, meal_windows: s.meal_windows, ...patch };
      if (!HHMM.test(body.sleep_start) || !HHMM.test(body.sleep_end)) throw new Error('睡覺時間格式要像 23:00');
      for (const w of body.meal_windows) {
        if (!HHMM.test(w[0]) || !HHMM.test(w[1])) throw new Error('用餐時間格式要像 12:00');
      }
      await api('/settings', { method: 'PUT', body });
      setS(v => ({ ...v, ...body }));
      setSaved('已儲存');
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const setMeal = (i, j, v) =>
    setS(x => ({ ...x, meal_windows: x.meal_windows.map((w, k) => k === i ? w.map((t, m) => m === j ? v : t) : w) }));
  const addMeal = () => setS(x => ({ ...x, meal_windows: [...x.meal_windows, ['18:00', '18:30']] }));
  const delMeal = i => setS(x => ({ ...x, meal_windows: x.meal_windows.filter((_, k) => k !== i) }));

  // 排程與日期邊界一律用台灣時間（Asia/Taipei），這是後端的既定 contract，
  // 不是跟著裝置走——先前這裡寫「跟著裝置時區」是錯的，會讓人以為出國就會跟著變。
  // 順帶顯示裝置時區，兩者不同時使用者才知道為什麼日期看起來怪怪的。
  const deviceTz = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || '未知'; } catch { return '未知'; }
  })();
  const SCHEDULE_TZ = 'Asia/Taipei';

  return (
    <div className="main">
      <PageHeader title="設定" subtitle="外觀、作息、提醒" />
      <div className="main-body">
        {err && <SurfaceCard tone="warning" role="alert">{err}</SurfaceCard>}

        {/* ---------- 外觀 ---------- */}
        <section className="ui-section">
          <div className="ui-section-title">外觀</div>
          <SurfaceCard>
            <div className="ui-meta" style={{ marginBottom: 'var(--sp-3)' }}>深色模式</div>
            <SegmentedControl block ariaLabel="主題" value={theme} onChange={pickTheme}
              options={THEMES.map(([value, label]) => ({ value, label }))} />
            <div className="ui-meta" style={{ marginTop: 'var(--sp-3)' }}>
              「跟隨系統」會照裝置的深色模式設定切換。
            </div>
          </SurfaceCard>
        </section>

        {/* ---------- 提醒 ---------- */}
        <section className="ui-section">
          <div className="ui-section-title">提醒</div>
          <SurfaceCard>
            {perm === 'unsupported' ? (
              <div className="ui-meta">這個瀏覽器不支援通知。App 開著的時候仍會在畫面上提示。</div>
            ) : perm === 'denied' ? (
              <div className="ui-meta">
                通知被瀏覽器擋住了。要收到提醒的話，請到瀏覽器的網站設定裡把這個網站的通知改成允許。
              </div>
            ) : perm === 'default' ? (
              <div className="row">
                <span className="ui-meta" style={{ flex: 1 }}>還沒允許通知</span>
                <Button size="sm" variant="primary" onClick={askPermission}>開啟通知</Button>
              </div>
            ) : (
              <div className="ui-meta">已允許通知。</div>
            )}
            <div style={{ marginTop: 'var(--sp-3)' }}>
              {NOTIFY_KINDS.map(([kind, label, sub]) => (
                <label key={kind} className="ui-row" style={{ cursor: 'pointer' }}>
                  <div className="ui-row-main">
                    <div className="ui-row-title">{label}</div>
                    <div className="ui-row-sub">{sub}</div>
                  </div>
                  <input type="checkbox" checked={!!notify[kind]} aria-label={label}
                    onChange={() => toggleNotify(kind)} />
                </label>
              ))}
            </div>
            <div className="ui-meta" style={{ marginTop: 'var(--sp-2)' }}>
              提醒只在 App 開著的時候送出。關掉分頁就不會再提醒。
            </div>
          </SurfaceCard>
        </section>

        {/* ---------- 作息 ---------- */}
        <section className="ui-section">
          <div className="ui-section-title">平常作息</div>
          <div className="ui-meta" style={{ marginBottom: 'var(--sp-2)' }}>
            排程會避開這些時段，不把讀書排進去。
          </div>
          {!s ? <SurfaceCard><div className="ui-meta">載入中…</div></SurfaceCard> : (
            <SurfaceCard>
              <div className="row" style={{ alignItems: 'center' }}>
                <span style={{ flex: 1 }}>睡覺</span>
                <input type="time" aria-label="睡覺開始" value={s.sleep_start}
                  onChange={e => setS(v => ({ ...v, sleep_start: e.target.value }))} />
                <span>–</span>
                <input type="time" aria-label="睡覺結束" value={s.sleep_end}
                  onChange={e => setS(v => ({ ...v, sleep_end: e.target.value }))} />
              </div>
              <div className="ui-meta" style={{ marginTop: 'var(--sp-4)', marginBottom: 'var(--sp-2)' }}>用餐</div>
              {s.meal_windows.map((w, i) => (
                <div className="row" key={i} style={{ marginTop: 'var(--sp-2)', alignItems: 'center' }}>
                  <input type="time" aria-label={`第 ${i + 1} 餐開始`} value={w[0]} onChange={e => setMeal(i, 0, e.target.value)} />
                  <span>–</span>
                  <input type="time" aria-label={`第 ${i + 1} 餐結束`} value={w[1]} onChange={e => setMeal(i, 1, e.target.value)} />
                  <Button size="sm" variant="tertiary" style={{ marginLeft: 'auto' }}
                    onClick={() => delMeal(i)}>移除</Button>
                </div>
              ))}
              <Button size="sm" style={{ marginTop: 'var(--sp-3)' }} onClick={addMeal}>＋ 加一段用餐時間</Button>
              <div className="row" style={{ marginTop: 'var(--sp-4)' }}>
                {saved && <span className="ui-meta">{saved}</span>}
                <Button variant="primary" style={{ marginLeft: 'auto' }} disabled={busy}
                  onClick={() => save({})}>{busy ? '儲存中…' : '儲存作息'}</Button>
              </div>
            </SurfaceCard>
          )}
        </section>

        {/* ---------- 連結 ---------- */}
        <section className="ui-section">
          <div className="ui-section-title">連結</div>
          <GoogleCalendarCard />
        </section>

        {/* ---------- 這台裝置 ---------- */}
        <section className="ui-section">
          <div className="ui-section-title">這台裝置</div>
          <SurfaceCard>
            <ListRow title="排程時區" subtitle="日期與排程一律以台灣時間計算"
              trailing={<span className="ui-meta">{SCHEDULE_TZ}</span>} />
            {deviceTz !== SCHEDULE_TZ && (
              <ListRow title="這台裝置的時區" subtitle="與排程時區不同，畫面上的時間可能跟你的當地時間有落差"
                trailing={<span className="ui-meta">{deviceTz}</span>} />
            )}
            <ListRow title="版本" trailing={<span className="ui-meta">{window.APP_VER || '—'}</span>} />
          </SurfaceCard>
        </section>
      </div>
    </div>
  );
}
