// Страница 1: вход (POST /api/auth/login). Регистрация клиента — в клиентском интерфейсе web/register.html.
import { useState, type FormEvent } from 'react';
import { api, type User } from '../api';
import { ErrorBox, go, useAction, useApp } from '../ui';

const homeOf = (user: User) => (user.role === 'admin' ? '/admin' : user.role === 'master' ? '/master' : '/slots');

export function LoginPage() {
  const { refreshUser } = useApp();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const action = useAction();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const res = await action.run(() => api.post<{ user: User }>('/api/auth/login', { login, password }));
    if (res) {
      await refreshUser();
      go(homeOf(res.user));
    }
  };

  return (
    <section>
      <h1>Вход</h1>
      <p className="muted">Один вход для всех ролей: клиент, администратор, мастер.</p>
      <form onSubmit={submit}>
        <label>Телефон или e-mail <input value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" /></label>
        <label>Пароль <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label>
        <button disabled={action.busy}>Войти</button>
      </form>
      <ErrorBox error={action.error} />
    </section>
  );
}
