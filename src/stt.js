// Speech recognition is configured independently from the chat provider.
const { pcmToWav } = require('./wav');

async function transcribeOpenAI(apiKey, wav, model, baseURL, language) {
  const OpenAI = require('openai');
  const toFile = OpenAI.toFile || require('openai/uploads').toFile;
  const client = new OpenAI({ apiKey, baseURL: baseURL || undefined, timeout: 120000, maxRetries: 0 });
  const file = await toFile(wav, 'audio.wav', { type: 'audio/wav' });
  const res = await client.audio.transcriptions.create({ file, model, ...(language && language !== 'auto' ? { language } : {}) });
  return (res.text || '').trim();
}


function createSTT(settings) {
  const chain = [];
  if (!settings.sttProvider || settings.sttProvider === 'local') {
    const endpoint = settings.sttBaseURL || 'http://127.0.0.1:8765/v1';
    const url = new URL(endpoint);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Локальное распознавание требует адрес loopback.');
    chain.push({ p: 'local', fn: (wav) => transcribeOpenAI('local', wav, settings.sttModel || 'small', endpoint, settings.sttLanguage) });
  } else if (settings.sttProvider === 'openai') {
    if (settings.sttApiKey) chain.push({ p: 'openai', fn: (wav) => transcribeOpenAI(settings.sttApiKey, wav, settings.sttModel || 'whisper-1', settings.sttBaseURL || 'https://api.openai.com/v1', settings.sttLanguage) });
  }

  return {
    available: chain.length > 0,
    providers: chain.map((c) => c.p),
    async transcribe(pcm) {
      if (!chain.length || !pcm || pcm.length < 3200) return { text: '' };
      const wav = pcmToWav(pcm, 16000, 1);
      let lastErr = null;
      for (const c of chain) {
        try {
          const text = await c.fn(wav);
          return { text, provider: c.p };
        } catch (e) {
          lastErr = { status: e && e.status, code: e && e.code, message: (e && e.message) || String(e), provider: c.p };
        }
      }
      return { text: '', error: lastErr };
    }
  };
}

module.exports = { createSTT };
