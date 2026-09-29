// Роли пользователя из GET /api/auth/me и POST /api/auth/login — список `roles`.
// Интерфейс проверяет, есть ли в нем нужная роль, а не равна ли роль одному значению. Эта проверка только
// решает, что показать: доступ к данным и к разделу /admin закрывает сервер (server/src/api/guards.ts,
// server/src/web/admin-pages.ts). Роль назначается только в базе — в интерфейсе нет способа ее получить.

/**
 * @param {{ roles?: string[] } | null | undefined} user
 * @param {'client' | 'admin' | 'master'} role
 */
export const hasRole = (user, role) => Array.isArray(user?.roles) && user.roles.includes(role);
