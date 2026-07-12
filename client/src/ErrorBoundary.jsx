import { Component } from 'react';

// 任何元件崩潰時顯示可恢復的畫面，而不是整頁白屏
export default class ErrorBoundary extends Component {
  state = { err: null };
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) { console.error('App crash:', err, info); }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 20 }}>
        <div style={{ textAlign: 'center', maxWidth: 360 }}>
          <div style={{ fontSize: 40 }}>😵</div>
          <h3 style={{ margin: '10px 0' }}>畫面出了點問題</h3>
          <div className="muted" style={{ marginBottom: 6 }}>資料都在，重新整理就好</div>
          <div className="muted" style={{ fontSize: 11, wordBreak: 'break-all', marginBottom: 14 }}>{String(this.state.err?.message || this.state.err)}</div>
          <button className="btn" onClick={() => window.location.reload()}>重新整理</button>
        </div>
      </div>
    );
  }
}
