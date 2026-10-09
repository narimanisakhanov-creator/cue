const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, globalShortcut, screen, session, desktopCapturer, shell } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const store = require('./src/store');
const { captureScreenshot } = require('./src/screen');
const { createSTT } = require('./src/stt');
const { createLLM } = require('./src/llm');
const { MODES } = require('./src/prompts');
const { rms16 } = require('./src/wav');
const { saveRecap } = require('./src/recap-export');

let win = null;
let tray = null;

// -------- capture / transcript state --------
const state = { capturing: false, busy: false, transcribing: { you: false, them: false } };
let sttDisabled = false; // terminal configuration failure; reset on settings change/start
let lastSttError = '';
const buffers = { you: [], them: [] };
const bufferedBytes = { you: 0, them: 0 };
const overflowReported = { you: false, them: false };
const MAX_BUFFER_BYTES = 16000 * 2 * 30; // bounded waiting audio per source
const SILENCE_CONTEXT_BYTES = 16000 * 2 * 0.2;
const STOP_DRAIN_MS = 1200; // upper bound on the wait for the renderer to hand over the tail audio
const STT_RETRY_MS = 10000; // transient speech errors back off, then retry: a local service may come up
let sttCooldownUntil = 0;
const transcript = []; // { channel, text, ts }
const FLUSH_MS = 2200;
const MIN_BYTES = Math.floor(16000 * 2 * 0.6); // ~0.6s
const RMS_GATE = 240;
let flushTimer = null;
let captureGeneration = 0;
let drainWaiter = null;
let finalizingGeneration = null;
const pendingTranscriptions = { you: null, them: null };
let activeFeatureDone = null;
const ASSIST_IDLE_MS = 700;
let assistActive = false;
let assistTimer = null;
let assistQueued = false;
let assistTurnCount = 0;

function send(channel, data) { if (win && !win.isDestroyed()) win.webContents.send(channel, data); }

const SCREEN_HINTS = ['экран', 'скрин', 'код', 'задач', 'leetcode', 'ошибк', 'сайт', 'страниц', 'кнопк', 'таблиц', 'консол', 'терминал', 'интерфейс', 'формул', 'график'];
function shouldCaptureScreen(mode, userText, automatic) {
  if (automatic) return false;
  if (mode === 'leetcode' || mode === 'assist') return true;
  if (mode !== 'ask') return false;
  return SCREEN_HINTS.some((hint) => String(userText || '').toLowerCase().includes(hint));
}

const DUPLICATE_WINDOW_MS = 12000;
function normalizeSpeech(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function isDuplicateTurn(channel, text) {
  const normalized = normalizeSpeech(text);
  if (normalized.length < 6) return false;
  const words = new Set(normalized.split(' '));
  return transcript.slice(-12).some((previous) => {
    if (Date.now() - previous.ts > DUPLICATE_WINDOW_MS) return false;
    const previousNormalized = normalizeSpeech(previous.text);
    if (normalized === previousNormalized) return true;
    const previousWords = new Set(previousNormalized.split(' '));
    if (words.size < 4 || previousWords.size < 4) return false;
    let intersection = 0;
    words.forEach((word) => { if (previousWords.has(word)) intersection += 1; });
    const similarity = intersection / (words.size + previousWords.size - intersection);
    const shorter = Math.min(normalized.length, previousNormalized.length);
    if (channel === previous.channel && shorter >= 18 && (normalized.includes(previousNormalized) || previousNormalized.includes(normalized))) return true;
    return similarity >= (channel === previous.channel ? 0.55 : 0.78);
  });
}

function needsReply(text) {
  const value = text.trim().toLowerCase();
  return value.includes('?') || /^(что|как|где|когда|почему|зачем|кто|какой|можешь|можно|нужно|будешь|ты\s)/i.test(value) || /\b(подскажи|объясни|помоги|выбери|реши|ответь|что думаешь|как считаешь)\b/i.test(value);
}

function toggleWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) win.hide();
  else { win.showInactive(); win.focus(); }
  updateTrayMenu();
}

function hideToTray() {
  if (!win || win.isDestroyed()) return;
  win.hide();
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  const visible = !!(win && !win.isDestroyed() && win.isVisible());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: visible ? 'Скрыть cue' : 'Показать cue', click: toggleWindow },
    { label: 'Настройки', click: () => { if (win && !win.isDestroyed()) { win.showInactive(); send('settings:open'); } } },
    { type: 'separator' },
    { label: 'Выйти', click: () => app.quit() }
  ]));
}

