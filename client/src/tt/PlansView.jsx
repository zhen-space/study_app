import Icon from './Icons';
import { usePlans, md } from './plans';

// 「計畫」＝計畫管理：回答「我要完成什麼計畫」。
// 資料來源與推導邏輯在 ./plans.js（從既有 tasks 推導，沒有新後端）。

const Bar = ({ done, total, color }) => (
  <div style={{ height: 6, borderRadius: 3, background: 'var(--fill-strong)', overflow: 'hidden' }}>
    <div style={{ width: `${total ? Math.round(done / total * 100) : 0}%`, height: '100%', background: color, transition: 'width .3s' }} />
  </div>
);


export default function PlansView({ tasks, lists, openPlan, goWizard }) {
  const plans = usePlans(tasks, lists);

  return (
    <div className="main">
      <div className="main-head">
        <h2>計畫</h2>
        <span className="muted">{plans.length} 個計畫</span>
      </div>
      <div className="main-body">
        <button className="btn" style={{ width: '100%', padding: '11px 0', fontSize: 16 }} onClick={goWizard}>
          <Icon name="wizard" size={18} style={{ verticalAlign: '-3px', marginRight: 6 }} />安排新的讀書計畫
        </button>

        {plans.length === 0 && (
          <div className="muted" style={{ marginTop: 30, textAlign: 'center' }}>
            還沒有讀書計畫——用上面的排程精靈安排一份吧
          </div>
        )}

        {plans.map(p => (
          <div key={p.key} className="tile" style={{ marginTop: 10, padding: '12px 14px', cursor: 'pointer' }}
            onClick={() => openPlan(p.key)}>
            <div className="row">
              <Icon name={p.icon} size={18} style={{ color: p.color }} />
              <b style={{ fontSize: 16 }}>{p.name}</b>
              <span className="muted" style={{ marginLeft: 'auto', fontSize: 13 }}>{p.done}／{p.total}</span>
            </div>
            <div style={{ marginTop: 8 }}><Bar done={p.done} total={p.total} color={p.color} /></div>
            <div className="row" style={{ marginTop: 6, fontSize: 12 }}>
              <span className="muted">{md(p.start)}–{md(p.end)}</span>
              {p.overdue > 0 && <span style={{ color: 'var(--red)' }}>逾期 {p.overdue} 項</span>}
              <span className="muted" style={{ marginLeft: 'auto' }}>{p.books.slice(0, 3).join('、')}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
