import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';

/**
 * RAG-lite: поиск по markdown-файлам базы знаний (knowledge/).
 * Без внешних API: чанкинг по заголовкам + скоринг по ключевым словам.
 * Апгрейд до векторного поиска описан в AGENTS.md, раздел «Апгрейды».
 */

export interface KbChunk {
  source: string; // имя файла, например faq.md
  heading: string; // заголовок раздела
  text: string; // текст фрагмента
}

export interface KbHit extends KbChunk {
  score: number;
}

interface CachedFile {
  mtimeMs: number;
  chunks: KbChunk[];
}

const cache = new Map<string, CachedFile>();

/** Загрузить все файлы knowledge/*.md, разбить на фрагменты по заголовкам. */
function loadChunks(): KbChunk[] {
  const chunks: KbChunk[] = [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(config.knowledgeDir).filter((f) => f.endsWith('.md'));
  } catch {
    return chunks;
  }

  for (const file of files) {
    const full = path.join(config.knowledgeDir, file);
    const stat = fs.statSync(full);
    const cached = cache.get(full);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      chunks.push(...cached.chunks);
      continue;
    }
    const raw = fs.readFileSync(full, 'utf-8');
    const fileChunks = splitIntoChunks(raw, file);
    cache.set(full, { mtimeMs: stat.mtimeMs, chunks: fileChunks });
    chunks.push(...fileChunks);
  }
  return chunks;
}

/** Разрез по заголовкам markdown (## или #); текст до первого заголовка — «Вступление». */
function splitIntoChunks(raw: string, file: string): KbChunk[] {
  const lines = raw.split(/\r?\n/);
  const out: KbChunk[] = [];
  let heading = 'Вступление';
  let buf: string[] = [];

  const push = () => {
    const text = buf.join('\n').trim();
    // HTML-комментарии-подсказки для владельца в поиск не отдаём
    const clean = text.replace(/<!--[\s\S]*?-->/g, '').trim();
    if (clean.length > 20) out.push({ source: file, heading, text: clean });
    buf = [];
  };

  for (const line of lines) {
    const m = /^(#{1,3})\s+(.+)$/.exec(line);
    if (m) {
      push();
      heading = m[2].trim();
    } else {
      buf.push(line);
    }
  }
  push();
  return out;
}

/** Простой токенизатор: буквы/цифры, слова длиннее 2 символов, в нижнем регистре. */
function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-zа-яё0-9]+/g) ?? []).filter((w) => w.length > 2);
}

/**
 * Поиск топ-N фрагментов по запросу.
 * Скоринг: +3 за слово в заголовке, +1 за каждое вхождение в текст (до 3).
 */
export function searchKb(query: string, topN = 3): KbHit[] {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];

  const hits: KbHit[] = [];
  for (const chunk of loadChunks()) {
    const headLower = chunk.heading.toLowerCase();
    const textLower = chunk.text.toLowerCase();
    let score = 0;
    for (const tok of qTokens) {
      if (headLower.includes(tok)) score += 3;
      const occurrences = textLower.split(tok).length - 1;
      if (occurrences > 0) score += Math.min(occurrences, 3);
    }
    if (score > 0) hits.push({ ...chunk, score });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, topN);
}

/** Кол-во файлов и фрагментов — для doctor-скрипта. */
export function kbStats(): { files: number; chunks: number } {
  const chunks = loadChunks();
  return { files: new Set(chunks.map((c) => c.source)).size, chunks: chunks.length };
}
