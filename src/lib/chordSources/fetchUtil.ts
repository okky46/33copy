// 外部サイト取得の共通ユーティリティ (タイムアウト・UA付きfetch)

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface FetchDiag {
  ok: boolean;
  status?: number;
  error?: string;
  bytes?: number;
  /** 応答本文にCAPTCHA・アクセス拒否らしき語が含まれるか (簡易ヒューリスティック) */
  blockedLike?: boolean;
}

const BLOCK_HINT_RE =
  /unusual traffic|captcha|are you a human|automated queries|access denied|blocked|お手数ですが|アクセスが集中|認証にご協力/i;

/**
 * URLを取得する。診断が必要な呼び出し元は diagOut に結果を書き込ませることで、
 * ステータスコード・エラー内容・応答サイズ・CAPTCHA疑いを検索デバッグ表示に反映できる。
 */
export async function fetchText(
  url: string,
  timeoutMs = 8000,
  diagOut?: FetchDiag,
  attempt = 0
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": UA,
        "accept-language": "ja,en;q=0.8",
        accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
    });
    if (!res.ok) {
      // 一時的な失敗 (429/5xx) は1回だけ間隔を空けてリトライする
      if ((res.status === 429 || res.status >= 500) && attempt === 0) {
        await new Promise((r) => setTimeout(r, 500));
        return fetchText(url, timeoutMs, diagOut, attempt + 1);
      }
      if (diagOut) {
        diagOut.ok = false;
        diagOut.status = res.status;
        diagOut.error = `HTTP ${res.status}`;
      }
      return null;
    }
    const text = await res.text();
    if (diagOut) {
      diagOut.ok = true;
      diagOut.status = res.status;
      diagOut.bytes = text.length;
      diagOut.blockedLike = BLOCK_HINT_RE.test(text.slice(0, 4000));
    }
    return text;
  } catch (e) {
    if (attempt === 0) {
      await new Promise((r) => setTimeout(r, 400));
      return fetchText(url, timeoutMs, diagOut, attempt + 1);
    }
    if (diagOut) {
      diagOut.ok = false;
      diagOut.error = e instanceof Error ? e.message : "fetch failed";
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson<T>(url: string, timeoutMs = 8000): Promise<T | null> {
  const text = await fetchText(url, timeoutMs);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** HTMLエンティティの簡易デコード */
export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}
