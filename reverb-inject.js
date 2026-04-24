// reverb-inject.js — BetterSuno
// MAIN world, document_start.
//
// Three responsibilities:
//  1. Intercept every AudioContext and patch its graph so all audio routed to
//     destination passes through a configurable dry/wet reverb chain.
//  2. Intercept window.fetch to detect Suno Studio's EditV3Selection analytics
//     events, automatically setting the reverb selection range.
//  3. Bridge commands/status between the isolated-world content script and this
//     MAIN-world script via window CustomEvents.
(function () {
  'use strict';
  if (window.__bettersunoReverbLoaded) return;
  window.__bettersunoReverbLoaded = true;

  // ── State ────────────────────────────────────────────────────────────────
  const S = {
    ctx:       null,    // first captured AudioContext
    insertBus: null,    // GainNode — receives all hijacked destination-connects
    dryGain:   null,
    convolver: null,
    wetGain:   null,
    enabled:   false,
    wetAmount: 0.5,
    roomSize:  'medium',
    selStart:  null,    // seconds | null = no lower bound
    selEnd:    null,    // seconds | null = no upper bound
    rafId:     null,
    _building: false,
  };

  // ── Synthetic impulse response ────────────────────────────────────────────
  function makeSyntheticIR(ctx, roomSize) {
    const cfg = {
      small:  { dur: 0.8,  decay: 3.0, preDelay: 0.005 },
      medium: { dur: 2.2,  decay: 2.2, preDelay: 0.015 },
      large:  { dur: 4.5,  decay: 1.6, preDelay: 0.030 },
    };
    const { dur, decay, preDelay } = cfg[roomSize] || cfg.medium;
    const sr     = ctx.sampleRate;
    const len    = Math.ceil(sr * dur);
    const preLen = Math.ceil(sr * preDelay);
    const ir     = ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = preLen; i < len; i++) {
        const t   = (i - preLen) / sr;
        const env = Math.pow(1 - t / dur, decay);
        d[i] = (Math.random() * 2 - 1) * env;
      }
    }
    return ir;
  }

  // ── Build the reverb chain once we have a context ────────────────────────
  function setupChain(ctx) {
    if (S.insertBus) return; // already done
    S.ctx      = ctx;
    S._building = true;

    S.insertBus = ctx.createGain();
    S.dryGain   = ctx.createGain();
    S.convolver = ctx.createConvolver();
    S.wetGain   = ctx.createGain();

    S.insertBus.gain.value = 1.0;
    S.dryGain.gain.value   = 1.0;
    S.wetGain.gain.value   = 0.0; // silent until enabled

    S.convolver.buffer = makeSyntheticIR(ctx, S.roomSize);

    // Use the original connect so our intercept doesn't loop.
    // Dry:  insertBus → dryGain → destination
    _origConnect.call(S.insertBus, S.dryGain);
    _origConnect.call(S.dryGain,   ctx.destination);

    // Wet:  insertBus → convolver → wetGain → destination
    _origConnect.call(S.insertBus, S.convolver);
    _origConnect.call(S.convolver, S.wetGain);
    _origConnect.call(S.wetGain,   ctx.destination);

    S._building = false;
    console.debug('[BetterSuno] reverb chain built on', ctx);
    emitStatus();
  }

  // ── Patch AudioNode.prototype.connect ────────────────────────────────────
  // · Opportunistically capture the context from `this.context` as a fallback
  //   in case the constructor proxy was missed (e.g. context created in an
  //   inline script that ran before document_start on some page navigations).
  // · Redirect any direct-to-destination connection through our insertBus.
  const _origConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, outIdx, inIdx) {
    // Opportunistic context capture.
    if (!S.ctx && !S._building && this.context) {
      setupChain(this.context);
    }

    if (!S._building && S.ctx && dest === S.ctx.destination) {
      return _origConnect.call(this, S.insertBus, outIdx, inIdx);
    }

    return _origConnect.call(this, dest, outIdx, inIdx);
  };

  // ── Patch AudioContext constructor ────────────────────────────────────────
  const _OrigAC = window.AudioContext || window.webkitAudioContext;
  if (_OrigAC) {
    const PatchedAC = new Proxy(_OrigAC, {
      construct(Target, args) {
        const ctx = new Target(...args);
        if (!S.ctx) setupChain(ctx);
        return ctx;
      },
    });
    window.AudioContext = PatchedAC;
    if (window.webkitAudioContext) window.webkitAudioContext = PatchedAC;
  }

  // ── Patch window.fetch — auto-capture Suno Studio waveform selections ────
  //
  // Suno Studio fires an "EditV3Selection" analytics event to:
  //   https://m-stratovibe.prod.suno.com/agg-receiver-service/v1/events/b
  // every time the user drags a selection on the waveform.  The payload has:
  //   batch[].properties.context.startSeconds / endSeconds
  //
  // We extract these and update S.selStart / S.selEnd automatically, then
  // broadcast a status event so the content-script UI can sync its fields.
  const _origFetch = window.fetch;
  window.fetch = function (...args) {
    const promise = _origFetch.apply(this, args);

    try {
      const url  = typeof args[0] === 'string' ? args[0]
                 : args[0] instanceof URL       ? args[0].href
                 : args[0]?.url ?? '';
      const init = args[1] || {};

      if (url.includes('agg-receiver-service') && init.body) {
        const body = init.body;
        if (body instanceof Blob) {
          body.text().then(tryParseSelectionEvent).catch(() => {});
        } else {
          tryParseSelectionEvent(String(body));
        }
      }
    } catch (_) { /* never break real fetch */ }

    return promise;
  };

  function tryParseSelectionEvent(text) {
    let body;
    try { body = JSON.parse(text); } catch { return; }

    const batch = Array.isArray(body.batch) ? body.batch : [body];
    for (const ev of batch) {
      if (ev?.properties?.actionName !== 'EditV3Selection') continue;

      const ctx    = ev.properties.context || {};
      const start  = ctx.startSeconds != null ? Number(ctx.startSeconds) : null;
      const end    = ctx.endSeconds   != null ? Number(ctx.endSeconds)   : null;

      S.selStart = start;
      S.selEnd   = end;

      console.debug('[BetterSuno] Studio selection:', start, '→', end);
      emitStatus({ selectionUpdated: true });
    }
  }

  // ── Playhead tracking (rAF) ───────────────────────────────────────────────
  function getPlayheadSeconds() {
    for (const el of document.querySelectorAll(
      'audio:not(#bettersuno-audio-element), video'
    )) {
      if (Number.isFinite(el.currentTime) && el.duration > 0) return el.currentTime;
    }
    for (const el of document.querySelectorAll('[role="slider"]')) {
      const max = parseFloat(el.getAttribute('aria-valuemax') || '0');
      const now = parseFloat(el.getAttribute('aria-valuenow') || '0');
      if (max > 100 && now >= 0) return now;
    }
    return null;
  }

  function startMonitor() {
    if (S.rafId !== null) return;
    (function tick() {
      S.rafId = requestAnimationFrame(tick);
      if (!S.ctx || !S.wetGain) return;

      let inSel = true;
      if (S.selStart !== null || S.selEnd !== null) {
        const t = getPlayheadSeconds();
        if (t !== null) {
          const afterStart = (S.selStart === null || t >= S.selStart);
          const beforeEnd  = (S.selEnd   === null || t <= S.selEnd);
          inSel = afterStart && beforeEnd;
        }
      }

      S.wetGain.gain.setTargetAtTime(inSel ? S.wetAmount : 0.0,
                                     S.ctx.currentTime, 0.04);
    })();
  }

  function stopMonitor() {
    if (S.rafId !== null) { cancelAnimationFrame(S.rafId); S.rafId = null; }
    if (S.ctx && S.wetGain) {
      S.wetGain.gain.setTargetAtTime(0, S.ctx.currentTime, 0.04);
    }
  }

  // ── Status broadcast ──────────────────────────────────────────────────────
  function emitStatus(extra) {
    window.dispatchEvent(new CustomEvent('bettersuno:reverb-status', {
      detail: Object.assign({
        hooked:   !!S.ctx,
        enabled:  S.enabled,
        wet:      S.wetAmount,
        roomSize: S.roomSize,
        selStart: S.selStart,
        selEnd:   S.selEnd,
      }, extra || {}),
    }));
  }

  // ── Command listener ──────────────────────────────────────────────────────
  window.addEventListener('bettersuno:reverb-cmd', e => {
    const { type, value } = e.detail || {};
    switch (type) {
      case 'setEnabled':
        S.enabled = !!value;
        if (S.enabled) startMonitor(); else stopMonitor();
        break;
      case 'setWet':
        S.wetAmount = Math.max(0, Math.min(1, Number(value)));
        break;
      case 'setRoomSize':
        if (['small', 'medium', 'large'].includes(value)) {
          S.roomSize = value;
          if (S.ctx && S.convolver) S.convolver.buffer = makeSyntheticIR(S.ctx, value);
        }
        break;
      case 'setSelection':
        S.selStart = (value.start != null) ? Number(value.start) : null;
        S.selEnd   = (value.end   != null) ? Number(value.end)   : null;
        break;
      case 'clearSelection':
        S.selStart = null;
        S.selEnd   = null;
        break;
      case 'getStatus':
        break; // falls through to emitStatus
    }
    emitStatus();
  });

  console.debug('[BetterSuno] reverb-inject loaded');
})();
