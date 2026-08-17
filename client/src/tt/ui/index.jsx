import { useEffect, useRef } from 'react';

// Design System v1 的共用元件（UI-R1）。
//
// 之後所有頁面用這裡的 primitives，不要再各自拼
// .btn / .btn.sm ghost / .icon-btn / .cal-modal-back + .ev-sheet。
// 樣式一律走 src/index.css 的 token，元件本身不寫死顏色與尺寸。
//
// 只抽 Today／Shell 真的共用得到的部分——不為了湊成 component library
// 而過度抽象，用不到的變體等真的有第二個呼叫端再加。

/* ---------- Button ---------- */
// variant: primary（主要動作）｜secondary（次要）｜tertiary（純文字）｜destructive（破壞性）
export function Button({ variant = 'secondary', size = 'md', block = false, className = '', ...rest }) {
  const cls = ['ui-btn', `ui-btn--${variant}`, `ui-btn--${size}`, block ? 'ui-btn--block' : '', className]
    .filter(Boolean).join(' ');
  return <button className={cls} {...rest} />;
}

/* ---------- IconButton ---------- */
// 只有圖示的按鈕一定要有 label：螢幕閱讀器看不到 svg 在畫什麼。
// 觸控目標由 CSS 保證 44px，視覺大小另外由 icon 決定。
export function IconButton({ label, className = '', children, ...rest }) {
  return (
    <button type="button" className={`ui-iconbtn ${className}`} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}

/* ---------- PageHeader ---------- */
// 大標題區：標題 ＋ 日期副標 ＋ 右側最多一兩個動作。
export function PageHeader({ title, subtitle, actions = null, meta = null }) {
  return (
    <div className="main-head">
      <div className="page-head-text">
        <h2>{title}</h2>
        {subtitle && <div className="head-sub">{subtitle}</div>}
      </div>
      {meta}
      {actions && <div className="row" style={{ marginLeft: 'auto', gap: 'var(--sp-1)' }}>{actions}</div>}
    </div>
  );
}

/* ---------- SurfaceCard ---------- */
// tone: surface（一般卡片）｜accent（AI／建議）｜warning（可能排不下）｜plain（不畫底）
export function SurfaceCard({ tone = 'surface', large = false, className = '', ...rest }) {
  const cls = ['ui-card', tone === 'surface' ? '' : `ui-card--${tone}`, large ? 'ui-card--lg' : '', className]
    .filter(Boolean).join(' ');
  return <div className={cls} {...rest} />;
}

/* ---------- Section ---------- */
export function Section({ title, action = null, children }) {
  return (
    <section className="ui-section">
      {(title || action) && (
        <div className="row" style={{ marginBottom: 'var(--sp-3)' }}>
          {title && <div className="ui-section-title" style={{ marginBottom: 0 }}>{title}</div>}
          {action && <span style={{ marginLeft: 'auto' }}>{action}</span>}
        </div>
      )}
      {children}
    </section>
  );
}

/* ---------- ProgressBar ---------- */
// 進度同時用寬度與文字表示，不只靠顏色。
export function ProgressBar({ value, max, label }) {
  const pct = max ? Math.round(value / max * 100) : 0;
  return (
    <div className="today-progress" role="progressbar"
      aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} aria-label={label}>
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

/* ---------- ListRow ---------- */
// 一行內容：左邊 leading（勾選框／圓點）、中間標題＋副標、右邊 trailing。
// Today 的待辦與時間軸共用同一種節奏，不要每一項都變成一張大卡片。
export function ListRow({ leading = null, title, subtitle = null, trailing = null, muted = false, ...rest }) {
  return (
    <div className={'ui-row' + (muted ? ' ui-row--muted' : '')} {...rest}>
      {leading != null && <div className="ui-row-lead">{leading}</div>}
      <div className="ui-row-main">
        <div className="ui-row-title">{title}</div>
        {subtitle && <div className="ui-row-sub">{subtitle}</div>}
      </div>
      {trailing != null && <div className="ui-row-trail">{trailing}</div>}
    </div>
  );
}

/* ---------- BottomSheet ---------- */
// 手機底部滑出、桌機置中；全 App 共用這一個，不要每個功能自己做一套。
// 保留 cal-modal-back / ev-sheet 兩個舊 class 當別名，還沒重做的頁面
// 與既有樣式才不會在這一批就斷掉（UI-R2～R5 會逐步移除）。
//
// 鍵盤行為：Escape 關閉、開啟時焦點移進面板、關閉後焦點還給原本的元素。
export function BottomSheet({ onClose, children, label = '', className = '', ...rest }) {
  const panel = useRef(null);
  useEffect(() => {
    const prev = document.activeElement;
    panel.current?.focus();
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); } };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (prev && typeof prev.focus === 'function') prev.focus();
    };
  }, [onClose]);

  return (
    <div className="sheet-backdrop cal-modal-back" onClick={onClose}>
      <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={label || undefined}
        className={`sheet-panel ev-sheet ${className}`} onClick={e => e.stopPropagation()} {...rest}>
        <div className="sheet-handle" />
        {children}
      </div>
    </div>
  );
}

/* ---------- SegmentedControl ---------- */
// options: [{ value, label }]。純粹切換檢視，不代表資料變更。
export function SegmentedControl({ value, onChange, options, block = false, ariaLabel }) {
  return (
    <div className={'ui-seg' + (block ? ' ui-seg--block' : '')} role="tablist" aria-label={ariaLabel}>
      {options.map(o => (
        <button key={o.value} role="tab" aria-selected={value === o.value}
          className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- EmptyState ---------- */
export function EmptyState({ title, description, action = null }) {
  return (
    <div className="ui-empty">
      <b>{title}</b>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}
