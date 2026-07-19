// AudioWorklet processor: consumes interleaved-stereo Float32Array chunks
// posted from the main thread and streams them to the audio output.
// Runs on the audio thread — keep it allocation-light and simple.
class GbAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0; // read position (in floats) within queue[0]
    this.port.onmessage = e => {
      this.queue.push(e.data);
      // Cap queued audio at ~1 s to bound latency if the page stalls
      let total = 0;
      for (const c of this.queue) total += c.length;
      while (this.queue.length > 1 && total > sampleRate * 2) {
        total -= this.queue.shift().length;
        this.offset = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const left = outputs[0][0];
    const right = outputs[0][1] || left;
    for (let i = 0; i < left.length; i++) {
      const chunk = this.queue[0];
      if (chunk === undefined || this.offset >= chunk.length) {
        // Starved: output silence (and advance past a finished chunk)
        if (chunk !== undefined && this.offset >= chunk.length) {
          this.queue.shift();
          this.offset = 0;
          i--; // retry this output sample from the next chunk
          continue;
        }
        left[i] = 0;
        right[i] = 0;
        continue;
      }
      left[i] = chunk[this.offset++];
      right[i] = chunk[this.offset++];
    }
    return true;
  }
}

registerProcessor("gb-audio", GbAudioProcessor);
