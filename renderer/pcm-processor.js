class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Int16Array(4096);
    this.length = 0;
    this.running = true;
    this.ratio = sampleRate / 16000;
    this.weight = 0;
    this.sum = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type !== 'flush') return;
      this.running = false;
      if (this.weight) this.append(this.sum / this.weight);
      this.emit();
      this.port.postMessage({ type: 'drained' });
    };
  }

  append(value) {
    const sample = Math.max(-1, Math.min(1, value));
    this.chunk[this.length++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    if (this.length === this.chunk.length) this.emit();
  }

  emit() {
    if (!this.length) return;
    const pcm = this.length === this.chunk.length ? this.chunk : this.chunk.slice(0, this.length);
    this.port.postMessage({ type: 'pcm', pcm: pcm.buffer }, [pcm.buffer]);
    this.chunk = new Int16Array(4096);
    this.length = 0;
  }

  process(inputs) {
    if (!this.running) return false;
    const channels = inputs[0];
    if (!channels || !channels.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let mono = 0;
      for (let channel = 0; channel < channels.length; channel++) mono += channels[channel][i];
      mono /= channels.length;
      if (this.ratio === 1) {
        this.append(mono);
      } else {
        let remaining = 1;
        while (remaining > 0) {
          const weight = Math.min(remaining, this.ratio - this.weight);
          this.sum += mono * weight;
          this.weight += weight;
          remaining -= weight;
          if (this.weight >= this.ratio - 1e-8) {
            this.append(this.sum / this.ratio);
            this.weight = 0;
            this.sum = 0;
          }
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-processor', PcmProcessor);
