import { useEffect, useRef, useState } from 'react';
import PetSprite, { MONSTERS } from './PetSprite';
import { today, onActivePlan } from './helpers';

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
  // Shell-level 安全區（Phase 1 O）：角色的活動範圍 = 內容安全區 − 底部導航 − 右下 Global Add。
  // 右側保留一欄給 Global Add FAB，角色不會走到 ＋ 底下；容器底部抬到底部導航之上，
  // 角色與說話泡泡都不會被 Bottom Nav 切掉。
  const FAB_RESERVE = 76;

  // 走動節奏依個性：皮皮竄來竄去、藍牙慢吞吞
  useEffect(() => {
    if (!m) return;
    let alive = true;
    const [gMin, gMax] = m.walk.gap;
    function wander() {
      if (!alive) return;
      const max = Math.max(40, Math.min(window.innerWidth, 500) - size - 12 - FAB_RESERVE);
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
    const remain = (tasks || []).filter(t => !t.completed && onActivePlan(t) && t.due_date === td);
    const overdue = (tasks || []).filter(t => !t.completed && onActivePlan(t) && t.due_date && t.due_date < td);
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

  // 說話泡泡：以角色為中心，但夾在視窗內，避免靠邊時被螢幕左／右緣切掉（配合 §O 安全區）。
  // 泡泡放在「不會跟著位移動畫飄」的外層容器（容器左緣貼齊視窗左緣），直接用視窗座標定位；
  // 若掛在角色內層，位移中的 translateX 動畫會讓泡泡短暫偏出畫面。角色左緣視窗座標即為 x。
  const BUBBLE_W = 220;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 375;
  const bubbleLeft = Math.max(8, Math.min(x + size / 2 - BUBBLE_W / 2, vw - 8 - BUBBLE_W));

  return (
    <div style={{
      position: 'fixed', bottom: 'calc(92px + env(safe-area-inset-bottom))',
      left: 0, right: `calc(${FAB_RESERVE}px + env(safe-area-inset-right))`,
      height: size, pointerEvents: 'none', zIndex: 14,
    }}>
      {msg && (
        <div style={{
          position: 'absolute', bottom: size + 4, left: bubbleLeft,
          background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12,
          padding: '8px 12px', fontSize: 13, width: 'max-content', maxWidth: BUBBLE_W,
          boxShadow: '0 4px 14px rgba(0,0,0,.15)', lineHeight: 1.5,
        }}>{msg}</div>
      )}
      <div onClick={poke} style={{
        position: 'absolute', left: 0, bottom: 0, width: size,
        transform: `translateX(${x}px)`,
        transition: `transform ${moveDur}s ease-in-out`,
        pointerEvents: 'auto', cursor: 'pointer',
      }}>
        <div className={jump ? 'pet-jumping' : ''} style={{ transform: `scaleX(${dir})` }}>
          <PetSprite type={pet.type} equipped={pet.equipped || []} size={size} walking />
        </div>
      </div>
    </div>
  );
}
