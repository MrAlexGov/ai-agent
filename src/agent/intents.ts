/**
 * Квалификация запроса: интенты, эскалация, извлечение контактов.
 * Всё на регулярках — предсказуемо, бесплатно и легко тестировать.
 */

export type Intent = 'greeting' | 'pricing' | 'faq' | 'lead' | 'escalation' | 'smalltalk';

const RE = {
  // Внимание: \b в JS не дружит с кириллицей, поэтому границы слов делаем вручную:
  // (?:^|[^а-яёa-z]) слева и (?![а-яё]) справа.
  greeting:
    /(?:^|[^а-яёa-z])(привет|здравствуй(?:те)?|добр(?:ый|ое)\s(?:день|вечер|утро)|хай|hello|hi)(?![а-яё])/i,

  pricing:
    /(цен[аыу]|сколько стоит|стоимость|прайс|тариф[а-я]*|расценк[а-я]*|почём|побольше деталей по прайсу)/i,

  lead:
    /(хочу (заказать|купить|записаться|оформить|купит)|заказать|остав(ить|ьте) заявку|запис(аться|ь на)|купить|приобрести|нужна консультация|нужен (расч|счёт|счет)|сотрудничеств|опт|прайс на опт)/i,

  escalation:
    /(менеджер|оператор|живой человек|позовите человека|поговорить с человеком|руководител|жалоб[а-я]*|претензи[а-я]*|обман|мошенник|верните деньги|возврат средств|разочарован|ужасно|отвратительно|суд|юрист|адвокат|никто не отвечает)/i,

  phone: /(\+?\d[\d\s\-()]{8,}\d)/,
  email: /([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i,
  tgHandle: /@[a-z_][a-z0-9_]{3,}/i,
};

export function detectIntent(text: string): Intent {
  if (RE.escalation.test(text)) return 'escalation';
  if (RE.lead.test(text)) return 'lead';
  if (RE.pricing.test(text)) return 'pricing';
  if (RE.greeting.test(text)) return 'greeting';
  return 'faq';
}

/** Вытащить контакт (телефон / email / @telegram) из текста. */
export function extractContact(text: string): string | null {
  const phone = RE.phone.exec(text)?.[0];
  if (phone) return normalizePhone(phone);
  const email = RE.email.exec(text)?.[0];
  if (email) return email.toLowerCase();
  const tg = RE.tgHandle.exec(text)?.[0];
  return tg ?? null;
}

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  return '+' + digits;
}

/** Похоже ли сообщение на контакт (для режима «ждём контакт»). */
export function looksLikeContact(text: string): boolean {
  return Boolean(RE.phone.test(text) || RE.email.test(text) || RE.tgHandle.test(text));
}

/** Защита от prompt-инъекций в LLM: обезличиваем служебные конструкции. */
export function sanitizeForPrompt(text: string): string {
  return text
    .replace(/```/g, "'''")
    .replace(/\b(system|assistant|developer)\s*:/gi, '›')
    .slice(0, 4000);
}
