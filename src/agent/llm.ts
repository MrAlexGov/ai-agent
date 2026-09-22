import { config } from '../config';
import { sanitizeForPrompt } from './intents';

/**
 * Опциональный LLM через любой OpenAI-совместимый API (OpenAI, OpenRouter,
 * Ollama, GLM и т.д.). Если ключ не задан — мозг работает по правилам (brain.ts).
 * Любая ошибка/таймаут -> исключение, вызывающий код фолбэкается на шаблоны.
 */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export function llmEnabled(): boolean {
  return config.llm.apiKey.length > 0;
}

export async function llmChat(messages: LlmMessage[], timeoutMs = 30_000): Promise<string> {
  if (!llmEnabled()) throw new Error('LLM не настроен (LLM_API_KEY в .env)');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.llm.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.llm.apiKey}`,
      },
      body: JSON.stringify({
        model: config.llm.model,
        temperature: 0.4,
        max_tokens: 700,
        messages,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`LLM API ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('LLM вернул пустой ответ');
    return sanitizeForPrompt(content);
  } finally {
    clearTimeout(timer);
  }
}
