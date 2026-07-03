// アプリ全体で共有する型定義

/** コード候補の情報源 */
export type ChordSource =
  | "external" // 外部コード譜サイト (1件)
  | "merged" // 複数外部ソースの照合結果 / 外部+音源解析の統合
  | "audio-analysis" // 音源解析 (chroma) 由来
  | "manual" // ユーザー手動入力・編集 (最優先)
  | "saved"; // 過去に保存されたユーザー編集済みコード

/** 信頼度 (内部では必ず持つ。UIでは控えめに表示) */
export type ChordConfidence = "high" | "medium" | "low" | "unknown";

/** タイムライン上の1つのコード */
export interface ChordEvent {
  id: string;
  /** 表示用コード名 (例: "G/B", "Am7") */
  name: string;
  root: string;
  quality: string;
  /** ベース音。オンコードなら slash 後の音 */
  bass: string;
  start: number;
  end: number;
  source: ChordSource;
  confidence: ChordConfidence;
  /** 信頼度の根拠 */
  evidence?: {
    /** 一致した外部ソースのprovider名 */
    externalSources?: string[];
    /** 音源解析のテンプレート一致度 0..1 */
    audioConfidence?: number;
    /** タイミングの確からしさ 0..1 */
    timingConfidence?: number;
    notes?: string[];
  };
  /** 音源解析と矛盾する等、確認を促すフラグ */
  needsReview?: boolean;
  /** ユーザーが編集したか */
  edited: boolean;
  section?: string;
  memo?: string;
}

/** 拍・小節グリッド */
export interface BeatGrid {
  bpm: number;
  /** 拍位置 (秒) の列 */
  beats: number[];
  /** 小節頭 (秒) の列 */
  downbeats: number[];
  /** 最初の小節頭 (秒) */
  firstDownbeat: number;
  /** グリッドの信頼度 0..1 */
  confidence: number;
  /** グリッドの出どころ */
  source: "audio" | "assumed";
}

/** 音源解析によるコード候補 */
export interface AudioChordCandidate {
  start: number;
  end: number;
  chord: string;
  root?: string;
  quality?: string;
  bass?: string;
  /** テンプレート一致度 0..1 */
  confidence: number;
}

/** 音源解析の全体結果 */
export interface AudioAnalysisResult {
  grid: BeatGrid;
  chords: AudioChordCandidate[];
  duration: number;
}

/** 曲名・アーティスト名の推定結果 */
export interface SongGuess {
  title: string;
  artist: string;
  confidence: number;
  queries: string[];
}

/** 外部ソース1件の取得結果 */
export interface ExternalSourceResult {
  provider: string;
  url: string;
  pageTitle: string;
  chords: { name: string; section?: string }[];
  score: number;
}

/** /api/analyze のレスポンス */
export interface AnalyzeResult {
  videoId: string;
  videoTitle: string;
  channelName: string;
  /** 動画長 (秒)。サーバー側で取れなければ 0 */
  duration: number;
  songGuess: SongGuess;
  /** 外部コード譜が見つかったか。false のときは progression は空 */
  found: boolean;
  /** 採用した初期コード進行 (タイムライン化前)。根拠がなければ空 */
  progression: {
    name: string;
    section?: string;
    /** このコードに一致した外部ソース数 */
    sourceCount: number;
    /** 一致した外部ソースのprovider名 */
    providers: string[];
    /** 照合スコア 0..1 */
    score: number;
  }[];
  sources: { provider: string; url: string; pageTitle: string; chordCount: number }[];
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

/** スナップ設定 */
export type SnapMode = "off" | "beat" | "bar";

/** 解析結果サマリー (UI表示・保存用) */
export interface AnalysisSummary {
  /** 外部コードソース数 */
  sourceCount: number;
  /** 推定BPM (音源解析があるときのみ) */
  bpm?: number;
  /** タイミング信頼度 */
  timingConfidence: "high" | "medium" | "low";
  /** 要確認コード数 */
  needsReviewCount: number;
  /** ユーザー向けメッセージ */
  message: string;
}

/** 曲ごとのプロジェクト (ローカル保存単位) */
export interface Project {
  videoId: string;
  videoTitle: string;
  channelName: string;
  duration: number;
  songGuess: SongGuess;
  sources: { provider: string; url: string; pageTitle: string; chordCount: number }[];
  /** 現在のコードタイムライン (ユーザー編集込み)。根拠がなければ空 */
  timeline: ChordEvent[];
  /** 解析時の生の進行 (音源解析後のグリッド再配置に使う) */
  progression?: AnalyzeResult["progression"];
  /** 拍・小節グリッド (音源解析 or 仮定) */
  beatGrid?: BeatGrid | null;
  /** 音源解析によるコード候補 (統合・照合に使用) */
  audioChords?: AudioChordCandidate[];
  /** 解析した音源ファイル名 */
  audioFileName?: string;
  /** 解析結果サマリー */
  analysis?: AnalysisSummary | null;
  loop: LoopRange;
  settings: {
    playMode: PlayMode;
    chordVolume: number; // 0..1
    chordLength: number; // 0.1..1
    snapMode: SnapMode;
  };
  updatedAt: number;
  createdAt: number;
}
