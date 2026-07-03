"use client";

// 音源ファイルのデコードとダウンサンプリング (ブラウザ専用)
// 解析本体 (analyze.ts) は純TSなので、ここでFileをFloat32Arrayに変換して渡す

const ANALYSIS_SAMPLE_RATE = 11025;

/** 音源ファイルをモノラル・11025Hzにデコードする */
export async function decodeAudioFile(
  file: File
): Promise<{ samples: Float32Array; sampleRate: number }> {
  const arrayBuffer = await file.arrayBuffer();

  // いったん通常のAudioContextでデコード (ブラウザ対応フォーマットすべて対応)
  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(arrayBuffer);
  } finally {
    void ctx.close();
  }

  // OfflineAudioContextでモノラル・低サンプルレートにリサンプル
  const length = Math.ceil(decoded.duration * ANALYSIS_SAMPLE_RATE);
  const offline = new OfflineAudioContext(1, length, ANALYSIS_SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();

  return { samples: rendered.getChannelData(0), sampleRate: ANALYSIS_SAMPLE_RATE };
}
