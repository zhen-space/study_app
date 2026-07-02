import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';

export default function Auth() {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const nav = useNavigate();

  async function submit(e) {
    e.preventDefault();
    setErr('');
    try {
      const { token } = await api(`/auth/${mode}`, { method: 'POST', body: { email, password } });
      localStorage.setItem('token', token);
      nav('/');
    } catch (e) { setErr(e.message); }
  }

  return (
    <div className="auth-wrap">
      <form className="card auth-card" onSubmit={submit}>
        <h1>📚 讀書計劃</h1>
        <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} required />
        <input type="password" placeholder="密碼（至少 6 碼）" value={password} onChange={e => setPassword(e.target.value)} required />
        {err && <div className="error">{err}</div>}
        <button className="btn">{mode === 'login' ? '登入' : '註冊'}</button>
        <button type="button" className="btn ghost" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
          {mode === 'login' ? '沒有帳號？註冊' : '已有帳號？登入'}
        </button>
      </form>
    </div>
  );
}
