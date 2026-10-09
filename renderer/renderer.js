/* cue renderer — UI state, mic capture, IPC, streaming render. */
(function () {
  const { icon } = window.ICONS;
  const cue = window.cue; // exposed by preload
  const $ = (s) => document.querySelector(s);
  const isMac = cue.platform === 'darwin';
  const isWindows = cue.platform === 'win32';
  const modifierLabel = isMac ? '⌘' : 'Ctrl';
  const commandKey = (event) => isMac ? event.metaKey : event.ctrlKey;
  $('#modifier-hint').textContent = modifierLabel;
  $('#send-btn').title = 'Отправить вопрос (Enter)';
  $('#more-btn').title = 'Настройки (' + modifierLabel + '+,)';
  $('.act[data-mode="assist"]').title = 'Автоматические подсказки; разовая помощь: ' + modifierLabel + '+Enter';

  // ---- paint icons -------------------------------------------------------
  $('#logo-btn').innerHTML = icon('logo', { size: 18 });
  $('.tb-hide .chev').innerHTML = icon('chevron-down', { size: 14 });
  $('#stop-btn').innerHTML = icon('stop-square', { size: 15 });
  document.querySelector('.act[data-mode="assist"] .ic').innerHTML = icon('sparkles', { size: 16 });
  document.querySelector('.act[data-mode="say"] .ic').innerHTML = icon('wand-sparkles', { size: 16 });
  document.querySelector('.act[data-mode="followup"] .ic').innerHTML = icon('message-circle', { size: 16 });
  document.querySelector('.act[data-mode="recap"] .ic').innerHTML = icon('refresh-cw', { size: 16 });
  $('#smart-toggle .ic').innerHTML = icon('zap', { size: 14 });
  $('#copy-btn').innerHTML = icon('copy', { size: 16 });
  $('#more-btn').innerHTML = icon('more-horizontal', { size: 18 });
  $('#send-btn').innerHTML = icon('play', { size: 15 });

  // ---- state -------------------------------------------------------------
  let settings = null;
  let busy = false;
  let aiEl = null;       // current streaming <div class="ai-text">
  let caretEl = null;

  const messages = $('#messages');
  const liveTranscript = $('#live-transcript');
  const transcriptCountEl = $('#transcript-count');
  const assistStateEl = $('#assist-state');
  let transcriptCount = 0;
  let messagesFollow = true;

  function esc(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // minimal, safe markdown: fenced code, bullets, inline code, bold, paragraphs
  function renderMarkdown(text) {
    const lines = text.split('\n');
    let html = '', inCode = false, inList = false, buf = [];
    const flushP = () => { if (buf.length) { html += '<p>' + inline(buf.join(' ')) + '</p>'; buf = []; } };
    const inline = (s) => esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    for (const raw of lines) {
      const line = raw;
      if (/^```/.test(line.trim())) {
        if (!inCode) { flushP(); if (inList) { html += '</ul>'; inList = false; } html += '<pre><code>'; inCode = true; }
        else { html += '</code></pre>'; inCode = false; }
        continue;
      }
      if (inCode) { html += esc(line) + '\n'; continue; }
      if (/^\s*[-*]\s+/.test(line)) { flushP(); if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inline(line.replace(/^\s*[-*]\s+/, '')) + '</li>'; continue; }
      if (line.trim() === '') { flushP(); if (inList) { html += '</ul>'; inList = false; } continue; }
      buf.push(line.trim());
    }
    flushP(); if (inList) html += '</ul>'; if (inCode) html += '</code></pre>';
    return html;
  }

  function clearMessages() { messages.innerHTML = ''; aiEl = null; caretEl = null; messagesFollow = true; }

  messages.addEventListener('scroll', () => {
    messagesFollow = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 24;
  });

  function keepMessagesAtBottom() {
    if (messagesFollow) requestAnimationFrame(() => { messages.scrollTop = messages.scrollHeight; });
  }

  function clearLiveTranscript() {
    liveTranscript.innerHTML = '';
    transcriptCount = 0;
    transcriptCountEl.textContent = 'Нет реплик';
  }

  function appendTranscript(turn) {
    if (!turn || !turn.text) return;
    const wasAtBottom = liveTranscript.scrollHeight - liveTranscript.scrollTop - liveTranscript.clientHeight < 24;
    const row = document.createElement('div');
    row.className = 'transcript-row ' + (turn.channel === 'them' ? 'them' : 'you');

    const meta = document.createElement('div');
    meta.className = 'transcript-meta';
    const speaker = document.createElement('span');
    speaker.className = 'transcript-speaker';
    speaker.textContent = turn.channel === 'them' ? 'Собеседник' : 'Вы';
    const source = document.createElement('span');
    source.className = 'transcript-source';
    source.textContent = turn.channel === 'them' ? 'ноутбук' : 'микрофон';
    const time = document.createElement('time');
    time.className = 'transcript-time';
    time.textContent = new Date(turn.ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    meta.append(speaker, source, time);

    const text = document.createElement('div');
    text.className = 'transcript-text';
    text.textContent = turn.text;
    row.append(meta, text);
    liveTranscript.appendChild(row);
    transcriptCount += 1;
    transcriptCountEl.textContent = transcriptCount + (transcriptCount === 1 ? ' реплика' : ' реплик');
    if (wasAtBottom) requestAnimationFrame(() => { liveTranscript.scrollTop = liveTranscript.scrollHeight; });
  }

  function addUserBubble(text) {
    const b = document.createElement('div');
    b.className = 'user-bubble';
    b.textContent = text;
    messages.appendChild(b);
  }

  function startAi(small, label) {
    if (label) {
      const marker = document.createElement('div');
      marker.className = 'answer-label';
      marker.textContent = label;
      messages.appendChild(marker);
    }
    aiEl = document.createElement('div');
    aiEl.className = 'ai-text' + (small ? ' small' : '');
    aiEl.dataset.raw = '';
    caretEl = document.createElement('span');
    caretEl.className = 'ai-caret';
    aiEl.appendChild(caretEl);
    messages.appendChild(aiEl);
    keepMessagesAtBottom();
  }

  function appendToken(t) {
    if (!aiEl) startAi(false);
    aiEl.dataset.raw += t;
    aiEl.insertBefore(document.createTextNode(t), caretEl);
    keepMessagesAtBottom();
  }

  function finalizeAi() {
    if (!aiEl) return;
    const raw = aiEl.dataset.raw || '';
    aiEl.innerHTML = renderMarkdown(raw);
    aiEl = null; caretEl = null;
  }

  function removeAi() {
    if (!aiEl) return;
    const marker = aiEl.previousElementSibling;
    if (marker && marker.classList.contains('answer-label')) marker.remove();
    aiEl.remove();
    aiEl = null; caretEl = null;
  }

  function setBusy(v) { busy = v; $('#send-btn').classList.toggle('busy', v); }

  // ---- actions -----------------------------------------------------------
  function runMode(mode, text) {
    if (busy) return;
    setBusy(true);
    cue.ask({ mode, text: text || '' });
  }

  const assistBtn = document.querySelector('.act[data-mode="assist"]');
  function syncAssistMode(active) {
    assistBtn.classList.toggle('active', active);
    assistBtn.setAttribute('aria-pressed', String(active));
  }

  document.querySelectorAll('.act').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.dataset.mode === 'assist') {
        const active = await cue.assistToggle();
        syncAssistMode(active);
        return;
      }
      runMode(btn.dataset.mode, '');
    });
  });

  const input = $('#input');
  const placeholder = $('#placeholder');
  const composer = $('#composer');

  function syncPlaceholder() {
    placeholder.classList.toggle('hidden', input.value.length > 0 || document.activeElement === input);
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  }
  input.addEventListener('input', syncPlaceholder);
  input.addEventListener('focus', () => { composer.classList.add('focused'); placeholder.classList.add('hidden'); });
  input.addEventListener('blur', () => { composer.classList.remove('focused'); syncPlaceholder(); });
  $('#input-area').addEventListener('click', () => input.focus());

  function send() {
    const text = input.value.trim();
    if (!text) { runMode('assist', ''); return; }
    input.value = ''; syncPlaceholder();
    runMode('ask', text);
  }
  $('#send-btn').addEventListener('click', send);
  $('#copy-btn').addEventListener('click', async () => {
    const text = [liveTranscript.innerText.trim(), messages.innerText.trim()].filter(Boolean).join('\n\n');
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      showStatus('Сообщения скопированы');
    } catch (err) {
      const area = document.createElement('textarea');
      area.value = text; document.body.appendChild(area); area.select();
      document.execCommand('copy'); area.remove();
      showStatus('Сообщения скопированы');
    }
  });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.key !== 'Enter' || e.shiftKey || e.altKey) return;
    if (commandKey(e)) { e.preventDefault(); runMode('assist', ''); }
    else if (!e.metaKey && !e.ctrlKey) { e.preventDefault(); send(); }
  });

  // Smart toggle
  const smartBtn = $('#smart-toggle');
  smartBtn.addEventListener('click', async () => {
    settings.smart = !settings.smart;
    smartBtn.classList.toggle('on', settings.smart);
    await cue.settingsSet({ smart: settings.smart });
  });

  // Hide / collapse
  $('#hide-btn').addEventListener('click', () => {
    const collapsed = $('#panel').classList.toggle('collapsed');
    $('#hide-btn').classList.toggle('collapsed', collapsed);
    $('#live-dot').style.display = collapsed ? 'none' : '';
  });

  $('#stop-btn').addEventListener('click', () => { cue.captureToggle(); });

  // Both sources use a generation-bound worklet. Display video stays live until stop.
  let captureSession = null;
  const sourceStarts = new Map(); // generation -> { you, them }: serializes setup per source across start/stop races
  function sourceStatus(source, state, message) {
    cue.audioStatus({ generation: source.generation, channel: source.channel, state, message });
  }
  function sourceIsCurrent(source) {
    return captureSession && captureSession.generation === source.generation && !source.stopping;
  }
  async function stopSource(source) {
    if (source.stopPromise) return source.stopPromise;
    source.stopping = true;
    source.stopPromise = (async () => {
      if (source.stream) source.stream.getTracks().forEach((track) => { track.onended = null; });
      if (source.node) source.node.disconnect();
      const processor = source.processor;
      if (processor) {
        // Ask the worklet for the tail it still holds; a dead worklet can never answer.
        await new Promise((resolve) => {
          let settled = false;
          const finish = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
          const timer = setTimeout(finish, 1000);
          source.drained = finish;
          try { processor.port.postMessage({ type: 'flush' }); } catch (error) { finish(); }
        });
        source.drained = null;
        if (source.processor === processor) source.processor = null;
        try { processor.disconnect(); } catch (error) { /* already detached */ }
        try { processor.port.close(); } catch (error) { /* already closed */ }
      }
      if (source.stream) source.stream.getTracks().forEach((track) => track.stop());
      if (source.context) {
        const context = source.context;
        source.context = null;
        try { await context.close(); } catch (error) { /* already closed */ }
      }
    })();
    return source.stopPromise;
  }
  const micConstraints = isWindows
    ? { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    : { channelCount: 1, echoCancellation: true, noiseSuppression: true };
  // Ask only for what we consume; the display video stays live for the whole session.
  const loopbackConstraints = { video: { frameRate: 1, width: 320, height: 180 }, audio: true };
  async function startSource(source) {
    if (!sourceIsCurrent(source)) return;
    sourceStatus(source, 'starting');
    try {
      const stream = source.channel === 'you'
        ? await navigator.mediaDevices.getUserMedia({ audio: micConstraints })
        : await navigator.mediaDevices.getDisplayMedia(loopbackConstraints);
      if (!sourceIsCurrent(source)) { stream.getTracks().forEach((track) => track.stop()); return; }
      source.stream = stream;
      const tracks = stream.getAudioTracks();
      if (!tracks.length || tracks.some((track) => track.readyState !== 'live')) {
        throw new Error(source.channel === 'you' ? 'Нет активной дорожки микрофона.' : 'Windows не предоставила живую дорожку loopback. Проверьте устройство вывода в настройках звука.');
      }
      const video = stream.getVideoTracks()[0];
      if (video && video.readyState !== 'live') throw new Error('Windows не предоставила живой поток экрана для захвата звука.');
      stream.getTracks().forEach((track) => {
        track.onended = () => {
          if (!sourceIsCurrent(source)) return;
          sourceStatus(source, 'error', 'Источник отключён или доступ к захвату отозван. Остановите и снова включите запись.');
          stopSource(source).catch((error) => cue.log('audio stop: ' + error.message));
        };
      });
      const context = new AudioContext({ sampleRate: 16000 });
      source.context = context;
      await context.resume();
      if (!sourceIsCurrent(source)) { await stopSource(source); return; }
      await context.audioWorklet.addModule('pcm-processor.js');
      if (!sourceIsCurrent(source)) { await stopSource(source); return; }
      const node = context.createMediaStreamSource(new MediaStream(tracks));
      const processor = new AudioWorkletNode(context, 'pcm-processor', { outputChannelCount: [1] });
      const sink = context.createGain();
      sink.gain.value = 0;
      node.connect(processor);
      processor.connect(sink);
      sink.connect(context.destination);
      source.node = node;
      source.processor = processor;
      source.sink = sink;
      processor.port.onmessage = ({ data }) => {
        if (data.type === 'pcm') {
          // Forward the tail too: during the drain phase the session is already closed on the
          // main side, but the audio still belongs to this generation.
          if (!sourceIsCurrent(source) && !source.stopping) return;
          const payload = { generation: source.generation, pcm: data.pcm };
          if (source.channel === 'you') cue.micPcm(payload); else cue.systemPcm(payload);
        } else if (data.type === 'drained' && source.drained) source.drained();
      };
      processor.onprocessorerror = () => {
        if (!sourceIsCurrent(source) && !source.drained) return;
        sourceStatus(source, 'error', 'Обработчик звука остановился. Остановите и снова включите запись.');
        // A failed worklet cannot answer a flush request.
        const failed = source.processor;
        source.processor = null;
        if (failed) {
          try { failed.disconnect(); } catch (error) { /* already detached */ }
          try { failed.port.close(); } catch (error) { /* already closed */ }
        }
        if (source.drained) source.drained();
        stopSource(source).catch((error) => cue.log('audio stop: ' + error.message));
      };
      if (tracks.some((track) => track.readyState !== 'live') || context.state !== 'running') throw new Error('Источник звука не запустился. Проверьте разрешения и устройство.');
      if (!sourceIsCurrent(source)) { await stopSource(source); return; }
      sourceStatus(source, 'active');
    } catch (error) {
      if (sourceIsCurrent(source)) {
        sourceStatus(source, 'error', (source.channel === 'you' ? 'Не удалось включить микрофон. Проверьте разрешение Windows и устройство. ' : 'Не удалось включить звук компьютера. Проверьте устройство вывода и разрешение захвата. ') + error.message);
      }
      await stopSource(source);
    }
  }
  function applyCaptureState({ active, generation }) {
    $('#live-dot').classList.toggle('off', !active);
    $('#stop-btn').classList.toggle('active', active);
    if (active) {
      if (captureSession && captureSession.generation === generation) return;
      const previous = captureSession;
      if (previous) {
        // A start without a matching stop would otherwise leave the old capture running.
        captureSession = null;
        const previousStarts = sourceStarts.get(previous.generation);
        if (previousStarts) sourceStarts.delete(previous.generation);
        const settled = previousStarts ? Promise.all([previousStarts.you, previousStarts.them]) : Promise.resolve();
        settled.then(() => Promise.all(previous.sources.map(stopSource))).catch((error) => cue.log('audio stop: ' + error.message));
      }
      const sources = ['you', 'them'].map((channel) => ({ channel, generation, stopping: false, reported: false }));
      captureSession = { generation, sources };
      const starts = { you: Promise.resolve(), them: Promise.resolve() };
      sourceStarts.set(generation, starts);
      sources.forEach((source) => {
        starts[source.channel] = starts[source.channel]
          .then(() => startSource(source))
          .catch((error) => cue.log('audio setup: ' + error.message));
      });
      clearMessages(); clearLiveTranscript(); assistStateEl.textContent = 'Слушаю';
    } else {
      if (!captureSession || captureSession.generation !== generation) return;
      const stopped = captureSession;
      captureSession = null;
      const starts = sourceStarts.get(generation);
      if (starts) sourceStarts.delete(generation);
      const awaited = sources => Promise.all(sources.map(stopSource));
      // Never announce "stopped" before setup has settled: a late startSource would otherwise revive the source.
      const settled = starts ? Promise.all([starts.you, starts.them]) : Promise.resolve();
      settled.then(awaited.bind(null, stopped.sources)).then(() => {
        stopped.sources.forEach((source) => {
          if (source.reported) return;
          source.reported = true;
          sourceStatus(source, 'stopped');
        });
        cue.audioDrained({ generation });
      }).catch((error) => cue.log('audio drain: ' + error.message));
      assistStateEl.textContent = 'Готово';
    }
  }

  // ---- events from main --------------------------------------------------
  cue.on('capture:state', applyCaptureState);
  cue.on('transcript', appendTranscript);
  cue.on('llm:start', ({ userBubble, small, append, responseLabel }) => {
    if (append) finalizeAi();
    else clearMessages();
    if (userBubble && !append) addUserBubble(userBubble);
    startAi(!!small, append ? responseLabel : '');
    assistStateEl.textContent = 'Генерирую';
    setBusy(true);
  });
  cue.on('llm:token', ({ text }) => appendToken(text));
  cue.on('llm:done', ({ suppress }) => { if (suppress) removeAi(); else finalizeAi(); assistStateEl.textContent = 'Готово'; setBusy(false); });
  cue.on('llm:idle', () => { setBusy(false); assistStateEl.textContent = 'Готово'; });
  cue.on('llm:error', ({ message }) => {
    if (!aiEl) startAi(true);
    aiEl.dataset.raw = message; finalizeAi(); assistStateEl.textContent = 'Ошибка'; setBusy(false);
  });
  let statusTimer = null;
  function showStatus(message) {
    let el = document.getElementById('cue-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cue-status';
      const panel = document.getElementById('panel');
      panel.insertBefore(el, document.getElementById('action-row'));
    }
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => el.classList.remove('show'), 11000);
  }
  cue.on('status', ({ message }) => { cue.log('[status] ' + message); showStatus(message); });
  const audioStateLabels = { starting: 'подключение…', active: 'захват активен', error: 'ошибка', stopped: 'остановлен' };
  cue.on('audio:status', ({ channel, state, message }) => {
    if (!['you', 'them'].includes(channel) || !audioStateLabels[state]) return;
    const source = channel === 'you' ? 'Микрофон' : 'Звук компьютера';
    const el = $('#audio-' + channel);
    el.textContent = source + ': ' + audioStateLabels[state];
    el.dataset.state = state;
    el.title = message || '';
    if (message) showStatus(source + ': ' + message);
  });

  // ---- settings ----------------------------------------------------------
  const scrim = $('#settings-scrim');
  let settingsReturnFocus = null;
  function openSettings() {
    if (!settings) return;
    if (scrim.classList.contains('hidden')) settingsReturnFocus = document.activeElement;
    fillSettings(); scrim.classList.remove('hidden'); setIgnore(false);
    $('#s-close').focus();
  }
  async function closeSettings() {
    try {
      await saveSettings();
      scrim.classList.add('hidden');
      if (settingsReturnFocus) settingsReturnFocus.focus();
    } catch (error) {
      $('#s-status').textContent = 'Не удалось сохранить настройки: ' + error.message;
    }
  }
  $('#more-btn').addEventListener('click', openSettings);
  $('#s-close').addEventListener('click', closeSettings);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) closeSettings(); });
  cue.on('settings:open', openSettings);

  const STT_DEFAULTS = {
    local: { baseURL: 'http://127.0.0.1:8765/v1', model: 'small' },
    openai: { baseURL: 'https://api.openai.com/v1', model: 'whisper-1' }
  };
  function updateSpeechHelp() {
    const provider = $('#stt-provider').value;
    $('#stt-help').textContent = provider === 'local'
      ? 'Нужен запущенный локальный сервис faster-whisper по указанному URL. Первый запуск может потребовать загрузки модели. Ключ речи не нужен; ключ чата не используется.'
      : 'Нужен endpoint с поддержкой /audio/transcriptions и доступом к указанной модели. Ключ речи независим от ключа чата. Chat-only gateway не подходит.';
  }
  $('#stt-provider').addEventListener('change', () => {
    const defaults = STT_DEFAULTS[$('#stt-provider').value];
    if (defaults) {
      $('#stt-base-url').value = defaults.baseURL;
      $('#stt-model').value = defaults.model;
    }
    updateSpeechHelp();
  });

  function fillSettings() {
    document.querySelectorAll('#provider-seg button').forEach((b) => b.classList.toggle('on', b.dataset.provider === settings.provider));
    $('#key-openai').value = settings.apiKeys.openai || '';
    $('#key-anthropic').value = settings.apiKeys.anthropic || '';
    $('#key-gemini').value = settings.apiKeys.gemini || '';
    $('#base-url').value = (settings.baseURLs && settings.baseURLs[settings.provider]) || '';
    const m = settings.models[settings.provider] || { fast: '', smart: '' };
    $('#model-fast').value = m.fast; $('#model-smart').value = m.smart;
    const provider = settings.sttProvider || 'local';
    $('#stt-provider').value = provider;
    const defaults = STT_DEFAULTS[provider] || { baseURL: '', model: '' };
    $('#stt-base-url').value = settings.sttBaseURL || defaults.baseURL;
    $('#stt-model').value = settings.sttModel || defaults.model;
    $('#stt-api-key').value = settings.sttApiKey || '';
    $('#stt-language').value = settings.sttLanguage || 'auto';
    updateSpeechHelp();
    $('#s-status').textContent = statusText();
  }
  function statusText() {
    const k = settings.apiKeys;
    const has = [k.openai && 'OpenAI', k.anthropic && 'Anthropic', k.gemini && 'Gemini'].filter(Boolean);
    return 'Провайдер ИИ: ' + settings.provider + ' · ключи чата: ' + (has.join(', ') || 'не заданы') + '. Наличие ключей не подтверждает доступ к моделям. Состояние источников звука — в живом конспекте.';
  }
  document.querySelectorAll('#provider-seg button').forEach((b) => b.addEventListener('click', () => {
    if (!settings.baseURLs) settings.baseURLs = {};
    settings.baseURLs[settings.provider] = $('#base-url').value.trim();
    settings.provider = b.dataset.provider;
    document.querySelectorAll('#provider-seg button').forEach((x) => x.classList.toggle('on', x === b));
    const m = settings.models[settings.provider] || { fast: '', smart: '' };
    $('#base-url').value = (settings.baseURLs && settings.baseURLs[settings.provider]) || '';
    $('#model-fast').value = m.fast; $('#model-smart').value = m.smart;
    $('#s-status').textContent = statusText();
  }));
  async function saveSettings() {
    settings.apiKeys.openai = $('#key-openai').value.trim();
    settings.apiKeys.anthropic = $('#key-anthropic').value.trim();
    settings.apiKeys.gemini = $('#key-gemini').value.trim();
    if (!settings.baseURLs) settings.baseURLs = {};
    settings.baseURLs[settings.provider] = $('#base-url').value.trim();
    if (!settings.models[settings.provider]) settings.models[settings.provider] = {};
    settings.models[settings.provider].fast = $('#model-fast').value.trim();
    settings.models[settings.provider].smart = $('#model-smart').value.trim();
    settings.sttProvider = $('#stt-provider').value;
    settings.sttBaseURL = $('#stt-base-url').value.trim();
    settings.sttModel = $('#stt-model').value.trim();
    settings.sttApiKey = $('#stt-api-key').value.trim();
    settings.sttLanguage = $('#stt-language').value;
    await cue.settingsSet(settings);
  }

  // ---- global keys -------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!obScrim.classList.contains('hidden')) finishOnboard();
      else if (!scrim.classList.contains('hidden')) closeSettings();
    }
    if (commandKey(e) && e.key === ',' && !e.altKey && !e.shiftKey) { e.preventDefault(); openSettings(); }
    if (e.key === 'Tab') {
      const dialog = !obScrim.classList.contains('hidden') ? $('#onboard') : !scrim.classList.contains('hidden') ? $('#settings') : null;
      if (!dialog) return;
      const controls = Array.from(dialog.querySelectorAll('button, input, select')).filter((el) => !el.disabled && getComputedStyle(el).visibility !== 'hidden');
      const first = controls[0], last = controls[controls.length - 1];
      if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    }
  });

  // ---- click-through: only the UI blocks the mouse; empty gaps pass to your screen ----
  let ignoring = null;
  function setIgnore(v) { if (v !== ignoring) { ignoring = v; cue.setIgnoreMouse(v); } }
  document.addEventListener('mousemove', (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const overUI = !!(el && el.closest && el.closest('#toolbar, #panel-wrap, #settings-scrim, #onboard-scrim'));
    setIgnore(!overUI);
  });
  setIgnore(true); // start fully click-through; hovering the panel re-enables it

  // ---- onboarding / first-run tutorial -----------------------------------
  const obScrim = $('#onboard-scrim');
  const permissionStep = isWindows ? {
    icon: '🔐',
    title: 'Микрофон и звук в Windows',
    body: 'В разделе конфиденциальности включите <strong>доступ к микрофону</strong>, доступ для приложений и <strong>доступ для классических приложений</strong>. cue — классическое приложение: отдельного переключателя cue может не быть.<br><br>В настройках звука проверьте устройство <strong>ввода</strong> и устройство <strong>вывода</strong>, через которое слышен созвон. Запись звука компьютера не требует включать «Стерео микшер».<br><br>Для снимков экрана в Windows нет отдельного разрешения «Запись экрана». Защищённые окна могут не захватываться. После изменения настроек остановите и снова включите запись.',
    buttons: [
      { label: 'Доступ к микрофону', action: () => cue.openPane('ms-settings:privacy-microphone') },
      { label: 'Устройства звука', action: () => cue.openPane('ms-settings:sound') }
    ]
  } : isMac ? {
    icon: '🔐',
    title: 'Разрешите cue видеть и слышать',
    body: 'В настройках macOS разрешите <strong>cue</strong> доступ к микрофону и запись экрана / системного аудио (название раздела зависит от версии ОС). Микрофон нужен для вашей речи; доступ к экрану — для снимков и звука компьютера.<br><br>Если система попросит, перезапустите cue. Затем включите запись и проверьте состояния обоих источников в живом конспекте.',
    buttons: [
      { label: 'Настройки микрофона', action: () => cue.openPane('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone') },
      { label: 'Настройки записи экрана', action: () => cue.openPane('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture') }
    ]
  } : {
    icon: '🔐', title: 'Доступ к экрану и микрофону',
    body: 'Разрешите cue использовать микрофон и экран в настройках вашей системы. Поддержка звука компьютера зависит от ОС. После запуска записи проверьте состояния источников в живом конспекте.'
  };
  const shortcut = (...keys) => [modifierLabel, ...keys].map((key) => '<span class="kbd">' + key + '</span>').join(' ');
  const OB_STEPS = [
    {
      icon: '👋', title: 'Добро пожаловать в cue',
      body: 'cue помогает вести <strong>живой конспект</strong>, задавать вопросы по разговору и экрану и готовить итоги встречи.<br><br>До записи получите согласие участников и проверьте правила встречи. Аудио и снимки могут отправляться выбранным API-провайдерам; локальный Whisper распознаёт речь на этом компьютере.'
    },
    permissionStep,
    {
      icon: '🔑', title: 'Настройте ИИ и распознавание речи',
      body: 'Для ответов выберите <strong>OpenAI, Anthropic или Gemini</strong>, укажите свой ключ, endpoint и модель. Для этого форка используйте параметры wikivibe и модель <strong>gpt-6.1-sol</strong> в OpenAI-совместимом подключении.<br><br><strong>Речь настраивается отдельно.</strong> По умолчанию выбран локальный Whisper: нужен работающий сервис по адресу <span class="hl">http://127.0.0.1:8765/v1</span>. Для облачного распознавания нужен отдельный сервис с поддержкой аудио; доступ к чату не означает доступ к речи.',
      buttons: [{ label: 'Открыть настройки cue', action: () => { finishOnboard(); openSettings(); } }]
    },
    {
      icon: '🎙️', title: 'Запись и живой конспект',
      body: 'Нажмите <strong>квадрат на верхней панели</strong>, чтобы начать запись. В живом конспекте отдельно показаны <strong>микрофон</strong> и <strong>звук компьютера</strong>. «Захват активен» означает подключённый источник, а не успешное распознавание.<br><br>Произнесите фразу и дождитесь реплики «Вы»; включите звук созвона и проверьте реплики «Собеседник». Текст появляется с задержкой. При ошибке прочитайте сообщение и проверьте разрешения, устройства и сервис речи.<br><br>Нажмите квадрат ещё раз, чтобы остановить запись. cue обработает последние фразы и запросит итог; не начинайте новую запись до завершения, если нужен полный итог текущей встречи.'
    },
    {
      icon: '✨', title: 'Помощь, вопросы и итоги',
      body: '<ul><li>' + shortcut('Enter') + ' — разовая помощь по экрану и разговору. Кнопка <strong>Помощь</strong> включает автоматические подсказки по разговору без снимков.</li><li>' + shortcut('H') + ' — задача на экране. Запись микрофона для снимка не нужна; в вопросе явно укажите «на экране» или «скриншот», если нужен анализ изображения.</li><li><strong>Что сказать?</strong> и <strong>Уточняющие вопросы</strong> используют конспект разговора.</li><li>Введите вопрос и нажмите <span class="kbd">Enter</span>. <span class="kbd">Shift</span> + <span class="kbd">Enter</span> — новая строка.</li><li><strong>Итоги</strong> — сводка текущего разговора. После остановки cue также готовит и сохраняет итог. Кнопка копирования копирует конспект и ответы.</li></ul>'
    },
    {
      icon: '🖥️', title: 'Демонстрация экрана и управление',
      body: 'Исключение cue из захвата экрана работает <strong>по возможности, без гарантии</strong>. Окно может попасть в трансляцию или запись: проверьте предпросмотр в своей программе. Не используйте cue для обхода правил или требований согласия.<br><br><strong>Скрыть</strong> сворачивает панель, но не останавливает запись. ' + shortcut('Shift', 'T') + ' убирает cue в трей; иконка в трее возвращает окно. ' + shortcut('Shift', 'X') + ' — выход. Инструкция доступна по логотипу cue, настройки — по кнопке «…» или ' + shortcut(',') + '.'
    }
  ];
  let obIndex = 0;
  function renderOnboard() {
    const step = OB_STEPS[obIndex];
    $('#ob-icon').textContent = step.icon;
    $('#ob-title').textContent = step.title;
    $('#ob-body').innerHTML = step.body;
    const btns = $('#ob-buttons'); btns.innerHTML = '';
    (step.buttons || []).forEach((b) => { const el = document.createElement('button'); el.textContent = b.label; el.addEventListener('click', b.action); btns.appendChild(el); });
    const dots = $('#ob-dots'); dots.innerHTML = '';
    OB_STEPS.forEach((_, i) => { const d = document.createElement('span'); if (i === obIndex) d.className = 'on'; dots.appendChild(d); });
    $('#ob-back').style.visibility = obIndex === 0 ? 'hidden' : 'visible';
    $('#ob-next').textContent = obIndex === OB_STEPS.length - 1 ? 'Готово' : 'Далее';
    $('#ob-skip').style.visibility = obIndex === OB_STEPS.length - 1 ? 'hidden' : 'visible';
  }
  let onboardReturnFocus = null;
  function showOnboard() {
    onboardReturnFocus = document.activeElement;
    obIndex = 0; renderOnboard(); obScrim.classList.remove('hidden'); setIgnore(false);
    $('#ob-next').focus();
  }
  async function finishOnboard() {
    obScrim.classList.add('hidden');
    if (onboardReturnFocus) onboardReturnFocus.focus();
    if (settings && !settings.onboarded) { settings.onboarded = true; await cue.settingsSet({ onboarded: true }); }
  }
  $('#ob-next').addEventListener('click', () => { if (obIndex === OB_STEPS.length - 1) finishOnboard(); else { obIndex++; renderOnboard(); } });
  $('#ob-back').addEventListener('click', () => { if (obIndex > 0) { obIndex--; renderOnboard(); } });
  $('#ob-skip').addEventListener('click', finishOnboard);
  $('#logo-btn').addEventListener('click', showOnboard);

  // ---- boot --------------------------------------------------------------
  (async function boot() {
    settings = await cue.settingsGet();
    smartBtn.classList.toggle('on', !!settings.smart);
    syncPlaceholder();
    const st = await cue.captureState();
    applyCaptureState(st);
    if (!settings.onboarded) showOnboard();
  })();
})();
