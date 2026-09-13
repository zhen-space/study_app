import { useEffect, useState, useCallback } from 'react';
import { Button, SurfaceCard } from './ui';
import {
  isSupported, getPermissionState, requestPermission, listCalendars, permissionMessage,
  loadSelectedCalendarIds, saveSelectedCalendarIds, pruneSelectedCalendarIds,
} from './calendarBusy';

// Apple / 裝置行事曆設定卡。
//
// 這一版是純 JS glue：目前這個 repo 沒有原生層，所以 web/PWA 一律顯示「僅支援
// iPhone / iPad App」，不假裝連得上。真正能讀 EventKit 要等原生 wrapper（另一條線）。
//
// 權限狀態每次進設定都**重新讀一次**——之前授權過、後來在系統設定關掉的情況，
// 這裡要立刻反映成未授權，不能繼續顯示已授權。
// 選取的行事曆只存本機（calendar id 跨裝置無意義），永遠不送後端，也不碰事件內容。
export default function AppleCalendarCard() {
  const [state, setState] = useState('unsupported');
  const [calendars, setCalendars] = useState([]);
  const [selected, setSelected] = useState(() => loadSelectedCalendarIds());
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const st = await getPermissionState();
    setState(st);
    if (st === 'authorized') {
      const list = await listCalendars();
      setCalendars(list);
      // 已刪除的行事曆自動從選取中剔除
      setSelected(pruneSelectedCalendarIds(list));
    } else {
      setCalendars([]);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const ask = async () => {
    setBusy(true);
    try { await requestPermission(); await refresh(); } finally { setBusy(false); }
  };

  const toggle = id => {
    const next = selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id];
    setSelected(saveSelectedCalendarIds(next));
  };

  const supported = isSupported();

  return (
    <SurfaceCard>
      <div className="row" style={{ alignItems: 'center' }}>
        <div>
          <b>Apple 行事曆</b>
          <div className="ui-meta" style={{ marginTop: 2 }}>{permissionMessage(state)}</div>
        </div>
        {supported && state === 'not_determined' && (
          <Button size="sm" variant="primary" style={{ marginLeft: 'auto' }} disabled={busy} onClick={ask}>
            允許 Apple 行事曆存取
          </Button>
        )}
      </div>

      {!supported && (
        <div className="ui-meta" style={{ marginTop: 8 }}>
          在 iPhone / iPad App 上，可以把選定行事曆的忙碌時段納入排程；桌機瀏覽器與 Android 無法讀取裝置行事曆。
        </div>
      )}

      {supported && state === 'denied' && (
        <div className="ui-meta" style={{ marginTop: 8 }}>已拒絕存取。要納入排程的話，請到系統「設定 → 隱私權 → 行事曆」開啟本 App 的權限。</div>
      )}
      {supported && state === 'restricted' && (
        <div className="ui-meta" style={{ marginTop: 8 }}>此裝置的行事曆存取受到限制（例如螢幕使用時間／MDM），無法納入排程。</div>
      )}

      {supported && state === 'authorized' && (
        <div style={{ marginTop: 10 }}>
          <div className="ui-section-title">選擇要納入忙碌計算的行事曆</div>
          {calendars.length === 0 ? (
            <div className="ui-meta" style={{ marginTop: 6 }}>沒有可用的行事曆。</div>
          ) : (
            calendars.map(c => (
              <label key={c.id} className="row" style={{ gap: 8, marginTop: 6, cursor: 'pointer', alignItems: 'center' }}>
                <input type="checkbox" aria-label={c.title || c.id}
                  checked={selected.includes(c.id)} onChange={() => toggle(c.id)} />
                <span className="ui-row-main">{c.title || '（未命名行事曆）'}</span>
              </label>
            ))
          )}
          <div className="ui-meta" style={{ marginTop: 8 }}>
            只讀取忙碌時段（開始／結束時間），不會讀取或上傳事件標題、地點、與會者等內容。
          </div>
        </div>
      )}
    </SurfaceCard>
  );
}
