// POST /api/analyze { url }
// YouTubeリンク → 動画情報取得 → 曲名推定 → 外部コード譜検索 → 初期コード進行生成

import { NextRequest, NextResponse } from "next/server";
import { extractVideoId, fetchVideoInfo } from "@/lib/youtube";
import { guessSong } from "@/lib/titleParse";
import { searchChordWiki, searchWeb } from "@/lib/chordSources/providers";
import { buildConsensus } from "@/lib/chordSources/consensus";
import { buildFallbackProgression } from "@/lib/chordSources/fallback";
import type { AnalyzeResult, ExternalSourceResult } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let body: { url?: string };
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

  // 2. 曲名・アーティスト名推定
  const songGuess = guessSong(videoTitle, video.channelName);

  // 3. 外部コード譜検索 (ChordWiki直接 + Web検索経由、並列・ベストエフォート)
  let sources: ExternalSourceResult[] = [];
  if (songGuess.title) {
    const [wiki, web] = await Promise.all([
      searchChordWiki(songGuess.title, songGuess.artist).catch(() => []),
      searchWeb(songGuess.queries, songGuess.title, songGuess.artist).catch(() => []),
    ]);
    sources = [...wiki, ...web];
  }

  // 4. 複数ソース照合 → 初期進行
  let progression = buildConsensus(sources);
  let usedFallback = false;
  let message = "";

  if (progression.length >= 4) {
    const consensusCount = progression.filter((p) => p.sourceCount > 1).length;
    message =
      `外部コード譜 ${sources.length} 件を参照して初期コード進行を生成しました` +
      (consensusCount > 0 ? `（複数ソース一致: ${consensusCount}コード）` : "") +
      "。タイミングは目安なので、再生しながら調整してください。";
  } else {
    // 5. フォールバック: J-POP頻出進行を仮置き
    const fb = buildFallbackProgression(videoId);
    progression = fb.progression;
    usedFallback = true;
    message =
      `外部コード譜が見つからなかったため、J-POPで頻出の「${fb.progressionName}」を仮置きしています。` +
      "再生しながらコードを編集して仕上げてください。";
  }

  const result: AnalyzeResult = {
    videoId,
    videoTitle,
    channelName: video.channelName,
    duration: video.duration,
    songGuess,
    progression,
    sources: sources.map((s) => ({
      provider: s.provider,
      url: s.url,
      pageTitle: s.pageTitle,
      chordCount: s.chords.length,
    })),
    usedFallback,
    message,
  };

  return NextResponse.json(result);
}
