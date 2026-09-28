// The master's voice: hands every microphone frame to the page, which listens for speech and writes it down. Each
// frame carries when it was heard (the audio's own clock), so a page that handles frames late still times them right.
class MasterPcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage({ samples: channel.slice(0), time: currentTime });
    return true;
  }
}
registerProcessor('master-pcm-tap', MasterPcmTap);
