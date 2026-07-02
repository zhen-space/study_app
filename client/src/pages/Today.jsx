import { useEffect, useState } from 'react';
import { api } from '../api';

export default function Today() {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [blocks, setBlocks] = useState([]);

  const load = () => api(`/blocks?from=${date}&to=${date}`).then(setBlocks);
  useEffect(() => { load(); }, [date]);

  async function toggle(b) {
    await api(`/blocks/${b.id}`, { method: 'PATCH', body: { completed: !b.completed } });
    load();
  }

  const done = blocks.filter(b => b.completed).length;

  return (
    <div className="page">
      <div className="row">
        <h2>每日待辦</h2>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} />
        {blocks.length > 0 && <span className="muted">{done}/{blocks.length} 完成</span>}
      </div>
      {blocks.length === 0 && <div className="card muted">這天沒有讀書安排。到「排程精靈」建立你的讀書計劃吧！</div>}
      {blocks.map(b => (
        <div key={b.id} className={'todo' + (b.completed ? ' done' : '')}>
          <input type="checkbox" checked={!!b.completed} onChange={() => toggle(b)} />
          <span className="tag" style={{ background: b.color }}>{b.subject_name}</span>
          <span className="todo-title">{b.range_title || '讀書'}</span>
          <span className="muted" style={{ marginLeft: 'auto' }}>{b.start_time}–{b.end_time}</span>
        </div>
      ))}
    </div>
  );
}
