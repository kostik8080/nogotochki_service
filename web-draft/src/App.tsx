// Каркас: шапка с навигацией по ролям, текущий пользователь и выбор страницы по hash-маршруту.
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, ROLE_LABELS, setStudioTimezone, type Studio, type User } from './api';
import { AdminPage } from './pages/Admin';
import { LoginPage } from './pages/Auth';
import { BookPage } from './pages/Book';
import { BookingPage } from './pages/Booking';
import { MasterSchedulePage } from './pages/MasterSchedule';
import { SlotsPage } from './pages/Slots';
import { AppContext, ErrorBox, go, useRoute } from './ui';

export function App() {
  const route = useRoute();
  const [user, setUser] = useState<User | null>(null);
  const [studio, setStudio] = useState<Studio | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<unknown>();

  const refreshUser = useCallback(async () => {
    try {
      const { user } = await api.get<{ user: User }>('/api/auth/me');
      setUser(user);
    } catch (e) {
      // Без входа /api/auth/me отвечает 401 — это не ошибка, а гость.
      if (e instanceof ApiError && e.status === 401) setUser(null);
      else setError(e);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const s = await api.get<Studio>('/api/studio');
        setStudioTimezone(s.timezone);
        setStudio(s);
      } catch (e) {
        setError(e);
      }
      await refreshUser();
      setReady(true);
    })();
  }, [refreshUser]);

  const logout = async () => {
    try {
      await api.post('/api/auth/logout');
    } catch (e) {
      setError(e);
    }
    setUser(null);
    go('/login');
  };

  const page = (() => {
    const p = route.path;
    // Каталог, регистрация и кабинет клиента заменены клиентским интерфейсом web/: здесь остались вход,
    // запись (ею пользуется администратор), карточка записи, раздел администратора и расписание мастера.
    if (p === '/' || p === '/login') return <LoginPage />;
    // key: при новых параметрах в адресе страница начинает с чистого состояния.
    if (p === '/slots') return <SlotsPage key={route.params.toString()} params={route.params} />;
    if (p === '/book') return <BookPage key={route.params.toString()} params={route.params} />;
    const m = /^\/bookings\/(\d+)$/.exec(p);
    if (m) return <BookingPage key={m[1]} id={Number(m[1])} />;
    if (p === '/admin') return <AdminPage tab={route.params.get('tab') ?? 'bookings'} />;
    if (p === '/master') return <MasterSchedulePage />;
    return <p>Страница не найдена. <a href="#/login">Ко входу</a></p>;
  })();

  return (
    <AppContext.Provider value={{ user, studio, refreshUser }}>
      <header>
        <b>Ноготочки · тест API</b>
        <nav>
          <a href="#/slots">Свободное время</a>
          {user?.role === 'admin' && <a href="#/admin">Администратор</a>}
          {user?.role === 'master' && <a href="#/master">Мое расписание</a>}
        </nav>
        <span className="who">
          {user ? (
            <>
              {user.name} ({ROLE_LABELS[user.role]}) <button type="button" onClick={logout}>Выйти</button>
            </>
          ) : (
            <>
              <a href="#/login">Вход</a>
            </>
          )}
        </span>
      </header>
      <main>
        {studio?.isMaintenance && <div className="warn">Студия в режиме технических работ: клиенты не могут записаться.</div>}
        <ErrorBox error={error} />
        {ready ? page : <p className="muted">Загрузка…</p>}
      </main>
    </AppContext.Provider>
  );
}
