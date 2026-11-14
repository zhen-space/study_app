import { useEffect, useRef, useState } from 'react';

// 375px 觸控長按拖曳的共用部分：任務清單與計畫明細都用同一套手勢與放置判定。
//
// 放置目標用 data-drop-date 標記：值是要移到的日期（'' 為無日期），PICK_DATE 代表
// 「其他日期…」——放下後由呼叫端開日期選擇器，不是直接寫入。

// 長按多久才進入拖曳：比一般點擊長、又不會久到讓人以為沒反應（iOS 約 0.5 秒）。
export const LONG_PRESS_MS = 450;
// 長按期間手指移動超過這個距離就視為捲動或左滑，取消拖曳。
export const LONG_PRESS_SLOP = 8;
export const PICK_DATE = '__pick__';

// 單純的長按（沒有左滑）：給計畫明細這類列使用。勾選框與按鈕上不啟動。
export function useLongPress(onLongPress) {
  const lp = useRef(null);
  useEffect(() => () => clearTimeout(lp.current?.timer), []);
  if (!onLongPress) return {};
  return {
    onTouchStart: e => {
      if (e.target.closest?.('input,button,select,textarea,a')) return;
      const p = e.touches[0];
      clearTimeout(lp.current?.timer);
      const l = { x: p.clientX, y: p.clientY };
      l.timer = setTimeout(() => { if (lp.current === l) { lp.current = null; onLongPress(); } }, LONG_PRESS_MS);
      lp.current = l;
    },
    onTouchMove: e => {
      const l = lp.current;
      if (!l) return;
      const p = e.touches[0];
      if (Math.hypot(p.clientX - l.x, p.clientY - l.y) > LONG_PRESS_SLOP) { clearTimeout(l.timer); lp.current = null; }
    },
    onTouchEnd: () => { clearTimeout(lp.current?.timer); lp.current = null; },
    onTouchCancel: () => { clearTimeout(lp.current?.timer); lp.current = null; },
    onContextMenu: e => e.preventDefault(),
    style: { WebkitTouchCallout: 'none', WebkitUserSelect: 'none', userSelect: 'none' },
  };
}

// 拖曳中的追蹤：手指移動時找出下方的放置分區，放開時交給 onDrop(item, target)。
// target 為 undefined 表示放在不能放的地方（不寫入）。
export function useTouchDrag(onDrop) {
  const [drag, setDrag] = useState(null); // { id, target }
  const ref = useRef(null);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  // 放下後列可能移到新分區（重新掛載），瀏覽器補的 click 落在新列上；短時間內忽略。
  const endedAt = useRef(0);
  const start = item => {
    try { navigator.vibrate?.(10); } catch { /* 部分瀏覽器不支援震動 */ }
    ref.current = { item, target: undefined };
    setDrag({ id: item.id, target: undefined });
  };
  const active = !!drag;
  useEffect(() => {
    if (!active) return undefined;
    const targetAt = (x, y) => {
      const el = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : null;
      const zone = el?.closest?.('[data-drop-date]');
      return zone ? zone.getAttribute('data-drop-date') : undefined;
    };
    // 拖曳中不讓頁面捲動；touchmove 需非 passive 才能 preventDefault。
    const onMove = e => {
      const cur = ref.current;
      if (!cur) return;
      if (e.cancelable) e.preventDefault();
      const p = e.touches?.[0];
      if (!p) return;
      const target = targetAt(p.clientX, p.clientY);
      if (target !== cur.target) {
        ref.current = { ...cur, target };
        setDrag({ id: cur.item.id, target });
      }
    };
    const onEnd = e => {
      const cur = ref.current;
      ref.current = null;
      endedAt.current = Date.now();
      setDrag(null);
      if (e.type === 'touchend' && cur && cur.target !== undefined) onDropRef.current(cur.item, cur.target);
    };
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
    document.addEventListener('touchcancel', onEnd);
    return () => {
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
    };
  }, [active]);
  return { drag, start, justEnded: () => Date.now() - endedAt.current < 600 };
}

// 拖曳時固定在底部的說明，兩個畫面共用同一句話。
export const DRAG_HINT = '拖到要移動的日期分區後放開';
export const dragHintStyle = {
  position: 'fixed', left: 16, right: 16, bottom: 'calc(env(safe-area-inset-bottom, 0px) + 84px)', zIndex: 30,
  padding: '10px 14px', borderRadius: 12, background: 'var(--surface-2)', boxShadow: '0 4px 16px rgba(0,0,0,.18)', textAlign: 'center',
};
// 放置分區在拖曳中的外框：手指下方那一區實線，其餘虛線。
export const dropZoneStyle = over => ({
  outline: over ? '2px solid var(--primary)' : '1px dashed var(--separator)', borderRadius: 10, minHeight: 44,
});
