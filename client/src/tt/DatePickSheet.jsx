import { useState } from 'react';
import { BottomSheet, Button } from './ui';
import { today } from './helpers';

// 拖曳到「其他日期…」後的日期選擇：畫面上沒有那一天的分區時，用這裡指定任意日期。
// 只回傳選好的日期，寫入仍由呼叫端走各自的 domain（一般任務 PATCH／計畫任務 ScheduleVersion）。
export default function DatePickSheet({ title, initial = '', onPick, onClose }) {
  const [date, setDate] = useState(initial && initial >= today() ? initial : '');
  return (
    <BottomSheet onClose={onClose} label="移到其他日期">
      <b>移到其他日期</b>
      <div className="ui-meta" style={{ marginTop: 'var(--sp-1)' }}>{title}</div>
      <label className="sheet-sec" htmlFor="date-pick-input" style={{ display: 'block', marginTop: 'var(--sp-4)' }}>日期</label>
      <input id="date-pick-input" type="date" min={today()} value={date} onChange={e => setDate(e.target.value)} />
      <div className="row" style={{ marginTop: 'var(--sp-4)', gap: 'var(--sp-2)' }}>
        <Button variant="tertiary" onClick={onClose}>取消</Button>
        <Button variant="primary" style={{ marginLeft: 'auto' }} disabled={!date || date < today()}
          onClick={() => onPick(date)}>移到這一天</Button>
      </div>
    </BottomSheet>
  );
}
