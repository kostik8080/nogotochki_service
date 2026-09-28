// Индикатор шагов записи: элемент <booking-steps current="services|master|time|confirm">.
// Как в прототипе: «Услуги → Мастер → Время → Подтверждение», текущий шаг — акцентом, пройденные —
// ссылками (лист «Навигация» карты связей, N-15…N-18), будущие — приглушены и не нажимаются.
// Если мастер закреплен заранее («Записаться к мастеру»), шаг «Мастер» пропускается и ссылкой не бывает.
import { routes } from './routes.js';
import { getDraft } from './store.js';

const STEPS = [
  { key: 'services', label: 'Услуги', href: routes.booking() },
  { key: 'master', label: 'Мастер', href: 'booking-master.html' },
  { key: 'time', label: 'Время', href: 'booking-time.html' },
  { key: 'confirm', label: 'Подтверждение', href: 'booking-confirm.html' },
];

class BookingSteps extends HTMLElement {
  connectedCallback() {
    const current = STEPS.findIndex((s) => s.key === this.getAttribute('current'));
    const locked = getDraft().lockedMasterId !== null;
    const items = STEPS.map((step, i) => {
      let body;
      if (i === current) body = `<span class="steps__item steps__item--current" aria-current="step">${step.label}</span>`;
      else if (i < current && !(step.key === 'master' && locked)) body = `<a class="steps__item steps__item--done" href="${step.href}">${step.label}</a>`;
      else body = `<span class="steps__item steps__item--todo">${step.label}</span>`;
      return `<li>${body}</li>`;
    });
    this.innerHTML = `
      <nav aria-label="Шаги записи">
        <ol class="steps">${items.join('<li class="steps__arrow" aria-hidden="true">→</li>')}</ol>
      </nav>`;
  }
}

customElements.define('booking-steps', BookingSteps);
