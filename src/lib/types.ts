// アプリ全体で共有する型定義

/** コード候補の情報源 */
export type ChordSource =
  | "external" // 外部コード譜サイト
  | "consensus" // 複数外部ソースの一致
  | "fallback" // 外部情報なし・頻出進行による仮置き
  | "user"; // ユーザー編集（最優先）

/** タイムライン上の1つのコード */
export interface ChordEvent {
  id: string;
  /** 表示用コード名 (例: "G/B", "Am7") */
  name: string;
  /** ルート音 (例: "G") */
  root: string;
  /** コード種別 (例: "m7", "maj7", "") */
  quality: string;
  /** ベース音。オンコードなら slash 後の音、そうでなければルート */
  bass: string;
  /** 開始時間 (秒) */
  start: number;
  /** 終了時間 (秒) */
  end: number;
  /** 情報源 */
  source: ChordSource;
  /** このコードに一致した外部ソース数 */
  sourceCount: number;
  /** 参考程度の信頼度 0..1 */
  confidence: number;
  /** ユーザーが編集したか */
  edited: boolean;
  /** セクション名 (intro / Aメロ / サビ など、取れた場合のみ) */
  section?: string;
  /** ユーザーメモ */
  memo?: string;
}

/** 曲名・アーティスト名の推定結果 */
export interface SongGuess {
  title: string;
  artist: string;
  confidence: number;
  /** 検索に使ったクエリ */
  queries: string[];
}

/** 外部ソース1件の取得結果 */
export interface ExternalSourceResult {
  provider: string;
  url: string;
  pageTitle: string;
  /** 抽出したコード列 (セクション情報付き) */
  chords: { name: string; section?: string }[];
  /** ソースの品質スコア 0..1 */
  score: number;
}

/** /api/analyze のレスポンス */
export interface AnalyzeResult {
  videoId: string;
  videoTitle: string;
  channelName: string;
  /** 動画長 (秒)。サーバー側で取れなければ 0 (クライアントでプレイヤーから取得) */
  duration: number;
  songGuess: SongGuess;
  /** 採用した初期コード進行 (タイムライン化前) */
  progression: {
    name: string;
    section?: string;
    sourceCount: number;
    confidence: number;
    source: ChordSource;
  }[];
  /** 参照した外部ソースの一覧 (デバッグ・出典表示用) */
  sources: { provider: string; url: string; pageTitle: string; chordCount: number }[];
  /** フォールバック進行を使ったか */
  usedFallback: boolean;
  /** 解析に関するユーザー向けメッセージ */
  message: string;
}

/** 再生モード */
export type PlayMode = "original" | "mix" | "chordsOnly";

/** ループ設定 */
export interface LoopRange {
  enabled: boolean;
  start: number;
  end: number;
}

/** 曲ごとのプロジェクト (ローカル保存単位) */
export interface Project {
  videoId: string;
  videoTitle: string;
  channelName: string;
  duration: number;
  songGuess: SongGuess;
  /** 解析時の外部ソース情報 */
  sources: { provider: string; url: string; pageTitle: string; chordCount: number }[];
  /** 現在のコードタイムライン (ユーザー編集込み) */
  timeline: ChordEvent[];
  loop: LoopRange;
  settings: {
    playMode: PlayMode;
    chordVolume: number; // 0..1
    chordLength: number; // コード区間に対する発音長の割合 0.1..1
  };
  updatedAt: number;
  createdAt: number;
}
