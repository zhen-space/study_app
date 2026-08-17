// Design System v1 的共用元件（UI-R1）。
//
// 之後所有頁面用這裡的 primitives，不要再各自拼
// .btn / .btn.sm ghost / .icon-btn / .cal-modal-back + .ev-sheet。
// 樣式一律走 src/index.css 的 token，元件本身不寫死顏色與尺寸。

/* ---------- Button ---------- */
// variant: primary（主要動作）｜secondary（次要）｜tertiary（純文字）｜destructive（破壞性）
export function Button({ variant = 'secondary', size = 'md', block = false, className = '', ...rest }) {
  const cls = ['ui-btn', `ui-btn--${variant}`, `ui-btn--${size}`, block ? 'ui-btn--block' : '', className]
    .filter(Boolean).join(' ');
  return <button className={cls} {...rest} />;
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

/* ---------- BottomSheet ---------- */
// 手機底部滑出、桌機置中；全 App 共用這一個，不要每個功能自己做一套。
// 保留 cal-modal-back / ev-sheet 兩個舊 class 當別名，還沒重做的頁面
// 與既有樣式才不會在這一批就斷掉（UI-R2～R5 會逐步移除）。
export function BottomSheet({ onClose, children, className = '', ...rest }) {
  return (
    <div className="sheet-backdrop cal-modal-back" onClick={onClose}>
      <div className={`sheet-panel ev-sheet ${className}`} onClick={e => e.stopPropagation()} {...rest}>
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
