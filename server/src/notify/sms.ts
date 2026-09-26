// Отправка SMS с одноразовыми кодами. SMS-шлюз еще не выбран (паспорт: «пока SMS-шлюз не подключен»),
// поэтому настоящей отправки нет: в production без шлюза действия, которым нужен код по SMS,
// отвечают 503, а при разработке код печатается в консоль.
export interface SmsSender {
  send(phone: string, text: string): Promise<void>;
}

export class ConsoleSms implements SmsSender {
  async send(phone: string, text: string): Promise<void> {
    console.log(`\n[SMS] ${phone}: ${text}\n`);
  }
}

export class MemorySms implements SmsSender {
  readonly sent: { phone: string; text: string }[] = [];
  async send(phone: string, text: string): Promise<void> {
    this.sent.push({ phone, text });
  }
}
