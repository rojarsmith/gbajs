/**
 * Audio output: an AudioWorklet fed with sample chunks over its MessagePort.
 * (No SharedArrayBuffer needed, so no cross-origin-isolation requirement.)
 *
 * Browsers block audio until a user gesture, so `unlock()` is called from
 * pointer/key handlers; until then `running` is false and the main loop
 * paces itself by requestAnimationFrame instead of the audio clock.
 */
export class GbAudio {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private pushedSamples = 0; // stereo pairs
  private startTime = 0;

  /** True once the context is running and the worklet is loaded. */
  get running(): boolean {
    return this.node !== null && this.ctx !== null && this.ctx.state === "running";
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  /** Call from a user-gesture handler. Safe to call repeatedly. */
  async unlock(): Promise<void> {
    if (this.ctx === null) {
      this.ctx = new AudioContext();
      await this.ctx.audioWorklet.addModule("/audio-worklet.js");
      this.node = new AudioWorkletNode(this.ctx, "gb-audio", {
        outputChannelCount: [2],
      });
      this.node.connect(this.ctx.destination);
      this.pushedSamples = 0;
      this.startTime = this.ctx.currentTime;
    }
    if (this.ctx.state !== "running") {
      await this.ctx.resume();
      this.pushedSamples = 0;
      this.startTime = this.ctx.currentTime;
    }
  }

  /** Queue interleaved-stereo samples for playback. */
  push(chunk: Float32Array): void {
    if (!this.running || chunk.length === 0) return;
    const pairs = chunk.length / 2; // read BEFORE transfer detaches the buffer
    this.node!.port.postMessage(chunk, [chunk.buffer]);
    this.pushedSamples += pairs;
  }

  /** Seconds of audio queued ahead of the hardware clock. */
  bufferedSeconds(): number {
    if (!this.running) return 0;
    const played = this.ctx!.currentTime - this.startTime;
    const queued = this.pushedSamples / this.sampleRate - played;
    if (queued < 0) {
      // Underrun (e.g. the tab was hidden): re-anchor the baseline so the
      // loop refills at normal speed instead of fast-forwarding to catch up.
      this.startTime = this.ctx!.currentTime - this.pushedSamples / this.sampleRate;
      return 0;
    }
    return queued;
  }
}