function createTray() {
  if (tray) return;
  const icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAAAUklEQVR4nM2TwQoAIAhDXf//z+uc6ZIocFfnc6CadRNUkSQXM5D6UQF4RUAoiG+gqG2QU5rMN+y1WEyT+Z8lGu1A/baGaNrNQeLbi5gAyrdopwlK7E/hnNmM7QAAAABJRU5ErkJggg==')
    .resize({ width: 18, height: 18 });
  tray = new Tray(icon);
  tray.setToolTip('cue');
  tray.on('click', toggleWindow);
  tray.on('right-click', updateTrayMenu);
  updateTrayMenu();
}

// -------- window --------
function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 700, H = 600;
  win = new BrowserWindow({
    width: W,
    height: H,
    x: Math.round(workArea.x + (workArea.width - W) / 2),
    y: workArea.y + 6,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // Invisibility + overlay behavior. Set CUE_NO_PROTECT=1 to disable for debugging.
  win.setContentProtection(!process.env.CUE_NO_PROTECT);            // excluded from screen capture (best-effort)
  win.setAlwaysOnTop(true, process.platform === 'darwin' ? 'screen-saver' : 'floating', 1);
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (typeof win.setHiddenInMissionControl === 'function') win.setHiddenInMissionControl(true);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.webContents.on('did-finish-load', () => win.showInactive());
  win.webContents.on('render-process-gone', (_e, d) => console.log('[cue] renderer gone', JSON.stringify(d)));
}

// -------- audio ingest --------
// PCM arrives from the renderer as { generation, pcm }. Audio tagged with a superseded
// generation is dropped, and the waiting buffer is bounded so a silent room cannot grow it forever.
function trimBuffer(channel) {
  while (bufferedBytes[channel] > MAX_BUFFER_BYTES && buffers[channel].length > 1) {
    bufferedBytes[channel] -= buffers[channel].shift().length;
  }
}

function resetBuffer(channel) {
  buffers[channel] = [];
  bufferedBytes[channel] = 0;
  overflowReported[channel] = false;
}

function pushPcm(channel, payload) {
  if (!payload || (payload.generation !== captureGeneration && payload.generation !== finalizingGeneration)) return;
  const raw = payload.pcm;
  let buffer = null;
  if (Buffer.isBuffer(raw)) buffer = raw;
  else if (ArrayBuffer.isView(raw)) buffer = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  else if (raw instanceof ArrayBuffer) buffer = Buffer.from(raw);
  if (!buffer || !buffer.length) return;
  buffers[channel].push(buffer);
  bufferedBytes[channel] += buffer.length;
  trimBuffer(channel);
  if (bufferedBytes[channel] >= MAX_BUFFER_BYTES && !overflowReported[channel]) {
    overflowReported[channel] = true;
    send('status', { message: 'Звук ' + (channel === 'you' ? 'микрофона' : 'компьютера') + ' копится быстрее, чем распознаётся: старые фрагменты отбрасываются. Проверьте сервис распознавания речи в настройках.' });
  }
}

// Put audio back so a failed (transient) transcription does not cost us the phrase.
function restorePcm(channel, pcm, generation) {
  if (generation !== captureGeneration && generation !== finalizingGeneration) return;
  buffers[channel].unshift(pcm);
  bufferedBytes[channel] += pcm.length;
  trimBuffer(channel);
}

// Resolves when the renderer reports its sources drained, or after STOP_DRAIN_MS at the latest.
function waitForDrain(generation) {
  return new Promise((resolve) => {
    const done = () => {
      if (drainWaiter && drainWaiter.generation === generation) drainWaiter = null;
      resolve();
    };
    drainWaiter = { generation, resolve: done };
    setTimeout(done, STOP_DRAIN_MS); // the renderer may be gone; never hang the stop path
  });
}

// -------- STT flushing --------
async function flushChannel(channel, options = {}) {
  if (pendingTranscriptions[channel]) return pendingTranscriptions[channel];
  if (sttDisabled) return;
  const allowStopped = options.allowStopped === true;
  const allowShort = options.allowShort === true;
  if (Date.now() < sttCooldownUntil && !allowStopped) return; // transient failure just happened; keep the audio for the retry
  const chunks = buffers[channel];
  if (!chunks.length) return;
  const generation = options.generation === undefined ? captureGeneration : options.generation;
  const pcm = Buffer.concat(chunks);
  buffers[channel] = [];
  bufferedBytes[channel] = 0;
  // Too short to be worth a request: keep it and let the next window carry it over, rather
  // than dropping the beginning of an utterance.
  if (pcm.length < MIN_BYTES && !allowShort) { restorePcm(channel, pcm, generation); return; }
  if (rms16(pcm) < RMS_GATE) return; // silence gate: nothing was said

  state.transcribing[channel] = true;
  const task = (async () => {
    try {
      const settings = store.getSettings();
      let stt = null;
      try {
        stt = createSTT(settings);
      } catch (e) {
        stt = { available: false, error: (e && e.message) || String(e) };
      }
      if (!stt.available) {
        sttDisabled = true;
        const detail = stt.error ? ' Причина: ' + stt.error : '';
        if (lastSttError !== detail) {
          lastSttError = detail;
          send('status', { message: 'Распознавание речи недоступно. Настройте сервис речи в разделе «Настройки» → «Распознавание речи».' + detail + ' Ответы по экрану и вопросы работают без него.' });
        }
        return;
      }
      const res = await stt.transcribe(pcm);
      if (res.error) {
        if (generation === captureGeneration && (state.capturing || finalizingGeneration === generation)) handleSttError(res.error, settings, channel, pcm, generation);
        return;
      }
      sttDisabled = false;
      lastSttError = '';
      if (generation !== captureGeneration || (!state.capturing && finalizingGeneration !== generation)) return;
      const text = res.text && res.text.trim();
      if (text && !isDuplicateTurn(channel, text)) {
        const turn = { channel, text, ts: Date.now() };
        transcript.push(turn);
        send('transcript', turn);
        if (channel === 'them' && needsReply(text)) scheduleAutoAssist();
      }
    } catch (e) {
      console.log('[stt] error', e && e.message);
    }
  })();
  pendingTranscriptions[channel] = task;
  try {
    await task;
  } finally {
    if (pendingTranscriptions[channel] === task) pendingTranscriptions[channel] = null;
    state.transcribing[channel] = false;
  }
}

async function waitForTranscriptions() {
  const pending = Object.values(pendingTranscriptions).filter(Boolean);
  if (pending.length) await Promise.all(pending);
}

function scheduleAutoAssist() {
  clearTimeout(assistTimer);
  if (!assistActive || !state.capturing) return;
  assistTimer = setTimeout(() => {
    assistTimer = null;
    if (!assistActive || !state.capturing || transcript.length <= assistTurnCount) return;
    if (state.busy) {
      assistQueued = true;
      return;
    }
    assistTurnCount = transcript.length;
    runFeature('assist', '', { automatic: true });
  }, ASSIST_IDLE_MS);
}

function setAssistActive(active) {
  assistActive = active;
  assistQueued = false;
  clearTimeout(assistTimer);
  assistTimer = null;
  if (active) {
    assistTurnCount = transcript.length;
    send('status', { message: 'Помощь в реальном времени включена.' });
  } else {
    send('status', { message: 'Помощь в реальном времени выключена.' });
  }
  return active;
}

async function finalizeCapture(generation) {
  try {
    await waitForDrain(generation); // the renderer hands over its tail audio, or STOP_DRAIN_MS elapses
    await waitForTranscriptions();
    if (state.capturing || generation !== captureGeneration) return;

    await Promise.all([
      flushChannel('you', { generation, allowStopped: true, allowShort: true }),
      flushChannel('them', { generation, allowStopped: true, allowShort: true })
    ]);
    if (state.capturing || generation !== captureGeneration) return;

    if (!transcript.length) {
      send('status', { message: 'Не удалось распознать речь для итогов созвона.' });
      return;
    }
    send('status', { message: 'Транскрипция готова. Готовлю итог созвона...' });
    if (activeFeatureDone) await activeFeatureDone;
    if (state.capturing || generation !== captureGeneration) return;
    await runFeature('recap', '');
  } finally {
    if (finalizingGeneration === generation) finalizingGeneration = null;
  }
}

function handleSttError(err, settings, channel, pcm, generation) {
  console.log('[stt] error', err.provider, err.status, err.code, err.message);
  const local = err.provider === 'local';
  const noAccess = !local && (err.status === 403 || err.status === 401 || err.code === 'model_not_found');
  const noService = local && !err.status; // connection refused / DNS / timeout: the local service is not answering
  if (noAccess) {
    if (sttDisabled) return;
    sttDisabled = true; // a key without speech access will not recover on its own
    send('status', { message: 'Распознавание выключено: у ключа ' + err.provider + ' нет доступа к модели речи (403). Ответы по экрану работают. Дайте ключу доступ к транскрипции или выберите другой сервис речи в настройках.' });
    return;
  }
  // Transient (or not-yet-started service): keep the audio and retry instead of disabling listening.
  sttCooldownUntil = Date.now() + STT_RETRY_MS;
  if (pcm) restorePcm(channel, pcm, generation);
  const detail = err.status ? err.status + ' ' + err.message : err.message;
  if (noService) {
    send('status', { message: 'Локальный сервис распознавания не отвечает по адресу из настроек. Запустите его и проверьте URL. Запись продолжается, звук не потерян.' });
  } else {
    send('status', { message: 'Ошибка распознавания (' + err.provider + '): ' + detail + '. Повторю попытку через ' + Math.round(STT_RETRY_MS / 1000) + ' с.' });
  }
}

function startFlushLoop() {
  if (flushTimer) return;
  flushTimer = setInterval(() => { flushChannel('you'); flushChannel('them'); }, FLUSH_MS);
}
function stopFlushLoop() { if (flushTimer) { clearInterval(flushTimer); flushTimer = null; } }

function openRecapInMarkEdit(filePath) {
  if (process.platform !== 'darwin') {
    shell.openPath(filePath).catch((error) => console.log('[recap] open error', error && error.message));
    return;
  }

  execFile('/usr/bin/open', ['-a', 'MarkEdit', filePath], (error) => {
    if (!error) return;
    // MarkEdit may not be installed or may not be registered by its bundle name.
    // Opening through the default file association still makes the export useful.
    shell.openPath(filePath).catch((fallbackError) => console.log('[recap] open error', fallbackError && fallbackError.message));
  });
}

// -------- capture toggle --------
// Mic + system audio are both captured in the RENDERER (getUserMedia for the mic,
// getDisplayMedia loopback for system audio) so they run inside cue's own process
// and use cue's own Screen-Recording grant — no separate helper binary to authorize.
function setCapturing(active) {
  if (active) captureGeneration += 1;
  state.capturing = active;
  const stoppedGeneration = active ? null : captureGeneration;
  if (active) {
    finalizingGeneration = null;
    drainWaiter = null;
    sttDisabled = false;
    sttCooldownUntil = 0;
    lastSttError = '';
    transcript.length = 0;
    resetBuffer('you');
    resetBuffer('them');
    assistTurnCount = 0;
    assistQueued = false;
    startFlushLoop();
  } else {
    finalizingGeneration = stoppedGeneration;
    clearTimeout(assistTimer);
    assistTimer = null;
    assistQueued = false;
    stopFlushLoop();
  }
  send('capture:state', { active, generation: captureGeneration });
  if (stoppedGeneration !== null) {
    send('status', { message: 'Запись остановлена. Догружаю последние фразы...' });
    finalizeCapture(stoppedGeneration).catch((e) => console.log('[recap] error', e && e.message));
  }
  return active;
}

// -------- feature runner --------
async function runFeature(mode, userText, options = {}) {
  if (state.busy) return;
  const def = MODES[mode];
  if (!def) return;
  state.busy = true;
  let resolveFeature;
  activeFeatureDone = new Promise((resolve) => { resolveFeature = resolve; });
  const featureGeneration = captureGeneration;
  const featureTranscript = transcript.map((turn) => ({ ...turn }));
  const featureSend = (channel, payload) => { if (featureGeneration === captureGeneration) send(channel, payload); };
  try {
    const settings = store.getSettings();
    const llm = createLLM(settings, { fast: mode === 'assist', maxTokens: mode === 'assist' ? 450 : undefined });
    const userBubble = def.userBubble !== null ? def.userBubble : (mode === 'ask' ? userText : null);
    const appendResponse = (mode === 'assist' && assistActive) || mode === 'recap';
    send('llm:start', { userBubble, small: !!def.small, append: appendResponse, responseLabel: mode === 'recap' ? 'Итог' : 'Помощь' });

    if (!llm.ready) {
      send('llm:error', { message: 'Add your ' + settings.provider + ' API key in Settings (gear icon) to start. Model: ' + (llm.model || 'unset') + '.' });
      return;
    }

    let imageDataUrl = null;
    if (def.needsScreen && shouldCaptureScreen(mode, userText, options.automatic)) {
      try {
        imageDataUrl = await captureScreenshot();
        if (!imageDataUrl) throw new Error('Снимок экрана пуст. Проверьте доступ к захвату экрана.');
      } catch (error) {
        send('llm:error', { message: 'Не удалось получить экран: ' + error.message });
        return;
      }
    }

    const built = def.build({ transcript: featureTranscript, userText: userText || '' });
    const output = await llm.stream({
      system: def.system,
      turns: [{ role: 'user', text: built }],
      imageDataUrl,
      onToken: (t) => featureSend('llm:token', { text: t })
    });
    if (featureGeneration !== captureGeneration) return;
    const suppress = mode === 'assist' && /^NO_ACTION[.!]?$/i.test(String(output || '').trim());
    let savedRecap = null;
    if (mode === 'recap' && output && String(output).trim()) {
      try {
        savedRecap = await saveRecap({
          documentsPath: app.getPath('documents'),
          summary: output,
          transcript: featureTranscript
        });
        send('status', { message: `Итог сохранён: ${savedRecap.fileName}` });
        openRecapInMarkEdit(savedRecap.filePath);
      } catch (error) {
        console.log('[recap] save error', error && error.message);
        send('status', { message: 'Итог готов, но не удалось сохранить Markdown-файл.' });
      }
    }
    send('llm:done', { suppress, recapFile: savedRecap && savedRecap.filePath });
  } catch (e) {
    featureSend('llm:error', { message: 'Ошибка: ' + (e && e.message ? e.message : String(e)) });
  } finally {
    state.busy = false;
    activeFeatureDone = null;
    resolveFeature();
    if (featureGeneration !== captureGeneration) send('llm:idle');
    if (mode === 'assist' && assistActive && state.capturing && assistQueued) {
      assistQueued = false;
      scheduleAutoAssist();
    }
  }
}

// -------- IPC --------
ipcMain.handle('settings:get', () => store.getSettings());
ipcMain.handle('settings:set', (_e, patch) => {
  sttDisabled = false;
  sttCooldownUntil = 0;
  lastSttError = '';
  return store.setSettings(patch);
});
ipcMain.handle('assist:toggle', () => setAssistActive(!assistActive));
ipcMain.handle('capture:toggle', () => setCapturing(!state.capturing));
ipcMain.handle('capture:state', () => ({ active: state.capturing, generation: captureGeneration }));
ipcMain.on('ask', (_e, payload) => runFeature(payload.mode, payload.text));
ipcMain.on('mic:pcm', (_e, payload) => pushPcm('you', payload));
ipcMain.on('system:pcm', (_e, payload) => pushPcm('them', payload));
ipcMain.on('audio:drained', (_e, payload) => {
  if (!payload || payload.generation !== captureGeneration) return;
  if (drainWaiter && drainWaiter.generation === payload.generation) drainWaiter.resolve();
});
ipcMain.on('audio:status', (_e, payload) => {
  if (!payload || !['you', 'them'].includes(payload.channel) || !['starting', 'active', 'error', 'stopped'].includes(payload.state)) return;
  // A status from a superseded session must not overwrite the state of the current one.
  if (payload.generation !== undefined && payload.generation !== captureGeneration && payload.generation !== finalizingGeneration) return;
  send('audio:status', { channel: payload.channel, state: payload.state, message: String(payload.message || '').slice(0, 500) });
});
ipcMain.on('mouse:ignore', (_e, v) => { if (win) win.setIgnoreMouseEvents(!!v, { forward: true }); });
ipcMain.on('open-pane', (_e, url) => {
  const allowed = process.platform === 'win32'
    ? ['ms-settings:privacy-microphone', 'ms-settings:sound']
    : ['x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone', 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'];
  if (allowed.includes(url)) shell.openExternal(url).catch((error) => send('status', { message: 'Не удалось открыть настройки: ' + error.message }));
});
ipcMain.on('settings:open', () => send('settings:open'));
ipcMain.on('window:hide-to-tray', hideToTray);
ipcMain.on('log', (_e, msg) => console.log('[renderer]', msg));

// -------- shortcuts --------
function registerShortcuts() {
  globalShortcut.register('CommandOrControl+Return', () => runFeature('assist', ''));
  globalShortcut.register('CommandOrControl+H', () => runFeature('leetcode', ''));
  globalShortcut.register('CommandOrControl+Shift+T', hideToTray);
  globalShortcut.register('CommandOrControl+Shift+X', () => app.quit());
}

// -------- lifecycle --------
app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  const allowMedia = (permission) => permission === 'media' || permission === 'microphone' || permission === 'audioCapture' || permission === 'display-capture';
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowMedia(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowMedia(permission));

  // System-audio loopback for getDisplayMedia: hand back a screen source with 'loopback'
  // audio so the renderer can capture what's playing (Zoom/Meet) using cue's own grant.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      if (sources.length) callback({ video: sources[0], audio: 'loopback' });
      else callback();
    }).catch(() => callback());
  }, { useSystemPicker: false });

  createWindow();
  createTray();
  registerShortcuts();

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); });
app.on('window-all-closed', () => app.quit());
