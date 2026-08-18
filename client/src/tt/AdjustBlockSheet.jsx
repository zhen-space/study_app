import { useEffect, useState } from 'react';
import { api } from '../api';
import Icon from './Icons';
import { shortTitle, md } from './plans';
import { conflictText } from './scheduleAdjust';
import { BottomSheet, Button, SurfaceCard } from './ui';

// 「調整這一項」：使用者自己把 AI 排出來的一段挪到別的日子／時段。
//
// 邊界（跟 ReplanSheet 同一套精神）：
//   ・按下「儲存新安排」之前不寫入任何東西
//   ・寫入一律走 POST /schedule/manual，前端不直接改 due_date
//     （2C 起 ScheduledBlock 才是時間的唯一真相，due_date 只是鏡射）
//   ・放不下就是放不下：這裡沒有「還是要放」的按鈕。
//     使用者要的話得先去改期限、刪固定行程或解除鎖定。
//   ・衝突原因照後端回的講，不自己在前端重算一套可行性
//
// 邊改邊問（dry run）：日期／時間一停下來就先問後端一次，讓使用者在按下去
// 之前就知道放不放得下。dry run 通過不代表儲存一定會成功——中間可能有別的
// 變更，所以儲存時後端會在同一筆交易裡再算一次。

const HM = t => (t || '').slice(0, 5);

export default function AdjustBlockSheet({ block, task, lists = [], versionId, reload, onClose }) {
  const [date, setDate] = useState(block.date);
  const [timed, setTimed] = useState(!!block.start_time);
  const [start, setStart] = useState(HM(block.start_time) || '19:00');
  const [end, setEnd] = useState(HM(block.end_time) || '20:00');
  const [conflicts, setConflicts] = useState([]);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const subject = lists.find(l => String(l.id) === String(task?.list_id));
  const changed = date !== block.date
    || timed !== !!block.start_time
    || (timed && (start !== HM(block.start_time) || end !== HM(block.end_time)));

  const move = () => ({
    block_id: block.id, date,
    ...(timed ? { start_time: start, end_time: end } : {}),
  });

  // 停下來 400ms 才問，不要每按一下鍵盤就打一次後端
  useEffect(() => {
    if (!changed) { setConflicts([]); setErr(''); return undefined; }
    let alive = true;
    setChecking(true);
    const timer = setTimeout(async () => {
      try {
        const r = await api('/schedule/manual', {
          method: 'POST',
          body: { base_version_id: versionId, moves: [move()], dry_run: true },
        });
        if (alive) { setConflicts(r.conflicts || []); setErr(''); }
      } catch (e) {
        // 格式還沒填完整（例如結束早於開始）也會落到這裡，直接照後端的話講
        if (alive) { setConflicts([]); setErr(e.message); }
      } finally {
        if (alive) setChecking(false);
      }
    }, 400);
    return () => { alive = false; clearTimeout(timer); };
  }, [date, timed, start, end, changed, versionId]);

  async function save() {
    setSaving(true); setErr('');
    try {
      await api('/schedule/manual', {
        method: 'POST',
        body: { base_version_id: versionId, moves: [move()] },
      });
    } catch (e) {
      setConflicts(e.conflicts || []);
      setErr(e.conflicts?.length ? '' : e.message);
      setSaving(false);
      return;
    }
    await reload();
    onClose();
  }
  async function startStudy() {
    setSaving(true); setErr('');
    try {
      await api('/study-sessions', { method: 'POST', body: { task_id: task.id, scheduled_block_id: block.id, source: 'scheduled_block' } });
      onClose();
    } catch (e) { setErr(e.message); setSaving(false); }
  }

  const blocked = conflicts.length > 0 || !!err;

  return (
    <BottomSheet onClose={onClose} label="調整這一項">
      <div className="row">
        <b>調整這一項</b>
        <button className="icon-btn" style={{ marginLeft: 'auto' }} aria-label="關閉" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>

      <div style={{ marginTop: 'var(--sp-3)', fontWeight: 600 }}>{shortTitle(task?.title || '')}</div>
      <div className="ui-meta">
        {/* 全 App 的日期都用 md（8/18），這裡不要突然冒出 ISO 格式 */}
        {subject?.name || '讀書'}・目前排在 {md(block.date)}
        {block.start_time ? ` ${HM(block.start_time)}–${HM(block.end_time)}` : ''}
      </div>

      <div className="sheet-sec" style={{ marginTop: 'var(--sp-4)' }}>換到哪一天</div>
      <input type="date" value={date} aria-label="日期" onChange={e => setDate(e.target.value)} />

      <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
        <label className="row" style={{ gap: 'var(--sp-2)' }}>
          <input type="checkbox" checked={timed} onChange={e => setTimed(e.target.checked)} />
          <span>指定時段</span>
        </label>
      </div>
      {timed && (
        <div className="row" style={{ marginTop: 'var(--sp-2)' }}>
          <input type="time" value={start} aria-label="開始時間" onChange={e => setStart(e.target.value)} />
          <span className="ui-meta">至</span>
          <input type="time" value={end} aria-label="結束時間" onChange={e => setEnd(e.target.value)} />
        </div>
      )}

      {/* 放不下的原因照後端回的講。這裡刻意不提供「還是要放」——
          讓使用者繞過去，等於讓 App 產生一份它自己知道做不到的計畫。 */}
      {blocked && (
        <SurfaceCard tone="warning" style={{ marginTop: 'var(--sp-4)' }}>
          <b style={{ color: 'var(--warning)' }}>這個時間放不下</b>
          {conflicts.map((c, i) => (
            <div key={i} className="ui-meta" style={{ marginTop: 2 }}>・{conflictText(c)}</div>
          ))}
          {err && <div className="ui-meta" style={{ marginTop: 2 }}>・{err}</div>}
        </SurfaceCard>
      )}

      <div className="ui-meta" style={{ marginTop: 'var(--sp-3)' }}>
        按下「儲存新安排」之前，原本的安排不會有任何改變
      </div>

      <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
        <Button variant="secondary" disabled={saving} onClick={startStudy}>開始讀書</Button>
        <Button variant="primary" style={{ marginLeft: 'auto' }}
          disabled={saving || checking || blocked || !changed} onClick={save}>
          {saving ? '儲存中…' : checking ? '確認中…' : '儲存新安排'}
        </Button>
      </div>
    </BottomSheet>
  );
}
