// Выпадающий список по кнопке: меню аккаунта, меню гостя, уведомления в шапке (js/header.js, js/notifications.js).

/**
 * Список [data-dropdown-list] открывается и закрывается кнопкой [data-dropdown-toggle], закрывается кликом мимо
 * и клавишей Escape.
 * @param {HTMLElement} root блок, внутри которого кнопка и список
 * @returns {AbortController} снимает слушатели документа
 */
export function bindDropdown(root) {
  const toggle = /** @type {HTMLButtonElement} */ (root.querySelector('[data-dropdown-toggle]'));
  const list = /** @type {HTMLElement} */ (root.querySelector('[data-dropdown-list]'));

  // Слушатели документа снимаются, когда блок перерисовывают (например, после выхода)
  const listeners = new AbortController();
  const setOpen = (open) => {
    list.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.addEventListener('click', () => setOpen(list.hidden));
  document.addEventListener('click', (event) => {
    if (!root.isConnected) return listeners.abort();
    // Кнопка внутри списка могла убрать сама себя (закрытое уведомление): такой клик — не «мимо»
    const target = /** @type {Node} */ (event.target);
    if (!list.hidden && target.isConnected && !root.contains(target)) setOpen(false);
  }, { signal: listeners.signal });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !list.hidden) {
      setOpen(false);
      toggle.focus();
    }
  }, { signal: listeners.signal });
  return listeners;
}
