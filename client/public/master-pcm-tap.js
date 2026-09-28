// The master's voice: hands every microphone frame to the page, which listens for speech and writes it down.
class MasterPcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor('master-pcm-tap', MasterPcmTap);
