// Страница 1: вход и регистрация (POST /api/auth/login, POST /api/auth/register).
// Регистрация по номеру, который уже есть в карточке клиента (сценарий 16), отвечает 202 —
// тогда появляется поле для кода, и форма отправляется еще раз вместе с ним.
import { useState, type FormEvent } from 'react';
import { api, type User } from '../api';
import { ErrorBox, go, useAction, useApp } from '../ui';

const homeOf = (user: User) => (user.role === 'admin' ? '/admin' : user.role === 'master' ? '/master' : '/cabinet');

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  return mode === 'login' ? <LoginForm /> : <RegisterForm />;
}

function LoginForm() {
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
      <p>Нет аккаунта? <a href="#/register">Регистрация</a></p>
    </section>
  );
}

interface CodeRequired {
  status: 'phone_verification_required';
  delivery: 'email' | 'studio';
  message: string;
}

function RegisterForm() {
  const { refreshUser } = useApp();
  const [form, setForm] = useState({ name: '', phone: '', email: '', password: '', pdConsent: false, marketingConsent: false });
  const [code, setCode] = useState('');
  const [codeRequired, setCodeRequired] = useState<CodeRequired | null>(null);
  const [linked, setLinked] = useState(false);
  const action = useAction();
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = {
      name: form.name,
      password: form.password,
      pdConsent: form.pdConsent,
      marketingConsent: form.marketingConsent,
    };
    if (form.phone.trim()) body.phone = form.phone.trim();
    if (form.email.trim()) body.email = form.email.trim();
    if (codeRequired && code.trim()) body.code = code.trim();
    const res = await action.run(() => api.post<{ user?: User; linkedExistingClient?: boolean } | CodeRequired>('/api/auth/register', body));
    if (!res) return;
    if ('status' in res && res.status === 'phone_verification_required') {
      setCodeRequired(res);
      return;
    }
    if ('user' in res && res.user) {
      setLinked(Boolean(res.linkedExistingClient));
      await refreshUser();
      go('/cabinet');
    }
  };

  return (
    <section>
      <h1>Регистрация клиента</h1>
      <form onSubmit={submit}>
        <label>Имя <input value={form.name} onChange={(e) => set({ name: e.target.value })} /></label>
        <label>Телефон <input value={form.phone} onChange={(e) => set({ phone: e.target.value })} placeholder="+7 900 123-45-67" /></label>
        <label>E-mail <input value={form.email} onChange={(e) => set({ email: e.target.value })} /></label>
        <p className="muted small">Нужен телефон или e-mail (или оба).</p>
        <label>Пароль (8–128 символов) <input type="password" value={form.password} onChange={(e) => set({ password: e.target.value })} autoComplete="new-password" /></label>
        <label><input type="checkbox" checked={form.pdConsent} onChange={(e) => set({ pdConsent: e.target.checked })} /> Согласен на обработку персональных данных</label>
        <label><input type="checkbox" checked={form.marketingConsent} onChange={(e) => set({ marketingConsent: e.target.checked })} /> Получать новости студии</label>
        {codeRequired && (
          <div className="warn">
            <p>{codeRequired.message}</p>
            <label>Код из 6 цифр <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" /></label>
          </div>
        )}
        <button disabled={action.busy}>{codeRequired ? 'Подтвердить код и зарегистрироваться' : 'Зарегистрироваться'}</button>
      </form>
      <ErrorBox error={action.error} />
      {linked && <div className="ok">Номер подтвержден: прежние записи студии добавлены в кабинет.</div>}
      <p>Уже есть аккаунт? <a href="#/login">Вход</a></p>
    </section>
  );
}
