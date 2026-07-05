import { useEffect, useRef, useState } from 'react';
import PetSprite, { MONSTERS } from './PetSprite';
import { today } from './helpers';

export default function Companion({ pet, tasks }) {
  const m = MONSTERS[pet?.type];
  const [x, setX] = useState(30);
  const [dir, setDir] = useState(1);
  const [msg, setMsg] = useState(null);
  const [jump, setJump] = useState(false);
  const timers = useRef([]);
  const xRef = useRef(30);

  const size = m?.walk.size || 64;
  const moveDur = m?.walk.moveDur || 3;

  // 走動節奏依個性：皮皮竄來竄去、藍牙慢吞吞
  useEffect(() => {
    if (!m) return;
    let alive = true;
    const [gMin, gMax] = m.walk.gap;
    function wander() {
      if (!alive) return;
      const max = Math.min(window.innerWidth, 500) - size - 12;
      const nx = 8 + Math.random() * max;
      setDir(nx > xRef.current ? 1 : -1);
      xRef.current = nx;
      setX(nx);
      timers.current.push(setTimeout(wander, gMin + Math.random() * (gMax - gMin)));
    }
    timers.current.push(setTimeout(wander, 1500));
    return () => { alive = false; timers.current.forEach(clearTimeout); timers.current = []; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pet?.type]);

  useEffect(() => {
    if (!m) return;
    const iv = setInterval(() => {
      setMsg(pickMessage());
      setTimeout(() => setMsg(null), 5200);
    }, 16000 + Math.random() * 12000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, pet?.type]);

  function pickMessage() {
    const v = m.voice;
    const td = today();
    const remain = (tasks || []).filter(t => !t.completed && t.due_date === td);
    const overdue = (tasks || []).filter(t => !t.completed && t.due_date && t.due_date < td);
    const pool = [];
    if (overdue.length) pool.push(v.overdue(overdue.length));
    if (remain.length) pool.push(v.remain(remain.length), v.next(remain[0].title));
    if (!remain.length && !overdue.length) pool.push(v.done);
    if (pool.length && Math.random() < 0.6) return pool[Math.floor(Math.random() * pool.length)];
    return v.quotes[Math.floor(Math.random() * v.quotes.length)];
  }

  function poke() {
    setJump(true);
    setTimeout(() => setJump(false), 600);
    setMsg(pickMessage());
    setTimeout(() => setMsg(null), 5200);
  }

  if (!m) return null;

  return (
    <div style={{
      position: 'fixed', bottom: 'calc(64px + env(safe-area-inset-bottom))', left: 0, right: 0,
      height: size, pointerEvents: 'none', zIndex: 14,
    }}>
      <div onClick={poke} style={{
        position: 'absolute', left: 0, bottom: 0, width: size,
        transform: `translateX(${x}px)`,
        transition: `transform ${moveDur}s ease-in-out`,
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
