import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import Auth from './pages/Auth';
import Shell from './tt/Shell';

function Main() {
  const nav = useNavigate();
  if (!localStorage.getItem('token')) return <Navigate to="/login" />;
  return <Shell onLogout={() => { localStorage.removeItem('token'); nav('/login'); }} />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Auth />} />
        <Route path="*" element={<Main />} />
      </Routes>
    </BrowserRouter>
  );
}
