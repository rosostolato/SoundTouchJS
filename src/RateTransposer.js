/*
 * SoundTouch JS audio processing library
 * Copyright (c) Olli Parviainen
 * Copyright (c) Ryan Berdeen
 * Copyright (c) Jakub Fiala
 * Copyright (c) Steve 'Cutter' Blades
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with this library; if not, write to the Free Software
 * Foundation, Inc., 59 Temple Place, Suite 330, Boston, MA  02111-1307  USA
 */

import AbstractFifoSamplePipe from './AbstractFifoSamplePipe';

// Default sample rate used when none is provided
const DEFAULT_SAMPLE_RATE = 44100;

export default class RateTransposer extends AbstractFifoSamplePipe {
  constructor(createBuffers) {
    super(createBuffers);
    this._rate = 1;
    this._sampleRate = DEFAULT_SAMPLE_RATE;

    // AA filter state (2nd-order Butterworth IIR biquad, stereo)
    this._filterActive = false;
    this._aaCoeffs = { b0: 0, b1: 0, b2: 0, a1: 0, a2: 0 };

    this.reset();
  }

  set rate(rate) {
    this._rate = rate;
    this._updateFilter();
  }

  set sampleRate(sampleRate) {
    this._sampleRate = sampleRate;
    this._updateFilter();
  }

  /**
   * Recalculate anti-aliasing filter coefficients.
   * Only active when rate > 1.0 (downsampling-like resampling that causes aliasing).
   * Uses a 2nd-order Butterworth lowpass biquad with cutoff at Nyquist / rate.
   */
  _updateFilter() {
    if (this._rate <= 1.0) {
      this._filterActive = false;
      return;
    }

    this._filterActive = true;
    const fc = this._sampleRate / (2.0 * this._rate);
    const w0 = (2.0 * Math.PI * fc) / this._sampleRate;
    const cosW0 = Math.cos(w0);
    const sinW0 = Math.sin(w0);
    const alpha = sinW0 / (2.0 * Math.SQRT1_2); // Q = 1/sqrt(2) for Butterworth

    const a0 = 1.0 + alpha;
    this._aaCoeffs = {
      b0: (1.0 - cosW0) / 2.0 / a0,
      b1: (1.0 - cosW0) / a0,
      b2: (1.0 - cosW0) / 2.0 / a0,
      a1: (-2.0 * cosW0) / a0,
      a2: (1.0 - alpha) / a0,
    };
  }

  reset() {
    this.slopeCount = 0;
    this.prevSampleL = 0;
    this.prevSampleR = 0;

    // AA filter delay line (biquad state for stereo)
    this._x1L = 0;
    this._x2L = 0;
    this._y1L = 0;
    this._y2L = 0;
    this._x1R = 0;
    this._x2R = 0;
    this._y1R = 0;
    this._y2R = 0;
  }

  clear() {
    super.clear();
    this.reset();
  }

  clone() {
    const result = new RateTransposer();
    result.rate = this._rate;
    return result;
  }

  process() {
    const numFrames = this._inputBuffer.frameCount;
    this._outputBuffer.ensureAdditionalCapacity(numFrames / this._rate + 1);

    // Apply AA filter in-place on input buffer before transposing
    if (this._filterActive) {
      this._applyAAFilter(numFrames);
    }

    const numFramesOutput = this.transpose(numFrames);
    this._inputBuffer.receive();
    this._outputBuffer.put(numFramesOutput);
  }

  /**
   * Apply the anti-aliasing biquad lowpass filter in-place on the input buffer.
   */
  _applyAAFilter(numFrames) {
    const src = this._inputBuffer.vector;
    const offset = this._inputBuffer.startIndex;
    const { b0, b1, b2, a1, a2 } = this._aaCoeffs;

    for (let n = 0; n < numFrames; n++) {
      const idx = offset + 2 * n;
      const inL = src[idx];
      const inR = src[idx + 1];

      // Direct Form I biquad - left channel
      const outL =
        b0 * inL + b1 * this._x1L + b2 * this._x2L - a1 * this._y1L - a2 * this._y2L;
      this._x2L = this._x1L;
      this._x1L = inL;
      this._y2L = this._y1L;
      this._y1L = outL;

      // Direct Form I biquad - right channel
      const outR =
        b0 * inR + b1 * this._x1R + b2 * this._x2R - a1 * this._y1R - a2 * this._y2R;
      this._x2R = this._x1R;
      this._x1R = inR;
      this._y2R = this._y1R;
      this._y1R = outR;

      src[idx] = outL;
      src[idx + 1] = outR;
    }
  }

  transpose(numFrames = 0) {
    if (numFrames === 0) {
      return 0;
    }

    const src = this._inputBuffer.vector;
    const srcOffset = this._inputBuffer.startIndex;

    const dest = this._outputBuffer.vector;
    const destOffset = this._outputBuffer.endIndex;

    let used = 0;
    let i = 0;

    while (this.slopeCount < 1.0) {
      dest[destOffset + 2 * i] =
        (1.0 - this.slopeCount) * this.prevSampleL +
        this.slopeCount * src[srcOffset];
      dest[destOffset + 2 * i + 1] =
        (1.0 - this.slopeCount) * this.prevSampleR +
        this.slopeCount * src[srcOffset + 1];
      i = i + 1;
      this.slopeCount += this._rate;
    }

    this.slopeCount -= 1.0;

    if (numFrames !== 1) {
      // eslint-disable-next-line no-constant-condition
      out: while (true) {
        while (this.slopeCount > 1.0) {
          this.slopeCount -= 1.0;
          used = used + 1;
          if (used >= numFrames - 1) {
            break out;
          }
        }

        const srcIndex = srcOffset + 2 * used;
        dest[destOffset + 2 * i] =
          (1.0 - this.slopeCount) * src[srcIndex] +
          this.slopeCount * src[srcIndex + 2];
        dest[destOffset + 2 * i + 1] =
          (1.0 - this.slopeCount) * src[srcIndex + 1] +
          this.slopeCount * src[srcIndex + 3];

        i = i + 1;
        this.slopeCount += this._rate;
      }
    }

    this.prevSampleL = src[srcOffset + 2 * numFrames - 2];
    this.prevSampleR = src[srcOffset + 2 * numFrames - 1];

    return i;
  }
}
