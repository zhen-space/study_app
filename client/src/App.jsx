import { BrowserRouter, Routes, Route, NavLink, Navigate, useNavigate } from 'react-router-dom';
import Auth from './pages/Auth';
import Today from './pages/Today';
import Calendar from './pages/Calendar';
import Wizard from './pages/Wizard';
import Stats from './pages/Stats';

function Layout({ children }) {
  const nav = useNavigate();
  if (!localStorage.getItem('token')) return <Navigate to="/login" />;
  return (
    <>
      <nav className="nav">
        <b>📚 讀書計劃</b>
        <NavLink to="/">今日待辦</NavLink>
        <NavLink to="/wizard">排程精靈</NavLink>
        <NavLink to="/calendar">固定行程</NavLink>
        <NavLink to="/stats">統計</NavLink>
        <span className="spacer" />
        <button className="btn sm ghost" onClick={() => { localStorage.removeItem('token'); nav('/login'); }}>登出</button>
      </nav>
      {children}
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Auth />} />
        <Route path="/" element={<Layout><Today /></Layout>} />
        <Route path="/wizard" element={<Layout><Wizard /></Layout>} />
        <Route path="/calendar" element={<Layout><Calendar /></Layout>} />
        <Route path="/stats" element={<Layout><Stats /></Layout>} />
      </Routes>
    </BrowserRouter>
  );
}
