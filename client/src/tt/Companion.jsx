import { useEffect, useRef, useState } from 'react';
import PetSprite, { MONSTERS } from './PetSprite';
import { today } from './helpers';

const QUOTES = [
  '讀書不是為了考試，是為了以後有更多選擇！',
  '每天進步 1%，一年後就是 37 倍的自己 💪',
  '先開始 5 分鐘，剩下的交給慣性。',
  '休息是為了走更長遠的路，但別休息太久喔 😆',
  '現在流的汗，是為了以後少流淚。',
  '不會的題目就是升級的經驗值！',
  '專注 25 分鐘，比分心 2 小時有用。',
  '今天的你，要比昨天的你厲害一點點。',
  '背不起來很正常，多看三遍就是你的了。',
  '累的時候，想想當初為什麼開始。',
  '慢慢來，比較快。',
  '你不需要很厲害才開始，要開始才會很厲害！',
];

export default function Companion({ pet, tasks }) {
  const [x, setX] = useState(30);
  const [dir, setDir] = useState(1);
  const [msg, setMsg] = useState(null);
  const [jump, setJump] = useState(false);
  const timers = useRef([]);

  const size = 68;

  // 走動：每 4~7 秒換一個位置
  useEffect(() => {
    let alive = true;
    function wander() {
      if (!alive) return;
      const max = Math.min(window.innerWidth, 500) - size - 12;
      const nx = 8 + Math.random() * max;
      setDir(cur => (nx > x ? 1 : -1));
      setX(nx);
      timers.current.push(setTimeout(wander, 4000 + Math.random() * 3000));
    }
    timers.current.push(setTimeout(wander, 2000));
    return () => { alive = false; timers.current.forEach(clearTimeout); timers.current = []; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 說話：每 18~30 秒隨機講一句（提醒優先）
  useEffect(() => {
    const iv = setInterval(() => {
      setMsg(pickMessage());
      setTimeout(() => setMsg(null), 5000);
    }, 18000 + Math.random() * 12000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  function pickMessage() {
    const td = today();
    const remain = (tasks || []).filter(t => !t.completed && t.due_date === td);
    const overdue = (tasks || []).filter(t => !t.completed && t.due_date && t.due_date < td);
    const pool = [];
    if (overdue.length) pool.push(`有 ${overdue.length} 項任務逾期了，要不要補一下？`);
    if (remain.length) pool.push(`今天還有 ${remain.length} 項任務，加油！`, `下一個是「${remain[0].title}」，衝吧！`);
    if (!remain.length && !overdue.length) pool.push('今天的任務都完成了，你超棒！🎉');
    // 提醒與金句混合，提醒機率較高
    if (pool.length && Math.random() < 0.6) return pool[Math.floor(Math.random() * pool.length)];
    return QUOTES[Math.floor(Math.random() * QUOTES.length)];
  }

  function poke() {
    setJump(true);
    setTimeout(() => setJump(false), 600);
    setMsg(pickMessage());
    setTimeout(() => setMsg(null), 5000);
  }

  if (!pet?.type || !MONSTERS[pet.type]) return null;

  return (
    <div style={{
      position: 'fixed', bottom: 'calc(64px + env(safe-area-inset-bottom))', left: 0, right: 0,
      height: size, pointerEvents: 'none', zIndex: 14,
    }}>
      <div onClick={poke} style={{
        position: 'absolute', left: 0, bottom: 0, width: size,
        transform: `translateX(${x}px)`,
        transition: 'transform 3.5s ease-in-out',
        pointerEvents: 'auto', cursor: 'pointer',
      }}>
        {msg && (
          <div style={{
            position: 'absolute', bottom: size + 4, left: '50%',
            transform: `translateX(${x > 200 ? '-80%' : '-20%'})`,
            background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12,
            padding: '8px 12px', fontSize: 13, width: 'max-content', maxWidth: 220,
            boxShadow: '0 4px 14px rgba(0,0,0,.15)', lineHeight: 1.5,
          }}>{msg}</div>
        )}
        <div className={jump ? 'pet-jumping' : ''} style={{ transform: `scaleX(${dir})` }}>
          <PetSprite type={pet.type} equipped={pet.equipped || []} size={size} walking />
        </div>
      </div>
    </div>
  );
}
