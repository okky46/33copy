// POST /api/analyze { url, titleOverride?, artistOverride? }
// YouTubeリンク → 動画情報取得 → 曲名推定 → 外部コード譜検索 → 初期コード進行生成
//
// 品質ルール: 外部コード譜が見つからなければ progression は空で返す。
// 曲と無関係な定番進行 (カノン進行など) の仮置きは行わない。
// 検索の動作確認のため、クエリ・候補URL・採否理由などのデバッグ情報を必ず返す。

import { NextRequest, NextResponse } from "next/server";
import { extractVideoId, fetchVideoInfo } from "@/lib/youtube";
import { buildQueries, guessSong } from "@/lib/titleParse";
import { collectSources } from "@/lib/chordSources/providers";
import { buildConsensus } from "@/lib/chordSources/consensus";
import type { AnalyzeDebug, AnalyzeResult, SongGuess } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let body: { url?: string; titleOverride?: string; artistOverride?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 });
  }

  const videoId = extractVideoId(body.url ?? "");
  if (!videoId) {
    return NextResponse.json(
      { error: "YouTubeのURLとして認識できませんでした" },
      { status: 400 }
    );
  }

  // 1. 動画情報
  const video = await fetchVideoInfo(videoId);
  const videoTitle = video.title || `YouTube動画 (${videoId})`;

  // 2. 曲名・アーティスト名推定 (ユーザーによる手動指定があれば最優先)
  let songGuess: SongGuess;
  if (body.titleOverride?.trim()) {
    const title = body.titleOverride.trim();
    const artist = body.artistOverride?.trim() ?? "";
    songGuess = { title, artist, confidence: 1, queries: buildQueries(title, artist) };
  } else {
    songGuess = guessSong(videoTitle, video.channelName);
  }

  // 3. 外部コード譜の収集 (直接検索 + Web検索 + スコアリング)
  const debug: AnalyzeDebug = {
    songTitle: songGuess.title,
    artist: songGuess.artist,
    queries: songGuess.queries,
    searches: [],
    candidates: [],
    fetched: [],
    adopted: [],
    keyCorrections: [],
    elapsedMs: 0,
  };
  const searchStart = Date.now();
  const sources = songGuess.title
    ? await collectSources(songGuess, debug).catch(() => [])
    : [];
  debug.elapsedMs = Date.now() - searchStart;

  // 4. 複数ソース照合 (移調・カポ補正込み) → 初期進行
  let progression = buildConsensus(sources, debug);
  const found = progression.length >= 4;
  if (!found) progression = [];

  const disputedCount = progression.filter((p) => p.disputed).length;
  const message = found
    ? `外部コード譜 ${sources.length} 件を参照して初期コード進行を生成しました` +
      (disputedCount > 0 ? `（ソース間不一致: ${disputedCount}コードは要確認）。` : "。")
    : "外部コード譜が見つかりませんでした。曲名・アーティスト名を修正して再検索するか、音源ファイルをアップロードして解析してください。";

  const result: AnalyzeResult = {
    videoId,
    videoTitle,
    channelName: video.channelName,
    duration: video.duration,
    songGuess,
    found,
    progression,
    sources: sources.map((s) => ({
      provider: s.provider,
      url: s.url,
      pageTitle: s.pageTitle,
      chordCount: s.chords.length,
    })),
    message,
    debug,
  };

  return NextResponse.json(result);
}
