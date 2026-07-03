// 反復型 radix-2 FFT (実信号用)
// 依存を増やさないための最小実装。twiddle係数とビット反転表を使い回す

export class FFT {
  readonly size: number;
  private cosTable: Float32Array;
  private sinTable: Float32Array;
  private reverseTable: Uint32Array;

  constructor(size: number) {
    if ((size & (size - 1)) !== 0) throw new Error("FFT size must be power of 2");
    this.size = size;
    this.cosTable = new Float32Array(size / 2);
    this.sinTable = new Float32Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cosTable[i] = Math.cos((-2 * Math.PI * i) / size);
      this.sinTable[i] = Math.sin((-2 * Math.PI * i) / size);
    }
    this.reverseTable = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let rev = 0;
      for (let b = 0; b < bits; b++) rev = (rev << 1) | ((i >> b) & 1);
      this.reverseTable[i] = rev;
    }
  }

  /**
   * 実信号input (長さsize) のパワースペクトルを out (長さsize/2) に書き込む。
   * 作業バッファ re/im は呼び出し側で確保して使い回す。
   */
  powerSpectrum(input: Float32Array, re: Float32Array, im: Float32Array, out: Float32Array): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      re[i] = input[this.reverseTable[i]];
      im[i] = 0;
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const c = this.cosTable[k];
          const s = this.sinTable[k];
          const idx = i + j;
          const idx2 = idx + half;
          const tre = re[idx2] * c - im[idx2] * s;
          const tim = re[idx2] * s + im[idx2] * c;
          re[idx2] = re[idx] - tre;
          im[idx2] = im[idx] - tim;
          re[idx] += tre;
          im[idx] += tim;
        }
      }
    }
    for (let i = 0; i < n / 2; i++) {
      out[i] = re[i] * re[i] + im[i] * im[i];
    }
  }
}

/** ハン窓を生成 */
export function hannWindow(size: number): Float32Array {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return w;
}
