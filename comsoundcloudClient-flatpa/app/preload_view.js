// preload-view.js – Injected into SoundCloud BrowserView & OAuth popups
// Includes:
// 1. OAuth anti-detection (Google / Apple / SoundCloud login)
// 2. Real-time WebAudio Studio DSP (Natural Bass Boost, 5-band EQ, Warmth Saturator, Preamp, Soft Limiter)
// 3. High-performance Custom Wallpaper, Blur, Theme, Rounded Corners & Batched Particle Engine
// 4. In-app Glassmorphic Studio Drawers (Audio DSP, Theme & Wallpaper, Genius Lyrics)
// 5. Full 2026 SoundCloud Track Page UI Engine with:
//    - Real comments under DETAILS and timed avatars + popovers on the waveform
//    - Original SoundCloud hover animation on waveform & bottom playback bar (left of cursor brightens)
//    - Automatic track switching when the next/previous track starts playing
//    - 60 FPS smooth playhead & timeline movement
//    - Collapsible DETAILS section with fade mask & "Show more / Show less" toggle

const { ipcRenderer, webFrame } = require('electron');

// ------------------------------------------------------------------
// 1. Main-World OAuth Anti-Detection, WebAudio DSP & Media Hooks
// ------------------------------------------------------------------
const MAIN_WORLD_BOOTSTRAP = `
(() => {
  try {
    if (typeof Error.isError !== 'function') {
      Error.isError = function(val) {
        return Boolean(val && (val instanceof Error || Object.prototype.toString.call(val) === '[object Error]'));
      };
    }
    if (typeof RegExp.escape !== 'function') {
      RegExp.escape = function(str) {
        return String(str).replace(/[\\^$*+?.()|[\\]{}\\/-]/g, '\\\\$&');
      };
    }
    if (typeof Promise.try !== 'function') {
      Promise.try = function(fn, ...args) {
        return new Promise((resolve) => resolve(fn(...args)));
      };
    }
    if (typeof window.Float16Array === 'undefined') {
      window.Float16Array = Float32Array;
    }
    if (typeof Uint8Array.fromBase64 !== 'function') {
      Uint8Array.fromBase64 = function(b64) {
        const bin = atob(String(b64 || '').replace(/-/g, '+').replace(/_/g, '/'));
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
      };
    }
    if (!window.scheduler) window.scheduler = {};
    if (typeof window.scheduler.yield !== 'function') {
      window.scheduler.yield = () => new Promise((r) => setTimeout(r, 0));
    }
  } catch (e) {}

  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
    const host = window.location.hostname || '';
    if (host.includes('google.com') || host.includes('gstatic.com') || host.includes('youtube.com')) {
      const ffUA = 'Mozilla/5.0 (X11; Fedora; Linux x86_64; rv:135.0) Gecko/20100101 Firefox/135.0';
      Object.defineProperty(navigator, 'userAgent', { get: () => ffUA, configurable: true });
      Object.defineProperty(navigator, 'appVersion', { get: () => '5.0 (X11)', configurable: true });
      Object.defineProperty(navigator, 'vendor', { get: () => '', configurable: true });
      Object.defineProperty(navigator, 'userAgentData', { get: () => undefined, configurable: true });
      try { delete window.chrome; } catch (e) {}
    }
  } catch (e) {}

  if (!window.location.hostname.includes('soundcloud.com') && window.location.hostname !== '') return;

  // Permanently suppress OneTrust / SoundCloud Cookie Consent banners
  try {
    const isoNow = new Date().toISOString();
    const exp = new Date(Date.now() + 365 * 10 * 86400 * 1000).toUTCString();
    document.cookie = 'OptanonAlertBoxClosed=' + isoNow + '; path=/; domain=.soundcloud.com; expires=' + exp + '; SameSite=Lax';
    document.cookie = 'OptanonConsent=isGpcEnabled=0&datestamp=' + encodeURIComponent(isoNow) + '&version=202402.1.0&isIABGlobal=false&hosts=&consentId=sc-electron; path=/; domain=.soundcloud.com; expires=' + exp + '; SameSite=Lax';
    localStorage.setItem('OptanonAlertBoxClosed', isoNow);
  } catch (e) {}

  if (window.__scDspInitialized) return;
  window.__scDspInitialized = true;

  window.__scDspState = {
    eqPreset: 'flat',
    antiClip: true,
    bassBoost: 0,
    subBass: 0,
    deepBass: 0,
    punchBass: 0,
    upperBass: 0,
    mudCut: 0,
    lowMids: 0,
    mids: 0,
    upperMids: 0,
    presence: 0,
    treble: 0,
    airBand: 0,
    warmth: 0,
    stereoWidth: 0,
    reverbMix: 0,
    speedPitch: 1.0,
    preamp: 1.0
  };

  window.__scDspChains = [];
  window.__scTrackedMediaElements = new Set();
  window.__scTargetVolume = 1.0;
  window.__scTargetMuted = false;

  function isDspActive(st) {
    if (!st) return false;
    return (
      st.antiClip === false ||
      Math.abs(Number(st.bassBoost) || 0) > 0.01 ||
      Math.abs(Number(st.subBass) || 0) > 0.01 ||
      Math.abs(Number(st.deepBass) || 0) > 0.01 ||
      Math.abs(Number(st.punchBass) || 0) > 0.01 ||
      Math.abs(Number(st.upperBass) || 0) > 0.01 ||
      Math.abs(Number(st.mudCut) || 0) > 0.01 ||
      Math.abs(Number(st.lowMids) || 0) > 0.01 ||
      Math.abs(Number(st.mids) || 0) > 0.01 ||
      Math.abs(Number(st.upperMids) || 0) > 0.01 ||
      Math.abs(Number(st.presence) || 0) > 0.01 ||
      Math.abs(Number(st.treble) || 0) > 0.01 ||
      Math.abs(Number(st.airBand) || 0) > 0.01 ||
      Math.abs(Number(st.warmth) || 0) > 0.01 ||
      Math.abs(Number(st.stereoWidth) || 0) > 0.01 ||
      Math.abs(Number(st.reverbMix) || 0) > 0.01 ||
      Math.abs((Number(st.speedPitch) || 1.0) - 1.0) > 0.005 ||
      Math.abs((Number(st.preamp) || 1.0) - 1.0) > 0.01
    );
  }

  function applyPlaybackSpeedAndPitch(el) {
    try {
      if (!el || el.id === 'sc-wallpaper-video') return;
      const spd = Math.max(0.5, Math.min(2.0, Number(window.__scDspState.speedPitch) || 1.0));
      const pitchShiftMode = Math.abs(spd - 1.0) > 0.005;
      if ('preservesPitch' in el) el.preservesPitch = !pitchShiftMode;
      if ('mozPreservesPitch' in el) el.mozPreservesPitch = !pitchShiftMode;
      if ('webkitPreservesPitch' in el) el.webkitPreservesPitch = !pitchShiftMode;
      if (Math.abs((el.playbackRate || 1.0) - spd) > 0.004) {
        el.playbackRate = spd;
      }
      if (Math.abs((el.defaultPlaybackRate || 1.0) - spd) > 0.004) {
        el.defaultPlaybackRate = spd;
      }
    } catch (e) {}
  }

  function enforceSteadyVolume(el) {
    try {
      if (!el) return;
      const sliderEl = document.querySelector('.volume__sliderWrapper');
      const volEl = document.querySelector('.volume');
      if (sliderEl) {
        const rawVal = parseFloat(sliderEl.getAttribute('aria-valuenow'));
        if (Number.isFinite(rawVal)) {
          window.__scTargetVolume = Math.max(0, Math.min(1, rawVal));
        }
      }
      if (volEl) {
        window.__scTargetMuted = volEl.classList.contains('muted');
      }
      const targetV = window.__scTargetMuted ? 0 : window.__scTargetVolume;
      if (Number.isFinite(targetV)) {
        if (Math.abs(el.volume - targetV) > 0.005) {
          el.volume = targetV;
        }
        if (el.muted !== window.__scTargetMuted) {
          el.muted = window.__scTargetMuted;
        }
      }
    } catch (e) {}
  }

  function registerMediaEl(el) {
    if (!el || el.id === 'sc-wallpaper-video' || window.__scTrackedMediaElements.has(el)) return;
    window.__scTrackedMediaElements.add(el);
    window.__scActiveAudioElement = el;
    enforceSteadyVolume(el);
    applyPlaybackSpeedAndPitch(el);
    const syncTimeAttr = () => {
      try {
        if (!el.paused || el.currentTime > 0) {
          window.__scActiveAudioElement = el;
          if (el.currentTime < 2.0) {
            enforceSteadyVolume(el);
          }
          if (document.documentElement) {
            document.documentElement.dataset.scAudioTime = String(el.currentTime || 0);
            if (Number.isFinite(el.duration) && el.duration > 0) {
              document.documentElement.dataset.scAudioDur = String(el.duration);
            }
            document.documentElement.dataset.scAudioPerf = String(performance.now());
            document.documentElement.dataset.scAudioPaused = String(Boolean(el.paused));
          }
        }
      } catch (e) {}
    };
    const onStartOrVolume = () => {
      enforceSteadyVolume(el);
      applyPlaybackSpeedAndPitch(el);
      if (typeof window.__scRouteElementToDsp === 'function') {
        try { window.__scRouteElementToDsp(el); } catch (e) {}
      }
      if (window.__scSharedMediaCtx && window.__scSharedMediaCtx.state === 'suspended') {
        window.__scSharedMediaCtx.resume().catch(() => {});
      }
      syncTimeAttr();
    };
    el.addEventListener('ratechange', () => {
      applyPlaybackSpeedAndPitch(el);
    }, { passive: true });
    el.addEventListener('loadstart', onStartOrVolume, { passive: true });
    el.addEventListener('loadedmetadata', onStartOrVolume, { passive: true });
    el.addEventListener('canplay', onStartOrVolume, { passive: true });
    el.addEventListener('play', onStartOrVolume, { passive: true });
    el.addEventListener('playing', onStartOrVolume, { passive: true });
    el.addEventListener('volumechange', () => {
      try {
        if (el.currentTime < 1.8 && !el.paused && !window.__scTargetMuted && el.volume > 0 && el.volume < window.__scTargetVolume * 0.92) {
          el.volume = window.__scTargetVolume;
        }
      } catch (e) {}
    }, { passive: true });
    el.addEventListener('timeupdate', syncTimeAttr, { passive: true });
    el.addEventListener('pause', syncTimeAttr, { passive: true });
    el.addEventListener('seeked', syncTimeAttr, { passive: true });
    el.addEventListener('durationchange', syncTimeAttr, { passive: true });
  }

  // Hook Audio constructor, createElement('audio'), and HTMLMediaElement.src
  // so every <audio> has crossOrigin='anonymous' and is captured for WebAudio DSP on ALL tracks
  try {
    const OrigAudio = window.Audio;
    if (typeof OrigAudio === 'function') {
      const PatchedAudio = function(src) {
        const el = new OrigAudio();
        try { el.crossOrigin = 'anonymous'; } catch (e) {}
        registerMediaEl(el);
        if (src !== undefined) {
          el.src = src;
        }
        return el;
      };
      PatchedAudio.prototype = OrigAudio.prototype;
      window.Audio = PatchedAudio;
    }

    const origCreateElement = document.createElement;
    document.createElement = function(tagName, options) {
      const el = origCreateElement.apply(this, arguments);
      try {
        const t = String(tagName || '').toLowerCase();
        if (t === 'audio') {
          el.crossOrigin = 'anonymous';
          registerMediaEl(el);
        }
      } catch (e) {}
      return el;
    };

    const origAddEL = HTMLMediaElement.prototype.addEventListener;
    HTMLMediaElement.prototype.addEventListener = function() {
      registerMediaEl(this);
      return origAddEL.apply(this, arguments);
    };

    const origSetAttr = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(name, value) {
      if (this instanceof HTMLMediaElement && String(name).toLowerCase() === 'src') {
        try {
          const vStr = String(value || '');
          if (vStr && !vStr.startsWith('blob:') && !vStr.startsWith('data:') && !this.crossOrigin) {
            this.crossOrigin = 'anonymous';
          }
        } catch (e) {}
        registerMediaEl(this);
      }
      return origSetAttr.apply(this, arguments);
    };

    const srcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    if (srcDesc && srcDesc.set) {
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        get: srcDesc.get,
        set: function(v) {
          try {
            const vStr = String(v || '');
            if (vStr && !vStr.startsWith('blob:') && !vStr.startsWith('data:') && !this.crossOrigin) {
              this.crossOrigin = 'anonymous';
            }
          } catch (e) {}
          registerMediaEl(this);
          return srcDesc.set.call(this, v);
        },
        configurable: true
      });
    }
  } catch (e) {}

  function makeWarmthCurve(amountPct, antiClipOn = true) {
    const n = 8192;
    const curve = new Float32Array(n);
    if (antiClipOn) {
      // Smooth studio analog tube saturation + soft peak ceiling (no harsh rattle)
      const k = Math.max(0.001, (amountPct / 100) * 3.8);
      const norm = Math.tanh(k);
      const makeup = 1.0 + (amountPct / 100) * 0.22;
      for (let i = 0; i < n; i++) {
        const x = (i * 2) / n - 1;
        const y = (Math.tanh(k * x) / norm) * makeup;
        curve[i] = Math.tanh(y * 1.15);
      }
    } else {
      // Raw Overdrive / Intentional Clipping ("чтоб хрипело когда надо мне")
      const drive = 1.0 + (amountPct / 100) * 11.5;
      for (let i = 0; i < n; i++) {
        const x = (i * 2) / n - 1;
        let y = x * drive;
        // Asymmetric raw speaker-rattle hard clipping with gritty harmonics
        if (y > 0.78) y = 0.78 + (y - 0.78) * 0.08;
        if (y < -0.72) y = -0.72 + (y + 0.72) * 0.06;
        curve[i] = Math.max(-1.0, Math.min(1.0, y));
      }
    }
    return curve;
  }

  function makeMasterClipperCurve(antiClipOn, rawCrunchLevel = 0) {
    const n = 8192;
    const curve = new Float32Array(n);
    if (antiClipOn) {
      // Studio Soft-Knee Mastering Ceiling: keeps huge loudness crystal-clear and rattle-free
      for (let i = 0; i < n; i++) {
        const x = (i * 2) / n - 1;
        if (Math.abs(x) <= 0.65) {
          curve[i] = x;
        } else {
          const sign = x < 0 ? -1 : 1;
          const excess = Math.abs(x) - 0.65;
          curve[i] = sign * (0.65 + 0.33 * Math.tanh(excess / 0.33));
        }
      }
    } else {
      // Raw Unprotected Clipper: lets bass slam directly into hard speaker rattle when pushed
      const boost = 1.0 + rawCrunchLevel * 0.45;
      for (let i = 0; i < n; i++) {
        const x = (i * 2) / n - 1;
        const v = x * boost;
        curve[i] = Math.max(-0.98, Math.min(0.98, v));
      }
    }
    return curve;
  }

  function createLushHallImpulse(ctx) {
    try {
      const sr = ctx.sampleRate || 44100;
      const duration = 2.5;
      const len = Math.floor(sr * duration);
      const buf = ctx.createBuffer(2, len, sr);
      for (let ch = 0; ch < 2; ch++) {
        const data = buf.getChannelData(ch);
        let lp = 0;
        for (let i = 0; i < len; i++) {
          const t = i / len;
          const env = Math.pow(1 - t, 2.3) * (i < sr * 0.025 ? (i / (sr * 0.025)) : 1.0);
          const white = (Math.random() * 2 - 1) * env;
          lp = lp * 0.72 + white * 0.28;
          data[i] = lp * 0.88;
        }
      }
      return buf;
    } catch (e) {
      return null;
    }
  }

  function applyDspParamsToChain(chain, st, immediate = false) {
    try {
      const active = isDspActive(st);
      const now = chain.ctx.currentTime || 0;
      const tc = 0.015;
      const antiClipOn = st.antiClip !== false;

      // Master Bass Macro (0..+25 dB) distributes musical weight across the 4 bass bands
      const bassBoostVal = active ? (Number(st.bassBoost) || 0) : 0;

      // 4 Dedicated Deep Bass Bands:
      // 1) 42 Hz Infra-Subwoofer (Deep 808 rumble)
      const totalSub42 = active ? (bassBoostVal * 0.95 + (Number(st.subBass) || 0)) : 0;
      // 2) 72 Hz Deep Bass Body (Chest-hitting club bass)
      const totalDeep72 = active ? (bassBoostVal * 1.05 + (Number(st.deepBass) || 0)) : 0;
      // 3) 120 Hz Kick & Punch (Hard transient slam)
      const totalPunch120 = active ? (bassBoostVal * 0.72 + (Number(st.punchBass) || 0)) : 0;
      // 4) 185 Hz Upper Bass Warmth & Synth Bass Thickness
      const totalUpperBass185 = active ? (bassBoostVal * 0.32 + (Number(st.upperBass) || 0)) : 0;

      // Anti-Mud / De-Boom Filter at 255 Hz (cleans up boxy mud so huge bass stays crystal-clear)
      const manualMudCutPct = active ? Math.max(0, Math.min(100, Number(st.mudCut) || 0)) : 0;
      const autoMudCutDb = (active && antiClipOn && (bassBoostVal + Math.max(0, totalDeep72)) > 9)
        ? -Math.min(7.5, ((bassBoostVal + Math.max(0, totalDeep72)) - 9) * 0.32)
        : 0;
      const totalMudDb = active ? Math.max(-15, -(manualMudCutPct / 100) * 12.0 + autoMudCutDb) : 0;

      // 6 Full-Range Equalizer Bands for Dramatic Track Transformation:
      // 5) 380 Hz Low-Mids (Body / Warmth vs Hollow Scoop)
      const lowMids380 = active ? (Number(st.lowMids) || 0) : 0;
      // 6) 1000 Hz Center Mids (Lead Instruments & Core Vocal)
      const mids1k = active ? (Number(st.mids) || 0) : 0;
      // 7) 2800 Hz Upper-Mids (Vocal Forwardness, Guitars, Snare Snap)
      const upperMids2k8 = active ? (Number(st.upperMids) || 0) : 0;
      // 8) 5500 Hz Presence & Definition (Clarity, Attack, Crispness)
      const presence5k5 = active ? (Number(st.presence) || 0) : 0;
      // 9) 10000 Hz Treble & Hi-Hats (Sizzle & Brilliance)
      const treble10k = active ? (Number(st.treble) || 0) : 0;
      // 10) 14500 Hz Ultra-Air (Studio Sheen & Breath)
      const air14k5 = active ? (Number(st.airBand) || 0) : 0;

      const warmthVal = active ? (Number(st.warmth) || 0) : 0;
      const stereoPct = active ? Math.max(0, Math.min(100, Number(st.stereoWidth) || 0)) : 0;
      const reverbPct = active ? Math.max(0, Math.min(100, Number(st.reverbMix) || 0)) : 0;

      // Subsonic excursion protection:
      // When antiClip is ON, 26 Hz high-pass prevents speaker cone bottoming-out while 42-120 Hz slams hard.
      // When antiClip is OFF, subsonic filter drops to 10 Hz so raw 808 excursion rattles speakers freely.
      if (chain.subsonicFilter) {
        const subHpFreq = (active && antiClipOn) ? 26 : 10;
        if (immediate) {
          chain.subsonicFilter.frequency.value = subHpFreq;
        } else {
          chain.subsonicFilter.frequency.setTargetAtTime(subHpFreq, now, tc);
        }
      }

      // Smart Headroom & Preamp (up to 400% = 4.0x):
      // When antiClip is ON, we apply smart pre-EQ headroom compensation + makeup gain in the limiter
      // so even +25 dB of bass + 400% preamp sounds thunderously loud and clean without ugly digital crackle!
      // When antiClip is OFF, zero attenuation is applied so the signal drives straight into raw clipping/rattle!
      const rawPreamp = active ? Math.max(0.2, Math.min(4.5, Number(st.preamp) || 1.0)) : 1.0;
      const maxBassBoostDb = Math.max(0, totalSub42, totalDeep72, totalPunch120);
      let inputTrim = 1.0;
      let targetGain = rawPreamp;

      if (active && antiClipOn) {
        // Prevent internal Biquad/WaveShaper overload while boosting output makeup gain
        const eqHeadroomDb = maxBassBoostDb > 6 ? -(maxBassBoostDb - 6) * 0.42 : 0;
        inputTrim = Math.pow(10, eqHeadroomDb / 20);
        const makeupBoost = maxBassBoostDb > 6 ? Math.pow(10, ((maxBassBoostDb - 6) * 0.36) / 20) : 1.0;
        targetGain = Math.min(5.0, rawPreamp * makeupBoost);
      } else if (active && !antiClipOn) {
        inputTrim = 1.0;
        targetGain = rawPreamp * (1.0 + (bassBoostVal / 25) * 0.35);
      }

      if (chain.limiter) {
        if (!active) {
          chain.limiter.threshold.value = 0.0;
          chain.limiter.knee.value = 0.0;
          chain.limiter.ratio.value = 1.0;
        } else if (antiClipOn) {
          // Brickwall Studio Mastering Limiter (Clean Loudness & Anti-Rattle ON)
          chain.limiter.threshold.value = -1.2;
          chain.limiter.knee.value = 8.0;
          chain.limiter.ratio.value = 20.0;
          chain.limiter.attack.value = 0.0015;
          chain.limiter.release.value = 0.065;
        } else {
          // Anti-Rattle OFF: disable compressor limiting so raw bass & overdrive rattle freely
          chain.limiter.threshold.value = 0.0;
          chain.limiter.knee.value = 0.0;
          chain.limiter.ratio.value = 1.0;
        }
      }

      if (chain.masterClipper) {
        if (!active) {
          chain.masterClipper.curve = null;
          chain.masterClipper.oversample = 'none';
        } else {
          const rawCrunch = !antiClipOn ? Math.min(2.5, (bassBoostVal / 15) + (warmthVal / 60) + Math.max(0, rawPreamp - 1)) : 0;
          chain.masterClipper.curve = makeMasterClipperCurve(antiClipOn, rawCrunch);
          chain.masterClipper.oversample = antiClipOn ? '4x' : 'none';
        }
      }

      // 3D Stereo Widener crossfeed gain
      const targetStereoWet = (stereoPct / 100) * 0.72;

      // Hall Reverb Dry/Wet mix
      const wetRev = (reverbPct / 100) * 0.82;
      const dryRev = Math.max(0.50, 1.0 - (reverbPct / 100) * 0.30);

      const setParam = (audioParam, val) => {
        if (!audioParam) return;
        if (immediate) {
          audioParam.value = val;
        } else {
          audioParam.setTargetAtTime(val, now, tc);
        }
      };

      setParam(chain.inputNode.gain, inputTrim);
      setParam(chain.subFilter.gain, totalSub42);
      setParam(chain.deepBassFilter.gain, totalDeep72);
      setParam(chain.punchFilter.gain, totalPunch120);
      setParam(chain.upperBassFilter.gain, totalUpperBass185);
      setParam(chain.mudFilter.gain, totalMudDb);
      setParam(chain.lowMidFilter.gain, lowMids380);
      setParam(chain.midFilter.gain, mids1k);
      setParam(chain.upperMidFilter.gain, upperMids2k8);
      setParam(chain.presenceFilter.gain, presence5k5);
      setParam(chain.trebleFilter.gain, treble10k);
      setParam(chain.airFilter.gain, air14k5);
      setParam(chain.preampNode.gain, targetGain);

      if (chain.stereoWetL && chain.stereoWetR) {
        setParam(chain.stereoWetL.gain, targetStereoWet);
        setParam(chain.stereoWetR.gain, targetStereoWet);
      }
      if (chain.reverbDry && chain.reverbWet) {
        setParam(chain.reverbDry.gain, dryRev);
        setParam(chain.reverbWet.gain, wetRev);
      }

      if (warmthVal <= 0.5 && (antiClipOn || bassBoostVal <= 0.5)) {
        chain.shaper.curve = null;
        chain.shaper.oversample = 'none';
      } else {
        const effWarmth = !antiClipOn ? Math.max(warmthVal, bassBoostVal * 2.2) : warmthVal;
        chain.shaper.curve = makeWarmthCurve(effWarmth, antiClipOn);
        chain.shaper.oversample = antiClipOn ? '2x' : 'none';
      }
    } catch (e) {}
  }

  const OrigAudioCtx = window.AudioContext || window.webkitAudioContext;
  if (OrigAudioCtx) {
    const origConnect = AudioNode.prototype.connect;
    const origDisconnect = AudioNode.prototype.disconnect;

    function getOrCreateDspChain(ctx) {
      if (ctx.__scDspChain) return ctx.__scDspChain;

      const inputNode = ctx.createGain();

      // 0. Switchable Subsonic Excursion Guard (26 Hz when Anti-Clip ON, 10 Hz when OFF)
      const subsonicFilter = ctx.createBiquadFilter();
      subsonicFilter.type = 'highpass';
      subsonicFilter.frequency.value = 26;
      subsonicFilter.Q.value = 0.707;

      // 1. Infra-Subwoofer 808 Filter (42 Hz Low-Shelf)
      const subFilter = ctx.createBiquadFilter();
      subFilter.type = 'lowshelf';
      subFilter.frequency.value = 42;

      // 2. Deep Club Bass Body Filter (72 Hz Peaking)
      const deepBassFilter = ctx.createBiquadFilter();
      deepBassFilter.type = 'peaking';
      deepBassFilter.frequency.value = 72;
      deepBassFilter.Q.value = 0.95;

      // 3. Kick & Punch Slam Filter (120 Hz Peaking)
      const punchFilter = ctx.createBiquadFilter();
      punchFilter.type = 'peaking';
      punchFilter.frequency.value = 120;
      punchFilter.Q.value = 1.15;

      // 4. Upper Bass Warmth & Synth Bass Filter (185 Hz Peaking)
      const upperBassFilter = ctx.createBiquadFilter();
      upperBassFilter.type = 'peaking';
      upperBassFilter.frequency.value = 185;
      upperBassFilter.Q.value = 1.2;

      // 5. Anti-Mud / De-Boom Cleanup Filter (255 Hz Peaking)
      const mudFilter = ctx.createBiquadFilter();
      mudFilter.type = 'peaking';
      mudFilter.frequency.value = 255;
      mudFilter.Q.value = 1.45;

      // 6. Low-Mids Body / Scoop Filter (380 Hz Peaking)
      const lowMidFilter = ctx.createBiquadFilter();
      lowMidFilter.type = 'peaking';
      lowMidFilter.frequency.value = 380;
      lowMidFilter.Q.value = 1.0;

      // 7. Center Mids Vocal & Lead Core Filter (1.0 kHz Peaking)
      const midFilter = ctx.createBiquadFilter();
      midFilter.type = 'peaking';
      midFilter.frequency.value = 1000;
      midFilter.Q.value = 0.9;

      // 8. Upper-Mids Vocal Presence & Guitars Filter (2.8 kHz Peaking)
      const upperMidFilter = ctx.createBiquadFilter();
      upperMidFilter.type = 'peaking';
      upperMidFilter.frequency.value = 2800;
      upperMidFilter.Q.value = 0.95;

      // 9. Presence & Attack Clarity Filter (5.5 kHz Peaking)
      const presenceFilter = ctx.createBiquadFilter();
      presenceFilter.type = 'peaking';
      presenceFilter.frequency.value = 5500;
      presenceFilter.Q.value = 1.0;

      // 10. Crisp Treble & Hi-Hats Filter (10.0 kHz High-Shelf)
      const trebleFilter = ctx.createBiquadFilter();
      trebleFilter.type = 'highshelf';
      trebleFilter.frequency.value = 10000;

      // 11. Ultra-Air Studio Brilliance Filter (14.5 kHz High-Shelf)
      const airFilter = ctx.createBiquadFilter();
      airFilter.type = 'highshelf';
      airFilter.frequency.value = 14500;

      // 12. Harmonic Drive / Tube Saturation / Raw Overdrive
      const shaper = ctx.createWaveShaper();
      shaper.oversample = '2x';

      // 13. 3D Stereo Widener (Haas + Cross-Phase Spatializer)
      const stereoStageOut = ctx.createGain();
      const splitter = ctx.createChannelSplitter(2);
      const merger = ctx.createChannelMerger(2);
      const delayL = ctx.createDelay(0.05);
      const delayR = ctx.createDelay(0.05);
      delayL.delayTime.value = 0.011;
      delayR.delayTime.value = 0.014;
      const stereoWetL = ctx.createGain();
      const stereoWetR = ctx.createGain();
      const invL = ctx.createGain();
      const invR = ctx.createGain();
      invL.gain.value = -1;
      invR.gain.value = -1;
      stereoWetL.gain.value = 0;
      stereoWetR.gain.value = 0;

      origConnect.call(shaper, stereoStageOut);
      origConnect.call(shaper, splitter);
      origConnect.call(splitter, delayL, 0);
      origConnect.call(splitter, delayR, 1);
      origConnect.call(delayL, stereoWetL);
      origConnect.call(delayR, stereoWetR);
      origConnect.call(stereoWetL, merger, 0, 0);
      origConnect.call(stereoWetR, merger, 0, 1);
      origConnect.call(stereoWetL, invL);
      origConnect.call(stereoWetR, invR);
      origConnect.call(invL, merger, 0, 1);
      origConnect.call(invR, merger, 0, 0);
      origConnect.call(merger, stereoStageOut);

      // 14. Concert Hall Reverb Stage
      const reverbDry = ctx.createGain();
      const reverbWet = ctx.createGain();
      reverbDry.gain.value = 1.0;
      reverbWet.gain.value = 0.0;
      const convolver = ctx.createConvolver();
      const hallBuf = createLushHallImpulse(ctx);
      if (hallBuf) {
        try { convolver.buffer = hallBuf; } catch (e) {}
      }

      // 15. Master Preamp (up to 400%) + Switchable Anti-Clip Limiter + Soft/Raw Clipper
      const preampNode = ctx.createGain();
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -1.2;
      limiter.knee.value = 8.0;
      limiter.ratio.value = 20.0;
      limiter.attack.value = 0.0015;
      limiter.release.value = 0.065;

      const masterClipper = ctx.createWaveShaper();
      masterClipper.__isScMasterLimiter = true;

      origConnect.call(inputNode, subsonicFilter);
      origConnect.call(subsonicFilter, subFilter);
      origConnect.call(subFilter, deepBassFilter);
      origConnect.call(deepBassFilter, punchFilter);
      origConnect.call(punchFilter, upperBassFilter);
      origConnect.call(upperBassFilter, mudFilter);
      origConnect.call(mudFilter, lowMidFilter);
      origConnect.call(lowMidFilter, midFilter);
      origConnect.call(midFilter, upperMidFilter);
      origConnect.call(upperMidFilter, presenceFilter);
      origConnect.call(presenceFilter, trebleFilter);
      origConnect.call(trebleFilter, airFilter);
      origConnect.call(airFilter, shaper);

      origConnect.call(stereoStageOut, reverbDry);
      origConnect.call(stereoStageOut, convolver);
      origConnect.call(convolver, reverbWet);
      origConnect.call(reverbDry, preampNode);
      origConnect.call(reverbWet, preampNode);

      origConnect.call(preampNode, limiter);
      origConnect.call(limiter, masterClipper);
      origConnect.call(masterClipper, ctx.destination);

      const chain = {
        ctx,
        inputNode,
        subsonicFilter,
        subFilter,
        deepBassFilter,
        punchFilter,
        upperBassFilter,
        mudFilter,
        lowMidFilter,
        midFilter,
        upperMidFilter,
        presenceFilter,
        trebleFilter,
        airFilter,
        shaper,
        stereoWetL,
        stereoWetR,
        reverbDry,
        reverbWet,
        preampNode,
        limiter,
        masterClipper
      };
      ctx.__scDspChain = chain;
      window.__scDspChains.push(chain);
      applyDspParamsToChain(chain, window.__scDspState, true);
      return chain;
    }

    AudioNode.prototype.connect = function(destination, outputIndex, inputIndex) {
      try {
        const isOffline =
          typeof OfflineAudioContext !== 'undefined' &&
          this.context instanceof OfflineAudioContext;
        if (
          !isOffline &&
          destination &&
          this.context &&
          destination === this.context.destination &&
          !this.__isScMasterLimiter
        ) {
          const chain = getOrCreateDspChain(this.context);
          if (typeof outputIndex === 'number' && typeof inputIndex === 'number') {
            origConnect.call(this, chain.inputNode, outputIndex, inputIndex);
          } else if (typeof outputIndex === 'number') {
            origConnect.call(this, chain.inputNode, outputIndex);
          } else {
            origConnect.call(this, chain.inputNode);
          }
          return destination;
        }
      } catch (e) {}
      return origConnect.apply(this, arguments);
    };

    AudioNode.prototype.disconnect = function(destinationOrOutput, output, input) {
      try {
        if (
          destinationOrOutput &&
          this.context &&
          destinationOrOutput === this.context.destination &&
          this.context.__scDspChain &&
          !this.__isScMasterLimiter
        ) {
          const chain = this.context.__scDspChain;
          if (arguments.length === 1) {
            return origDisconnect.call(this, chain.inputNode);
          } else if (arguments.length === 2) {
            return origDisconnect.call(this, chain.inputNode, output);
          } else {
            return origDisconnect.call(this, chain.inputNode, output, input);
          }
        }
        return origDisconnect.apply(this, arguments);
      } catch (e) {
        try {
          return origDisconnect.call(this);
        } catch (e2) {}
      }
    };

    if (OrigAudioCtx.prototype && OrigAudioCtx.prototype.createMediaElementSource) {
      const origCreateMES = OrigAudioCtx.prototype.createMediaElementSource;
      OrigAudioCtx.prototype.createMediaElementSource = function(mediaEl) {
        registerMediaEl(mediaEl);
        if (mediaEl && mediaEl.__scMediaSourceNode && mediaEl.__scMediaSourceCtx === this) {
          return mediaEl.__scMediaSourceNode;
        }
        const node = origCreateMES.call(this, mediaEl);
        if (mediaEl) {
          mediaEl.__scRouted = true;
          mediaEl.__scMediaSourceNode = node;
          mediaEl.__scMediaSourceCtx = this;
        }
        return node;
      };
    }

    function routeElementToDspIfNeeded(mediaEl) {
      try {
        if (!mediaEl || mediaEl.__scRouted) return;
        const curSrc = String(mediaEl.currentSrc || mediaEl.src || '');
        if (curSrc && !curSrc.startsWith('blob:') && !curSrc.startsWith('data:') && !mediaEl.crossOrigin) {
          try {
            mediaEl.crossOrigin = 'anonymous';
          } catch (e) {}
        }
        if (!window.__scSharedMediaCtx || window.__scSharedMediaCtx.state === 'closed') {
          window.__scSharedMediaCtx = new OrigAudioCtx();
        }
        const ctx = window.__scSharedMediaCtx;
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        const chain = getOrCreateDspChain(ctx);
        applyDspParamsToChain(chain, window.__scDspState, true);
        const srcNode = ctx.createMediaElementSource(mediaEl);
        origConnect.call(srcNode, chain.inputNode);
        mediaEl.__scRouted = true;
      } catch (e) {}
    }

    window.__scRouteElementToDsp = routeElementToDspIfNeeded;

    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function() {
      try {
        registerMediaEl(this);
        enforceSteadyVolume(this);
        window.__scActiveAudioElement = this;
        routeElementToDspIfNeeded(this);
      } catch (e) {}
      const res = origPlay.apply(this, arguments);
      try {
        enforceSteadyVolume(this);
        setTimeout(() => enforceSteadyVolume(this), 40);
        setTimeout(() => enforceSteadyVolume(this), 150);
      } catch (e) {}
      return res;
    };
  }

  // Capture SoundCloud API tracks, comments, playlists, OAuth token & client_id in real time
  window.__scTrackCache = window.__scTrackCache || {};
  window.__scCommentsCache = window.__scCommentsCache || {};
  window.__scPlaylistsMap = window.__scPlaylistsMap || {};
  window.__scAuthHeader = '';

  function getMainWorldAuthHeader() {
    if (window.__scAuthHeader) return window.__scAuthHeader;
    try {
      const m = document.cookie.match(/(?:^|;\s*)oauth_token=([^;]+)/);
      if (m && m[1]) {
        const tok = decodeURIComponent(m[1]);
        window.__scAuthHeader = tok.startsWith('OAuth ') ? tok : 'OAuth ' + tok;
        const parts = tok.replace(/^OAuth\s+/i, '').split('-');
        if (parts.length >= 3 && /^\d+$/.test(parts[2])) {
          window.__scMeUserId = parts[2];
        }
        return window.__scAuthHeader;
      }
    } catch (e) {}
    return '';
  }

  try {
    const origSetReqHdr = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
      try {
        if (String(name || '').toLowerCase() === 'authorization' && value) {
          window.__scAuthHeader = String(value);
          const parts = String(value).replace(/^OAuth\s+/i, '').split('-');
          if (parts.length >= 3 && /^\d+$/.test(parts[2])) {
            window.__scMeUserId = parts[2];
          }
        }
      } catch (e) {}
      return origSetReqHdr.apply(this, arguments);
    };
  } catch (e) {}

  function broadcastClientId(cid) {
    if (!cid || window.__scClientId === cid) return;
    window.__scClientId = cid;
    window.postMessage({ type: '__SC_CLIENT_ID__', clientId: cid, authHeader: getMainWorldAuthHeader() }, '*');
  }

  function trimCacheMap(mapObj, maxKeys = 25) {
    try {
      const keys = Object.keys(mapObj);
      if (keys.length > maxKeys) {
        for (let i = 0; i < keys.length - maxKeys; i++) {
          delete mapObj[keys[i]];
        }
      }
    } catch (e) {}
  }

  function inspectAndCacheScObject(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 5) return;
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length && i < 60; i++) inspectAndCacheScObject(obj[i], depth + 1);
      return;
    }
    if (obj.kind === 'playlist' && obj.id && obj.title && !obj.is_album) {
      window.__scPlaylistsMap[String(obj.id)] = obj;
      trimCacheMap(window.__scPlaylistsMap, 30);
    }
    if (obj.kind === 'comment' && obj.track_id && obj.body != null) {
      const tid = String(obj.track_id);
      if (!window.__scCommentsCache[tid]) window.__scCommentsCache[tid] = [];
      if (window.__scCommentsCache[tid].length < 120 && !window.__scCommentsCache[tid].some((c) => c.id === obj.id)) {
        window.__scCommentsCache[tid].push(obj);
      }
      trimCacheMap(window.__scCommentsCache, 15);
      return;
    }
    if (
      (obj.kind === 'track' || (obj.waveform_url && obj.title && obj.user)) &&
      obj.permalink_url
    ) {
      try {
        const u = new URL(obj.permalink_url);
        const key = u.pathname.replace(/\\/+$/, '').toLowerCase();
        window.__scTrackCache[key] = obj;
        trimCacheMap(window.__scTrackCache, 25);
        window.postMessage({ type: '__SC_TRACK_DATA__', key, track: obj }, '*');
      } catch (e) {}
    }
    for (const k of ['collection', 'track', 'sound', 'data', 'items']) {
      if (obj[k]) inspectAndCacheScObject(obj[k], depth + 1);
    }
  }

  try {
    if (Array.isArray(window.__sc_hydration)) {
      inspectAndCacheScObject(window.__sc_hydration, 0);
    }
  } catch (e) {}

  const origFetch = window.fetch;
  try {
    if (typeof origFetch === 'function') {
      window.fetch = function(input, init) {
        try {
          const urlStr = typeof input === 'string' ? input : (input && input.url) || '';
          if (urlStr.includes('api-v2.soundcloud.com')) {
            const u = new URL(urlStr, window.location.origin);
            const cid = u.searchParams.get('client_id');
            if (cid) broadcastClientId(cid);
          }
        } catch (e) {}
        const p = origFetch.apply(this, arguments);
        try {
          p.then((res) => {
            if (res && res.url && res.url.includes('api-v2.soundcloud.com')) {
              const rUrl = res.url;
              res.clone().json().then((data) => {
                const runInspect = () => {
                  inspectAndCacheScObject(data, 0);
                  const m = rUrl.match(/\\/tracks\\/(\\d+)\\/comments/);
                  if (m && m[1] && data && Array.isArray(data.collection)) {
                    window.__scCommentsCache[m[1]] = data.collection;
                    window.postMessage({ type: '__SC_COMMENTS_DATA__', trackId: m[1], comments: data.collection }, '*');
                  }
                };
                if (typeof window.requestIdleCallback === 'function') {
                  window.requestIdleCallback(runInspect, { timeout: 600 });
                } else {
                  setTimeout(runInspect, 0);
                }
              }).catch(() => {});
            }
          }).catch(() => {});
        } catch (e) {}
        return p;
      };
    }

    const origXhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
      try {
        if (typeof url === 'string' && url.includes('api-v2.soundcloud.com')) {
          const u = new URL(url, window.location.origin);
          const cid = u.searchParams.get('client_id');
          if (cid) broadcastClientId(cid);
          this.addEventListener('load', function() {
            const rawText = this.responseText;
            const runXhrInspect = () => {
              try {
                const data = JSON.parse(rawText);
                inspectAndCacheScObject(data, 0);
                const m = String(url).match(/\\/tracks\\/(\\d+)\\/comments/);
                if (m && m[1] && data && Array.isArray(data.collection)) {
                  window.__scCommentsCache[m[1]] = data.collection;
                  window.postMessage({ type: '__SC_COMMENTS_DATA__', trackId: m[1], comments: data.collection }, '*');
                }
              } catch (e) {}
            };
            if (typeof window.requestIdleCallback === 'function') {
              window.requestIdleCallback(runXhrInspect, { timeout: 600 });
            } else {
              setTimeout(runXhrInspect, 0);
            }
          });
        }
      } catch (e) {}
      return origXhrOpen.apply(this, arguments);
    };
  } catch (e) {}

  // Helper to discover client_id from performance resources or script bundles if not yet captured
  async function ensureMainWorldClientId() {
    if (window.__scClientId) return window.__scClientId;
    try {
      const entries = performance.getEntriesByType('resource') || [];
      for (const entry of entries) {
        if (entry.name && entry.name.includes('client_id=')) {
          const u = new URL(entry.name, window.location.origin);
          const cid = u.searchParams.get('client_id');
          if (cid) {
            broadcastClientId(cid);
            return cid;
          }
        }
      }
    } catch (e) {}
    try {
      const scripts = Array.from(document.querySelectorAll('script[src*="sndcdn.com/assets/"]')).slice(-3);
      for (const s of scripts.reverse()) {
        const res = await origFetch(s.src);
        const txt = await res.text();
        const m = txt.match(/client_id\\s*[:=]\\s*["']([a-zA-Z0-9]{32})["']/);
        if (m && m[1]) {
          broadcastClientId(m[1]);
          return m[1];
        }
      }
    } catch (e) {}
    return '';
  }

  setTimeout(ensureMainWorldClientId, 1200);

  // Main-world fallback fetcher for comments & fans using browser session cookies
  window.addEventListener('sc-mw-fetch-track-extras', async (ev) => {
    try {
      const d = (ev && ev.detail) || {};
      const trackId = d.trackId;
      let cid = d.clientId || window.__scClientId || (await ensureMainWorldClientId());
      if (!trackId || !cid) return;

      const urlsToTry = [
        "https://api-v2.soundcloud.com/tracks/" + trackId + "/comments?threaded=1&filter_replies=0&limit=100&offset=0&linked_partitioning=1&client_id=" + encodeURIComponent(cid),
        "https://api-v2.soundcloud.com/tracks/" + trackId + "/comments?threaded=0&filter_replies=1&limit=100&offset=0&linked_partitioning=1&client_id=" + encodeURIComponent(cid),
        "https://api-v2.soundcloud.com/tracks/" + trackId + "/comments?limit=100&offset=0&linked_partitioning=1&client_id=" + encodeURIComponent(cid)
      ];

      for (const u of urlsToTry) {
        try {
          const r = await origFetch(u, { credentials: 'include' });
          if (r.ok) {
            const j = await r.json();
            if (j && Array.isArray(j.collection) && j.collection.length > 0) {
              window.__scCommentsCache[String(trackId)] = j.collection;
              window.postMessage({
                type: '__SC_COMMENTS_DATA__',
                trackId: String(trackId),
                comments: j.collection
              }, '*');
              break;
            }
          }
        } catch (e) {}
      }
    } catch (e) {}
  });

  // Main-World Like, Repost & Playlist API actions using user's session
  window.addEventListener('sc-mw-like-track', async (ev) => {
    try {
      const d = (ev && ev.detail) || {};
      const trackId = d.trackId;
      const liked = Boolean(d.liked);
      let cid = d.clientId || window.__scClientId || (await ensureMainWorldClientId());
      if (!trackId || !cid) return;
      const auth = getMainWorldAuthHeader();
      const hdrs = auth ? { Authorization: auth } : {};
      let meId = window.__scMeUserId || null;
      if (!meId) {
        try {
          const meRes = await origFetch('https://api-v2.soundcloud.com/me?client_id=' + encodeURIComponent(cid), {
            credentials: 'include',
            headers: hdrs
          });
          if (meRes.ok) {
            const meData = await meRes.json();
            if (meData && meData.id) {
              meId = meData.id;
              window.__scMeUserId = meId;
            }
          }
        } catch (e) {}
      }
      if (meId) {
        const method = liked ? 'PUT' : 'DELETE';
        await origFetch('https://api-v2.soundcloud.com/users/' + meId + '/track_likes/' + trackId + '?client_id=' + encodeURIComponent(cid), {
          method,
          credentials: 'include',
          headers: hdrs
        }).catch(() => {});
      }
    } catch (e) {}
  });

  window.addEventListener('sc-mw-repost-track', async (ev) => {
    try {
      const d = (ev && ev.detail) || {};
      const trackId = d.trackId;
      const repost = Boolean(d.repost);
      let cid = d.clientId || window.__scClientId || (await ensureMainWorldClientId());
      if (!trackId || !cid) return;
      const method = repost ? 'PUT' : 'DELETE';
      await origFetch('https://api-v2.soundcloud.com/e1/me/track_reposts/' + trackId + '?client_id=' + encodeURIComponent(cid), {
        method,
        credentials: 'include'
      }).catch(() => {});
    } catch (e) {}
  });

  window.addEventListener('sc-mw-fetch-playlists', async (ev) => {
    try {
      const d = (ev && ev.detail) || {};
      let cid = d.clientId || window.__scClientId || (await ensureMainWorldClientId());
      if (!cid) return;
      const auth = getMainWorldAuthHeader();
      const hdrs = auth ? { Authorization: auth } : {};
      const collected = [];
      const seenIds = new Set();
      const addPl = (p) => {
        if (!p || !p.title || !p.id) return;
        const k = String(p.id);
        if (seenIds.has(k)) return;
        seenIds.add(k);
        collected.push(p);
      };

      const endpoints = [
        'https://api-v2.soundcloud.com/me/playlists?limit=50&client_id=' + encodeURIComponent(cid),
        'https://api-v2.soundcloud.com/me/library/all?limit=50&client_id=' + encodeURIComponent(cid)
      ];

      let meId = window.__scMeUserId || null;
      if (!meId) {
        try {
          const meRes = await origFetch('https://api-v2.soundcloud.com/me?client_id=' + encodeURIComponent(cid), {
            credentials: 'include',
            headers: hdrs
          });
          if (meRes.ok) {
            const meData = await meRes.json();
            if (meData && meData.id) {
              meId = meData.id;
              window.__scMeUserId = meId;
            }
          }
        } catch (e) {}
      }

      if (!meId && d.userPermalink) {
        try {
          const resUrl = 'https://api-v2.soundcloud.com/resolve?url=' + encodeURIComponent('https://soundcloud.com' + d.userPermalink) + '&client_id=' + encodeURIComponent(cid);
          const uRes = await origFetch(resUrl, { credentials: 'include', headers: hdrs });
          if (uRes.ok) {
            const uData = await uRes.json();
            if (uData && uData.id) {
              meId = uData.id;
              window.__scMeUserId = meId;
            }
          }
        } catch (e) {}
      }

      if (meId) {
        endpoints.push('https://api-v2.soundcloud.com/users/' + meId + '/playlists_without_albums?limit=50&client_id=' + encodeURIComponent(cid));
        endpoints.push('https://api-v2.soundcloud.com/users/' + meId + '/playlists?limit=50&client_id=' + encodeURIComponent(cid));
      }

      await Promise.allSettled(
        endpoints.map(async (ep) => {
          try {
            const r = await origFetch(ep, { credentials: 'include', headers: hdrs });
            if (!r.ok) return;
            const j = await r.json();
            const items = (j && Array.isArray(j.collection)) ? j.collection : (Array.isArray(j) ? j : []);
            for (const it of items) {
              const pl = it && (it.playlist || (it.kind === 'playlist' ? it : null));
              if (pl) {
                if (!meId || !pl.user_id || Number(pl.user_id) === Number(meId) || ep.includes('/me/')) {
                  addPl(pl);
                }
              }
            }
          } catch (e) {}
        })
      );

      if (collected.length === 0) {
        for (const p of Object.values(window.__scPlaylistsMap || {})) {
          if (!meId || Number(p.user_id) === Number(meId)) addPl(p);
        }
      }

      if (collected.length > 0) {
        window.postMessage({ type: '__SC_USER_PLAYLISTS__', playlists: collected }, '*');
      }
    } catch (e) {}
  });

  window.addEventListener('sc-mw-add-to-playlist', async (ev) => {
    try {
      const d = (ev && ev.detail) || {};
      const playlistId = d.playlistId;
      const trackId = Number(d.trackId);
      let cid = d.clientId || window.__scClientId || (await ensureMainWorldClientId());
      if (!playlistId || !trackId || !cid) return;
      const auth = getMainWorldAuthHeader();
      const hdrs = { 'Content-Type': 'application/json' };
      if (auth) hdrs.Authorization = auth;

      const getRes = await origFetch('https://api-v2.soundcloud.com/playlists/' + playlistId + '?client_id=' + encodeURIComponent(cid), {
        credentials: 'include',
        headers: auth ? { Authorization: auth } : {}
      });
      if (!getRes.ok) return;
      const pl = await getRes.json();
      const existingIds = ((pl && pl.tracks) || []).map((t) => Number(typeof t === 'object' ? t.id : t)).filter(Boolean);
      if (!existingIds.includes(trackId)) existingIds.push(trackId);
      await origFetch('https://api-v2.soundcloud.com/playlists/' + playlistId + '?client_id=' + encodeURIComponent(cid), {
        method: 'PUT',
        credentials: 'include',
        headers: hdrs,
        body: JSON.stringify({ playlist: { tracks: existingIds } })
      });
    } catch (e) {}
  });

  window.addEventListener('sc-mw-create-playlist', async (ev) => {
    try {
      const d = (ev && ev.detail) || {};
      const title = d.title || 'New Playlist';
      const trackId = Number(d.trackId);
      let cid = d.clientId || window.__scClientId || (await ensureMainWorldClientId());
      if (!trackId || !cid) return;
      const auth = getMainWorldAuthHeader();
      const hdrs = { 'Content-Type': 'application/json' };
      if (auth) hdrs.Authorization = auth;

      const res = await origFetch('https://api-v2.soundcloud.com/playlists?client_id=' + encodeURIComponent(cid), {
        method: 'POST',
        credentials: 'include',
        headers: hdrs,
        body: JSON.stringify({
          playlist: {
            title,
            sharing: d.sharing || 'public',
            tracks: [trackId]
          }
        })
      });
      if (res.ok) {
        const created = await res.json();
        window.postMessage({ type: '__SC_PLAYLIST_CREATED__', playlist: created }, '*');
      }
    } catch (e) {}
  });

  window.addEventListener('sc-seek-audio', (ev) => {
    try {
      const targetSec = Number(ev && ev.detail && ev.detail.seconds);
      if (!Number.isFinite(targetSec) || targetSec < 0) return;
      for (const a of window.__scTrackedMediaElements) {
        try {
          if (!a.paused || a.currentTime > 0 || a.src) {
            a.currentTime = targetSec;
          }
        } catch (e) {}
      }
      const audios = document.querySelectorAll('audio, video');
      for (const a of audios) {
        if (!a.paused || a.currentTime > 0 || a.src) {
          a.currentTime = targetSec;
        }
      }
      if (window.__scActiveAudioElement) {
        window.__scActiveAudioElement.currentTime = targetSec;
      }
      if (document.documentElement) {
        document.documentElement.dataset.scAudioTime = String(targetSec);
        document.documentElement.dataset.scAudioPerf = String(performance.now());
      }
    } catch (e) {}
  });

  window.addEventListener('sc-set-volume', (ev) => {
    try {
      const d = (ev && ev.detail) || {};
      const v = Math.max(0, Math.min(1, Number(d.volume ?? 1)));
      const m = Boolean(d.muted);
      window.__scTargetVolume = v;
      window.__scTargetMuted = m;
      for (const a of window.__scTrackedMediaElements) {
        try {
          a.volume = m ? 0 : v;
          a.muted = m;
        } catch (e) {}
      }
      document.querySelectorAll('audio, video').forEach((a) => {
        try {
          a.volume = m ? 0 : v;
          a.muted = m;
        } catch (e) {}
      });
    } catch (e) {}
  });

  window.addEventListener('sc-dsp-update', (ev) => {
    if (!ev || !ev.detail) return;
    window.__scDspState = { ...window.__scDspState, ...ev.detail };
    for (const a of window.__scTrackedMediaElements) {
      try {
        applyPlaybackSpeedAndPitch(a);
        if (typeof window.__scRouteElementToDsp === 'function') window.__scRouteElementToDsp(a);
      } catch (e) {}
    }
    document.querySelectorAll('audio').forEach((a) => {
      try {
        applyPlaybackSpeedAndPitch(a);
        if (typeof window.__scRouteElementToDsp === 'function') window.__scRouteElementToDsp(a);
      } catch (e) {}
    });
    if (window.__scSharedMediaCtx && window.__scSharedMediaCtx.state === 'suspended') {
      window.__scSharedMediaCtx.resume().catch(() => {});
    }
    for (const chain of window.__scDspChains) {
      applyDspParamsToChain(chain, window.__scDspState, false);
    }
  });
})();
`;

try {
  webFrame.executeJavaScript(MAIN_WORLD_BOOTSTRAP);
} catch (e) {}

function isMainSoundCloudApp() {
  const host = window.location.hostname || '';
  return host === 'soundcloud.com' || host === 'www.soundcloud.com';
}

// ------------------------------------------------------------------
// 2. Built-in Atmospheric Wallpapers (Pure GPU CSS Gradients — Never Blocked by CSP)
// ------------------------------------------------------------------
const PRESET_WALLPAPERS = {
  none: '',
  cyberpunk: 'radial-gradient(circle at 78% 22%, rgba(255, 0, 128, 0.55) 0%, transparent 52%), radial-gradient(circle at 18% 82%, rgba(0, 240, 255, 0.48) 0%, transparent 58%), radial-gradient(circle at 50% 50%, rgba(124, 58, 237, 0.32) 0%, transparent 65%), linear-gradient(135deg, #070312 0%, #170b3b 48%, #350642 100%)',
  sunset: 'radial-gradient(circle at 52% 84%, rgba(255, 85, 0, 0.62) 0%, transparent 62%), radial-gradient(circle at 82% 24%, rgba(255, 168, 0, 0.34) 0%, transparent 52%), linear-gradient(135deg, #11050c 0%, #3a101d 50%, #7d2812 100%)',
  aurora: 'radial-gradient(circle at 26% 28%, rgba(16, 185, 129, 0.52) 0%, transparent 56%), radial-gradient(circle at 76% 72%, rgba(56, 189, 248, 0.46) 0%, transparent 54%), radial-gradient(circle at 50% 18%, rgba(168, 85, 247, 0.28) 0%, transparent 50%), linear-gradient(135deg, #030d11 0%, #07262c 50%, #071930 100%)',
  amethyst: 'radial-gradient(circle at 68% 32%, rgba(168, 85, 247, 0.55) 0%, transparent 58%), radial-gradient(circle at 22% 76%, rgba(236, 72, 153, 0.38) 0%, transparent 54%), linear-gradient(135deg, #090412 0%, #210b3a 52%, #110726 100%)'
};

let currentSettings = {
  accentColor: '#ff5500',
  surfaceColor: '#16161a',
  cardOpacity: 0.82,
  borderRadius: 12,
  wallpaperUrl: '',
  wallpaperPreset: 'none',
  wallpaperBlur: 0,
  wallpaperDim: 20,
  particleEffect: 'none',
  particleCount: 80,
  particleSpeed: 1.0,
  particleSize: 1.0,
  cursorTrail: 'none',
  cursorTrailSize: 1.0,
  eqPreset: 'flat',
  antiClip: true,
  bassBoost: 0,
  subBass: 0,
  deepBass: 0,
  punchBass: 0,
  upperBass: 0,
  mudCut: 0,
  lowMids: 0,
  mids: 0,
  upperMids: 0,
  presence: 0,
  treble: 0,
  airBand: 0,
  warmth: 0,
  stereoWidth: 0,
  reverbMix: 0,
  speedPitch: 1.0,
  preamp: 1.0
};

function hexToRgbString(hex) {
  const clean = (hex || '#16161a').replace('#', '');
  const num = parseInt(clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `${r}, ${g}, ${b}`;
}

function pushDspToMainWorld() {
  const detail = {
    eqPreset: currentSettings.eqPreset || 'custom',
    antiClip: currentSettings.antiClip !== false,
    bassBoost: Number(currentSettings.bassBoost) || 0,
    subBass: Number(currentSettings.subBass) || 0,
    deepBass: Number(currentSettings.deepBass) || 0,
    punchBass: Number(currentSettings.punchBass) || 0,
    upperBass: Number(currentSettings.upperBass) || 0,
    mudCut: Number(currentSettings.mudCut) || 0,
    lowMids: Number(currentSettings.lowMids) || 0,
    mids: Number(currentSettings.mids) || 0,
    upperMids: Number(currentSettings.upperMids) || 0,
    presence: Number(currentSettings.presence) || 0,
    treble: Number(currentSettings.treble) || 0,
    airBand: Number(currentSettings.airBand) || 0,
    warmth: Number(currentSettings.warmth) || 0,
    stereoWidth: Number(currentSettings.stereoWidth) || 0,
    reverbMix: Number(currentSettings.reverbMix) || 0,
    speedPitch: Number(currentSettings.speedPitch) || 1.0,
    preamp: Number(currentSettings.preamp) || 1.0
  };
  try {
    webFrame.executeJavaScript(
      `window.dispatchEvent(new CustomEvent('sc-dsp-update', { detail: ${JSON.stringify(detail)} }));`
    );
  } catch (e) {}
}

// ------------------------------------------------------------------
// 3. High-Performance Visual Theme, Animated Video/GIF/Image Wallpaper &
//    Realistic Atmospheric Particle Engine (Zero RAM Bloat)
// ------------------------------------------------------------------
let particles = [];
let rainSplashes = [];
let shootingStars = [];
let animFrameId = null;
let startParticleLoopFn = null;
let lastParticleMode = '';

let cursorTrailPoints = [];
let cursorTrailParticles = [];
let cursorAnimFrameId = null;
let startCursorTrailLoopFn = null;
let cursorHue = 0;

function isVideoWallpaperUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  const lower = urlStr.toLowerCase();
  if (lower.startsWith('data:video/')) return true;
  const clean = lower.split('#')[0];
  return /\.(mp4|webm|mkv|avi|m4v|ogv)(?:$|\?|&)/i.test(clean) || lower.includes('ext=.mp4') || lower.includes('ext=.webm') || lower.includes('ext=.mkv') || lower.includes('ext=.m4v') || lower.includes('ext=.ogv');
}

function applyVisualSettings() {
  if (!isMainSoundCloudApp() || !document.documentElement) return;

  const root = document.documentElement;
  const accent = currentSettings.accentColor || '#ff5500';
  const accentRgbParts = hexToRgbString(accent).split(',').map((n) => parseInt(n.trim(), 10));
  const accentLum = (0.299 * (accentRgbParts[0] || 255)) + (0.587 * (accentRgbParts[1] || 85)) + (0.114 * (accentRgbParts[2] || 0));
  const accentFg = accentLum > 165 ? '#111111' : '#ffffff';
  const surfaceRgb = hexToRgbString(currentSettings.surfaceColor || '#16161a');

  const wpLayer = document.getElementById('sc-wallpaper-layer');
  const wpImg = document.getElementById('sc-wallpaper-img');
  const wpVideo = document.getElementById('sc-wallpaper-video');

  const rawWpUrl = String(currentSettings.wallpaperUrl || '').trim();
  const presetKey = String(currentSettings.wallpaperPreset || 'none').trim();
  const presetGradient = (!rawWpUrl && presetKey !== 'none' && PRESET_WALLPAPERS[presetKey])
    ? PRESET_WALLPAPERS[presetKey]
    : '';
  const hasAnyWallpaper = Boolean(rawWpUrl || presetGradient);

  // Make cards slightly translucent when a wallpaper is active so the wallpaper shines through!
  const opacity = hasAnyWallpaper ? 0.78 : 0.92;
  const radius = Number(currentSettings.borderRadius ?? 14);

  root.style.setProperty('--sc-accent', accent);
  root.style.setProperty('--sc-accent-fg', accentFg);
  root.style.setProperty('--sc-surface-rgb', surfaceRgb);
  root.style.setProperty('--sc-card-opacity', String(opacity));
  root.style.setProperty('--sc-radius', `${radius}px`);

  if (wpLayer) {
    if (hasAnyWallpaper) {
      const blurPx = Number(currentSettings.wallpaperBlur ?? 0);
      const brightnessPct = Math.max(12, 100 - Number(currentSettings.wallpaperDim ?? 0));
      wpLayer.style.filter = (blurPx > 0 || brightnessPct < 100)
        ? `blur(${blurPx}px) brightness(${brightnessPct}%)`
        : 'none';
      wpLayer.style.transform = blurPx > 0 ? 'translateZ(0) scale(1.06)' : 'translateZ(0) scale(1.0)';

      if (presetGradient) {
        // Built-in preset gradient wallpaper
        if (wpVideo) {
          wpVideo.pause();
          wpVideo.removeAttribute('data-wp-src');
          wpVideo.removeAttribute('src');
          wpVideo.style.display = 'none';
        }
        if (wpImg) {
          wpImg.removeAttribute('data-wp-src');
          wpImg.removeAttribute('src');
          wpImg.style.display = 'none';
        }
        wpLayer.style.background = presetGradient;
        wpLayer.style.backgroundSize = 'cover';
        wpLayer.style.backgroundPosition = 'center';
      } else if (isVideoWallpaperUrl(rawWpUrl) && wpVideo) {
        // Animated Video Wallpaper (MP4 / WebM)
        wpLayer.style.background = '#0d0d12';
        if (wpImg) {
          wpImg.removeAttribute('data-wp-src');
          wpImg.removeAttribute('src');
          wpImg.style.display = 'none';
        }
        wpVideo.style.display = 'block';
        if (wpVideo.getAttribute('data-wp-src') !== rawWpUrl) {
          wpVideo.setAttribute('data-wp-src', rawWpUrl);
          wpVideo.src = rawWpUrl;
          wpVideo.onerror = () => {
            // Automatic fallback to local HTTP stream if sc-wallpaper:// encountered any codec/scheme issue
            if (rawWpUrl.startsWith('sc-wallpaper://')) {
              const fb = rawWpUrl.replace('sc-wallpaper://local/', 'http://127.0.0.1:43821/wallpaper-stream');
              if (wpVideo.src !== fb) wpVideo.src = fb;
            }
          };
        }
        if (!document.hidden && wpVideo.paused) {
          wpVideo.play().catch(() => {});
        }
      } else {
        // Static Image or Animated GIF/WebP/APNG Wallpaper
        if (wpVideo) {
          wpVideo.pause();
          wpVideo.removeAttribute('data-wp-src');
          wpVideo.removeAttribute('src');
          wpVideo.style.display = 'none';
        }
        wpLayer.style.background = '#0d0d12';
        wpLayer.style.backgroundImage = `url("${rawWpUrl}")`;
        wpLayer.style.backgroundSize = 'cover';
        wpLayer.style.backgroundPosition = 'center';
        if (wpImg) {
          wpImg.style.display = 'block';
          if (wpImg.getAttribute('data-wp-src') !== rawWpUrl) {
            wpImg.setAttribute('data-wp-src', rawWpUrl);
            wpImg.src = rawWpUrl;
            wpImg.onerror = () => {
              if (rawWpUrl.startsWith('sc-wallpaper://')) {
                const fb = rawWpUrl.replace('sc-wallpaper://local/', 'http://127.0.0.1:43821/wallpaper-stream');
                if (wpImg.src !== fb) wpImg.src = fb;
              }
            };
          }
        }
      }

      document.documentElement.classList.add('sc-has-custom-wp');
      if (document.body) document.body.classList.add('sc-has-custom-wp');
    } else {
      if (wpVideo) {
        wpVideo.pause();
        wpVideo.removeAttribute('data-wp-src');
        wpVideo.removeAttribute('src');
        wpVideo.style.display = 'none';
      }
      if (wpImg) {
        wpImg.removeAttribute('data-wp-src');
        wpImg.removeAttribute('src');
        wpImg.style.display = 'none';
      }
      wpLayer.style.background = '#121212';
      wpLayer.style.backgroundImage = 'none';
      wpLayer.style.filter = 'none';
      wpLayer.style.transform = 'none';
      document.documentElement.classList.remove('sc-has-custom-wp');
      if (document.body) document.body.classList.remove('sc-has-custom-wp');
    }
  }

  const fxCanvas = document.getElementById('sc-particles-canvas');
  if (fxCanvas) {
    if (!currentSettings.particleEffect || currentSettings.particleEffect === 'none') {
      fxCanvas.style.display = 'none';
      document.documentElement.classList.remove('sc-has-particles');
      if (document.body) document.body.classList.remove('sc-has-particles');
      if (animFrameId) {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
      }
    } else {
      fxCanvas.style.display = 'block';
      document.documentElement.classList.add('sc-has-particles');
      if (document.body) document.body.classList.add('sc-has-particles');
      if (lastParticleMode !== currentSettings.particleEffect) {
        lastParticleMode = currentSettings.particleEffect;
        particles.length = 0;
        rainSplashes.length = 0;
        shootingStars.length = 0;
      }
      if (!animFrameId && startParticleLoopFn) {
        startParticleLoopFn();
      }
    }
  }

  const cursorCanvas = document.getElementById('sc-cursor-trail-canvas');
  if (cursorCanvas) {
    if (!currentSettings.cursorTrail || currentSettings.cursorTrail === 'none') {
      cursorCanvas.style.display = 'none';
      cursorTrailPoints.length = 0;
      cursorTrailParticles.length = 0;
      if (cursorAnimFrameId) {
        cancelAnimationFrame(cursorAnimFrameId);
        cursorAnimFrameId = null;
      }
    } else {
      cursorCanvas.style.display = 'block';
      if (!cursorAnimFrameId && startCursorTrailLoopFn) {
        startCursorTrailLoopFn();
      }
    }
  }

  pushDspToMainWorld();
}

function drawSakuraPetalPath(ctx, rx, ry) {
  ctx.beginPath();
  ctx.moveTo(0, ry);
  ctx.bezierCurveTo(rx * 1.15, ry * 0.55, rx * 1.1, -ry * 0.65, rx * 0.28, -ry);
  ctx.lineTo(0, -ry * 0.62);
  ctx.lineTo(-rx * 0.28, -ry);
  ctx.bezierCurveTo(-rx * 1.1, -ry * 0.65, -rx * 1.15, ry * 0.55, 0, ry);
  ctx.closePath();
}

function drawFourPointStar(ctx, x, y, outerR, innerR, rot = 0) {
  ctx.save();
  ctx.translate(x, y);
  if (rot) ctx.rotate(rot);
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const a = (i * Math.PI) / 4;
    if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawSnowflakeShape(ctx, x, y, r, rot = 0) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    ctx.moveTo(0, 0);
    ctx.lineTo(cos * r, sin * r);
    const bx = cos * (r * 0.58);
    const by = sin * (r * 0.58);
    const bLen = r * 0.34;
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + Math.cos(a + 0.65) * bLen, by + Math.sin(a + 0.65) * bLen);
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + Math.cos(a - 0.65) * bLen, by + Math.sin(a - 0.65) * bLen);
  }
  ctx.stroke();
  ctx.restore();
}

function drawHeartShape(ctx, x, y, size, rot = 0) {
  ctx.save();
  ctx.translate(x, y);
  if (rot) ctx.rotate(rot);
  const s = size;
  ctx.beginPath();
  ctx.moveTo(0, s * 0.35);
  ctx.bezierCurveTo(-s, -s * 0.35, -s * 0.55, -s * 1.05, 0, -s * 0.42);
  ctx.bezierCurveTo(s * 0.55, -s * 1.05, s, -s * 0.35, 0, s * 0.35);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function initParticleEngine(canvas) {
  const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });

  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resizeCanvas, { passive: true });
  resizeCanvas();

  function makeRadialSprite(size, innerColor, midColor, outerColor) {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const gctx = c.getContext('2d');
    const half = size / 2;
    const grad = gctx.createRadialGradient(half, half, 0, half, half, half);
    grad.addColorStop(0, innerColor);
    grad.addColorStop(0.45, midColor);
    grad.addColorStop(1, outerColor);
    gctx.fillStyle = grad;
    gctx.fillRect(0, 0, size, size);
    return c;
  }

  const snowSprite = makeRadialSprite(
    24,
    'rgba(255, 255, 255, 0.96)',
    'rgba(225, 242, 255, 0.54)',
    'rgba(255, 255, 255, 0)'
  );
  const emberSprite = makeRadialSprite(
    28,
    'rgba(255, 240, 160, 0.98)',
    'rgba(255, 110, 20, 0.62)',
    'rgba(255, 50, 0, 0)'
  );
  const fireflyGoldSprite = makeRadialSprite(
    32,
    'rgba(255, 255, 200, 0.98)',
    'rgba(190, 255, 70, 0.52)',
    'rgba(120, 220, 20, 0)'
  );
  const fireflyCyanSprite = makeRadialSprite(
    32,
    'rgba(220, 255, 255, 0.96)',
    'rgba(56, 220, 255, 0.50)',
    'rgba(0, 180, 255, 0)'
  );

  const rainSprite = (() => {
    const c = document.createElement('canvas');
    c.width = 6;
    c.height = 64;
    const rctx = c.getContext('2d');
    const grad = rctx.createLinearGradient(3, 0, 3, 64);
    grad.addColorStop(0.0, 'rgba(175, 215, 255, 0.0)');
    grad.addColorStop(0.35, 'rgba(185, 222, 255, 0.18)');
    grad.addColorStop(0.82, 'rgba(210, 238, 255, 0.65)');
    grad.addColorStop(0.96, 'rgba(245, 252, 255, 0.95)');
    grad.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)');
    rctx.fillStyle = grad;
    rctx.beginPath();
    rctx.ellipse(3, 34, 1.35, 30, 0, 0, Math.PI * 2);
    rctx.fill();
    return c;
  })();

  const sakuraColors = [
    ['#fff0f5', '#ffb7c5', '#ff8da1'],
    ['#ffe4ec', '#ff9ebb', '#f47296'],
    ['#fff5f8', '#ffc2d1', '#fb6f92'],
    ['#fce7f3', '#f9a8d4', '#ec4899']
  ];
  // Pre-render sakura petals onto offscreen sprites to eliminate per-frame createLinearGradient & bezier path overhead
  const sakuraSprites = sakuraColors.map((pal) => {
    const c = document.createElement('canvas');
    c.width = 36;
    c.height = 48;
    const sctx = c.getContext('2d');
    sctx.translate(18, 24);
    const rx = 14;
    const ry = 19;
    const grad = sctx.createLinearGradient(0, -ry, 0, ry);
    grad.addColorStop(0, pal[0]);
    grad.addColorStop(0.55, pal[1]);
    grad.addColorStop(1, pal[2]);
    sctx.fillStyle = grad;
    drawSakuraPetalPath(sctx, rx, ry);
    sctx.fill();
    return c;
  });

  const bokehHues = [18, 280, 195, 330, 150];
  const bokehSprites = {};
  bokehHues.forEach((hue) => {
    const c = document.createElement('canvas');
    c.width = 96;
    c.height = 96;
    const bctx = c.getContext('2d');
    const g = bctx.createRadialGradient(48, 48, 4.8, 48, 48, 48);
    g.addColorStop(0, `hsla(${hue}, 95%, 72%, 0.45)`);
    g.addColorStop(0.7, `hsla(${hue}, 95%, 62%, 0.65)`);
    g.addColorStop(0.92, `hsla(${hue}, 95%, 78%, 0.90)`);
    g.addColorStop(1, `hsla(${hue}, 95%, 65%, 0)`);
    bctx.fillStyle = g;
    bctx.beginPath();
    bctx.arc(48, 48, 48, 0, Math.PI * 2);
    bctx.fill();
    bokehSprites[hue] = c;
  });

  const starColors = ['#ffffff', '#bae6fd', '#fde68a', '#e9d5ff', '#fbcfe8'];
  const heartColors = ['#ff4d79', '#ff758f', '#ec4899', '#a855f7', '#fb7185'];
  const matrixChars = '0123456789ABCDEFﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘｱﾎﾃﾏｹﾒｴｶｷﾑﾕﾗｾﾈｽﾀﾇﾍ';

  function spawnParticle(randomY = false) {
    const w = canvas.width || 1280;
    const h = canvas.height || 800;
    const mode = currentSettings.particleEffect || 'snow';
    const z = Math.pow(Math.random(), 1.35) * 0.9 + 0.35;

    if (mode === 'rain') {
      const vy = (16 + z * 15) + Math.random() * 4;
      const windAngle = 0.13;
      return {
        x: Math.random() * (w + 180) - 90,
        y: randomY ? Math.random() * h : -Math.random() * 80 - 20,
        z,
        len: Math.round(24 + z * 38),
        thickness: 0.75 + z * 0.85,
        vy,
        vx: vy * windAngle + (Math.random() - 0.5) * 0.3,
        alpha: Math.min(0.82, 0.16 + z * 0.44),
        splashY: h - (4 + (1.25 - z) * 34 + Math.random() * 14)
      };
    }

    if (mode === 'sakura') {
      const paletteIdx = Math.floor(Math.random() * sakuraColors.length);
      const palette = sakuraColors[paletteIdx];
      return {
        x: Math.random() * (w + 120) - 60,
        y: randomY ? Math.random() * h : -25 - Math.random() * 60,
        z,
        r: 4.2 + z * 5.2,
        vy: 0.65 + z * 1.15 + Math.random() * 0.35,
        vx: 0.45 + z * 0.75 + (Math.random() - 0.5) * 0.4,
        phase: Math.random() * Math.PI * 2,
        tiltPhase: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 0.032 + 0.014,
        tiltSpeed: 0.025 + Math.random() * 0.03,
        paletteIdx,
        palette,
        alpha: Math.min(0.94, 0.38 + z * 0.48)
      };
    }

    if (mode === 'stars') {
      const color = starColors[Math.floor(Math.random() * starColors.length)];
      return {
        x: Math.random() * w,
        y: randomY ? Math.random() * h : -15,
        z,
        r: 1.5 + z * 3.8,
        vy: 0.06 + z * 0.16,
        vx: (Math.random() - 0.5) * 0.08,
        phase: Math.random() * Math.PI * 2,
        twinkleSpeed: 0.018 + Math.random() * 0.035,
        isFlare: Math.random() < 0.42,
        color,
        alpha: Math.min(0.96, 0.32 + z * 0.58)
      };
    }

    if (mode === 'fireflies') {
      return {
        x: Math.random() * w,
        y: Math.random() * h,
        z,
        r: 3.5 + z * 6.5,
        angle: Math.random() * Math.PI * 2,
        turnSpeed: (Math.random() - 0.5) * 0.04,
        speed: 0.35 + z * 0.75,
        phase: Math.random() * Math.PI * 2,
        isCyan: Math.random() < 0.28,
        alpha: Math.min(0.92, 0.30 + z * 0.55)
      };
    }

    if (mode === 'hearts') {
      return {
        x: Math.random() * w,
        y: randomY ? Math.random() * h : h + 25,
        z,
        r: 4.5 + z * 6.5,
        vy: 0.55 + z * 1.15,
        vx: (Math.random() - 0.5) * 0.5,
        phase: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 0.02,
        color: heartColors[Math.floor(Math.random() * heartColors.length)],
        alpha: Math.min(0.88, 0.28 + z * 0.48)
      };
    }

    if (mode === 'matrix') {
      return {
        x: Math.floor(Math.random() * Math.ceil(w / 18)) * 18,
        y: randomY ? Math.random() * h : -Math.random() * 160 - 20,
        z,
        vy: 3.2 + z * 5.2,
        len: 6 + Math.floor(z * 8),
        charSeed: Math.floor(Math.random() * 1000),
        isAccent: Math.random() < 0.35,
        alpha: Math.min(0.85, 0.22 + z * 0.48)
      };
    }

    if (mode === 'bokeh') {
      const hues = [18, 280, 195, 330, 150];
      return {
        x: Math.random() * w,
        y: randomY ? Math.random() * h : h + 40,
        z,
        r: 14 + z * 34,
        vy: 0.22 + z * 0.45,
        vx: (Math.random() - 0.5) * 0.35,
        phase: Math.random() * Math.PI * 2,
        hue: hues[Math.floor(Math.random() * hues.length)],
        alpha: Math.min(0.32, 0.08 + z * 0.16)
      };
    }

    if (mode === 'galaxy') {
      const hues = [265, 295, 195, 330, 45];
      return {
        x: Math.random() * w,
        y: Math.random() * h,
        z,
        r: 1.8 + z * 3.6,
        orbitAngle: Math.random() * Math.PI * 2,
        orbitSpeed: (0.004 + z * 0.008) * (Math.random() < 0.5 ? 1 : -1),
        driftX: (Math.random() - 0.5) * 0.45,
        driftY: (Math.random() - 0.5) * 0.35,
        phase: Math.random() * Math.PI * 2,
        hue: hues[Math.floor(Math.random() * hues.length)],
        alpha: Math.min(0.92, 0.30 + z * 0.55)
      };
    }

    return {
      x: Math.random() * w,
      y: randomY ? Math.random() * h : (mode === 'embers' ? h + 15 : -15),
      z,
      r: (mode === 'blizzard' ? 1.8 : 2.2) + z * 3.6,
      vy: mode === 'blizzard' ? (2.4 + z * 3.0) : (0.55 + z * 1.15),
      vx: mode === 'blizzard' ? (2.4 + z * 2.2) : (Math.random() - 0.5) * 0.65,
      phase: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 0.03,
      isCrystal: mode === 'snow' && z > 0.72 && Math.random() < 0.42,
      alpha: Math.min(0.92, 0.28 + z * 0.54)
    };
  }

  function spawnSplash(x, y, z) {
    if (rainSplashes.length > 55) return;
    rainSplashes.push({
      x,
      y,
      rx: 1.0,
      ry: 0.4,
      maxRx: 5 + z * 9,
      alpha: Math.min(0.65, 0.22 + z * 0.32),
      dropVy: -(1.2 + z * 1.6),
      dropY: y - 1,
      hasDrop: z > 0.75
    });
  }

  function spawnShootingStar(w, h) {
    if (shootingStars.length >= 3) return;
    const startX = Math.random() * w * 0.85 + w * 0.1;
    const startY = Math.random() * h * 0.42;
    const speed = 11 + Math.random() * 7;
    const angle = Math.PI * (0.68 + Math.random() * 0.14);
    shootingStars.push({
      x: startX,
      y: startY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      len: 75 + Math.random() * 65,
      life: 1.0,
      decay: 0.018 + Math.random() * 0.012
    });
  }

  function syncParticleCount() {
    const mode = currentSettings.particleEffect || 'none';
    if (mode === 'none') {
      particles.length = 0;
      return;
    }
    const rawCount = Math.min(220, Math.max(10, Number(currentSettings.particleCount) || 95));
    const target = mode === 'bokeh' ? Math.max(18, Math.round(rawCount * 0.45)) : rawCount;
    while (particles.length < target) particles.push(spawnParticle(true));
    if (particles.length > target) particles.length = target;
  }

  let lastParticleFrameTime = 0;

  function renderFrame(nowTs) {
    const mode = currentSettings.particleEffect || 'none';
    if (mode === 'none' || document.hidden) {
      animFrameId = null;
      lastParticleFrameTime = 0;
      return;
    }

    const now = typeof nowTs === 'number' ? nowTs : performance.now();
    const rawDt = lastParticleFrameTime > 0 ? (now - lastParticleFrameTime) / 16.6667 : 1.0;
    lastParticleFrameTime = now;
    // Clamp dt so if a tab navigation frame takes 25-65ms, particles advance proportionally in real time without slowing down!
    const dt = Math.min(3.8, Math.max(0.4, rawDt));

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    syncParticleCount();
    const baseSpeedMult = Number(currentSettings.particleSpeed) || 1.0;
    const speedMult = baseSpeedMult * dt;
    const sizeMult = Math.max(0.3, Math.min(2.5, Number(currentSettings.particleSize) || 1.0));
    const w = canvas.width;
    const h = canvas.height;

    if (mode === 'rain') {
      const angle = -0.13;
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.x += p.vx * speedMult;
        p.y += p.vy * speedMult;

        const len = p.len * sizeMult;
        const thick = p.thickness * sizeMult;
        ctx.save();
        ctx.globalAlpha = p.alpha;
        ctx.translate(p.x, p.y);
        ctx.rotate(angle);
        ctx.drawImage(rainSprite, -thick * 1.5, -len, thick * 3, len);
        ctx.restore();

        if (p.y >= p.splashY) {
          if (Math.random() < 0.65) {
            spawnSplash(p.x, p.splashY, p.z);
          }
          Object.assign(p, spawnParticle(false));
        } else if (p.x > w + 90) {
          p.x = -40;
        }
      }

      ctx.lineWidth = Math.max(0.8, 1.0 * sizeMult);
      for (let i = rainSplashes.length - 1; i >= 0; i--) {
        const s = rainSplashes[i];
        s.rx += (0.55 + (s.maxRx - s.rx) * 0.14) * speedMult;
        s.ry = s.rx * 0.28;
        s.alpha -= 0.026 * speedMult;

        if (s.alpha <= 0.02 || s.rx >= s.maxRx) {
          rainSplashes.splice(i, 1);
          continue;
        }

        ctx.strokeStyle = `rgba(205, 232, 255, ${s.alpha.toFixed(2)})`;
        ctx.beginPath();
        ctx.ellipse(s.x, s.y, s.rx * sizeMult, s.ry * sizeMult, 0, 0, Math.PI * 2);
        ctx.stroke();

        if (s.hasDrop && s.alpha > 0.18) {
          s.dropY += s.dropVy * speedMult;
          s.dropVy += 0.28 * speedMult;
          ctx.fillStyle = `rgba(225, 242, 255, ${(s.alpha * 1.1).toFixed(2)})`;
          ctx.fillRect(s.x - 0.6 * sizeMult, s.dropY, 1.3 * sizeMult, 2.2 * sizeMult);
        }
      }
    } else if (mode === 'snow' || mode === 'blizzard') {
      ctx.strokeStyle = 'rgba(240, 248, 255, 0.88)';
      ctx.lineWidth = Math.max(0.9, 1.15 * sizeMult);
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.phase += 0.018 * speedMult;
        p.x += (p.vx + Math.sin(p.phase) * (0.38 + p.z * 0.35)) * speedMult;
        p.y += p.vy * speedMult;
        if (p.y > h + 24) { Object.assign(p, spawnParticle(false)); }
        if (p.x > w + 24) p.x = -16;
        if (p.x < -24) p.x = w + 16;

        ctx.globalAlpha = p.alpha;
        if (p.isCrystal) {
          drawSnowflakeShape(ctx, p.x, p.y, p.r * 1.35 * sizeMult, p.phase * 0.7);
        } else {
          const d = p.r * 2.4 * sizeMult;
          ctx.drawImage(snowSprite, p.x - d / 2, p.y - d / 2, d, d);
        }
      }
      ctx.globalAlpha = 1.0;
    } else if (mode === 'embers') {
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.phase += 0.026 * speedMult;
        p.x += Math.sin(p.phase) * (0.62 + p.z * 0.42) * speedMult;
        p.y -= p.vy * 0.95 * speedMult;
        if (p.y < -24) { Object.assign(p, spawnParticle(false)); }
        if (p.x > w + 20) p.x = -14;
        if (p.x < -20) p.x = w + 14;

        const flicker = 0.62 + 0.38 * Math.sin(p.phase * 2.4);
        const d = p.r * 2.8 * sizeMult;
        ctx.globalAlpha = p.alpha * flicker;
        ctx.drawImage(emberSprite, p.x - d / 2, p.y - d / 2, d, d);
      }
      ctx.globalAlpha = 1.0;
    } else if (mode === 'sakura') {
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.phase += p.spin * speedMult;
        p.tiltPhase += p.tiltSpeed * speedMult;
        p.x += (p.vx + Math.sin(p.tiltPhase * 0.85) * (0.75 + p.z * 0.45)) * speedMult;
        p.y += (p.vy + Math.cos(p.tiltPhase * 0.7) * 0.18) * speedMult;

        if (p.y > h + 32) { Object.assign(p, spawnParticle(false)); }
        if (p.x > w + 32) p.x = -24;
        if (p.x < -32) p.x = w + 24;

        ctx.save();
        ctx.globalAlpha = p.alpha;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.phase);
        const squeeze = 0.38 + 0.62 * Math.abs(Math.cos(p.tiltPhase));
        ctx.scale(1.0, squeeze);

        const rx = p.r * 0.92 * sizeMult;
        const ry = p.r * 1.25 * sizeMult;
        const sp = sakuraSprites[p.paletteIdx || 0] || sakuraSprites[0];
        ctx.drawImage(sp, -rx * 1.28, -ry * 1.26, rx * 2.56, ry * 2.52);
        ctx.restore();
      }
      ctx.globalAlpha = 1.0;
    } else if (mode === 'stars') {
      if (Math.random() < 0.022 * speedMult) {
        spawnShootingStar(w, h);
      }

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.phase += p.twinkleSpeed * speedMult;
        p.x += p.vx * speedMult;
        p.y += p.vy * speedMult;
        if (p.y > h + 20) { p.y = -12; p.x = Math.random() * w; }
        if (p.x > w + 20) p.x = -12;
        if (p.x < -20) p.x = w + 12;

        const twinkle = 0.25 + 0.75 * Math.pow(Math.abs(Math.sin(p.phase)), 1.4);
        ctx.save();
        ctx.globalAlpha = p.alpha * twinkle;
        ctx.fillStyle = p.color || '#ffffff';

        if (p.isFlare) {
          const outer = p.r * (1.45 + 0.35 * twinkle) * sizeMult;
          drawFourPointStar(ctx, p.x, p.y, outer, outer * 0.24, Math.sin(p.phase * 0.3) * 0.25);
        } else {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r * 0.68 * sizeMult, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      for (let i = shootingStars.length - 1; i >= 0; i--) {
        const s = shootingStars[i];
        s.x += s.vx * speedMult;
        s.y += s.vy * speedMult;
        s.life -= s.decay * speedMult;
        if (s.life <= 0 || s.x < -100 || s.y > h + 100) {
          shootingStars.splice(i, 1);
          continue;
        }
        const tailX = s.x - (s.vx / 14) * s.len * sizeMult;
        const tailY = s.y - (s.vy / 14) * s.len * sizeMult;
        ctx.save();
        const g = ctx.createLinearGradient(s.x, s.y, tailX, tailY);
        g.addColorStop(0, `rgba(255, 255, 255, ${s.life.toFixed(2)})`);
        g.addColorStop(0.35, `rgba(165, 225, 255, ${(s.life * 0.65).toFixed(2)})`);
        g.addColorStop(1, 'rgba(120, 180, 255, 0)');
        ctx.strokeStyle = g;
        ctx.lineWidth = 2.1 * sizeMult;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(tailX, tailY);
        ctx.stroke();
        ctx.fillStyle = `rgba(255, 255, 255, ${s.life.toFixed(2)})`;
        drawFourPointStar(ctx, s.x, s.y, 6.5 * sizeMult, 1.6 * sizeMult, 0);
        ctx.restore();
      }
      ctx.globalAlpha = 1.0;
    } else if (mode === 'fireflies') {
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.phase += 0.032 * speedMult;
        p.angle += p.turnSpeed * speedMult;
        p.x += Math.cos(p.angle) * p.speed * speedMult;
        p.y += Math.sin(p.angle) * p.speed * speedMult;
        if (p.x > w + 24) p.x = -18;
        if (p.x < -24) p.x = w + 18;
        if (p.y > h + 24) p.y = -18;
        if (p.y < -24) p.y = h + 18;

        const pulse = 0.2 + 0.8 * Math.pow(0.5 + 0.5 * Math.sin(p.phase), 2);
        const d = p.r * (1.8 + 0.8 * pulse) * sizeMult;
        ctx.globalAlpha = p.alpha * pulse;
        ctx.drawImage(p.isCyan ? fireflyCyanSprite : fireflyGoldSprite, p.x - d / 2, p.y - d / 2, d, d);
      }
      ctx.globalAlpha = 1.0;
    } else if (mode === 'hearts') {
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.phase += 0.022 * speedMult;
        p.x += (p.vx + Math.sin(p.phase) * 0.55) * speedMult;
        p.y -= p.vy * speedMult;
        if (p.y < -30) { Object.assign(p, spawnParticle(false)); }
        if (p.x > w + 24) p.x = -18;
        if (p.x < -24) p.x = w + 18;

        ctx.save();
        ctx.globalAlpha = p.alpha;
        ctx.fillStyle = p.color;
        drawHeartShape(ctx, p.x, p.y, p.r * sizeMult, Math.sin(p.phase) * 0.22);
        ctx.restore();
      }
      ctx.globalAlpha = 1.0;
    } else if (mode === 'matrix') {
      const fontPx = Math.max(8, Math.round(13 * sizeMult));
      const stepY = Math.max(9, Math.round(14 * sizeMult));
      ctx.font = `700 ${fontPx}px monospace`;
      const accent = currentSettings.accentColor || '#ff5500';
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.y += p.vy * speedMult;
        if (p.y - p.len * stepY > h + 24) {
          Object.assign(p, spawnParticle(false));
        }
        for (let k = 0; k < p.len; k++) {
          const cy = p.y - k * stepY;
          if (cy < -20 || cy > h + 20) continue;
          const chIdx = (p.charSeed + k * 7 + Math.floor(p.y * 0.12)) % matrixChars.length;
          const ch = matrixChars[chIdx];
          const fade = (1 - k / p.len) * p.alpha;
          ctx.globalAlpha = fade;
          ctx.fillStyle = k === 0 ? '#ffffff' : (p.isAccent ? accent : '#00f5d4');
          ctx.fillText(ch, p.x, cy);
        }
      }
      ctx.globalAlpha = 1.0;
    } else if (mode === 'bokeh') {
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.phase += 0.012 * speedMult;
        p.x += (p.vx + Math.sin(p.phase) * 0.25) * speedMult;
        p.y -= p.vy * speedMult;
        const rad = p.r * sizeMult;
        if (p.y < -rad * 2) { Object.assign(p, spawnParticle(false)); }
        if (p.x > w + rad * 2) p.x = -rad;
        if (p.x < -rad * 2) p.x = w + rad;

        const pulse = 0.75 + 0.25 * Math.sin(p.phase * 1.5);
        const sp = bokehSprites[p.hue] || bokehSprites[18];
        ctx.globalAlpha = p.alpha * pulse;
        ctx.drawImage(sp, p.x - rad, p.y - rad, rad * 2, rad * 2);
      }
      ctx.globalAlpha = 1.0;
    } else if (mode === 'galaxy') {
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.phase += 0.025 * speedMult;
        p.orbitAngle += p.orbitSpeed * speedMult;
        p.x += (Math.cos(p.orbitAngle) * 0.65 + p.driftX) * speedMult;
        p.y += (Math.sin(p.orbitAngle) * 0.65 + p.driftY) * speedMult;
        if (p.x > w + 20) p.x = -12;
        if (p.x < -20) p.x = w + 12;
        if (p.y > h + 20) p.y = -12;
        if (p.y < -20) p.y = h + 12;

        const shimmer = 0.35 + 0.65 * Math.abs(Math.sin(p.phase));
        ctx.save();
        ctx.globalAlpha = p.alpha * shimmer;
        ctx.fillStyle = `hsl(${p.hue}, 95%, 76%)`;
        drawFourPointStar(ctx, p.x, p.y, p.r * 1.4 * sizeMult, p.r * 0.32 * sizeMult, p.orbitAngle);
        ctx.restore();
      }
      ctx.globalAlpha = 1.0;
    }

    animFrameId = requestAnimationFrame(renderFrame);
  }

  startParticleLoopFn = () => {
    if (!animFrameId && currentSettings.particleEffect && currentSettings.particleEffect !== 'none') {
      animFrameId = requestAnimationFrame(renderFrame);
    }
  };

  document.addEventListener('visibilitychange', () => {
    const wpVideo = document.getElementById('sc-wallpaper-video');
    if (document.hidden) {
      if (wpVideo && !wpVideo.paused) wpVideo.pause();
    } else {
      if (wpVideo && wpVideo.getAttribute('data-wp-src') && wpVideo.paused) {
        wpVideo.play().catch(() => {});
      }
      startParticleLoopFn();
      if (startCursorTrailLoopFn) startCursorTrailLoopFn();
    }
  });

  startParticleLoopFn();
}

// ------------------------------------------------------------------
// 3B. Interactive 60 FPS Cursor Trail Engine (Rainbow, Snow, Sakura,
//     Stars, Fire, Neon Laser, Hearts, Galaxy, Bubbles)
// ------------------------------------------------------------------
function initCursorTrailEngine(canvas) {
  const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
  let lastMouseX = -1000;
  let lastMouseY = -1000;

  function resizeCursorCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resizeCursorCanvas, { passive: true });
  resizeCursorCanvas();

  function spawnCursorParticle(x, y, vx, vy, mode, scale) {
    if (cursorTrailParticles.length > 160) {
      cursorTrailParticles.shift();
    }
    cursorHue = (cursorHue + 7) % 360;

    if (mode === 'rainbow') {
      cursorTrailParticles.push({
        type: 'sparkle',
        x: x + (Math.random() - 0.5) * 8,
        y: y + (Math.random() - 0.5) * 8,
        vx: vx * 0.12 + (Math.random() - 0.5) * 1.5,
        vy: vy * 0.12 + (Math.random() - 0.5) * 1.5 + 0.35,
        r: (2.8 + Math.random() * 3.2) * scale,
        hue: cursorHue,
        rot: Math.random() * Math.PI * 2,
        vRot: (Math.random() - 0.5) * 0.12,
        life: 1.0,
        decay: 0.026 + Math.random() * 0.015
      });
    } else if (mode === 'snow') {
      cursorTrailParticles.push({
        type: 'snow',
        x: x + (Math.random() - 0.5) * 10,
        y: y + (Math.random() - 0.5) * 10,
        vx: vx * 0.08 + (Math.random() - 0.5) * 1.2,
        vy: 0.65 + Math.random() * 1.25,
        r: (3.2 + Math.random() * 4.2) * scale,
        rot: Math.random() * Math.PI * 2,
        vRot: (Math.random() - 0.5) * 0.06,
        isFlake: Math.random() < 0.68,
        life: 1.0,
        decay: 0.020 + Math.random() * 0.012
      });
    } else if (mode === 'sakura') {
      const pals = [
        ['#fff0f5', '#ffb7c5', '#ff8da1'],
        ['#ffe4ec', '#ff9ebb', '#f47296'],
        ['#fce7f3', '#f9a8d4', '#ec4899']
      ];
      cursorTrailParticles.push({
        type: 'sakura',
        x: x + (Math.random() - 0.5) * 10,
        y: y + (Math.random() - 0.5) * 10,
        vx: vx * 0.1 + (Math.random() - 0.35) * 1.4,
        vy: 0.55 + Math.random() * 1.15,
        r: (4.2 + Math.random() * 4.0) * scale,
        rot: Math.random() * Math.PI * 2,
        vRot: (Math.random() - 0.5) * 0.08,
        tilt: Math.random() * Math.PI * 2,
        vTilt: 0.06 + Math.random() * 0.05,
        palette: pals[Math.floor(Math.random() * pals.length)],
        life: 1.0,
        decay: 0.018 + Math.random() * 0.012
      });
    } else if (mode === 'stars') {
      const cols = ['#ffffff', '#fde047', '#7dd3fc', '#f472b6', '#c084fc'];
      cursorTrailParticles.push({
        type: 'star',
        x: x + (Math.random() - 0.5) * 10,
        y: y + (Math.random() - 0.5) * 10,
        vx: vx * 0.1 + (Math.random() - 0.5) * 1.4,
        vy: vy * 0.1 + (Math.random() - 0.5) * 1.4 + 0.2,
        r: (3.8 + Math.random() * 4.5) * scale,
        rot: Math.random() * Math.PI * 2,
        vRot: (Math.random() - 0.5) * 0.09,
        color: cols[Math.floor(Math.random() * cols.length)],
        life: 1.0,
        decay: 0.024 + Math.random() * 0.014
      });
    } else if (mode === 'fire') {
      cursorTrailParticles.push({
        type: 'fire',
        x: x + (Math.random() - 0.5) * 8,
        y: y + (Math.random() - 0.5) * 8,
        vx: vx * 0.08 + (Math.random() - 0.5) * 1.6,
        vy: -0.9 - Math.random() * 1.8,
        r: (4.5 + Math.random() * 5.5) * scale,
        life: 1.0,
        decay: 0.032 + Math.random() * 0.018
      });
    } else if (mode === 'neon') {
      cursorTrailParticles.push({
        type: 'neon',
        x: x + (Math.random() - 0.5) * 6,
        y: y + (Math.random() - 0.5) * 6,
        vx: (Math.random() - 0.5) * 1.5,
        vy: (Math.random() - 0.5) * 1.5,
        r: (2.4 + Math.random() * 3.0) * scale,
        life: 1.0,
        decay: 0.030 + Math.random() * 0.015
      });
    } else if (mode === 'hearts') {
      const cols = ['#ff4d79', '#ff758f', '#ec4899', '#fb7185', '#d946ef'];
      cursorTrailParticles.push({
        type: 'heart',
        x: x + (Math.random() - 0.5) * 10,
        y: y + (Math.random() - 0.5) * 10,
        vx: (Math.random() - 0.5) * 1.2,
        vy: -0.7 - Math.random() * 1.1,
        r: (4.5 + Math.random() * 4.5) * scale,
        rot: (Math.random() - 0.5) * 0.4,
        color: cols[Math.floor(Math.random() * cols.length)],
        life: 1.0,
        decay: 0.022 + Math.random() * 0.012
      });
    } else if (mode === 'galaxy') {
      const hues = [265, 290, 195, 325, 45];
      cursorTrailParticles.push({
        type: 'galaxy',
        cx: x,
        cy: y,
        angle: Math.random() * Math.PI * 2,
        radius: (2 + Math.random() * 14) * scale,
        vAngle: (0.09 + Math.random() * 0.08) * (Math.random() < 0.5 ? 1 : -1),
        r: (2.8 + Math.random() * 3.5) * scale,
        hue: hues[Math.floor(Math.random() * hues.length)],
        life: 1.0,
        decay: 0.024 + Math.random() * 0.012
      });
    } else if (mode === 'bubbles') {
      cursorTrailParticles.push({
        type: 'bubble',
        x: x + (Math.random() - 0.5) * 10,
        y: y + (Math.random() - 0.5) * 10,
        vx: (Math.random() - 0.5) * 1.1,
        vy: -0.6 - Math.random() * 1.2,
        r: (4.0 + Math.random() * 6.5) * scale,
        hue: cursorHue,
        life: 1.0,
        decay: 0.020 + Math.random() * 0.012
      });
    }
  }

  window.addEventListener(
    'mousemove',
    (ev) => {
      const mode = currentSettings.cursorTrail || 'none';
      if (mode === 'none') return;

      const x = ev.clientX;
      const y = ev.clientY;
      const dx = lastMouseX < -500 ? 0 : x - lastMouseX;
      const dy = lastMouseY < -500 ? 0 : y - lastMouseY;
      const dist = Math.hypot(dx, dy);
      lastMouseX = x;
      lastMouseY = y;

      const scale = Math.max(0.4, Math.min(3.0, Number(currentSettings.cursorTrailSize) || 1.0));
      cursorHue = (cursorHue + 4) % 360;

      if (mode === 'rainbow' || mode === 'neon' || mode === 'fire') {
        cursorTrailPoints.push({
          x,
          y,
          hue: cursorHue,
          life: 1.0
        });
        if (cursorTrailPoints.length > 42) {
          cursorTrailPoints.shift();
        }
      }

      const steps = Math.min(4, Math.max(1, Math.floor(dist / 10)));
      for (let s = 0; s < steps; s++) {
        const px = x - dx * (s / steps);
        const py = y - dy * (s / steps);
        if (mode === 'rainbow' && Math.random() < 0.65) {
          spawnCursorParticle(px, py, dx, dy, mode, scale);
        } else if (mode !== 'rainbow') {
          spawnCursorParticle(px, py, dx, dy, mode, scale);
        }
      }

      if (startCursorTrailLoopFn) startCursorTrailLoopFn();
    },
    { passive: true }
  );

  let lastCursorFrameTime = 0;

  function renderCursorTrailFrame(nowTs) {
    const mode = currentSettings.cursorTrail || 'none';
    if (mode === 'none' || document.hidden) {
      cursorAnimFrameId = null;
      lastCursorFrameTime = 0;
      return;
    }

    const now = typeof nowTs === 'number' ? nowTs : performance.now();
    const dt = lastCursorFrameTime > 0 ? Math.min(3.2, Math.max(0.5, (now - lastCursorFrameTime) / 16.6667)) : 1.0;
    lastCursorFrameTime = now;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const scale = Math.max(0.4, Math.min(3.0, Number(currentSettings.cursorTrailSize) || 1.0));
    const accent = currentSettings.accentColor || '#ff5500';

    // 1. Render smooth ribbon trail for rainbow, neon, and fire modes
    if (cursorTrailPoints.length > 1 && (mode === 'rainbow' || mode === 'neon' || mode === 'fire')) {
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let i = 1; i < cursorTrailPoints.length; i++) {
        const p0 = cursorTrailPoints[i - 1];
        const p1 = cursorTrailPoints[i];
        const life = p1.life;
        if (life <= 0.02) continue;

        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.lineWidth = Math.max(1.2, life * 7.5 * scale);

        if (mode === 'rainbow') {
          ctx.strokeStyle = `hsla(${p1.hue}, 98%, 62%, ${(life * 0.82).toFixed(2)})`;
          ctx.shadowColor = `hsla(${p1.hue}, 98%, 62%, 0.8)`;
          
        } else if (mode === 'neon') {
          ctx.strokeStyle = accent;
          ctx.globalAlpha = life * 0.88;
          ctx.shadowColor = accent;
          
        } else if (mode === 'fire') {
          const fHue = Math.round(12 + life * 42);
          ctx.strokeStyle = `hsla(${fHue}, 100%, ${50 + life * 35}%, ${(life * 0.85).toFixed(2)})`;
          ctx.shadowColor = 'rgba(255, 110, 0, 0.85)';
          
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    for (let i = cursorTrailPoints.length - 1; i >= 0; i--) {
      cursorTrailPoints[i].life -= 0.045 * dt;
      if (cursorTrailPoints[i].life <= 0) {
        cursorTrailPoints.splice(i, 1);
      }
    }

    // 2. Render cursor trail particles
    for (let i = cursorTrailParticles.length - 1; i >= 0; i--) {
      const p = cursorTrailParticles[i];
      p.life -= p.decay * dt;
      if (p.life <= 0) {
        cursorTrailParticles.splice(i, 1);
        continue;
      }

      if (p.type === 'galaxy') {
        p.angle += p.vAngle;
        p.radius += 0.25 * scale;
        const gx = p.cx + Math.cos(p.angle) * p.radius;
        const gy = p.cy + Math.sin(p.angle) * p.radius;
        ctx.save();
        ctx.globalAlpha = p.life;
        ctx.fillStyle = `hsl(${p.hue}, 95%, 74%)`;
        ctx.shadowColor = `hsl(${p.hue}, 95%, 65%)`;
        
        drawFourPointStar(ctx, gx, gy, p.r * p.life * 1.4, p.r * p.life * 0.35, p.angle);
        ctx.restore();
        continue;
      }

      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.rot !== undefined && p.vRot !== undefined) p.rot += p.vRot * dt;

      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life));

      if (p.type === 'sparkle') {
        ctx.fillStyle = `hsl(${p.hue}, 98%, 70%)`;
        ctx.shadowColor = `hsl(${p.hue}, 98%, 62%)`;
        
        drawFourPointStar(ctx, p.x, p.y, p.r * p.life * 1.5, p.r * p.life * 0.35, p.rot);
      } else if (p.type === 'snow') {
        ctx.strokeStyle = '#ffffff';
        ctx.fillStyle = '#e0f2fe';
        ctx.shadowColor = '#bae6fd';
        
        ctx.lineWidth = 1.25;
        if (p.isFlake) {
          drawSnowflakeShape(ctx, p.x, p.y, p.r * (0.5 + 0.5 * p.life), p.rot);
        } else {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r * 0.45 * p.life, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (p.type === 'sakura') {
        p.tilt += p.vTilt;
        p.x += Math.sin(p.tilt) * 0.55;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.scale(1.0, 0.38 + 0.62 * Math.abs(Math.cos(p.tilt)));
        const rx = p.r * 0.85 * (0.4 + 0.6 * p.life);
        const ry = p.r * 1.18 * (0.4 + 0.6 * p.life);
        const g = ctx.createLinearGradient(0, -ry, 0, ry);
        g.addColorStop(0, p.palette[0]);
        g.addColorStop(0.55, p.palette[1]);
        g.addColorStop(1, p.palette[2]);
        ctx.fillStyle = g;
        drawSakuraPetalPath(ctx, rx, ry);
        ctx.fill();
      } else if (p.type === 'star') {
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color;
        
        drawFourPointStar(ctx, p.x, p.y, p.r * p.life * 1.45, p.r * p.life * 0.32, p.rot);
      } else if (p.type === 'fire') {
        const rad = Math.max(0.5, p.r * p.life);
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad);
        g.addColorStop(0, 'rgba(255, 255, 210, 0.98)');
        g.addColorStop(0.45, 'rgba(255, 145, 20, 0.85)');
        g.addColorStop(1, 'rgba(255, 30, 0, 0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.type === 'neon') {
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = accent;
        
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(0.5, p.r * p.life * 0.65), 0, Math.PI * 2);
        ctx.fill();
      } else if (p.type === 'heart') {
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color;
        
        drawHeartShape(ctx, p.x, p.y, p.r * (0.45 + 0.55 * p.life), p.rot);
      } else if (p.type === 'bubble') {
        const rad = Math.max(1, p.r * (1.15 - p.life * 0.25));
        ctx.strokeStyle = `hsla(${p.hue}, 95%, 76%, ${(p.life * 0.85).toFixed(2)})`;
        ctx.fillStyle = `hsla(${(p.hue + 40) % 360}, 95%, 82%, ${(p.life * 0.20).toFixed(2)})`;
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = `rgba(255, 255, 255, ${(p.life * 0.75).toFixed(2)})`;
        ctx.beginPath();
        ctx.arc(p.x - rad * 0.32, p.y - rad * 0.32, rad * 0.2, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    }

    if (cursorTrailPoints.length > 0 || cursorTrailParticles.length > 0) {
      cursorAnimFrameId = requestAnimationFrame(renderCursorTrailFrame);
    } else {
      cursorAnimFrameId = null;
    }
  }

  startCursorTrailLoopFn = () => {
    if (!cursorAnimFrameId && currentSettings.cursorTrail && currentSettings.cursorTrail !== 'none') {
      cursorAnimFrameId = requestAnimationFrame(renderCursorTrailFrame);
    }
  };
}

function injectCustomThemeAndLayers() {
  if (!isMainSoundCloudApp() || !document.body) return;
  if (document.getElementById('sc-bg-root')) return;

  const styleEl = document.createElement('style');
  styleEl.id = 'sc-custom-theme-css';
  styleEl.textContent = `
    :root {
      --sc-accent: #ff5500;
      --sc-surface-rgb: 22, 22, 26;
      --sc-card-opacity: 0.78;
      --sc-radius: 14px;
    }

    ::-webkit-scrollbar {
      width: 7px !important;
      height: 7px !important;
    }

    ::-webkit-scrollbar-track {
      background: transparent !important;
    }

    ::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.22) !important;
      border-radius: 99px !important;
    }

    ::-webkit-scrollbar-thumb:hover {
      background: rgba(255, 255, 255, 0.4) !important;
    }

    /* Hide SoundCloud Ads, Startup Promo Banners ("Uploading tracks just got way easier"), Upsells & Cookie Popups */
    .header__upsellWrapper,
    .header__upsellWrapper.left,
    div.trackMonetizationSidebarUpsell,
    div.quotaMeterWrapper,
    article.sidebarModule.mobileApps,
    #onetrust-consent-sdk,
    #onetrust-banner-sdk,
    #onetrust-pc-sdk,
    .onetrust-pc-dark-filter,
    .ot-sdk-container,
    .ot-sdk-row,
    [id*="onetrust"],
    [class*="onetrust"],
    [id*="cookie-banner"],
    [class*="cookieBanner"],
    .l-announcement,
    .Announcement,
    [class*="Announcement"],
    [class*="announcement"],
    [class*="upsellBanner"],
    [class*="UpsellBanner"],
    [class*="promoBanner"],
    [class*="PromoBanner"],
    [class*="calloutBanner"],
    [class*="CalloutBanner"],
    .sc-hidden-promo-banner {
      display: none !important;
      visibility: hidden !important;
      opacity: 0 !important;
      height: 0 !important;
      min-height: 0 !important;
      margin: 0 !important;
      padding: 0 !important;
      border: none !important;
      pointer-events: none !important;
      overflow: hidden !important;
    }

    html, body, body.theme-dark, body.theme-light,
    #app, #content,
    .l-container, .l-fluid-fixed, .l-main, .l-content, .l-listen-wrapper, .l-listen,
    .l-collection, .l-search, .l-discover, .l-stream, .l-front,
    .stream, .userMain, .collection, .mixedModularHome, .modularHome,
    .lazyLoadingList, .soundList, .trackList, .searchList {
      background: transparent !important;
      background-color: transparent !important;
    }

    /* Solid, Non-Transparent Search Autocomplete Popup & Dropdown Menus */
    .headerSearch__results,
    .searchAutoComplete,
    .searchAutoComplete__list,
    .autocomplete,
    .ui-autocomplete,
    [class*="searchAutoComplete"],
    [class*="SearchAutoComplete"],
    [class*="autocomplete"],
    [class*="Autocomplete"],
    [class*="searchResults"],
    [class*="SearchResults"],
    .headerSearch [role="listbox"],
    [role="listbox"],
    .g-z-index-header > div,
    .g-z-index-header .sc-background-dark,
    .g-z-index-header .sc-background-light,
    .g-z-index-header .sc-background-white,
    .dropdownMenu,
    .dropdownContent,
    .headerMenu,
    .headerMenu__list,
    .userNav__menuList,
    .moreActions {
      background: rgba(var(--sc-surface-rgb, 20, 20, 26), 0.98) !important;
      background-color: rgb(var(--sc-surface-rgb, 20, 20, 26)) !important;
      backdrop-filter: blur(22px) !important;
      -webkit-backdrop-filter: blur(22px) !important;
      border: 1px solid rgba(255, 255, 255, 0.14) !important;
      border-radius: 12px !important;
      box-shadow: 0 20px 52px rgba(0, 0, 0, 0.88) !important;
      z-index: 99999 !important;
    }

    .searchAutoComplete__item,
    .autocompleteItem,
    [class*="searchAutoComplete"] li,
    [class*="Autocomplete"] li,
    [role="listbox"] [role="option"] {
      background: transparent !important;
      color: #f3f3f7 !important;
    }

    .searchAutoComplete__item:hover,
    .autocompleteItem:hover,
    [class*="searchAutoComplete"] li:hover,
    [class*="Autocomplete"] li:hover,
    [role="listbox"] [role="option"]:hover,
    .searchAutoComplete__item.selected,
    .autocompleteItem.selected {
      background: rgba(255, 255, 255, 0.09) !important;
    }

    html, body {
      overflow-y: auto !important;
      overflow-x: hidden !important;
    }

    /* CRITICAL: #app must NOT create a low z-index stacking context, otherwise .playControls & .volume__sliderWrapper get trapped below #sc-custom-track-page! */
    #app {
      position: static !important;
      z-index: auto !important;
    }

    #content {
      position: relative !important;
      z-index: 1 !important;
    }

    /* Hide ALL underlying page containers when 2026 Track Page is active so nothing ever overlaps */
    body.sc-custom-tp-open {
      overflow: hidden !important;
    }

    body.sc-custom-tp-open #content,
    body.sc-custom-tp-open #app > :not(.header):not(.playControls):not(.g-z-index-header):not(.g-z-index-modal-background):not(.g-z-index-modal-content) {
      display: none !important;
      visibility: hidden !important;
      opacity: 0 !important;
      pointer-events: none !important;
    }

    /* Hardware-accelerated Background Layer (z-index: 0, directly behind #content z-index: 1 and #sc-custom-track-page z-index: 50) */
    #sc-bg-root {
      position: fixed !important;
      inset: 0 !important;
      z-index: 0 !important;
      pointer-events: none !important;
      overflow: hidden !important;
      contain: strict;
      border-bottom-left-radius: 14px;
      border-bottom-right-radius: 14px;
    }

    #sc-wallpaper-layer {
      position: absolute;
      inset: 0;
      z-index: 1;
      background-color: #121212;
      background-size: cover;
      background-position: center;
      background-repeat: no-repeat;
      will-change: transform, filter;
      backface-visibility: hidden;
      transition: filter 0.22s ease;
      overflow: hidden;
    }

    #sc-wallpaper-img,
    #sc-wallpaper-video {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      pointer-events: none;
      display: none;
    }

    /* Background particles sit inside #sc-bg-root (z-index: 2): ABOVE wallpaper (z-index: 1), BELOW all SoundCloud UI! */
    #sc-particles-canvas {
      position: absolute !important;
      inset: 0 !important;
      width: 100% !important;
      height: 100% !important;
      z-index: 2 !important;
      pointer-events: none !important;
      display: none;
    }

    #sc-cursor-trail-canvas {
      position: fixed !important;
      inset: 0 !important;
      z-index: 999998 !important;
      pointer-events: none !important;
      display: none;
    }

    /* =================================================================
       2026 SoundCloud Track Page View (matches website image_511b3f.jpg)
        Dedicated full-viewport scroll container between top header (46px)
       and bottom playControls (49px) so scrolling down to read all
       comments & details ALWAYS works smoothly!
       ================================================================= */
    @keyframes scTpFadeIn {
      from {
        opacity: 0;
        transform: translateY(8px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    #sc-custom-track-page {
      position: fixed !important;
      top: 46px !important;
      left: 0 !important;
      right: 0 !important;
      bottom: 49px !important;
      z-index: 50 !important;
      overflow-y: auto !important;
      overflow-x: hidden !important;
      overscroll-behavior: contain;
      -webkit-overflow-scrolling: touch;
      will-change: scroll-position;
      pointer-events: auto !important;
      background-color: #121212 !important;
      padding: 24px 28px 110px 28px;
      color: #f2f2f2;
      font-family: "Inter", "Cantarell", "Segoe UI", "Helvetica Neue", sans-serif;
      display: none;
      box-sizing: border-box;
    }

    html.sc-has-custom-wp #sc-custom-track-page,
    body.sc-has-custom-wp #sc-custom-track-page,
    html.sc-has-particles #sc-custom-track-page,
    body.sc-has-particles #sc-custom-track-page {
      background-color: rgba(10, 10, 14, 0.36) !important;
      backdrop-filter: none !important;
    }

    .sc-tp-icon-circle.active {
      background: rgba(255, 85, 0, 0.34) !important;
      border-color: var(--sc-accent, #ff5500) !important;
      color: var(--sc-accent, #ff5500) !important;
    }

    /* Toast Notification & Action Modals (Share / Add to Playlist) */
    #sc-tp-toast {
      position: fixed;
      bottom: 66px;
      left: 50%;
      transform: translateX(-50%) translateY(12px);
      background: #1e1e24;
      color: #ffffff;
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 999px;
      padding: 9px 20px;
      font-size: 13px;
      font-weight: 700;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.6);
      z-index: 999999;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.18s ease, transform 0.18s ease;
    }

    #sc-tp-toast.show {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }

    .sc-tp-modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.42);
      z-index: 999990;
      display: none;
      align-items: center;
      justify-content: center;
    }

    .sc-tp-share-screen-close {
      position: fixed;
      top: 64px;
      right: 22px;
      width: 34px;
      height: 34px;
      border-radius: 50%;
      background: rgba(24, 24, 28, 0.92);
      border: 1px solid rgba(255, 255, 255, 0.14);
      color: #ffffff;
      font-size: 15px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 999995;
      transition: background 0.15s ease, transform 0.15s ease;
    }

    .sc-tp-share-screen-close:hover {
      background: #32323a;
      transform: scale(1.06);
    }

    .sc-tp-share-orig-box {
      width: 500px;
      max-width: calc(100vw - 32px);
      background: #121212;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 6px;
      padding: 22px 26px 24px 26px;
      color: #f2f2f2;
      box-shadow: 0 22px 64px rgba(0, 0, 0, 0.82);
      display: flex;
      flex-direction: column;
      font-family: "Inter", "Cantarell", "Segoe UI", sans-serif;
    }

    .sc-tp-share-tabs {
      display: flex;
      align-items: center;
      gap: 24px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.12);
      margin-bottom: 20px;
    }

    .sc-tp-share-tab {
      font-size: 16px;
      font-weight: 700;
      color: #999999;
      padding-bottom: 10px;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
      transition: color 0.15s ease;
    }

    .sc-tp-share-tab:hover {
      color: #dddddd;
    }

    .sc-tp-share-tab.active {
      color: #ffffff;
      border-bottom-color: #ffffff;
    }

    .sc-tp-share-card {
      display: flex;
      gap: 18px;
      align-items: stretch;
      margin-bottom: 22px;
    }

    .sc-tp-share-art {
      width: 148px;
      height: 148px;
      border-radius: 4px;
      object-fit: cover;
      background: #202024;
      flex-shrink: 0;
    }

    .sc-tp-share-card-right {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      padding: 4px 0 2px 0;
    }

    .sc-tp-share-card-top {
      display: flex;
      align-items: flex-start;
      gap: 10px;
    }

    .sc-tp-share-play {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: #ffffff;
      color: #111111;
      border: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      flex-shrink: 0;
      transition: transform 0.14s ease, filter 0.14s ease;
    }

    .sc-tp-share-play:hover {
      filter: brightness(0.92);
      transform: scale(1.04);
    }

    .sc-tp-share-meta {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .sc-tp-share-artist {
      font-size: 12px;
      color: #b5b5b5;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .sc-tp-share-title {
      font-size: 13.5px;
      font-weight: 700;
      color: #ffffff;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .sc-tp-share-ago {
      font-size: 11.5px;
      color: #999999;
      flex-shrink: 0;
      white-space: nowrap;
    }

    .sc-tp-share-wave-box {
      position: relative;
      width: 100%;
      height: 68px;
      margin-top: 10px;
    }

    #sc-tp-share-wave-canvas {
      width: 100%;
      height: 68px;
      display: block;
    }

    .sc-tp-share-wave-dur {
      position: absolute;
      right: 2px;
      top: 52%;
      transform: translateY(-50%);
      background: rgba(12, 12, 14, 0.92);
      color: #ffffff;
      font-size: 10px;
      font-weight: 700;
      padding: 1px 4px;
      border-radius: 2px;
      pointer-events: none;
    }

    .sc-tp-share-socials {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
    }

    .sc-tp-soc-btn {
      width: 38px;
      height: 38px;
      border-radius: 50%;
      border: none;
      color: #ffffff;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: transform 0.14s ease, filter 0.14s ease;
    }

    .sc-tp-soc-btn:hover {
      transform: translateY(-1px);
      filter: brightness(1.08);
    }

    .sc-tp-share-link-row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 10px;
    }

    .sc-tp-share-url-input {
      flex: 1;
      height: 32px;
      background: #222222;
      border: 1px solid #5a5a5a;
      border-radius: 4px !important;
      color: #ffffff;
      font-size: 12.5px;
      padding: 0 10px;
      outline: none;
    }

    .sc-tp-share-url-input:focus {
      border-color: #888888;
    }

    .sc-tp-share-ts-input {
      width: 62px;
      height: 32px;
      background: #222222;
      border: 1px solid #333333;
      border-radius: 4px !important;
      color: #ffffff;
      font-size: 12.5px;
      text-align: center;
      outline: none;
    }

    .sc-tp-share-chk-lbl {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      font-size: 12px;
      color: #cccccc;
      cursor: pointer;
      user-select: none;
    }

    .sc-tp-share-chk-lbl input[type="checkbox"] {
      appearance: none;
      -webkit-appearance: none;
      width: 15px;
      height: 15px;
      background: #1b1b1b;
      border: 1px solid #555555;
      border-radius: 3px !important;
      cursor: pointer;
      display: inline-grid;
      place-content: center;
      margin: 0;
    }

    .sc-tp-share-chk-lbl input[type="checkbox"]:checked {
      background: var(--sc-accent, #ff5500);
      border-color: var(--sc-accent, #ff5500);
    }

    .sc-tp-share-chk-lbl input[type="checkbox"]:checked::before {
      content: "✓";
      color: #ffffff;
      font-size: 11px;
      font-weight: 900;
      line-height: 1;
    }

    .sc-tp-modal-backdrop.open {
      display: flex;
      animation: scTpFadeIn 0.16s ease;
    }

    .sc-tp-modal-box {
      width: 440px;
      max-width: calc(100vw - 32px);
      background: #18181e;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 16px;
      padding: 20px 22px;
      color: #f2f2f2;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.7);
      display: flex;
      flex-direction: column;
      gap: 14px;
      font-family: "Inter", "Cantarell", "Segoe UI", sans-serif;
    }

    .sc-tp-modal-hdr {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      padding-bottom: 10px;
    }

    .sc-tp-modal-hdr h3 {
      margin: 0;
      font-size: 16px;
      font-weight: 800;
      color: #ffffff;
    }

    .sc-tp-pl-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.07);
    }

    .sc-tp-pl-btn {
      background: rgba(255, 255, 255, 0.12);
      color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 999px;
      padding: 5px 14px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
    }

    .sc-tp-pl-btn:hover,
    .sc-tp-pl-btn.added {
      background: var(--sc-accent, #ff5500);
      border-color: var(--sc-accent, #ff5500);
      color: var(--sc-accent-fg, #ffffff) !important;
    }

    #sc-custom-track-page.active {
      display: block !important;
      animation: scTpFadeIn 0.22s cubic-bezier(0.22, 1, 0.36, 1);
    }

    .sc-tp-inner {
      max-width: 1240px;
      margin: 0 auto;
      padding-bottom: 60px;
    }

    .sc-tp-hero {
      display: flex;
      justify-content: space-between;
      align-items: stretch;
      gap: 28px;
      background: var(--sc-hero-bg, #787774);
      border-radius: 18px;
      padding: 26px 28px;
      box-shadow: 0 18px 46px rgba(0, 0, 0, 0.42);
      border: 1px solid rgba(255, 255, 255, 0.1);
      margin-bottom: 28px;
      min-height: 364px;
      transition: background 0.48s cubic-bezier(0.22, 1, 0.36, 1), transform 0.36s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.32s cubic-bezier(0.22, 1, 0.36, 1);
      will-change: background, transform, opacity;
    }

    .sc-tp-title-meta,
    .sc-tp-cover,
    .sc-tp-body {
      transition: opacity 0.3s cubic-bezier(0.22, 1, 0.36, 1), transform 0.34s cubic-bezier(0.22, 1, 0.36, 1);
      will-change: opacity, transform;
    }

    #sc-custom-track-page.sc-tp-transition-out .sc-tp-title-meta {
      opacity: 0.25;
      transform: translateY(6px);
    }

    #sc-custom-track-page.sc-tp-transition-out .sc-tp-cover {
      opacity: 0.35;
      transform: scale(0.965);
    }

    #sc-custom-track-page.sc-tp-transition-out .sc-tp-body {
      opacity: 0.45;
      transform: translateY(6px);
    }

    .sc-tp-hero-left {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 16px;
    }

    .sc-tp-title-row {
      display: flex;
      align-items: flex-start;
      gap: 18px;
    }

    .sc-tp-play-btn {
      width: 64px;
      height: 64px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.18);
      border: 1.5px solid rgba(255, 255, 255, 0.32);
      color: #ffffff;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      flex-shrink: 0;
      transition: transform 0.16s cubic-bezier(0.22, 1, 0.36, 1), background 0.16s ease;
    }

    .sc-tp-play-btn:hover {
      background: rgba(255, 255, 255, 0.28);
      transform: scale(1.05);
    }

    .sc-tp-play-btn:active {
      transform: scale(0.97);
    }

    .sc-tp-title-meta {
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 0;
      padding-top: 4px;
    }

    .sc-tp-title {
      margin: 0;
      font-size: 27px;
      font-weight: 800;
      color: #ffffff;
      line-height: 1.2;
      word-break: break-word;
    }

    .sc-tp-subline {
      font-size: 13.5px;
      color: rgba(255, 255, 255, 0.78);
      display: flex;
      align-items: center;
      gap: 7px;
      flex-wrap: wrap;
    }

    .sc-tp-subline a {
      color: rgba(255, 255, 255, 0.92);
      text-decoration: none;
      font-weight: 600;
    }

    .sc-tp-subline a:hover {
      text-decoration: underline;
    }

    .sc-tp-hq-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: rgba(255, 255, 255, 0.22);
      color: #ffffff;
      font-size: 9.5px;
      font-weight: 800;
      padding: 1px 5px;
      border-radius: 3px;
      letter-spacing: 0.04em;
    }

    /* Waveform & Timed Comment Avatars + Popover */
    .sc-tp-waveform-wrap {
      position: relative;
      width: 100%;
      height: 138px;
      display: flex;
      align-items: center;
      cursor: pointer;
      user-select: none;
      margin: 4px 0 12px 0;
    }

    #sc-tp-waveform-canvas {
      width: calc(100% - 46px);
      height: 124px;
      display: block;
    }

    .sc-tp-wave-times {
      position: absolute;
      right: 0;
      top: 50%;
      transform: translateY(-50%);
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 18px;
      font-size: 11px;
      font-weight: 700;
      color: rgba(255, 255, 255, 0.9);
      pointer-events: none;
    }

    .sc-tp-wave-avatars {
      position: absolute;
      left: 0;
      right: 46px;
      top: 54%;
      height: 28px;
      pointer-events: none;
      z-index: 4;
    }

    .sc-tp-wave-avatar {
      position: absolute;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      border: 1.5px solid rgba(255, 255, 255, 0.9);
      object-fit: cover;
      transform: translate(-50%, -25%);
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.5);
      pointer-events: auto;
      cursor: pointer;
      transition: transform 0.16s cubic-bezier(0.22, 1, 0.36, 1), border-color 0.16s ease, width 0.16s ease, height 0.16s ease;
      background: #202026;
    }

    .sc-tp-wave-avatar:hover,
    .sc-tp-wave-avatar.active-comment {
      transform: translate(-50%, -28%) scale(1.32);
      border-color: #ffffff;
      z-index: 12;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.65);
    }

    .sc-tp-wave-popover {
      position: absolute;
      top: calc(54% + 22px);
      left: 50%;
      transform: translateX(-50%);
      background: rgba(16, 16, 20, 0.95);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 6px;
      padding: 5px 11px;
      font-size: 11.5px;
      color: #e6e6ea;
      white-space: nowrap;
      max-width: 425px;
      overflow: hidden;
      text-overflow: ellipsis;
      display: none;
      align-items: center;
      gap: 6px;
      z-index: 15;
      box-shadow: 0 8px 22px rgba(0, 0, 0, 0.55);
      pointer-events: auto;
    }

    .sc-tp-wave-popover.visible {
      display: inline-flex;
      animation: scTpFadeIn 0.14s ease;
    }

    .sc-tp-wave-popover-user {
      font-weight: 700;
      color: #ffffff;
    }

    .sc-tp-wave-popover-body {
      color: #d4d4dc;
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .sc-tp-wave-popover-act {
      font-weight: 700;
      color: #ffffff;
      cursor: pointer;
    }

    .sc-tp-wave-popover-act:hover {
      text-decoration: underline;
    }

    /* Hero Bottom Actions Row */
    .sc-tp-actions-row {
      display: flex;
      align-items: center;
      gap: 9px;
      flex-wrap: wrap;
    }

    .sc-tp-like-pill {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      height: 40px;
      padding: 0 16px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.14);
      border: 1px solid rgba(255, 255, 255, 0.25);
      color: #ffffff;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.15s ease, transform 0.15s ease, border-color 0.15s ease;
    }

    .sc-tp-like-pill:hover,
    .sc-tp-like-pill.liked {
      background: rgba(255, 85, 0, 0.34);
      border-color: var(--sc-accent, #ff5500);
      transform: translateY(-1px);
    }

    .sc-tp-comment-pill {
      flex: 1;
      min-width: 210px;
      max-width: 390px;
      height: 40px;
      border-radius: 999px;
      background: rgba(18, 18, 22, 0.42);
      border: 1px solid rgba(255, 255, 255, 0.22);
      display: flex;
      align-items: center;
      padding: 0 12px 0 6px;
      gap: 9px;
      transition: border-color 0.15s ease, background 0.15s ease;
    }

    .sc-tp-comment-pill:focus-within {
      background: rgba(18, 18, 22, 0.62);
      border-color: rgba(255, 255, 255, 0.48);
    }

    .sc-tp-comment-self-avatar {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      object-fit: cover;
      background: #2a2a32;
      flex-shrink: 0;
    }

    .sc-tp-comment-pill input {
      all: unset;
      flex: 1;
      color: #ffffff;
      font-size: 13px;
    }

    .sc-tp-comment-pill input::placeholder {
      color: rgba(255, 255, 255, 0.72);
    }

    .sc-tp-icon-circle {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.14);
      border: 1px solid rgba(255, 255, 255, 0.24);
      color: #ffffff;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: background 0.15s ease, transform 0.15s ease;
    }

    .sc-tp-icon-circle:hover {
      background: rgba(255, 255, 255, 0.25);
      transform: translateY(-1px);
    }

    .sc-tp-hero-right {
      width: 320px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .sc-tp-cover {
      width: 320px;
      height: 320px;
      border-radius: 14px;
      object-fit: cover;
      box-shadow: 0 14px 34px rgba(0, 0, 0, 0.45);
      background: #1c1c22;
    }

    /* Two-column lower section */
    .sc-tp-body {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 340px;
      gap: 36px;
      align-items: start;
    }

    .sc-tp-section-hdr {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid rgba(255, 255, 255, 0.12);
      padding-bottom: 10px;
      margin-bottom: 14px;
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.05em;
      color: #ffffff;
      text-transform: uppercase;
    }

    /* Collapsible DETAILS section matching original SoundCloud (image_511b3f.jpg) */
    #sc-tp-details-wrap {
      margin-bottom: 28px;
    }

    .sc-tp-description-body {
      font-size: 14px;
      line-height: 1.62;
      color: #e8e8ec;
      white-space: pre-wrap;
      word-break: break-word;
      position: relative;
      transition: max-height 0.28s cubic-bezier(0.22, 1, 0.36, 1);
    }

    .sc-tp-description-body.collapsed {
      max-height: 76px;
      overflow: hidden;
      -webkit-mask-image: linear-gradient(180deg, #000000 35%, rgba(0, 0, 0, 0) 100%);
      mask-image: linear-gradient(180deg, #000000 35%, rgba(0, 0, 0, 0) 100%);
    }

    .sc-tp-show-more-btn {
      all: unset;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      margin-top: 10px;
      font-size: 12.5px;
      font-weight: 700;
      color: #ffffff;
      cursor: pointer;
      opacity: 0.9;
      transition: opacity 0.15s ease;
    }

    .sc-tp-show-more-btn:hover {
      opacity: 1;
      text-decoration: underline;
    }

    /* Comments List matching original SoundCloud (image_511b3f.jpg) */
    .sc-tp-comments-sort {
      font-size: 11.5px;
      color: #c4c4cc;
      font-weight: 600;
      text-transform: none;
      letter-spacing: normal;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }

    .sc-tp-comments-sort:hover {
      color: #ffffff;
    }

    .sc-tp-comments-list {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    .sc-tp-comment-item {
      display: flex;
      gap: 14px;
      align-items: flex-start;
      padding: 4px 0;
    }

    .sc-tp-comment-avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      object-fit: cover;
      flex-shrink: 0;
      background: #25252c;
    }

    .sc-tp-comment-main {
      flex: 1;
      min-width: 0;
    }

    .sc-tp-comment-top {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 12.5px;
      color: #9a9aa6;
      margin-bottom: 5px;
      flex-wrap: wrap;
    }

    .sc-tp-comment-user {
      font-weight: 700;
      color: #ffffff;
    }

    .sc-tp-comment-ts {
      color: #38bdf8;
      font-weight: 700;
      font-size: 12px;
      cursor: pointer;
    }

    .sc-tp-comment-ts:hover {
      text-decoration: underline;
    }

    .sc-tp-comment-text {
      font-size: 13.5px;
      color: #f2f2f6;
      line-height: 1.46;
      word-break: break-word;
      margin-bottom: 8px;
    }

    .sc-tp-comment-actions {
      display: flex;
      align-items: center;
      gap: 14px;
      font-size: 11.5px;
      font-weight: 700;
      color: #a0a0ab;
    }

    .sc-tp-comment-actions span {
      cursor: pointer;
      transition: color 0.12s ease;
    }

    .sc-tp-comment-actions span:hover {
      color: #ffffff;
    }

    .sc-tp-comment-like-col {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 3px;
      color: #a0a0ab;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      padding-top: 4px;
      user-select: none;
    }

    .sc-tp-comment-like-col:hover,
    .sc-tp-comment-like-col.liked {
      color: var(--sc-accent, #ff5500);
    }

    /* Right Sidebar */
    .sc-tp-sidebar {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .sc-tp-artist-card {
      background: rgba(var(--sc-surface-rgb, 22, 22, 26), 0.9);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 14px;
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .sc-tp-artist-top {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .sc-tp-artist-avatar {
      width: 60px;
      height: 60px;
      border-radius: 50%;
      object-fit: cover;
      background: #25252c;
      flex-shrink: 0;
    }

    .sc-tp-artist-name-row {
      display: flex;
      align-items: center;
      gap: 5px;
      margin: 0 0 3px 0;
    }

    .sc-tp-artist-name {
      font-size: 16px;
      font-weight: 800;
      color: #ffffff;
      margin: 0;
    }

    .sc-tp-verified-badge {
      display: inline-flex;
      width: 15px;
      height: 15px;
      border-radius: 50%;
      background: #38bdf8;
      color: #000;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      font-weight: 900;
      flex-shrink: 0;
    }

    .sc-tp-artist-sub {
      font-size: 12px;
      color: #a5a5b0;
      margin: 0;
    }

    .sc-tp-artist-btns {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      padding-top: 14px;
    }

    .sc-tp-btn-follow {
      background: #ffffff;
      color: #111111;
      border: none;
      border-radius: 999px;
      height: 36px;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      transition: transform 0.14s ease, filter 0.14s ease;
    }

    .sc-tp-btn-follow:hover {
      filter: brightness(0.92);
      transform: translateY(-1px);
    }

    .sc-tp-btn-msg {
      background: transparent;
      color: #ffffff;
      border: 1px solid rgba(255, 255, 255, 0.22);
      border-radius: 999px;
      height: 36px;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.14s ease, transform 0.14s ease;
    }

    .sc-tp-btn-msg:hover {
      background: rgba(255, 255, 255, 0.1);
      transform: translateY(-1px);
    }

    .sc-tp-stats-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
    }

    .sc-tp-stat-box {
      background: rgba(var(--sc-surface-rgb, 22, 22, 26), 0.9);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      padding: 14px 10px;
      text-align: center;
    }

    .sc-tp-stat-val {
      font-size: 18px;
      font-weight: 800;
      color: #ffffff;
      margin-bottom: 4px;
    }

    .sc-tp-stat-lbl {
      font-size: 10.5px;
      font-weight: 700;
      color: #9a9aa6;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }

    .sc-tp-fans-card {
      background: rgba(var(--sc-surface-rgb, 22, 22, 26), 0.9);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 14px;
      padding: 16px;
    }

    .sc-tp-fans-tabs {
      display: flex;
      gap: 16px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.12);
      margin-bottom: 10px;
    }

    .sc-tp-fans-tab {
      font-size: 12px;
      font-weight: 700;
      color: #9a9aa6;
      padding-bottom: 8px;
      cursor: pointer;
      border-bottom: 2px solid transparent;
    }

    .sc-tp-fans-tab.active {
      color: #ffffff;
      border-bottom-color: #ffffff;
    }

    .sc-tp-fan-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 7px 0;
      font-size: 13px;
      color: #eaeaea;
    }

    .sc-tp-fan-left {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }

    .sc-tp-fan-avatar {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      object-fit: cover;
    }

    /* Bottom Playback Bar Hover Light-Up Animation & Smooth Progress */
    .playbackTimeline__progressWrapper {
      position: relative !important;
      cursor: pointer !important;
    }

    .sc-bottom-hover-bar {
      position: absolute;
      left: 0;
      top: 50%;
      transform: translateY(-50%);
      height: 3px;
      width: 0%;
      background: rgba(255, 255, 255, 0.65);
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.14s ease, width 0.04s linear;
      z-index: 2;
      border-radius: 2px;
    }

    .playbackTimeline__progressWrapper:hover .sc-bottom-hover-bar {
      opacity: 1;
    }

    .playbackTimeline__progressBar {
      transition: width 0.12s linear !important;
      z-index: 3 !important;
    }

    /* High-Performance Elevated Cards (no heavy backdrop-filter on scrolling list items) */
    .header {
      background: rgba(var(--sc-surface-rgb), 0.94) !important;
      backdrop-filter: blur(14px) !important;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08) !important;
      z-index: 1500 !important;
    }

    .dropdownMenu,
    .headerMenu,
    .g-z-index-header,
    .g-z-index-modal-background,
    .g-z-index-modal-content {
      z-index: 2600 !important;
    }

    .playControls {
      position: fixed !important;
      bottom: 0 !important;
      left: 0 !important;
      right: 0 !important;
      z-index: 2500 !important;
      overflow: visible !important;
      background-color: #16161a !important;
      background: rgb(var(--sc-surface-rgb, 22, 22, 26)) !important;
      border-top: 1px solid rgba(255, 255, 255, 0.09) !important;
      backdrop-filter: none !important;
      opacity: 1 !important;
    }

    .playControls__inner,
    .playControls__wrapper,
    .playControls__bg {
      overflow: visible !important;
      background-color: #16161a !important;
      background: rgb(var(--sc-surface-rgb, 22, 22, 26)) !important;
      backdrop-filter: none !important;
      opacity: 1 !important;
    }

    .playControls__elements,
    .playControls__volume,
    .playControls__queue,
    .playControls__soundBadge,
    .playbackSoundBadge,
    .playbackSoundBadge__actions,
    .volume {
      overflow: visible !important;
      background: transparent !important;
      backdrop-filter: none !important;
    }

    .playControls__soundBadge {
      width: auto !important;
      min-width: 340px !important;
      max-width: none !important;
      padding-right: 10px !important;
      box-sizing: border-box !important;
    }

    .playbackSoundBadge {
      display: flex !important;
      align-items: center !important;
      width: auto !important;
      max-width: none !important;
      padding-right: 6px !important;
    }

    .playbackSoundBadge__titleContextContainer {
      max-width: 185px !important;
      margin-right: 10px !important;
    }

    .playbackSoundBadge__actions {
      display: inline-flex !important;
      align-items: center !important;
      gap: 6px !important;
      flex-shrink: 0 !important;
      margin-left: auto !important;
      padding-right: 6px !important;
    }

    .playbackSoundBadge__actions > *,
    .playbackSoundBadge__actions .sc-button,
    .playbackSoundBadge__showQueue,
    .playControls__queue .sc-button,
    .playControls__queue > * {
      min-width: 42px !important;
      width: 42px !important;
      height: 30px !important;
      border-radius: 999px !important;
      padding: 0 !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      flex-shrink: 0 !important;
      box-sizing: border-box !important;
      overflow: visible !important;
    }

    .volume,
    .playControls__volume {
      position: relative !important;
      z-index: 2650 !important;
      overflow: visible !important;
    }

    .volume__sliderWrapper {
      z-index: 2700 !important;
      pointer-events: auto !important;
      background: rgb(var(--sc-surface-rgb, 22, 22, 26)) !important;
      background-color: #16161a !important;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.75) !important;
      border: 1px solid rgba(255, 255, 255, 0.14) !important;
    }

    .sound__body,
    .soundList__item > div,
    .trackList__item,
    .compactTrackList__item,
    .userInfoBar,
    .listenEngagement,
    .l-sidebar .sidebarModule,
    .visualSound__wrapper,
    .searchTitle,
    .collectionSection__top,
    .Dropbar__content,
    .modal__modal {
      background: rgba(var(--sc-surface-rgb), var(--sc-card-opacity)) !important;
      border-radius: var(--sc-radius) !important;
      border: 1px solid rgba(255, 255, 255, 0.07) !important;
      padding: 10px !important;
      margin-bottom: 10px !important;
      color: #f2f2f2 !important;
    }

    .sc-artwork,
    .image__full,
    .sound__coverArt,
    .playableTile__artwork,
    .playableTile__imageWrapper {
      border-radius: var(--sc-radius) !important;
      overflow: hidden !important;
    }

    .sc-button,
    .headerSearch__input,
    input,
    select {
      border-radius: calc(var(--sc-radius) * 0.75) !important;
    }

    .sc-button-play,
    .playButton,
    .sc-button-cta,
    .playbackTimeline__progressBar {
      background-color: var(--sc-accent) !important;
      border-color: var(--sc-accent) !important;
    }

    .playbackSoundBadge__titleLink,
    .soundTitle__title,
    .sc-link-primary,
    .sc-link-dark,
    .header__navMenu > li > a {
      color: #f3f3f3 !important;
    }

    /* Studio Floating Drawers */
    .sc-studio-drawer {
      position: fixed;
      top: 12px;
      left: 14px;
      width: 390px;
      max-height: calc(100vh - 85px);
      background: rgba(18, 18, 22, 0.94);
      backdrop-filter: blur(20px);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 18px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.65);
      color: #f2f2f2;
      z-index: 999999;
      padding: 16px 18px;
      display: none;
      flex-direction: column;
      gap: 12px;
      overflow-y: auto;
      font-family: "Cantarell", "Inter", "Segoe UI", sans-serif;
    }

    .sc-studio-drawer.open {
      display: flex;
      animation: scTpFadeIn 0.18s cubic-bezier(0.22, 1, 0.36, 1);
    }

    .sc-dsp-section-title {
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--sc-accent, #ff5500);
      margin-top: 6px;
      padding-top: 8px;
      border-top: 1px solid rgba(255, 255, 255, 0.09);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .sc-anticlip-card {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 12px;
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      transition: border-color 0.18s ease, background 0.18s ease;
    }

    .sc-anticlip-card.mode-clean {
      border-color: rgba(16, 185, 129, 0.55);
      background: rgba(16, 185, 129, 0.10);
    }

    .sc-anticlip-card.mode-raw {
      border-color: rgba(244, 63, 94, 0.65);
      background: rgba(244, 63, 94, 0.13);
    }

    .sc-anticlip-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }

    .sc-anticlip-btn {
      border: none;
      border-radius: 999px;
      padding: 5px 13px;
      font-size: 11.5px;
      font-weight: 800;
      cursor: pointer;
      transition: transform 0.14s ease, filter 0.14s ease;
      flex-shrink: 0;
    }

    .sc-anticlip-btn.on {
      background: #10b981;
      color: #06281e;
    }

    .sc-anticlip-btn.off {
      background: #f43f5e;
      color: #ffffff;
    }

    .sc-studio-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      padding-bottom: 10px;
    }

    .sc-studio-header h3 {
      margin: 0;
      font-size: 15px;
      font-weight: 700;
      color: var(--sc-accent);
    }

    .sc-studio-close {
      background: rgba(255, 255, 255, 0.08);
      border: none;
      color: #ddd;
      width: 26px;
      height: 26px;
      border-radius: 50%;
      cursor: pointer;
      font-size: 13px;
    }

    .sc-studio-close:hover {
      background: #e81123;
      color: #fff;
    }

    .sc-ctrl-row {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .sc-ctrl-label {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      color: #d0d0d6;
      font-weight: 600;
    }

    .sc-ctrl-label span.val {
      color: var(--sc-accent);
      font-weight: 700;
    }

    .sc-studio-drawer input[type="range"] {
      width: 100%;
      accent-color: var(--sc-accent);
      cursor: pointer;
    }

    .sc-preset-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 6px;
    }

    .sc-preset-btn {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #eaeaea;
      border-radius: 10px;
      padding: 7px 10px;
      font-size: 11.5px;
      font-weight: 600;
      cursor: pointer;
      text-align: center;
      transition: all 0.15s ease;
    }

    .sc-preset-btn:hover {
      border-color: var(--sc-accent);
      background: rgba(255, 85, 0, 0.15);
    }

    .sc-preset-btn.active {
      border-color: var(--sc-accent);
      background: rgba(255, 85, 0, 0.28);
      color: #ffffff;
      box-shadow: 0 0 12px rgba(255, 85, 0, 0.25);
    }

    .sc-action-btn {
      background: var(--sc-accent, #ff5500);
      color: var(--sc-accent-fg, #ffffff) !important;
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 10px;
      padding: 8px 14px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
    }

    .sc-action-btn.secondary {
      background: rgba(255, 255, 255, 0.08);
      color: #ddd;
    }

    .sc-studio-input, .sc-studio-select {
      background: rgba(0, 0, 0, 0.45);
      border: 1px solid rgba(255, 255, 255, 0.14);
      color: #fff;
      border-radius: 10px;
      padding: 7px 10px;
      font-size: 12px;
      width: 100%;
      outline: none;
    }
  `;
  document.head.appendChild(styleEl);

  const bgRoot = document.createElement('div');
  bgRoot.id = 'sc-bg-root';

  const wpLayer = document.createElement('div');
  wpLayer.id = 'sc-wallpaper-layer';

  const wpImg = document.createElement('img');
  wpImg.id = 'sc-wallpaper-img';
  wpImg.alt = '';
  wpLayer.appendChild(wpImg);

  const wpVideo = document.createElement('video');
  wpVideo.id = 'sc-wallpaper-video';
  wpVideo.muted = true;
  wpVideo.loop = true;
  wpVideo.autoplay = true;
  wpVideo.playsInline = true;
  wpVideo.preload = 'auto';
  wpLayer.appendChild(wpVideo);

  const fxCanvas = document.createElement('canvas');
  fxCanvas.id = 'sc-particles-canvas';

  const cursorCanvas = document.createElement('canvas');
  cursorCanvas.id = 'sc-cursor-trail-canvas';

  bgRoot.appendChild(wpLayer);
  bgRoot.appendChild(fxCanvas);
  document.documentElement.appendChild(bgRoot);
  document.documentElement.appendChild(cursorCanvas);

  const audioDrawer = document.createElement('div');
  audioDrawer.id = 'sc-drawer-audio';
  audioDrawer.className = 'sc-studio-drawer';
  audioDrawer.innerHTML = `
    <div class="sc-studio-header">
      <h3>🎛️ Студия Баса, Защита от хрипа и 10-полосный EQ</h3>
      <button class="sc-studio-close" data-close="sc-drawer-audio">&#10005;</button>
    </div>

    <!-- Защита от хрипа и перегруза (ON / OFF) -->
    <div class="sc-anticlip-card mode-clean" id="sc-anticlip-card">
      <div class="sc-anticlip-top">
        <div style="font-size:12.5px; font-weight:800; color:#ffffff;">🛡️ Защита от хрипа и перегруза</div>
        <button class="sc-anticlip-btn on" id="btn-toggle-anticlip" type="button">ВКЛ (Чисто и громко)</button>
      </div>
      <div id="sc-anticlip-desc" style="font-size:11px; color:#d0d6dc; line-height:1.35;">
        <b>ВКЛ:</b> Студийный лимитер и фильтр гула держат звук максимально громким и чистым без хрипа динамиков.<br>
        <b>ВЫКЛ:</b> Отключает лимитер — позволяет раскачать жёсткий перегруз и хрип баса, когда нужно!
      </div>
    </div>

    <div class="sc-ctrl-row">
      <div class="sc-ctrl-label"><span>Готовые пресеты (Меняют характер трека)</span></div>
      <div class="sc-preset-grid">
        <button class="sc-preset-btn" data-eq-preset="flat">Оригинал (Flat)</button>
        <button class="sc-preset-btn" data-eq-preset="cleanthunder">🔊 Чистый Громкий Бас</button>
        <button class="sc-preset-btn" data-eq-preset="rawrattle">💥 Разнос с Хрипом (Raw)</button>
        <button class="sc-preset-btn" data-eq-preset="club">🔥 Клубный Сабвуфер</button>
        <button class="sc-preset-btn" data-eq-preset="deep808">💣 Инфра-808 (42 Гц)</button>
        <button class="sc-preset-btn" data-eq-preset="spatial3d">✨ Широкий 3D-Космос</button>
        <button class="sc-preset-btn" data-eq-preset="slowed">🌙 Slowed + Reverb</button>
        <button class="sc-preset-btn" data-eq-preset="nightcore">⚡ Speed Up (Nightcore)</button>
        <button class="sc-preset-btn" data-eq-preset="vocal">🎤 Кристальный Вокал</button>
        <button class="sc-preset-btn" data-eq-preset="lofi">📻 Тёплый Винил (Lo-Fi)</button>
      </div>
    </div>

    <div class="sc-dsp-section-title">
      <span>🔊 Громкость и Глубокая настройка Баса</span>
    </div>

    <div class="sc-ctrl-row">
      <div class="sc-ctrl-label"><span>🔊 Усиление громкости (Preamp до 400%)</span><span class="val" id="val-preamp">100%</span></div>
      <input type="range" id="sl-preamp" min="0.5" max="4.0" step="0.05" value="1.0">
    </div>

    <div class="sc-ctrl-row">
      <div class="sc-ctrl-label"><span>💥 Общая Мощь Баса (Master Bass Boost)</span><span class="val" id="val-bassBoost">+0 dB</span></div>
      <input type="range" id="sl-bassBoost" min="0" max="25" step="0.5" value="0">
    </div>

    <div class="sc-ctrl-row">
      <div class="sc-ctrl-label"><span>🌊 42 Гц — Инфра-Сабвуфер (Вибрация 808)</span><span class="val" id="val-subBass">+0 dB</span></div>
      <input type="range" id="sl-subBass" min="-15" max="20" step="0.5" value="0">
    </div>

    <div class="sc-ctrl-row">
      <div class="sc-ctrl-label"><span>🔊 72 Гц — Глубокий Клубный Бас (Давление)</span><span class="val" id="val-deepBass">+0 dB</span></div>
      <input type="range" id="sl-deepBass" min="-15" max="20" step="0.5" value="0">
    </div>

    <div class="sc-ctrl-row">
      <div class="sc-ctrl-label"><span>🥁 120 Гц — Ударность Бочки и Панч (Kick)</span><span class="val" id="val-punchBass">+0 dB</span></div>
      <input type="range" id="sl-punchBass" min="-15" max="20" step="0.5" value="0">
    </div>

    <div class="sc-ctrl-row">
      <div class="sc-ctrl-label"><span>🎸 185 Гц — Верхний Бас и Жирность Синтов</span><span class="val" id="val-upperBass">+0 dB</span></div>
      <input type="range" id="sl-upperBass" min="-15" max="18" step="0.5" value="0">
    </div>

    <div class="sc-ctrl-row">
      <div class="sc-ctrl-label"><span>🧹 255 Гц — Вырез гула и бубнежа (Чистота баса)</span><span class="val" id="val-mudCut">0%</span></div>
      <input type="range" id="sl-mudCut" min="0" max="100" step="1" value="0">
    </div>

    <div class="sc-ctrl-row">
      <div class="sc-ctrl-label"><span>🔥 Насыщенность / Перегруз баса (Drive / Хрип)</span><span class="val" id="val-warmth">0%</span></div>
      <input type="range" id="sl-warmth" min="0" max="100" step="1" value="0">
    </div>

    <div class="sc-dsp-section-title">
      <span>🎚️ Детальный Эквалайзер (Середина и Верх)</span>
    </div>

    <div class="sc-ctrl-row">
      <div class="sc-ctrl-label"><span>🎹 380 Гц — Нижняя середина (Тело / Вырез)</span><span class="val" id="val-lowMids">+0 dB</span></div>
      <input type="range" id="sl-lowMids" min="-15" max="18" step="0.5" value="0">
    </div>

    <div class="sc-ctrl-row">
      <div class="sc-ctrl-label"><span>🎤 1.0 кГц — Центр (Основа голоса и лидов)</span><span class="val" id="val-mids">+0 dB</span></div>
      <input type="range" id="sl-mids" min="-15" max="18" step="0.5" value="0">
    </div>

    <div class="sc-ctrl-row">
      <div class="sc-ctrl-label"><span>🎙️ 2.8 кГц — Близость вокала и атака гитар</span><span class="val" id="val-upperMids">+0 dB</span></div>
      <input type="range" id="sl-upperMids" min="-15" max="18" step="0.5" value="0">
    </div>

    <div class="sc-ctrl-row">
      <div class="sc-ctrl-label"><span>⚡ 5.5 кГц — Чёткость, детализация и щелчок</span><span class="val" id="val-presence">+0 dB</span></div>
      <input type="range" id="sl-presence" min="-15" max="18" step="0.5" value="0">
    </div>

    <div class="sc-ctrl-row">
      <div class="sc-ctrl-label"><span>✨ 10 кГц — Высокие частоты и Хай-Хэты</span><span class="val" id="val-treble">+0 dB</span></div>
      <input type="range" id="sl-treble" min="-15" max="18" step="0.5" value="0">
    </div>

    <div class="sc-ctrl-row">
      <div class="sc-ctrl-label"><span>💎 14.5 кГц — Ультра-воздух и студийный блеск</span><span class="val" id="val-airBand">+0 dB</span></div>
      <input type="range" id="sl-airBand" min="-15" max="18" step="0.5" value="0">
    </div>

    <div class="sc-dsp-section-title">
      <span>🌌 Пространство и Скорость трека</span>
    </div>

    <div class="sc-ctrl-row">
      <div class="sc-ctrl-label"><span>🎧 3D-ширина сцены (Стереоэффект)</span><span class="val" id="val-stereoWidth">0%</span></div>
      <input type="range" id="sl-stereoWidth" min="0" max="100" step="1" value="0">
    </div>

    <div class="sc-ctrl-row">
      <div class="sc-ctrl-label"><span>🏛️ Эффект зала и эха (Реверберация)</span><span class="val" id="val-reverbMix">0%</span></div>
      <input type="range" id="sl-reverbMix" min="0" max="100" step="1" value="0">
    </div>

    <div class="sc-ctrl-row">
      <div class="sc-ctrl-label"><span>⚡ Скорость и тон (Slowed / Speed Up)</span><span class="val" id="val-speedPitch">1.00x</span></div>
      <input type="range" id="sl-speedPitch" min="0.65" max="1.40" step="0.01" value="1.00">
    </div>
  `;
  document.documentElement.appendChild(audioDrawer);

  const themeDrawer = document.createElement('div');
  themeDrawer.id = 'sc-drawer-theme';
  themeDrawer.className = 'sc-studio-drawer';
  themeDrawer.innerHTML = `
    <div class="sc-studio-header">
      <h3>🎨 Обои, Частицы, Следы Курсора и Тема</h3>
      <button class="sc-studio-close" data-close="sc-drawer-theme">&#10005;</button>
    </div>

    <div class="sc-ctrl-row">
      <div class="sc-ctrl-label"><span>Кастомные и анимированные обои (MP4, GIF, WebM, Фото)</span></div>
      <div style="display:flex; gap:6px;">
        <button class="sc-action-btn" id="btn-pick-wp" style="flex:1;">🎬 Выбрать файл (MP4 / GIF / WebM / Фото)...</button>
        <button class="sc-action-btn secondary" id="btn-clear-wp">Сброс</button>
      </div>
    </div>

    <div class="sc-ctrl-row">
      <div class="sc-ctrl-label"><span>Встроенные фоны</span></div>
      <div class="sc-preset-grid">
        <button class="sc-preset-btn" data-wp-preset="sunset">Sunset Glow</button>
        <button class="sc-preset-btn" data-wp-preset="cyberpunk">Cyberpunk Neon</button>
        <button class="sc-preset-btn" data-wp-preset="aurora">Northern Aurora</button>
        <button class="sc-preset-btn" data-wp-preset="amethyst">Deep Amethyst</button>
      </div>
    </div>

    <div class="sc-ctrl-row">
      <div class="sc-ctrl-label"><span>Размытие обоев (Blur)</span><span class="val" id="val-wpBlur">0 px</span></div>
      <input type="range" id="sl-wpBlur" min="0" max="40" step="1" value="0">
    </div>

    <div class="sc-ctrl-row">
      <div class="sc-ctrl-label"><span>Затемнение обоев</span><span class="val" id="val-wpDim">20%</span></div>
      <input type="range" id="sl-wpDim" min="0" max="85" step="1" value="20">
    </div>

    <div class="sc-dsp-section-title">
      <span>🌸 Фоновые Частицы и Атмосфера</span>
    </div>

    <div class="sc-ctrl-row">
      <div class="sc-ctrl-label"><span>Эффект фоновых частиц</span></div>
      <select class="sc-studio-select" id="sel-particle">
        <option value="none" selected>Отключено (По умолчанию)</option>
        <option value="sakura">🌸 Лепестки сакуры (3D Sakura Petals)</option>
        <option value="stars">⭐ Звёздное небо и кометы (Starlight &amp; Meteors)</option>
        <option value="snow">❄️ Падающий снег и снежинки (Snowfall)</option>
        <option value="blizzard">🌨️ Зимняя метель (Blizzard)</option>
        <option value="rain">🌧️ Атмосферный дождь с каплями (Rain)</option>
        <option value="fireflies">✨ Ночные светлячки (Magical Fireflies)</option>
        <option value="embers">🔥 Тлеющие искры костра (Floating Embers)</option>
        <option value="hearts">💖 Парящие неоновые сердечки (Neon Hearts)</option>
        <option value="matrix">💻 Неоновый кибер-дождь (Cyber Matrix)</option>
        <option value="bokeh">🔮 Мягкое неоновое Боке (Dreamy Bokeh)</option>
        <option value="galaxy">🌌 Космическая туманность (Cosmic Stardust)</option>
      </select>
    </div>

    <div class="sc-ctrl-row">
      <div class="sc-ctrl-label"><span>Количество частиц</span><span class="val" id="val-pCount">80</span></div>
      <input type="range" id="sl-pCount" min="15" max="220" step="5" value="80">
    </div>

    <div class="sc-ctrl-row">
      <div class="sc-ctrl-label"><span>Размер частиц</span><span class="val" id="val-pSize">1.0x</span></div>
      <input type="range" id="sl-pSize" min="0.3" max="2.5" step="0.1" value="1.0">
    </div>

    <div class="sc-ctrl-row">
      <div class="sc-ctrl-label"><span>Скорость частиц</span><span class="val" id="val-pSpeed">1.0x</span></div>
      <input type="range" id="sl-pSpeed" min="0.2" max="2.5" step="0.1" value="1.0">
    </div>

    <div class="sc-dsp-section-title">
      <span>🌈 Следы за курсором мыши (Cursor Trails)</span>
    </div>

    <div class="sc-ctrl-row">
      <div class="sc-ctrl-label"><span>Эффект следа за курсором</span></div>
      <select class="sc-studio-select" id="sel-cursor-trail">
        <option value="none" selected>Отключено (По умолчанию)</option>
        <option value="rainbow">🌈 Радужный шлейф и искры (Rainbow Trail)</option>
        <option value="sakura">🌸 Лепестки сакуры за курсором (Sakura Trail)</option>
        <option value="snow">❄️ Снежинки и морозная пыль (Snowflakes Trail)</option>
        <option value="stars">⭐ Звёздная россыпь (Starlight Trail)</option>
        <option value="fire">🔥 Огненная комета и искры (Fire Comet)</option>
        <option value="neon">⚡ Неоновый лазер под цвет акцента (Neon Laser)</option>
        <option value="hearts">💖 Россыпь сердечек (Hearts Trail)</option>
        <option value="galaxy">🌌 Галактическая спираль (Galaxy Vortex)</option>
        <option value="bubbles">🫧 Радужные пузырьки (Iridescent Bubbles)</option>
      </select>
    </div>

    <div class="sc-ctrl-row">
      <div class="sc-ctrl-label"><span>Размер и яркость следа курсора</span><span class="val" id="val-cursorSize">1.0x</span></div>
      <input type="range" id="sl-cursorSize" min="0.5" max="2.5" step="0.1" value="1.0">
    </div>

    <div class="sc-dsp-section-title">
      <span>🎨 Цвета и геометрия карточек</span>
    </div>

    <div class="sc-ctrl-row">
      <div class="sc-ctrl-label"><span>Закругление углов (Border Radius)</span><span class="val" id="val-radius">12 px</span></div>
      <input type="range" id="sl-radius" min="0" max="26" step="1" value="12">
    </div>

    <div class="sc-ctrl-row">
      <div class="sc-ctrl-label"><span>Цвет акцента и цвет карточек</span></div>
      <div style="display:flex; gap:10px; align-items:center;">
        <label style="font-size:11px; display:flex; align-items:center; gap:6px;">
          Акцент: <input type="color" id="clr-accent" value="#ff5500" style="border:none; width:34px; height:26px; cursor:pointer; background:transparent;">
        </label>
        <label style="font-size:11px; display:flex; align-items:center; gap:6px;">
          Фон карточек: <input type="color" id="clr-surface" value="#16161a" style="border:none; width:34px; height:26px; cursor:pointer; background:transparent;">
        </label>
      </div>
    </div>
  `;
  document.documentElement.appendChild(themeDrawer);

  const lyricsDrawer = document.createElement('div');
  lyricsDrawer.id = 'sc-drawer-lyrics';
  lyricsDrawer.className = 'sc-studio-drawer';
  lyricsDrawer.innerHTML = `
    <div class="sc-studio-header">
      <h3>📝 Genius Lyrics</h3>
      <button class="sc-studio-close" data-close="sc-drawer-lyrics">&#10005;</button>
    </div>
    <input type="text" class="sc-studio-input" id="ly-artist" placeholder="Исполнитель (Artist)">
    <input type="text" class="sc-studio-input" id="ly-song" placeholder="Название трека (Song)">
    <div style="display:flex; gap:6px;">
      <button class="sc-action-btn secondary" id="ly-current" style="flex:1;">Текущий трек</button>
      <button class="sc-action-btn" id="ly-search" style="flex:1;">Найти текст</button>
    </div>
    <div id="ly-result" style="background:rgba(0,0,0,0.45); border-radius:12px; padding:12px; min-height:220px; max-height:360px; overflow-y:auto; white-space:pre-wrap; font-size:12.5px; line-height:1.5; color:#e6e6e6;">Нажмите «Текущий трек» для автоматического поиска текста.</div>
  `;
  document.documentElement.appendChild(lyricsDrawer);

  wireDrawerEvents();
  initParticleEngine(fxCanvas);
  initCursorTrailEngine(cursorCanvas);
  applyVisualSettings();
}

function syncDrawerInputsFromSettings() {
  const setVal = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.value = v;
  };
  const setTxt = (id, t) => {
    const el = document.getElementById(id);
    if (el) el.textContent = t;
  };
  const fmtDb = (v) => {
    const n = Number(v) || 0;
    return `${n >= 0 ? '+' : ''}${n} dB`;
  };

  const antiClipOn = currentSettings.antiClip !== false;
  const acCard = document.getElementById('sc-anticlip-card');
  const acBtn = document.getElementById('btn-toggle-anticlip');
  if (acCard) {
    acCard.classList.toggle('mode-clean', antiClipOn);
    acCard.classList.toggle('mode-raw', !antiClipOn);
  }
  if (acBtn) {
    acBtn.classList.toggle('on', antiClipOn);
    acBtn.classList.toggle('off', !antiClipOn);
    acBtn.textContent = antiClipOn ? 'ВКЛ (Чисто и громко)' : 'ВЫКЛ (Режим Хрипа 🔥)';
  }

  setVal('sl-preamp', currentSettings.preamp ?? 1.0);
  setTxt('val-preamp', `${Math.round((currentSettings.preamp || 1) * 100)}%`);

  setVal('sl-bassBoost', currentSettings.bassBoost ?? 0);
  setTxt('val-bassBoost', `+${Number(currentSettings.bassBoost) || 0} dB`);

  setVal('sl-subBass', currentSettings.subBass ?? 0);
  setTxt('val-subBass', fmtDb(currentSettings.subBass));

  setVal('sl-deepBass', currentSettings.deepBass ?? 0);
  setTxt('val-deepBass', fmtDb(currentSettings.deepBass));

  setVal('sl-punchBass', currentSettings.punchBass ?? 0);
  setTxt('val-punchBass', fmtDb(currentSettings.punchBass));

  setVal('sl-upperBass', currentSettings.upperBass ?? 0);
  setTxt('val-upperBass', fmtDb(currentSettings.upperBass));

  setVal('sl-mudCut', currentSettings.mudCut ?? 0);
  setTxt('val-mudCut', `${Math.round(Number(currentSettings.mudCut) || 0)}%`);

  setVal('sl-warmth', currentSettings.warmth ?? 0);
  setTxt('val-warmth', `${Math.round(Number(currentSettings.warmth) || 0)}%`);

  setVal('sl-lowMids', currentSettings.lowMids ?? 0);
  setTxt('val-lowMids', fmtDb(currentSettings.lowMids));

  setVal('sl-mids', currentSettings.mids ?? 0);
  setTxt('val-mids', fmtDb(currentSettings.mids));

  setVal('sl-upperMids', currentSettings.upperMids ?? 0);
  setTxt('val-upperMids', fmtDb(currentSettings.upperMids));

  setVal('sl-presence', currentSettings.presence ?? 0);
  setTxt('val-presence', fmtDb(currentSettings.presence));

  setVal('sl-treble', currentSettings.treble ?? 0);
  setTxt('val-treble', fmtDb(currentSettings.treble));

  setVal('sl-airBand', currentSettings.airBand ?? 0);
  setTxt('val-airBand', fmtDb(currentSettings.airBand));

  setVal('sl-stereoWidth', currentSettings.stereoWidth || 0);
  setTxt('val-stereoWidth', `${Math.round(currentSettings.stereoWidth || 0)}%`);

  setVal('sl-reverbMix', currentSettings.reverbMix || 0);
  setTxt('val-reverbMix', `${Math.round(currentSettings.reverbMix || 0)}%`);

  const spd = Number(currentSettings.speedPitch || 1.0);
  setVal('sl-speedPitch', spd);
  setTxt('val-speedPitch', `${spd.toFixed(2)}x`);

  document.querySelectorAll('[data-eq-preset]').forEach((btn) => {
    const k = btn.getAttribute('data-eq-preset');
    btn.classList.toggle('active', Boolean(currentSettings.eqPreset && currentSettings.eqPreset === k));
  });

  document.querySelectorAll('[data-wp-preset]').forEach((btn) => {
    const p = btn.getAttribute('data-wp-preset');
    btn.classList.toggle('active', Boolean(!currentSettings.wallpaperUrl && currentSettings.wallpaperPreset === p));
  });

  setVal('sl-wpBlur', currentSettings.wallpaperBlur ?? 0);
  setTxt('val-wpBlur', `${currentSettings.wallpaperBlur ?? 0} px`);

  setVal('sl-wpDim', currentSettings.wallpaperDim ?? 20);
  setTxt('val-wpDim', `${currentSettings.wallpaperDim ?? 20}%`);

  setVal('sel-particle', currentSettings.particleEffect || 'none');
  setVal('sl-pCount', currentSettings.particleCount ?? 80);
  setTxt('val-pCount', `${currentSettings.particleCount ?? 80}`);

  const pSize = Number(currentSettings.particleSize ?? 1.0);
  setVal('sl-pSize', pSize);
  setTxt('val-pSize', `${pSize.toFixed(1)}x`);

  setVal('sl-pSpeed', currentSettings.particleSpeed ?? 1.0);
  setTxt('val-pSpeed', `${currentSettings.particleSpeed ?? 1.0}x`);

  setVal('sel-cursor-trail', currentSettings.cursorTrail || 'none');
  setVal('sl-cursorSize', currentSettings.cursorTrailSize ?? 1.0);
  setTxt('val-cursorSize', `${Number(currentSettings.cursorTrailSize ?? 1.0).toFixed(1)}x`);

  setVal('sl-radius', currentSettings.borderRadius ?? 12);
  setTxt('val-radius', `${currentSettings.borderRadius ?? 12} px`);

  setVal('clr-accent', currentSettings.accentColor || '#ff5500');
  setVal('clr-surface', currentSettings.surfaceColor || '#16161a');
}

function saveAndApplyPatch(patch) {
  currentSettings = { ...currentSettings, ...patch };
  syncDrawerInputsFromSettings();
  applyVisualSettings();
  ipcRenderer.invoke('app:save-settings', patch).catch(() => {});
}

function wireDrawerEvents() {
  document.querySelectorAll('.sc-studio-close').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-close');
      const el = document.getElementById(targetId);
      if (el) el.classList.remove('open');
    });
  });

  const btnAntiClip = document.getElementById('btn-toggle-anticlip');
  if (btnAntiClip) {
    btnAntiClip.addEventListener('click', () => {
      const nextVal = !(currentSettings.antiClip !== false);
      saveAndApplyPatch({ antiClip: nextVal });
      showTrackPageToast(
        nextVal
          ? '🛡️ Защита от хрипа ВКЛЮЧЕНА: чистый и мощный звук!'
          : '🔥 Защита от хрипа ВЫКЛЮЧЕНА: режим жёсткого перегруза!'
      );
    });
  }

  const eqPresets = {
    flat: {
      eqPreset: 'flat',
      antiClip: true,
      bassBoost: 0,
      subBass: 0,
      deepBass: 0,
      punchBass: 0,
      upperBass: 0,
      mudCut: 0,
      lowMids: 0,
      mids: 0,
      upperMids: 0,
      presence: 0,
      treble: 0,
      airBand: 0,
      warmth: 0,
      stereoWidth: 0,
      reverbMix: 0,
      speedPitch: 1.0,
      preamp: 1.0
    },
    cleanthunder: {
      eqPreset: 'cleanthunder',
      antiClip: true,
      bassBoost: 18.0,
      subBass: 11.5,
      deepBass: 12.0,
      punchBass: 9.5,
      upperBass: 3.5,
      mudCut: 68,
      lowMids: -2.0,
      mids: 1.5,
      upperMids: 3.5,
      presence: 5.5,
      treble: 6.5,
      airBand: 7.5,
      warmth: 42,
      stereoWidth: 48,
      reverbMix: 0,
      speedPitch: 1.0,
      preamp: 2.35
    },
    rawrattle: {
      eqPreset: 'rawrattle',
      antiClip: false,
      bassBoost: 22.0,
      subBass: 16.0,
      deepBass: 15.0,
      punchBass: 13.0,
      upperBass: 8.0,
      mudCut: 0,
      lowMids: 2.0,
      mids: 1.0,
      upperMids: 3.0,
      presence: 4.0,
      treble: 4.5,
      airBand: 3.0,
      warmth: 88,
      stereoWidth: 25,
      reverbMix: 0,
      speedPitch: 1.0,
      preamp: 2.85
    },
    club: {
      eqPreset: 'club',
      antiClip: true,
      bassBoost: 15.0,
      subBass: 9.5,
      deepBass: 11.0,
      punchBass: 10.5,
      upperBass: 3.0,
      mudCut: 55,
      lowMids: -2.5,
      mids: 0.5,
      upperMids: 2.5,
      presence: 4.5,
      treble: 6.0,
      airBand: 6.5,
      warmth: 36,
      stereoWidth: 52,
      reverbMix: 12,
      speedPitch: 1.0,
      preamp: 1.85
    },
    deep808: {
      eqPreset: 'deep808',
      antiClip: true,
      bassBoost: 19.5,
      subBass: 15.5,
      deepBass: 12.5,
      punchBass: 6.5,
      upperBass: 2.0,
      mudCut: 72,
      lowMids: -3.0,
      mids: 0.0,
      upperMids: 2.0,
      presence: 4.0,
      treble: 4.5,
      airBand: 5.5,
      warmth: 50,
      stereoWidth: 38,
      reverbMix: 0,
      speedPitch: 1.0,
      preamp: 2.0
    },
    spatial3d: {
      eqPreset: 'spatial3d',
      antiClip: true,
      bassBoost: 8.5,
      subBass: 6.0,
      deepBass: 5.5,
      punchBass: 5.0,
      upperBass: 1.5,
      mudCut: 40,
      lowMids: -2.0,
      mids: 2.0,
      upperMids: 4.5,
      presence: 7.0,
      treble: 8.5,
      airBand: 11.0,
      warmth: 24,
      stereoWidth: 96,
      reverbMix: 30,
      speedPitch: 1.0,
      preamp: 1.55
    },
    slowed: {
      eqPreset: 'slowed',
      antiClip: true,
      bassBoost: 12.0,
      subBass: 9.0,
      deepBass: 8.0,
      punchBass: 5.0,
      upperBass: 3.0,
      mudCut: 45,
      lowMids: 1.0,
      mids: -1.0,
      upperMids: 1.5,
      presence: 3.0,
      treble: 4.0,
      airBand: 5.0,
      warmth: 30,
      stereoWidth: 74,
      reverbMix: 58,
      speedPitch: 0.83,
      preamp: 1.55
    },
    nightcore: {
      eqPreset: 'nightcore',
      antiClip: true,
      bassBoost: 9.5,
      subBass: 5.0,
      deepBass: 7.0,
      punchBass: 8.5,
      upperBass: 2.0,
      mudCut: 35,
      lowMids: -1.0,
      mids: 2.0,
      upperMids: 4.0,
      presence: 5.5,
      treble: 6.5,
      airBand: 7.0,
      warmth: 22,
      stereoWidth: 48,
      reverbMix: 14,
      speedPitch: 1.19,
      preamp: 1.55
    },
    vocal: {
      eqPreset: 'vocal',
      antiClip: true,
      bassBoost: 3.0,
      subBass: 1.0,
      deepBass: 2.0,
      punchBass: 3.5,
      upperBass: -2.5,
      mudCut: 65,
      lowMids: -3.5,
      mids: 7.5,
      upperMids: 10.5,
      presence: 9.0,
      treble: 7.0,
      airBand: 9.5,
      warmth: 20,
      stereoWidth: 46,
      reverbMix: 14,
      speedPitch: 1.0,
      preamp: 1.60
    },
    lofi: {
      eqPreset: 'lofi',
      antiClip: true,
      bassBoost: 7.5,
      subBass: 2.0,
      deepBass: 6.5,
      punchBass: 6.0,
      upperBass: 5.5,
      mudCut: 10,
      lowMids: 5.5,
      mids: 4.5,
      upperMids: -3.5,
      presence: -8.5,
      treble: -12.0,
      airBand: -14.0,
      warmth: 78,
      stereoWidth: 20,
      reverbMix: 32,
      speedPitch: 0.94,
      preamp: 1.45
    }
  };

  document.querySelectorAll('[data-eq-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-eq-preset');
      if (eqPresets[key]) saveAndApplyPatch(eqPresets[key]);
    });
  });

  const audioKeys = new Set([
    'bassBoost',
    'subBass',
    'deepBass',
    'punchBass',
    'upperBass',
    'mudCut',
    'lowMids',
    'mids',
    'upperMids',
    'presence',
    'treble',
    'airBand',
    'stereoWidth',
    'reverbMix',
    'speedPitch',
    'warmth',
    'preamp'
  ]);

  const bindSlider = (id, key) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
      const patch = { [key]: parseFloat(el.value) };
      if (audioKeys.has(key)) patch.eqPreset = 'custom';
      saveAndApplyPatch(patch);
    });
  };

  bindSlider('sl-bassBoost', 'bassBoost');
  bindSlider('sl-subBass', 'subBass');
  bindSlider('sl-deepBass', 'deepBass');
  bindSlider('sl-punchBass', 'punchBass');
  bindSlider('sl-upperBass', 'upperBass');
  bindSlider('sl-mudCut', 'mudCut');
  bindSlider('sl-lowMids', 'lowMids');
  bindSlider('sl-mids', 'mids');
  bindSlider('sl-upperMids', 'upperMids');
  bindSlider('sl-presence', 'presence');
  bindSlider('sl-treble', 'treble');
  bindSlider('sl-airBand', 'airBand');
  bindSlider('sl-stereoWidth', 'stereoWidth');
  bindSlider('sl-reverbMix', 'reverbMix');
  bindSlider('sl-speedPitch', 'speedPitch');
  bindSlider('sl-warmth', 'warmth');
  bindSlider('sl-preamp', 'preamp');
  bindSlider('sl-wpBlur', 'wallpaperBlur');
  bindSlider('sl-wpDim', 'wallpaperDim');
  bindSlider('sl-pCount', 'particleCount');
  bindSlider('sl-pSize', 'particleSize');
  bindSlider('sl-pSpeed', 'particleSpeed');
  bindSlider('sl-cursorSize', 'cursorTrailSize');
  bindSlider('sl-radius', 'borderRadius');

  const selParticle = document.getElementById('sel-particle');
  if (selParticle) {
    selParticle.addEventListener('change', () => {
      saveAndApplyPatch({ particleEffect: selParticle.value });
    });
  }

  const selCursorTrail = document.getElementById('sel-cursor-trail');
  if (selCursorTrail) {
    selCursorTrail.addEventListener('change', () => {
      saveAndApplyPatch({ cursorTrail: selCursorTrail.value });
    });
  }

  const clrAccent = document.getElementById('clr-accent');
  if (clrAccent) {
    clrAccent.addEventListener('input', () => {
      saveAndApplyPatch({ accentColor: clrAccent.value });
    });
  }

  const clrSurface = document.getElementById('clr-surface');
  if (clrSurface) {
    clrSurface.addEventListener('input', () => {
      saveAndApplyPatch({ surfaceColor: clrSurface.value });
    });
  }

  document.querySelectorAll('[data-wp-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = btn.getAttribute('data-wp-preset');
      saveAndApplyPatch({ wallpaperPreset: preset, wallpaperUrl: '' });
      showTrackPageToast(`Фон «${btn.textContent}» установлен!`);
    });
  });

  const btnPickWp = document.getElementById('btn-pick-wp');
  if (btnPickWp) {
    btnPickWp.addEventListener('click', async () => {
      const streamUrl = await ipcRenderer.invoke('ui:pick-wallpaper');
      if (streamUrl) {
        saveAndApplyPatch({ wallpaperUrl: streamUrl, wallpaperPreset: 'none' });
        showTrackPageToast('Кастомные обои успешно загружены!');
      }
    });
  }

  const btnClearWp = document.getElementById('btn-clear-wp');
  if (btnClearWp) {
    btnClearWp.addEventListener('click', () => {
      saveAndApplyPatch({ wallpaperUrl: '', wallpaperPreset: 'none' });
      showTrackPageToast('Обои сброшены');
    });
  }

  const lyCurrent = document.getElementById('ly-current');
  const lySearch = document.getElementById('ly-search');
  const lyArtist = document.getElementById('ly-artist');
  const lySong = document.getElementById('ly-song');
  const lyResult = document.getElementById('ly-result');

  async function runLyricsLookup() {
    const artist = (lyArtist.value || '').trim();
    const song = (lySong.value || '').trim();
    if (!artist && !song) {
      lyResult.textContent = 'Введите название трека или исполнителя.';
      return;
    }
    lyResult.textContent = 'Ищем текст на Genius...';
    try {
      const res = await ipcRenderer.invoke('genius:search', { artist, song });
      lyResult.textContent = (res && res.ok && res.lyrics) ? res.lyrics : ((res && res.message) || 'Текст не найден.');
    } catch (e) {
      lyResult.textContent = 'Ошибка при поиске текста.';
    }
  }

  if (lyCurrent) {
    lyCurrent.addEventListener('click', () => {
      const st = scrapeCurrentState();
      if (st && st.title) {
        let rawTitle = st.title.replace(/\s*[\(\[](?:prod\.?|official|audio|video|free dl|lyric|visualizer)[^\)\]]*[\)\]]/gi, '').trim();
        let artist = st.artist || '';
        let song = rawTitle;
        if (rawTitle.includes(' - ')) {
          const parts = rawTitle.split(' - ');
          artist = parts[0].trim();
          song = parts.slice(1).join(' - ').trim();
        }
        lyArtist.value = artist;
        lySong.value = song;
        runLyricsLookup();
      } else {
        lyResult.textContent = 'Сейчас ни один трек не воспроизводится.';
      }
    });
  }
  if (lySearch) lySearch.addEventListener('click', runLyricsLookup);
}

ipcRenderer.on('ui:navigate-home', () => {
  if (!isMainSoundCloudApp()) return;
  hideCustomTrackPage();
  const curPath = window.location.pathname.replace(/\/+$/, '') || '/';
  if (curPath === '/' || curPath === '/discover') {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  const homeLink = document.querySelector('.header__navMenu a[href="/discover"], a.header__logoLink, .header__logo a');
  if (homeLink) {
    homeLink.click();
  }
});

ipcRenderer.on('ui:toggle-drawer', (_event, panelName) => {
  if (!isMainSoundCloudApp()) return;
  injectCustomThemeAndLayers();
  const map = {
    audio: 'sc-drawer-audio',
    theme: 'sc-drawer-theme',
    lyrics: 'sc-drawer-lyrics'
  };
  const targetId = map[panelName];
  Object.values(map).forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (id === targetId) {
      el.classList.toggle('open');
      if (panelName === 'lyrics' && el.classList.contains('open')) {
        const curBtn = document.getElementById('ly-current');
        if (curBtn) curBtn.click();
      }
    } else {
      el.classList.remove('open');
    }
  });
});

// ------------------------------------------------------------------
// 4. Playback State, Bottom Timeline Hover & MPRIS2 Sync
// ------------------------------------------------------------------
function scrapeCurrentState() {
  const playBtn = document.querySelector('.playControl, .playControls__play');
  const shuffleBtn = document.querySelector('.shuffleControl');
  const repeatBtn = document.querySelector('.repeatControl');

  const isPlaying = playBtn ? playBtn.classList.contains('playing') : false;
  const isShuffle = shuffleBtn ? shuffleBtn.classList.contains('m-active') : false;

  let repeatMode = 'none';
  let isRepeat = false;
  if (repeatBtn) {
    if (repeatBtn.classList.contains('m-one')) {
      repeatMode = 'one';
      isRepeat = true;
    } else if (repeatBtn.classList.contains('m-all') || repeatBtn.classList.contains('m-active')) {
      repeatMode = 'all';
      isRepeat = true;
    }
  }

  const titleEl = document.querySelector('.playbackSoundBadge__titleLink');
  const artistEl = document.querySelector('.playbackSoundBadge__lightLink');
  const title = (titleEl && (titleEl.getAttribute('title') || titleEl.textContent))
    ? (titleEl.getAttribute('title') || titleEl.textContent).trim()
    : '';
  const artist = (artistEl && (artistEl.getAttribute('title') || artistEl.textContent))
    ? (artistEl.getAttribute('title') || artistEl.textContent).trim()
    : '';
  const trackHref = (titleEl && titleEl.getAttribute('href')) ? titleEl.getAttribute('href') : '';

  let artworkUrl = '';
  try {
    const avatarSpan = document.querySelector('.playbackSoundBadge__avatar span.sc-artwork');
    if (avatarSpan && avatarSpan.style && avatarSpan.style.backgroundImage) {
      const m = avatarSpan.style.backgroundImage.match(/url\(["']?(.*?)["']?\)/);
      if (m && m[1]) artworkUrl = m[1].replace(/-t[0-9]+x[0-9]+\./, '-t500x500.');
    }
  } catch (e) {}

  let timePassed = 0;
  let duration = 0;
  try {
    const timeEl = document.querySelector('.playbackTimeline__timePassed > span[aria-hidden="true"]');
    const durEl = document.querySelector('.playbackTimeline__duration > span[aria-hidden="true"]');
    if (timeEl) timePassed = parseClockToSeconds(timeEl.textContent);
    if (durEl) duration = parseClockToSeconds(durEl.textContent);
  } catch (e) {}

  return {
    title,
    artist,
    trackHref,
    artworkUrl,
    isPlaying,
    isShuffle,
    isRepeat,
    repeatMode,
    timePassed,
    duration
  };
}

let lastSentStateHash = '';
function sendState() {
  if (!isMainSoundCloudApp()) return;
  const state = scrapeCurrentState();
  const stateHash = `${state.title}|${state.artist}|${state.isPlaying}|${state.isShuffle}|${state.repeatMode}|${Math.floor((state.timePassed || 0) / 3)}|${state.duration}`;
  if (stateHash === lastSentStateHash) return;
  lastSentStateHash = stateHash;
  ipcRenderer.send('player:view-state', state);
}

function setupMediaSessionHandlers() {
  if (!isMainSoundCloudApp() || !('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.setActionHandler('play', () => {
      const btn = document.querySelector('.playControl, .playControls__play');
      if (btn && !btn.classList.contains('playing')) btn.click();
    });
    navigator.mediaSession.setActionHandler('pause', () => {
      const btn = document.querySelector('.playControl, .playControls__play');
      if (btn && btn.classList.contains('playing')) btn.click();
    });
    navigator.mediaSession.setActionHandler('previoustrack', () => {
      const btn = document.querySelector('.skipControl__previous');
      if (btn) btn.click();
    });
    navigator.mediaSession.setActionHandler('nexttrack', () => {
      const btn = document.querySelector('.skipControl__next');
      if (btn) btn.click();
    });
  } catch (e) {}
}

function syncVolumeFromBottomBar() {
  try {
    const volEl = document.querySelector('.volume');
    const sliderEl = document.querySelector('.volume__sliderWrapper');
    if (!sliderEl) return;
    const isMuted = Boolean(volEl && volEl.classList.contains('muted'));
    const rawVal = parseFloat(sliderEl.getAttribute('aria-valuenow'));
    if (!Number.isFinite(rawVal)) return;
    const vol = isMuted ? 0 : Math.max(0, Math.min(1, rawVal));
    webFrame.executeJavaScript(
      `window.dispatchEvent(new CustomEvent('sc-set-volume', { detail: { volume: ${vol}, muted: ${isMuted} } }));`
    );
  } catch (e) {}
}

function setupBottomPlaybackBarHover() {
  const volEl = document.querySelector('.volume');
  if (volEl && !volEl.__scVolHooked) {
    volEl.__scVolHooked = true;
    const sliderEl = volEl.querySelector('.volume__sliderWrapper');
    if (sliderEl) {
      const vo = new MutationObserver(syncVolumeFromBottomBar);
      vo.observe(sliderEl, { attributes: true, attributeFilter: ['aria-valuenow'] });
      vo.observe(volEl, { attributes: true, attributeFilter: ['class', 'data-level'] });
    }
    setTimeout(syncVolumeFromBottomBar, 300);
  }

  const wrapper = document.querySelector('.playbackTimeline__progressWrapper');
  if (!wrapper || wrapper.__scHoverAttached) return;
  wrapper.__scHoverAttached = true;

  let hoverBar = wrapper.querySelector('.sc-bottom-hover-bar');
  if (!hoverBar) {
    hoverBar = document.createElement('div');
    hoverBar.className = 'sc-bottom-hover-bar';
    wrapper.appendChild(hoverBar);
  }

  wrapper.addEventListener('mousemove', (ev) => {
    const rect = wrapper.getBoundingClientRect();
    if (rect.width <= 0) return;
    const pct = Math.max(0, Math.min(100, ((ev.clientX - rect.left) / rect.width) * 100));
    hoverBar.style.width = `${pct}%`;
  }, { passive: true });

  wrapper.addEventListener('mouseleave', () => {
    hoverBar.style.width = '0%';
  }, { passive: true });
}

function attachObservers() {
  if (!isMainSoundCloudApp()) return true;
  injectCustomThemeAndLayers();

  const playBtn = document.querySelector('.playControl, .playControls__play');
  const shuffleBtn = document.querySelector('.shuffleControl');
  const repeatBtn = document.querySelector('.repeatControl');
  const badge = document.querySelector('.playbackSoundBadge');

  if (!playBtn) return false;

  setupMediaSessionHandlers();
  setupBottomPlaybackBarHover();
  sendState();

  let mutationTimer = null;
  const observer = new MutationObserver(() => {
    if (mutationTimer) return;
    mutationTimer = setTimeout(() => {
      mutationTimer = null;
      setupMediaSessionHandlers();
      setupBottomPlaybackBarHover();
      sendState();
      checkAutoTrackSwitch();
    }, 90);
  });
  const classOpts = { attributes: true, attributeFilter: ['class'] };

  observer.observe(playBtn, classOpts);
  if (shuffleBtn) observer.observe(shuffleBtn, classOpts);
  if (repeatBtn) observer.observe(repeatBtn, classOpts);
  if (badge) {
    observer.observe(badge, { childList: true, subtree: true, attributes: true });
  }

  return true;
}

// ------------------------------------------------------------------
// 5. Full 2026 SoundCloud Track Page UI Engine
// ------------------------------------------------------------------
let capturedClientId = '';
const localTrackCache = {};
const localCommentsCache = {};
let userPlaylistsCache = [];
const localCustomPlaylists = [];
let currentTrackPageReqId = 0;
let toastTimeoutId = null;
let lastClickedCardPlayBtn = null;
let waveformRafId = null;

// High-precision 60 FPS playback time interpolator state
let smoothTimeAnchorSec = 0;
let smoothTimeAnchorPerf = 0;
let lastObservedDomClockSec = -1;
let lastSeekOverrideSec = -1;
let lastSeekOverrideTime = 0;

// Waveform hover state
let waveHoverTargetRatio = -1;
let waveHoverDisplayRatio = -1;
let waveHoverIntensity = 0;
let hoveredCommentObj = null;
let hoveredCommentPct = 50;

// Auto-switch tracking
let lastKnownPlayingPath = '';
let lastKnownPlayingKey = '';

let activeTrackPageState = {
  visible: false,
  path: '',
  track: null,
  user: null,
  comments: [],
  commentSort: 'newest',
  fans: [],
  fansTab: 'top',
  waveformSamples: null,
  detailsExpanded: false
};

window.addEventListener('message', (ev) => {
  const d = ev && ev.data;
  if (!d || typeof d !== 'object') return;
  if (d.type === '__SC_CLIENT_ID__' && d.clientId) {
    capturedClientId = d.clientId;
  } else if (d.type === '__SC_TRACK_DATA__' && d.key && d.track) {
    localTrackCache[d.key] = d.track;
    const keys = Object.keys(localTrackCache);
    if (keys.length > 25) delete localTrackCache[keys[0]];
  } else if (d.type === '__SC_USER_PLAYLISTS__' && Array.isArray(d.playlists)) {
    userPlaylistsCache = d.playlists;
    renderPlaylistModalList();
  } else if (d.type === '__SC_PLAYLIST_CREATED__' && d.playlist) {
    userPlaylistsCache = [d.playlist, ...userPlaylistsCache];
    renderPlaylistModalList();
    showTrackPageToast('Плейлист создан и трек добавлен!');
  } else if (d.type === '__SC_COMMENTS_DATA__' && d.trackId && Array.isArray(d.comments)) {
    localCommentsCache[String(d.trackId)] = d.comments;
    if (
      activeTrackPageState.visible &&
      activeTrackPageState.track &&
      String(activeTrackPageState.track.id) === String(d.trackId)
    ) {
      activeTrackPageState.comments = d.comments;
      renderTrackCommentsAndAvatars();
    }
  }
});

function formatCompactCount(num) {
  const n = Number(num) || 0;
  if (n >= 1000000) return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 10000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  if (n >= 1000) return `${(n / 1000).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}K`;
  return n.toLocaleString('en-US');
}

function formatExactCount(num) {
  const n = Number(num) || 0;
  if (n >= 10000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return n.toLocaleString('en-US');
}

function formatSecondsToClock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  }
  return `${mins}:${String(rem).padStart(2, '0')}`;
}

function parseClockToSeconds(str) {
  if (!str) return 0;
  const parts = str.trim().split(':').map(Number);
  if (parts.length === 3) return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
  if (parts.length === 2) return (parts[0] || 0) * 60 + (parts[1] || 0);
  return 0;
}

function formatRelativeTimeAgo(dateStr) {
  if (!dateStr) return 'recently';
  const diffSec = Math.max(1, Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000));
  const days = Math.floor(diffSec / 86400);
  if (days >= 365) {
    const yrs = Math.floor(days / 365);
    return `${yrs} year${yrs > 1 ? 's' : ''} ago`;
  }
  if (days >= 30) {
    const mos = Math.floor(days / 30);
    return `${mos} month${mos > 1 ? 's' : ''} ago`;
  }
  if (days >= 1) return `${days} day${days > 1 ? 's' : ''} ago`;
  const hrs = Math.floor(diffSec / 3600);
  if (hrs >= 1) return `${hrs} hour${hrs > 1 ? 's' : ''} ago`;
  const mins = Math.floor(diffSec / 60);
  return `${Math.max(1, mins)} min ago`;
}

function generateDeterministicWaveform(seedStr, count = 180) {
  let h = 2166136261;
  const s = String(seedStr || 'soundcloud');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const out = [];
  for (let i = 0; i < count; i++) {
    h ^= i * 2654435761;
    h = Math.imul(h, 16777619);
    const base = 0.35 + 0.55 * Math.abs(Math.sin(i * 0.17 + (h & 255) * 0.05));
    const env = Math.sin((i / count) * Math.PI * 0.92 + 0.12);
    out.push(Math.max(0.12, Math.min(1.0, base * (0.45 + 0.55 * env))));
  }
  return out;
}

function extractDominantHeroColor(imgUrl, callback) {
  if (!imgUrl) return callback('#787774');
  const img = new Image();
  img.crossOrigin = 'Anonymous';
  img.onload = () => {
    try {
      const c = document.createElement('canvas');
      c.width = 24;
      c.height = 24;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, 24, 24);
      const data = ctx.getImageData(0, 0, 24, 24).data;
      let r = 0, g = 0, b = 0, cnt = 0;
      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3];
        if (a < 128) continue;
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        cnt++;
      }
      if (cnt > 0) {
        r = Math.round((r / cnt) * 0.55 + 48);
        g = Math.round((g / cnt) * 0.54 + 46);
        b = Math.round((b / cnt) * 0.52 + 44);
        callback(`rgb(${r}, ${g}, ${b})`);
        return;
      }
    } catch (e) {}
    callback('#787774');
  };
  img.onerror = () => callback('#787774');
  img.src = imgUrl;
}

function getNormalizedBadgePath() {
  const badgeLink = document.querySelector('.playbackSoundBadge__titleLink');
  if (!badgeLink) return '';
  const rawHref = badgeLink.getAttribute('href') || '';
  if (!rawHref) return '';
  try {
    const u = new URL(rawHref, window.location.origin);
    return u.pathname.replace(/\/+$/, '').toLowerCase();
  } catch (e) {
    return '';
  }
}

function isViewingCurrentlyPlayingTrack() {
  const badgePath = getNormalizedBadgePath();
  if (badgePath && badgePath === activeTrackPageState.path) {
    return true;
  }
  const st = scrapeCurrentState();
  const trTitle = (activeTrackPageState.track && activeTrackPageState.track.title) || '';
  if (st.title && trTitle && st.title.toLowerCase() === trTitle.toLowerCase()) {
    return true;
  }
  return false;
}

// ------------------------------------------------------------------
// Smooth 60 FPS Playback Time & Progress Calculation
// ------------------------------------------------------------------
function getSmoothPlaybackProgress(isCurrent, isPlaying) {
  const fallbackDur =
    activeTrackPageState.track && activeTrackPageState.track.duration
      ? activeTrackPageState.track.duration / 1000
      : 0;
  const durEl = document.querySelector('.playbackTimeline__duration > span[aria-hidden="true"]');
  const domDur = isCurrent && durEl ? parseClockToSeconds(durEl.textContent) : 0;

  const ds = document.documentElement ? document.documentElement.dataset : {};
  const audioDur = Number(ds.scAudioDur) || 0;
  const totalSec = (isCurrent && audioDur > 1 ? audioDur : 0) || domDur || fallbackDur;

  if (!isCurrent || totalSec <= 0) {
    return { curSec: 0, totalSec, progress: 0 };
  }

  const nowPerf = performance.now();

  // If the user just clicked to seek within the last 700ms, hold smooth seek target
  if (lastSeekOverrideSec >= 0 && nowPerf - lastSeekOverrideTime < 700) {
    const interp = isPlaying ? lastSeekOverrideSec + (nowPerf - lastSeekOverrideTime) / 1000 : lastSeekOverrideSec;
    const clamped = Math.max(0, Math.min(totalSec, interp));
    return { curSec: clamped, totalSec, progress: clamped / totalSec };
  }

  // 1. Try sub-millisecond HTMLMediaElement time from Main World
  const rawAudioTime = Number(ds.scAudioTime);
  const rawAudioPerf = Number(ds.scAudioPerf);
  const audioPaused = ds.scAudioPaused === 'true';

  if (Number.isFinite(rawAudioTime) && rawAudioTime >= 0 && rawAudioPerf > 0 && nowPerf - rawAudioPerf < 2500) {
    const dt = isPlaying && !audioPaused ? Math.min(1.0, Math.max(0, (nowPerf - rawAudioPerf) / 1000)) : 0;
    const curSec = Math.max(0, Math.min(totalSec, rawAudioTime + dt));
    return { curSec, totalSec, progress: curSec / totalSec };
  }

  // 2. Fallback: High-precision interpolation over SoundCloud's DOM clock & aria-valuenow
  const wrapperEl = document.querySelector('.playbackTimeline__progressWrapper');
  const ariaNow = wrapperEl ? Number(wrapperEl.getAttribute('aria-valuenow')) : NaN;
  const timeEl = document.querySelector('.playbackTimeline__timePassed > span[aria-hidden="true"]');
  const domSec = Number.isFinite(ariaNow) && ariaNow >= 0
    ? ariaNow
    : (timeEl ? parseClockToSeconds(timeEl.textContent) : 0);

  if (domSec !== lastObservedDomClockSec) {
    // If DOM clock jumped or ticked forward, re-anchor smooth interpolator
    const currentEstimated = smoothTimeAnchorSec + (isPlaying ? (nowPerf - smoothTimeAnchorPerf) / 1000 : 0);
    if (Math.abs(domSec - currentEstimated) > 0.45 || domSec > currentEstimated) {
      smoothTimeAnchorSec = domSec;
    } else {
      smoothTimeAnchorSec = Math.max(domSec, currentEstimated);
    }
    smoothTimeAnchorPerf = nowPerf;
    lastObservedDomClockSec = domSec;
  } else if (!isPlaying) {
    smoothTimeAnchorSec = domSec;
    smoothTimeAnchorPerf = nowPerf;
  }

  const elapsedSinceAnchor = isPlaying ? Math.min(2.2, Math.max(0, (nowPerf - smoothTimeAnchorPerf) / 1000)) : 0;
  const curSec = Math.max(0, Math.min(totalSec, smoothTimeAnchorSec + elapsedSinceAnchor));

  return { curSec, totalSec, progress: curSec / totalSec };
}

// ------------------------------------------------------------------
// Automatic Track Page Switching When Next / Previous Track Starts
// ------------------------------------------------------------------
function checkAutoTrackSwitch() {
  const st = scrapeCurrentState();
  const badgePath = getNormalizedBadgePath();
  const currentKey = `${st.artist}:::${st.title}`.toLowerCase();

  if (!badgePath && !st.title) return;

  const pathChanged = badgePath && badgePath !== lastKnownPlayingPath;
  const keyChanged = st.title && currentKey !== lastKnownPlayingKey;

  if (pathChanged || keyChanged) {
    const prevPlayingPath = lastKnownPlayingPath;
    lastKnownPlayingPath = badgePath || lastKnownPlayingPath;
    lastKnownPlayingKey = st.title ? currentKey : lastKnownPlayingKey;

    // Reset smooth clock anchors for the new track
    smoothTimeAnchorSec = 0;
    smoothTimeAnchorPerf = performance.now();
    lastObservedDomClockSec = -1;
    lastSeekOverrideSec = -1;

    // If the Track Page menu is currently open, automatically switch it to the new playing track!
    if (activeTrackPageState.visible && badgePath && isTrackPermalinkPath(badgePath)) {
      if (activeTrackPageState.path !== badgePath || prevPlayingPath !== badgePath) {
        const nextUrl = new URL(badgePath, window.location.origin).href;
        openAndRenderCustomTrackPage(
          nextUrl,
          { title: st.title, artist: st.artist, artworkUrl: st.artworkUrl },
          { isAutoSwitch: true }
        );
      }
    }
  }
}

function getLoggedInUserAvatar() {
  try {
    const navAv = document.querySelector('.header__userNavItem span.sc-artwork, .userNav__avatar span.sc-artwork');
    if (navAv && navAv.style && navAv.style.backgroundImage) {
      const m = navAv.style.backgroundImage.match(/url\(["']?(.*?)["']?\)/);
      if (m && m[1]) return m[1];
    }
  } catch (e) {}
  return '';
}

function showTrackPageToast(message) {
  let toast = document.getElementById('sc-tp-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'sc-tp-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  if (toastTimeoutId) clearTimeout(toastTimeoutId);
  toastTimeoutId = setTimeout(() => {
    toast.classList.remove('show');
  }, 2400);
}

function copyTextToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
  } catch (e) {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  } catch (e) {}
}

function getActiveTrackShareUrl(withTimestamp = false, customTimeStr = '', shorten = false) {
  const tr = activeTrackPageState.track;
  let base = (tr && tr.permalink_url) || window.location.href;
  try {
    const u = new URL(base, window.location.origin);
    u.hash = '';
    if (shorten) {
      const code = Math.abs(
        String(u.pathname)
          .split('')
          .reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)
      )
        .toString(36)
        .slice(0, 6);
      base = `https://on.soundcloud.com/${code || 'track'}`;
      if (withTimestamp && customTimeStr) {
        base += `#t=${customTimeStr}`;
      }
      return base;
    }
    if (!u.searchParams.has('si')) {
      const hashHex = Math.abs(
        String(u.pathname)
          .split('')
          .reduce((a, c) => (a * 33 + c.charCodeAt(0)) | 0, 5381)
      )
        .toString(16)
        .padStart(8, '0');
      u.searchParams.set('si', `${hashHex}9f4a4c1b8e2d`);
    }
    if (withTimestamp) {
      const tStr = (customTimeStr || '').trim() || '0:00';
      u.hash = `t=${tStr}`;
    }
    return u.href;
  } catch (e) {
    return base;
  }
}

function drawShareModalMiniWaveform() {
  const canvas = document.getElementById('sc-tp-share-wave-canvas');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(240, Math.floor(rect.width || 300));
  const h = Math.max(48, Math.floor(rect.height || 68));
  canvas.width = w * dpr;
  canvas.height = h * dpr;

  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const rawSamples =
    activeTrackPageState.waveformSamples && activeTrackPageState.waveformSamples.length > 10
      ? activeTrackPageState.waveformSamples
      : generateDeterministicWaveform(activeTrackPageState.path || 'track', 140);

  let maxSample = 1;
  for (let i = 0; i < rawSamples.length; i++) {
    if (rawSamples[i] > maxSample) maxSample = rawSamples[i];
  }

  const barWidth = 2;
  const gap = 1;
  const step = barWidth + gap;
  const numBars = Math.floor(w / step);
  const midY = Math.floor(h * 0.66);
  const maxTopH = midY - 2;
  const maxBotH = h - midY - 2;

  for (let i = 0; i < numBars; i++) {
    const idx = Math.min(rawSamples.length - 1, Math.floor((i / numBars) * rawSamples.length));
    const norm = Math.max(0.1, (rawSamples[idx] || 0) / maxSample);
    const topH = Math.max(2, Math.round(norm * maxTopH));
    const botH = Math.max(2, Math.round(norm * maxBotH * 0.55));
    const x = i * step;

    ctx.fillStyle = 'rgba(235, 235, 235, 0.88)';
    ctx.fillRect(x, midY - topH, barWidth, topH);

    ctx.fillStyle = 'rgba(160, 160, 160, 0.52)';
    ctx.fillRect(x, midY + 1, barWidth, botH);
  }

  ctx.restore();
}

function openShareTrackModal() {
  let modal = document.getElementById('sc-tp-share-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'sc-tp-share-modal';
    modal.className = 'sc-tp-modal-backdrop';
    modal.innerHTML = `
      <button class="sc-tp-share-screen-close" id="sc-tp-share-close" title="Close">&#10005;</button>
      <div class="sc-tp-share-orig-box">
        <div class="sc-tp-share-tabs">
          <div class="sc-tp-share-tab active" data-share-tab="share">Share</div>
          <div class="sc-tp-share-tab" data-share-tab="embed">Embed</div>
          <div class="sc-tp-share-tab" data-share-tab="message">Message</div>
        </div>

        <div id="sc-tp-share-pane-share">
          <div class="sc-tp-share-card">
            <img class="sc-tp-share-art" id="sc-tp-share-art" src="" alt="" />
            <div class="sc-tp-share-card-right">
              <div class="sc-tp-share-card-top">
                <button class="sc-tp-share-play" id="sc-tp-share-play-btn" title="Play / Pause">
                  <svg id="sc-tp-share-play-ico" viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                    <path d="M8 5v14l11-7z"/>
                  </svg>
                </button>
                <div class="sc-tp-share-meta">
                  <div class="sc-tp-share-artist" id="sc-tp-share-artist">Artist</div>
                  <div class="sc-tp-share-title" id="sc-tp-share-title">Track</div>
                </div>
                <div class="sc-tp-share-ago" id="sc-tp-share-ago">recently</div>
              </div>

              <div class="sc-tp-share-wave-box">
                <canvas id="sc-tp-share-wave-canvas"></canvas>
                <span class="sc-tp-share-wave-dur" id="sc-tp-share-dur">0:00</span>
              </div>
            </div>
          </div>

          <div class="sc-tp-share-socials">
            <button class="sc-tp-soc-btn" data-soc="twitter" style="background:#1da1f2;" title="Twitter / X">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                <path d="M23 3a10.9 10.9 0 0 1-3.14 1.53 4.48 4.48 0 0 0-7.86 3v1A10.66 10.66 0 0 1 3 4s-4 9 5 13a11.64 11.64 0 0 1-7 2c9 5 20 0 20-11.5a4.5 4.5 0 0 0-.08-.83A7.72 7.72 0 0 0 23 3z"/>
              </svg>
            </button>
            <button class="sc-tp-soc-btn" data-soc="facebook" style="background:#0866ff;" title="Facebook">
              <svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor">
                <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/>
              </svg>
            </button>
            <button class="sc-tp-soc-btn" data-soc="tumblr" style="background:#36465d;" title="Tumblr">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <path d="M14.5 22c-3.3 0-5.5-1.7-5.5-5.2V10H6.5V6.8C9.2 6 10.3 3.7 10.5 1.5h3.2v5h3.8V10h-3.8v6.2c0 1.5.8 2.1 2.1 2.1h1.9V22h-3.2z"/>
              </svg>
            </button>
            <span id="sc-tp-soc-share-lbl" style="font-size:12px; color:#2ea8e5; cursor:pointer; padding:0 2px;">Share</span>
            <button class="sc-tp-soc-btn" data-soc="email" style="background:#262626; border:1px solid #3c3c3c;" title="Email">
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8">
                <rect x="3" y="5" width="18" height="14" rx="2"/>
                <polyline points="3 7 12 13 21 7"/>
              </svg>
            </button>
          </div>

          <div class="sc-tp-share-link-row">
            <input type="text" class="sc-tp-share-url-input" id="sc-tp-share-url-inp" readonly />
            <label class="sc-tp-share-chk-lbl">
              <input type="checkbox" id="sc-tp-share-ts-chk" />
              <span>at</span>
            </label>
            <input type="text" class="sc-tp-share-ts-input" id="sc-tp-share-ts-inp" value="0:00" />
          </div>

          <div style="display:flex; align-items:center; justify-content:space-between;">
            <label class="sc-tp-share-chk-lbl">
              <input type="checkbox" id="sc-tp-share-short-chk" />
              <span>Shorten link</span>
            </label>
          </div>
        </div>

        <div id="sc-tp-share-pane-embed" style="display:none; flex-direction:column; gap:12px;">
          <div style="font-size:12.5px; color:#b5b5b5;">HTML Embed-код плеера SoundCloud:</div>
          <input type="text" class="sc-tp-share-url-input" id="sc-tp-share-embed-inp" readonly />
          <div style="font-size:11.5px; color:#888;">Нажмите на поле, чтобы скопировать код вставки.</div>
        </div>

        <div id="sc-tp-share-pane-message" style="display:none; flex-direction:column; gap:12px;">
          <div style="font-size:12.5px; color:#b5b5b5;">Отправить ссылку на трек в сообщениях SoundCloud:</div>
          <button class="sc-action-btn" id="sc-tp-share-open-msgs" style="align-self:flex-start; padding:8px 18px;">Открыть Сообщения</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener('click', (ev) => {
      if (ev.target === modal) modal.classList.remove('open');
    });
    modal.querySelector('#sc-tp-share-close').addEventListener('click', () => {
      modal.classList.remove('open');
    });

    // Tabs switching
    const tabs = modal.querySelectorAll('[data-share-tab]');
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const key = tab.getAttribute('data-share-tab');
        tabs.forEach((t) => t.classList.toggle('active', t === tab));
        modal.querySelector('#sc-tp-share-pane-share').style.display = key === 'share' ? 'block' : 'none';
        modal.querySelector('#sc-tp-share-pane-embed').style.display = key === 'embed' ? 'flex' : 'none';
        modal.querySelector('#sc-tp-share-pane-message').style.display = key === 'message' ? 'flex' : 'none';
        if (key === 'share') {
          requestAnimationFrame(drawShareModalMiniWaveform);
        }
      });
    });

    // Play button inside Share modal preview card
    modal.querySelector('#sc-tp-share-play-btn').addEventListener('click', () => {
      const mainPlayBtn = document.getElementById('sc-tp-play-btn');
      if (mainPlayBtn) mainPlayBtn.click();
      setTimeout(syncShareModalPlayIcon, 80);
    });

    const chkTs = modal.querySelector('#sc-tp-share-ts-chk');
    const inpTs = modal.querySelector('#sc-tp-share-ts-inp');
    const chkShort = modal.querySelector('#sc-tp-share-short-chk');
    const inpUrl = modal.querySelector('#sc-tp-share-url-inp');

    const refreshShareUrlField = (copyNow = true) => {
      inpUrl.value = getActiveTrackShareUrl(chkTs.checked, inpTs.value, chkShort.checked);
      setTimeout(() => {
        try {
          inpUrl.focus();
          inpUrl.select();
          if (copyNow) {
            copyTextToClipboard(inpUrl.value);
          }
        } catch (e) {}
      }, 20);
    };

    chkTs.addEventListener('change', () => refreshShareUrlField(true));
    inpTs.addEventListener('input', () => {
      chkTs.checked = true;
      refreshShareUrlField(true);
    });
    chkShort.addEventListener('change', () => refreshShareUrlField(true));

    inpUrl.addEventListener('click', () => {
      inpUrl.select();
      copyTextToClipboard(inpUrl.value);
      showTrackPageToast('Ссылка скопирована!');
    });

    const embedInp = modal.querySelector('#sc-tp-share-embed-inp');
    embedInp.addEventListener('click', () => {
      embedInp.select();
      copyTextToClipboard(embedInp.value);
      showTrackPageToast('Embed-код скопирован!');
    });

    modal.querySelector('#sc-tp-share-open-msgs').addEventListener('click', () => {
      copyTextToClipboard(inpUrl.value);
      modal.classList.remove('open');
      hideCustomTrackPage();
      window.location.href = 'https://soundcloud.com/messages';
    });

    // Social buttons
    modal.querySelectorAll('[data-soc]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const net = btn.getAttribute('data-soc');
        const u = encodeURIComponent(inpUrl.value);
        const txt = encodeURIComponent(
          (activeTrackPageState.track && activeTrackPageState.track.title) || 'SoundCloud Track'
        );
        if (net === 'twitter') {
          window.open(`https://twitter.com/intent/tweet?url=${u}&text=${txt}`, '_blank');
        } else if (net === 'facebook') {
          window.open(`https://www.facebook.com/sharer/sharer.php?u=${u}`, '_blank');
        } else if (net === 'tumblr') {
          window.open(`https://www.tumblr.com/widgets/share/tool?canonicalUrl=${u}`, '_blank');
        } else if (net === 'email') {
          window.open(`mailto:?subject=${txt}&body=${u}`);
        }
      });
    });

    modal.querySelector('#sc-tp-soc-share-lbl').addEventListener('click', () => {
      inpUrl.select();
      copyTextToClipboard(inpUrl.value);
      showTrackPageToast('Ссылка скопирована!');
    });
  }

  function syncShareModalPlayIcon() {
    const isCurrent = isViewingCurrentlyPlayingTrack();
    const playBtn = document.querySelector('.playControl, .playControls__play');
    const isPlaying = isCurrent && playBtn ? playBtn.classList.contains('playing') : false;
    const ico = modal.querySelector('#sc-tp-share-play-ico');
    if (ico) {
      ico.innerHTML = isPlaying
        ? '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>'
        : '<path d="M8 5v14l11-7z"/>';
    }
  }

  // Populate modal metadata from current track page state
  const st = scrapeCurrentState();
  const tr = activeTrackPageState.track || {};
  const us = activeTrackPageState.user || tr.user || {};
  const title = tr.title || st.title || 'Unknown Track';
  const artist = us.username || st.artist || 'Unknown Artist';
  const artwork =
    (tr.artwork_url ? tr.artwork_url.replace(/-large\./, '-t500x500.') : '') ||
    st.artworkUrl ||
    (us.avatar_url ? us.avatar_url.replace(/-large\./, '-t500x500.') : '') ||
    'https://i.imgur.com/6bFDfYA.png';

  const isCurrent = isViewingCurrentlyPlayingTrack();
  const { curSec, totalSec } = getSmoothPlaybackProgress(isCurrent, true);
  const trackDurSec = totalSec || (tr.duration ? tr.duration / 1000 : 0);

  const artEl = modal.querySelector('#sc-tp-share-art');
  if (artEl) artEl.src = artwork;
  const artistEl = modal.querySelector('#sc-tp-share-artist');
  if (artistEl) artistEl.textContent = artist;
  const titleEl = modal.querySelector('#sc-tp-share-title');
  if (titleEl) titleEl.textContent = title;
  const agoEl = modal.querySelector('#sc-tp-share-ago');
  if (agoEl) agoEl.textContent = tr.created_at ? formatRelativeTimeAgo(tr.created_at) : 'recently';
  const durEl = modal.querySelector('#sc-tp-share-dur');
  if (durEl) durEl.textContent = formatSecondsToClock(trackDurSec);

  const chkTs = modal.querySelector('#sc-tp-share-ts-chk');
  const inpTs = modal.querySelector('#sc-tp-share-ts-inp');
  const chkShort = modal.querySelector('#sc-tp-share-short-chk');
  const inpUrl = modal.querySelector('#sc-tp-share-url-inp');
  const embedInp = modal.querySelector('#sc-tp-share-embed-inp');

  if (chkTs) chkTs.checked = false;
  if (chkShort) chkShort.checked = false;
  if (inpTs) inpTs.value = formatSecondsToClock(curSec);
  const shareUrl = getActiveTrackShareUrl(false, formatSecondsToClock(curSec), false);
  if (inpUrl) inpUrl.value = shareUrl;
  if (embedInp) {
    embedInp.value = `<iframe width="100%" height="300" scrolling="no" frameborder="no" allow="autoplay" src="https://w.soundcloud.com/player/?url=${encodeURIComponent(
      (tr && tr.permalink_url) || window.location.href
    )}"></iframe>`;
  }

  // Ensure Share tab is active
  const tabs = modal.querySelectorAll('[data-share-tab]');
  tabs.forEach((t, i) => t.classList.toggle('active', i === 0));
  modal.querySelector('#sc-tp-share-pane-share').style.display = 'block';
  modal.querySelector('#sc-tp-share-pane-embed').style.display = 'none';
  modal.querySelector('#sc-tp-share-pane-message').style.display = 'none';

  syncShareModalPlayIcon();
  modal.classList.add('open');

  requestAnimationFrame(() => {
    drawShareModalMiniWaveform();
    if (inpUrl) {
      inpUrl.focus();
      inpUrl.select();
    }
  });
}

function renderPlaylistModalList() {
  const listEl = document.getElementById('sc-tp-pl-list');
  if (!listEl) return;
  const allPlaylists = [...localCustomPlaylists, ...userPlaylistsCache];
  const seen = new Set();
  const unique = [];
  for (const p of allPlaylists) {
    if (!p || !p.title) continue;
    const key = String(p.id || p.title);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
  }

  listEl.innerHTML = '';
  if (unique.length === 0) {
    const empty = document.createElement('div');
    empty.style.fontSize = '12.5px';
    empty.style.color = '#9a9aa6';
    empty.style.padding = '8px 0';
    empty.textContent = 'Создайте новый плейлист ниже или добавьте трек в очередь воспроизведения.';
    listEl.appendChild(empty);
    return;
  }

  const curTrackId = Number(activeTrackPageState.track && activeTrackPageState.track.id) || 0;
  unique.forEach((pl) => {
    const row = document.createElement('div');
    row.className = 'sc-tp-pl-item';
    const cnt = (pl.track_count != null ? pl.track_count : (pl.tracks ? pl.tracks.length : 0)) || 0;
    const art =
      (pl.artwork_url ? pl.artwork_url.replace(/-large\./, '-t120x120.') : '') ||
      (pl.tracks && pl.tracks[0] && pl.tracks[0].artwork_url ? pl.tracks[0].artwork_url.replace(/-large\./, '-t120x120.') : '') ||
      'https://i.imgur.com/6bFDfYA.png';
    const alreadyIn = Boolean(
      curTrackId &&
      Array.isArray(pl.tracks) &&
      pl.tracks.some((t) => Number(typeof t === 'object' ? t.id : t) === curTrackId)
    );
    row.innerHTML = `
      <div style="display:flex; align-items:center; gap:10px; min-width:0; flex:1;">
        <img src="${art}" alt="" style="width:38px; height:38px; border-radius:6px; object-fit:cover; background:#24242c; flex-shrink:0;" />
        <div style="min-width:0; flex:1;">
          <div class="sc-tp-pl-title" style="font-size:13px; font-weight:700; color:#fff; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"></div>
          <div class="sc-tp-pl-cnt" style="font-size:11px; color:#9a9aa6;">${cnt} tracks</div>
        </div>
      </div>
      <button class="sc-tp-pl-btn ${alreadyIn ? 'added' : ''}">${alreadyIn ? 'Added ✓' : 'Add to playlist'}</button>
    `;
    row.querySelector('.sc-tp-pl-title').textContent = pl.title;
    const cntNode = row.querySelector('.sc-tp-pl-cnt');
    const btn = row.querySelector('.sc-tp-pl-btn');
    btn.addEventListener('click', () => {
      if (!btn.classList.contains('added')) {
        btn.classList.add('added');
        btn.textContent = 'Added ✓';
        pl.track_count = cnt + 1;
        if (cntNode) cntNode.textContent = `${pl.track_count} tracks`;
      }
      const tr = activeTrackPageState.track;
      if (tr && tr.id && pl.id) {
        try {
          webFrame.executeJavaScript(
            `window.dispatchEvent(new CustomEvent('sc-mw-add-to-playlist', { detail: ${JSON.stringify({
              playlistId: pl.id,
              trackId: tr.id,
              clientId: capturedClientId
            })} }));`
          );
        } catch (e) {}
        ipcRenderer.invoke('sc:add-to-playlist', {
          playlistId: pl.id,
          trackId: tr.id,
          clientId: capturedClientId
        }).catch(() => {});
      }
      showTrackPageToast(`Добавлено в плейлист «${pl.title}»!`);
    });
    listEl.appendChild(row);
  });
}

function openAddToPlaylistModal() {
  let modal = document.getElementById('sc-tp-playlist-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'sc-tp-playlist-modal';
    modal.className = 'sc-tp-modal-backdrop';
    modal.innerHTML = `
      <div class="sc-tp-modal-box">
        <div class="sc-tp-modal-hdr">
          <h3>Добавить в плейлист / Очередь</h3>
          <button class="sc-studio-close" id="sc-tp-pl-close">&#10005;</button>
        </div>

        <button class="sc-action-btn secondary" id="sc-tp-add-queue-btn" style="width:100%; text-align:left; display:flex; align-items:center; justify-content:space-between; padding:10px 14px;">
          <span>▶️ Включить следующим в очереди (Add to Next up)</span>
          <span>+</span>
        </button>

        <div style="font-size:12px; font-weight:700; color:#b5b5c0; text-transform:uppercase; letter-spacing:0.04em;">Ваши плейлисты</div>
        <div id="sc-tp-pl-list" style="display:flex; flex-direction:column; gap:8px; max-height:210px; overflow-y:auto;"></div>

        <div style="border-top:1px solid rgba(255,255,255,0.1); padding-top:12px; display:flex; flex-direction:column; gap:8px;">
          <div style="font-size:12px; font-weight:700; color:#b5b5c0;">Создать новый плейлист с этим треком</div>
          <div style="display:flex; gap:8px;">
            <input type="text" class="sc-studio-input" id="sc-tp-new-pl-inp" placeholder="Название нового плейлиста..." style="flex:1;" />
            <button class="sc-action-btn" id="sc-tp-new-pl-btn">Создать</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener('click', (ev) => {
      if (ev.target === modal) modal.classList.remove('open');
    });
    modal.querySelector('#sc-tp-pl-close').addEventListener('click', () => {
      modal.classList.remove('open');
    });

    modal.querySelector('#sc-tp-add-queue-btn').addEventListener('click', () => {
      const nativeQueueBtn = document.querySelector('.sc-button-queue, [title*="Next up"], [aria-label*="Next up"]');
      if (nativeQueueBtn) {
        try { nativeQueueBtn.click(); } catch (e) {}
      }
      showTrackPageToast('Трек добавлен в очередь «Следующий»!');
      modal.classList.remove('open');
    });

    const createInp = modal.querySelector('#sc-tp-new-pl-inp');
    const createBtn = modal.querySelector('#sc-tp-new-pl-btn');
    const doCreate = () => {
      const title = (createInp.value || '').trim();
      if (!title) return;
      const tr = activeTrackPageState.track;
      localCustomPlaylists.unshift({
        id: 'local-' + Date.now(),
        title,
        track_count: 1
      });
      createInp.value = '';
      renderPlaylistModalList();
      if (tr && tr.id) {
        try {
          webFrame.executeJavaScript(
            `window.dispatchEvent(new CustomEvent('sc-mw-create-playlist', { detail: ${JSON.stringify({
              title,
              trackId: tr.id,
              clientId: capturedClientId
            })} }));`
          );
        } catch (e) {}
      }
      showTrackPageToast(`Плейлист «${title}» создан!`);
    };
    createBtn.addEventListener('click', doCreate);
    createInp.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') doCreate();
    });
  }

  let userPermalink = '';
  try {
    const profileAnchor = document.querySelector(
      '.header__userNavItem a[href^="/"], a.header__userNavButton[href^="/"], .userNav__button[href^="/"], .header__userNav a[href^="/"]'
    );
    if (profileAnchor) {
      const h = profileAnchor.getAttribute('href') || '';
      if (h && h !== '/' && !h.startsWith('/messages') && !h.startsWith('/notifications')) {
        userPermalink = h.split('?')[0];
      }
    }
  } catch (e) {}

  try {
    webFrame.executeJavaScript(
      `window.dispatchEvent(new CustomEvent('sc-mw-fetch-playlists', { detail: ${JSON.stringify({
        clientId: capturedClientId,
        userPermalink
      })} }));`
    );
  } catch (e) {}

  ipcRenderer
    .invoke('sc:fetch-user-playlists', {
      clientId: capturedClientId,
      userPermalink
    })
    .then((res) => {
      if (res && Array.isArray(res.playlists) && res.playlists.length > 0) {
        const merged = [...res.playlists, ...userPlaylistsCache];
        const seen = new Set();
        userPlaylistsCache = merged.filter((p) => {
          if (!p || !p.title) return false;
          const k = String(p.id || p.title);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        renderPlaylistModalList();
      }
    })
    .catch(() => {});

  renderPlaylistModalList();
  modal.classList.add('open');
}

function styleSearchAutocompletePopups() {
  try {
    const searchPopups = document.querySelectorAll(
      '.headerSearch__results, .searchAutoComplete, .autocomplete, [class*="searchAutoComplete"], [class*="SearchAutoComplete"], [class*="autocomplete"], [class*="Autocomplete"], [role="listbox"], .g-z-index-header > div'
    );
    for (let i = 0; i < searchPopups.length; i++) {
      const pop = searchPopups[i];
      if (!pop || pop.id === 'sc-custom-track-page') continue;
      pop.style.setProperty('background', 'rgba(var(--sc-surface-rgb, 20, 20, 26), 0.98)', 'important');
      pop.style.setProperty('background-color', 'rgb(var(--sc-surface-rgb, 20, 20, 26))', 'important');
      pop.style.setProperty('backdrop-filter', 'blur(22px)', 'important');
      pop.style.setProperty('z-index', '99999', 'important');
      pop.style.setProperty('box-shadow', '0 20px 52px rgba(0, 0, 0, 0.88)', 'important');
    }

    const searchForLinks = document.querySelectorAll('a[href*="/search?q="]');
    for (let i = 0; i < searchForLinks.length; i++) {
      let box = searchForLinks[i];
      while (box && box.parentElement && box.parentElement !== document.body && box.parentElement.id !== 'app') {
        const cs = window.getComputedStyle(box);
        if (cs.position === 'absolute' || cs.position === 'fixed' || (box.offsetHeight > 120 && box.offsetWidth > 220)) {
          box.style.setProperty('background', 'rgba(var(--sc-surface-rgb, 20, 20, 26), 0.98)', 'important');
          box.style.setProperty('background-color', 'rgb(var(--sc-surface-rgb, 20, 20, 26))', 'important');
          box.style.setProperty('backdrop-filter', 'blur(22px)', 'important');
          box.style.setProperty('border', '1px solid rgba(255, 255, 255, 0.14)', 'important');
          box.style.setProperty('box-shadow', '0 20px 52px rgba(0, 0, 0, 0.88)', 'important');
          box.style.setProperty('z-index', '99999', 'important');
          break;
        }
        box = box.parentElement;
      }
    }
  } catch (e) {}
}

function removeCookieBannersFromDOM() {
  try {
    // Only remove strict cookie/OneTrust/upsell leaf nodes — NEVER walk up parent containers or touch #content / .header!
    const fastTargets = document.querySelectorAll(
      '#onetrust-consent-sdk, #onetrust-banner-sdk, .onetrust-pc-dark-filter, [id*="onetrust"], [id*="cookie-banner"], .l-announcement, .Announcement, .trackMonetizationSidebarUpsell, .quotaMeterWrapper, article.sidebarModule.mobileApps'
    );
    for (let i = 0; i < fastTargets.length; i++) {
      const node = fastTargets[i];
      if (
        node &&
        node.id !== 'app' &&
        node.id !== 'content' &&
        !node.classList.contains('header') &&
        !node.classList.contains('playControls') &&
        !node.querySelector('#content, .playControls, .l-main')
      ) {
        node.remove();
      }
    }

    // Safeguard: ensure core SoundCloud UI containers are NEVER hidden by any promo class or inline style
    const coreSelectors = ['#app', '#content', '#content > div', '.header', '.playControls', '.l-container', '.l-main'];
    for (let i = 0; i < coreSelectors.length; i++) {
      const coreEl = document.querySelector(coreSelectors[i]);
      if (coreEl) {
        if (coreEl.classList.contains('sc-hidden-promo-banner')) {
          coreEl.classList.remove('sc-hidden-promo-banner');
        }
        if (coreEl.style && coreEl.style.display === 'none' && coreSelectors[i] !== '#content') {
          coreEl.style.removeProperty('display');
        } else if (coreSelectors[i] === '#content' && !activeTrackPageState.visible && coreEl.style && coreEl.style.display === 'none') {
          coreEl.style.removeProperty('display');
        }
      }
    }
  } catch (e) {}
}

function ensureCustomTrackPageElement() {
  let el = document.getElementById('sc-custom-track-page');
  if (el) return el;

  el = document.createElement('div');
  el.id = 'sc-custom-track-page';
  el.setAttribute('tabindex', '-1');
  el.innerHTML = `
    <div class="sc-tp-inner">
    <div class="sc-tp-hero" id="sc-tp-hero-card">
      <div class="sc-tp-hero-left">
        <div class="sc-tp-title-row">
          <button class="sc-tp-play-btn" id="sc-tp-play-btn" title="Play / Pause">
            <svg id="sc-tp-play-icon" viewBox="0 0 24 24" width="28" height="28" fill="currentColor">
              <path d="M8 5v14l11-7z"/>
            </svg>
          </button>
          <div class="sc-tp-title-meta">
            <h1 class="sc-tp-title" id="sc-tp-title">Track Title</h1>
            <div class="sc-tp-subline">
              <a href="#" id="sc-tp-artist-link">Artist</a>
              <span>&middot;</span>
              <span id="sc-tp-time-ago">recently</span>
              <span class="sc-tp-hq-badge">HQ</span>
            </div>
          </div>
        </div>

        <div class="sc-tp-waveform-wrap" id="sc-tp-waveform-wrap">
          <canvas id="sc-tp-waveform-canvas"></canvas>
          <div class="sc-tp-wave-avatars" id="sc-tp-wave-avatars"></div>
          <div class="sc-tp-wave-popover" id="sc-tp-wave-popover">
            <span class="sc-tp-wave-popover-user" id="sc-tp-pop-user"></span>
            <span class="sc-tp-wave-popover-body" id="sc-tp-pop-body"></span>
            <span>&middot;</span>
            <span class="sc-tp-wave-popover-act" id="sc-tp-pop-reply">Reply</span>
            <span>&middot;</span>
            <span class="sc-tp-wave-popover-act" id="sc-tp-pop-like">Like</span>
          </div>
          <div class="sc-tp-wave-times">
            <span id="sc-tp-cur-time">0:00</span>
            <span id="sc-tp-dur-time">0:00</span>
          </div>
        </div>

        <div class="sc-tp-actions-row">
          <button class="sc-tp-like-pill" id="sc-tp-like-btn" title="Like">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
            </svg>
            <span id="sc-tp-likes-pill-count">0</span>
          </button>

          <div class="sc-tp-comment-pill">
            <img class="sc-tp-comment-self-avatar" id="sc-tp-self-avatar" src="https://i.imgur.com/6bFDfYA.png" alt="" />
            <input type="text" id="sc-tp-comment-input" placeholder="Comment at 0:00" />
            <svg id="sc-tp-comment-send" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="rgba(255,255,255,0.78)" stroke-width="2" style="cursor:pointer;">
              <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>
            </svg>
          </div>

          <button class="sc-tp-icon-circle" id="sc-tp-share-btn" title="Share">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>
              <polyline points="16 6 12 2 8 6"/>
              <line x1="12" y1="2" x2="12" y2="15"/>
            </svg>
          </button>

          <button class="sc-tp-icon-circle" id="sc-tp-copy-btn" title="Copy Link">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
            </svg>
          </button>

          <button class="sc-tp-icon-circle" id="sc-tp-repost-btn" title="Repost">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M17 1l4 4-4 4"/>
              <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
              <path d="M7 23l-4-4 4-4"/>
              <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
            </svg>
          </button>

          <button class="sc-tp-icon-circle" id="sc-tp-add-btn" title="Add to Next up / Playlist">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"/>
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
          </button>
        </div>
      </div>

      <div class="sc-tp-hero-right">
        <img class="sc-tp-cover" id="sc-tp-cover-img" src="" alt="Track Artwork" />
      </div>
    </div>

    <div class="sc-tp-body">
      <div class="sc-tp-main-col">
        <div id="sc-tp-details-wrap">
          <div class="sc-tp-section-hdr">
            <span>DETAILS</span>
          </div>
          <div class="sc-tp-description-body collapsed" id="sc-tp-description"></div>
          <button class="sc-tp-show-more-btn" id="sc-tp-show-more-btn">
            <span id="sc-tp-show-more-lbl">Show more</span>
            <svg id="sc-tp-show-more-ico" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
        </div>

        <div class="sc-tp-section-hdr">
          <span id="sc-tp-comments-hdr">0 COMMENTS</span>
          <span class="sc-tp-comments-sort" id="sc-tp-comments-sort" title="Нажмите для смены сортировки">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="3" y1="6" x2="21" y2="6"/><line x1="6" y1="12" x2="18" y2="12"/><line x1="10" y1="18" x2="14" y2="18"/>
            </svg>
            <span id="sc-tp-sort-lbl">Newest</span>
          </span>
        </div>
        <div class="sc-tp-comments-list" id="sc-tp-comments-list"></div>
      </div>

      <div class="sc-tp-sidebar">
        <div class="sc-tp-artist-card">
          <div class="sc-tp-artist-top">
            <img class="sc-tp-artist-avatar" id="sc-tp-artist-avatar" src="" alt="Artist" />
            <div style="min-width:0;">
              <div class="sc-tp-artist-name-row">
                <h3 class="sc-tp-artist-name" id="sc-tp-artist-name">Artist</h3>
                <span class="sc-tp-verified-badge" id="sc-tp-artist-verified" title="Verified">&#10003;</span>
              </div>
              <p class="sc-tp-artist-sub" id="sc-tp-artist-loc"></p>
              <p class="sc-tp-artist-sub" id="sc-tp-artist-counts"></p>
            </div>
          </div>
          <div class="sc-tp-artist-btns">
            <button class="sc-tp-btn-follow" id="sc-tp-follow-btn">Follow</button>
            <button class="sc-tp-btn-msg" id="sc-tp-profile-btn">Message</button>
          </div>
        </div>

        <div class="sc-tp-stats-grid">
          <div class="sc-tp-stat-box">
            <div class="sc-tp-stat-val" id="sc-tp-stat-plays">&mdash;</div>
            <div class="sc-tp-stat-lbl">PLAYS</div>
          </div>
          <div class="sc-tp-stat-box">
            <div class="sc-tp-stat-val" id="sc-tp-stat-likes">&mdash;</div>
            <div class="sc-tp-stat-lbl">LIKES</div>
          </div>
          <div class="sc-tp-stat-box">
            <div class="sc-tp-stat-val" id="sc-tp-stat-reposts">&mdash;</div>
            <div class="sc-tp-stat-lbl">REPOSTS</div>
          </div>
        </div>

        <div class="sc-tp-fans-card">
          <div class="sc-tp-section-hdr" style="border-bottom:none; padding-bottom:2px; margin-bottom:8px;">
            <span>FANS <span style="opacity:0.6; font-weight:600;">&#9432;</span></span>
          </div>
          <div class="sc-tp-fans-tabs">
            <span class="sc-tp-fans-tab active" data-fans-tab="top">Top</span>
            <span class="sc-tp-fans-tab" data-fans-tab="first">First</span>
          </div>
          <div style="font-size:10.5px; color:#9a9aa6; font-weight:700; margin-bottom:10px; letter-spacing:0.04em;">
            FANS WHO HAVE PLAYED THIS TRACK THE MOST
          </div>
          <div id="sc-tp-fans-list"></div>
        </div>
      </div>
    </div>
    </div>
  `;

  document.body.appendChild(el);

  // Allow native Chromium smooth scrolling inside Track Page without abrupt jumps
  el.addEventListener(
    'wheel',
    (ev) => {
      ev.stopPropagation();
    },
    { passive: true }
  );

  // Keyboard scrolling (Up/Down/PageUp/PageDown/Home/End) when Track Page is open
  window.addEventListener(
    'keydown',
    (ev) => {
      if (!activeTrackPageState.visible) return;
      if (ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey) return;
      if (ev.target && ev.target.closest && ev.target.closest('.playControls, .volume, .sc-tp-modal-backdrop')) return;
      const tag = (ev.target && ev.target.tagName ? ev.target.tagName : '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || (ev.target && ev.target.isContentEditable)) return;
      if (ev.key === 'Escape') {
        document.querySelectorAll('.sc-tp-modal-backdrop.open').forEach((m) => m.classList.remove('open'));
        return;
      }
      if (ev.key === 'ArrowDown') {
        el.scrollBy({ top: 90, behavior: 'smooth' });
        ev.preventDefault();
      } else if (ev.key === 'ArrowUp') {
        el.scrollBy({ top: -90, behavior: 'smooth' });
        ev.preventDefault();
      } else if (ev.key === 'PageDown') {
        el.scrollBy({ top: Math.round(el.clientHeight * 0.8), behavior: 'smooth' });
        ev.preventDefault();
      } else if (ev.key === 'PageUp') {
        el.scrollBy({ top: -Math.round(el.clientHeight * 0.8), behavior: 'smooth' });
        ev.preventDefault();
      } else if (ev.key === 'Home') {
        el.scrollTo({ top: 0, behavior: 'smooth' });
        ev.preventDefault();
      } else if (ev.key === 'End') {
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
        ev.preventDefault();
      }
    },
    true
  );

  // Infinite scroll to load more comments when scrolling down
  el.addEventListener(
    'scroll',
    () => {
      if (!activeTrackPageState.visible) return;
      if (
        el.scrollTop + el.clientHeight >= el.scrollHeight - 420 &&
        !activeTrackPageState.loadingMoreComments &&
        activeTrackPageState.hasMoreComments
      ) {
        loadMoreTrackComments();
      }
    },
    { passive: true }
  );

  // Wire interactive events
  const playBtn = el.querySelector('#sc-tp-play-btn');
  if (playBtn) {
    playBtn.addEventListener('click', () => {
      if (!isViewingCurrentlyPlayingTrack() && lastClickedCardPlayBtn) {
        try {
          lastClickedCardPlayBtn.click();
          return;
        } catch (e) {}
      }
      const bottomPlay = document.querySelector('.playControl, .playControls__play');
      if (bottomPlay) bottomPlay.click();
    });
  }

  const likeBtn = el.querySelector('#sc-tp-like-btn');
  if (likeBtn) {
    likeBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const nowLiked = !likeBtn.classList.contains('liked');
      likeBtn.classList.toggle('liked', nowLiked);

      const tr = activeTrackPageState.track;
      if (tr) {
        const baseLikes = Number(tr.likes_count ?? tr.favoritings_count) || 0;
        const nextLikes = nowLiked ? baseLikes + 1 : Math.max(0, baseLikes - 1);
        tr.likes_count = nextLikes;
        tr.favoritings_count = nextLikes;
        const pillCnt = document.getElementById('sc-tp-likes-pill-count');
        if (pillCnt) pillCnt.textContent = formatCompactCount(nextLikes);
        const statLikes = document.getElementById('sc-tp-stat-likes');
        if (statLikes) statLikes.textContent = nextLikes ? formatExactCount(nextLikes) : '0';

        if (tr.id) {
          try {
            webFrame.executeJavaScript(
              `window.dispatchEvent(new CustomEvent('sc-mw-like-track', { detail: ${JSON.stringify({
                trackId: tr.id,
                liked: nowLiked,
                clientId: capturedClientId
              })} }));`
            );
          } catch (e) {}
        }
      }

      if (isViewingCurrentlyPlayingTrack()) {
        const badgeLike = document.querySelector('.playbackSoundBadge .playbackSoundBadge__like, .playbackSoundBadge .sc-button-like');
        if (badgeLike) {
          const badgeIsSelected = badgeLike.classList.contains('sc-button-selected');
          if (badgeIsSelected !== nowLiked) {
            try { badgeLike.click(); } catch (e) {}
          }
        }
      }

      showTrackPageToast(nowLiked ? '❤️ Трек добавлен в Понравившиеся!' : 'Лайк убран');
    });
  }

  const copyBtn = el.querySelector('#sc-tp-copy-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const linkUrl = getActiveTrackShareUrl(false);
      copyTextToClipboard(linkUrl);
      copyBtn.classList.add('active');
      showTrackPageToast('Ссылка на трек скопирована!');
      setTimeout(() => copyBtn.classList.remove('active'), 1000);
    });
  }

  const shareBtn = el.querySelector('#sc-tp-share-btn');
  if (shareBtn) {
    shareBtn.addEventListener('click', () => {
      openShareTrackModal();
    });
  }

  const repostBtn = el.querySelector('#sc-tp-repost-btn');
  if (repostBtn) {
    repostBtn.addEventListener('click', () => {
      const nowReposted = !repostBtn.classList.contains('active');
      repostBtn.classList.toggle('active', nowReposted);
      const tr = activeTrackPageState.track;
      if (tr) {
        const base = Number(tr.reposts_count) || 0;
        tr.reposts_count = nowReposted ? base + 1 : Math.max(0, base - 1);
        const repStat = document.getElementById('sc-tp-stat-reposts');
        if (repStat) repStat.textContent = tr.reposts_count ? formatExactCount(tr.reposts_count) : '0';
        if (tr.id) {
          try {
            webFrame.executeJavaScript(
              `window.dispatchEvent(new CustomEvent('sc-mw-repost-track', { detail: ${JSON.stringify({
                trackId: tr.id,
                repost: nowReposted,
                clientId: capturedClientId
              })} }));`
            );
          } catch (e) {}
        }
      }
      const nativeRepost = document.querySelector('.sc-button-repost');
      if (nativeRepost) {
        try { nativeRepost.click(); } catch (e) {}
      }
      showTrackPageToast(nowReposted ? 'Трек добавлен в ваши репосты!' : 'Репост отменён');
    });
  }

  const addBtn = el.querySelector('#sc-tp-add-btn');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      openAddToPlaylistModal();
    });
  }

  const followBtn = el.querySelector('#sc-tp-follow-btn');
  if (followBtn) {
    followBtn.addEventListener('click', () => {
      const badgeFollow = document.querySelector('.playbackSoundBadge__follow, .sc-button-follow');
      if (badgeFollow) badgeFollow.click();
      followBtn.textContent = followBtn.textContent === 'Follow' ? 'Following' : 'Follow';
    });
  }

  const profileBtn = el.querySelector('#sc-tp-profile-btn');
  const artistLink = el.querySelector('#sc-tp-artist-link');
  const goToArtist = (ev) => {
    if (ev) ev.preventDefault();
    const u = activeTrackPageState.user;
    if (u && u.permalink_url) {
      hideCustomTrackPage();
      window.location.href = u.permalink_url;
    }
  };
  if (profileBtn) profileBtn.addEventListener('click', goToArtist);
  if (artistLink) artistLink.addEventListener('click', goToArtist);

  // Collapsible DETAILS Show more / Show less toggle
  const showMoreBtn = el.querySelector('#sc-tp-show-more-btn');
  if (showMoreBtn) {
    showMoreBtn.addEventListener('click', () => {
      activeTrackPageState.detailsExpanded = !activeTrackPageState.detailsExpanded;
      const descNode = document.getElementById('sc-tp-description');
      const lblNode = document.getElementById('sc-tp-show-more-lbl');
      const icoNode = document.getElementById('sc-tp-show-more-ico');
      if (descNode) {
        descNode.classList.toggle('collapsed', !activeTrackPageState.detailsExpanded);
      }
      if (lblNode) {
        lblNode.textContent = activeTrackPageState.detailsExpanded ? 'Show less' : 'Show more';
      }
      if (icoNode) {
        icoNode.innerHTML = activeTrackPageState.detailsExpanded
          ? '<polyline points="18 15 12 9 6 15"/>'
          : '<polyline points="6 9 12 15 18 9"/>';
      }
    });
  }

  // Comments sort toggle (Newest / Oldest / Timestamp)
  const sortBtn = el.querySelector('#sc-tp-comments-sort');
  if (sortBtn) {
    sortBtn.addEventListener('click', () => {
      const order = ['newest', 'timestamp', 'oldest'];
      const labels = { newest: 'Newest', timestamp: 'Timestamp', oldest: 'Oldest' };
      const next = order[(order.indexOf(activeTrackPageState.commentSort) + 1) % order.length];
      activeTrackPageState.commentSort = next;
      const sortLbl = document.getElementById('sc-tp-sort-lbl');
      if (sortLbl) sortLbl.textContent = labels[next];
      renderTrackCommentsAndAvatars();
    });
  }

  // Fans Top / First tabs
  el.querySelectorAll('[data-fans-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      activeTrackPageState.fansTab = tab.getAttribute('data-fans-tab') || 'top';
      el.querySelectorAll('[data-fans-tab]').forEach((t) => {
        t.classList.toggle('active', t === tab);
      });
      renderTrackFansList();
    });
  });

  // Adding a comment in the Hero input bar
  const commentInp = el.querySelector('#sc-tp-comment-input');
  const commentSend = el.querySelector('#sc-tp-comment-send');
  const submitNewComment = () => {
    if (!commentInp) return;
    const text = (commentInp.value || '').trim();
    if (!text) return;
    const isCurrent = isViewingCurrentlyPlayingTrack();
    const { curSec } = getSmoothPlaybackProgress(isCurrent, true);
    const selfAv = getLoggedInUserAvatar() || 'https://i.imgur.com/6bFDfYA.png';
    const newComment = {
      id: Date.now(),
      body: text,
      timestamp: Math.round(curSec * 1000),
      created_at: new Date().toISOString(),
      user: {
        username: 'You',
        avatar_url: selfAv
      }
    };
    activeTrackPageState.comments = [newComment, ...(activeTrackPageState.comments || [])];
    if (activeTrackPageState.track) {
      activeTrackPageState.track.comment_count = (Number(activeTrackPageState.track.comment_count) || 0) + 1;
    }
    commentInp.value = '';
    renderTrackCommentsAndAvatars();
  };
  if (commentSend) commentSend.addEventListener('click', submitNewComment);
  if (commentInp) {
    commentInp.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        submitNewComment();
      }
    });
  }

  // Popover Reply / Like actions
  const popReply = el.querySelector('#sc-tp-pop-reply');
  if (popReply && commentInp) {
    popReply.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (hoveredCommentObj && hoveredCommentObj.user) {
        commentInp.value = `@${hoveredCommentObj.user.username} `;
        commentInp.focus();
      }
    });
  }

  // Waveform hover & click-to-seek (zero-latency cached bounds)
  const waveWrap = el.querySelector('#sc-tp-waveform-wrap');
  if (waveWrap) {
    let cachedCanvasRect = null;
    const refreshCanvasRect = () => {
      const canvas = document.getElementById('sc-tp-waveform-canvas');
      if (canvas) cachedCanvasRect = canvas.getBoundingClientRect();
    };

    waveWrap.addEventListener('mouseenter', refreshCanvasRect, { passive: true });
    window.addEventListener('resize', () => { cachedCanvasRect = null; }, { passive: true });
    el.addEventListener('scroll', () => { cachedCanvasRect = null; }, { passive: true });

    waveWrap.addEventListener('mousemove', (ev) => {
      if (!cachedCanvasRect || cachedCanvasRect.width <= 0) refreshCanvasRect();
      if (!cachedCanvasRect || cachedCanvasRect.width <= 0) return;
      const rawRatio = (ev.clientX - cachedCanvasRect.left) / cachedCanvasRect.width;
      if (rawRatio >= 0 && rawRatio <= 1.0) {
        waveHoverTargetRatio = rawRatio;
        waveHoverDisplayRatio = rawRatio;
      } else {
        waveHoverTargetRatio = -1;
      }
    }, { passive: true });

    waveWrap.addEventListener('mouseleave', () => {
      waveHoverTargetRatio = -1;
      hoveredCommentObj = null;
    }, { passive: true });

    waveWrap.addEventListener('click', (ev) => {
      if (ev.target && ev.target.closest && ev.target.closest('#sc-tp-wave-popover')) return;
      refreshCanvasRect();
      if (!cachedCanvasRect || cachedCanvasRect.width <= 0) return;
      const ratio = Math.max(0, Math.min(1, (ev.clientX - cachedCanvasRect.left) / cachedCanvasRect.width));
      seekSoundCloudPlayerByRatio(ratio);
    });
  }

  return el;
}

function seekSoundCloudPlayerByRatio(ratio) {
  try {
    const durEl = document.querySelector('.playbackTimeline__duration > span[aria-hidden="true"]');
    const totalSec = durEl
      ? parseClockToSeconds(durEl.textContent)
      : (activeTrackPageState.track && activeTrackPageState.track.duration
          ? activeTrackPageState.track.duration / 1000
          : 0);

    if (totalSec > 0) {
      const targetSec = ratio * totalSec;
      lastSeekOverrideSec = targetSec;
      lastSeekOverrideTime = performance.now();
      smoothTimeAnchorSec = targetSec;
      smoothTimeAnchorPerf = performance.now();

      webFrame.executeJavaScript(
        `window.dispatchEvent(new CustomEvent('sc-seek-audio', { detail: { seconds: ${targetSec} } }));`
      );
    }

    const timelineBox = document.querySelector('.playbackTimeline__progressWrapper');
    if (timelineBox) {
      const r = timelineBox.getBoundingClientRect();
      if (r.width > 0) {
        const clientX = r.left + r.width * ratio;
        const clientY = r.top + r.height / 2;
        timelineBox.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX, clientY }));
        timelineBox.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX, clientY }));
        timelineBox.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX, clientY }));
      }
    }
  } catch (e) {}
}

// ------------------------------------------------------------------
// 60 FPS Waveform & Timed Comment Popover Renderer (Zero-Lag Batched)
// ------------------------------------------------------------------
let lastActiveCommentId = null;
let lastPlaceholderSec = -1;
let animatedWaveformNorms = [];
let cachedWaveWidth = 620;
let cachedWaveHeight = 124;
let lastWaveSizeCheckPerf = 0;

function updateTimedCommentPopover(curSec, totalSec, isPlaying) {
  const popEl = document.getElementById('sc-tp-wave-popover');
  const avatarsWrap = document.getElementById('sc-tp-wave-avatars');
  if (!popEl || !avatarsWrap) return;

  let activeComment = hoveredCommentObj;
  let activePct = hoveredCommentPct;

  if (!activeComment && isPlaying && totalSec > 0 && activeTrackPageState.comments.length > 0) {
    const curMs = curSec * 1000;
    let bestDist = 2200;
    for (const c of activeTrackPageState.comments) {
      if (!c || c.timestamp == null || !c.body) continue;
      const dist = curMs - c.timestamp;
      if (dist >= -250 && dist <= bestDist) {
        bestDist = dist;
        activeComment = c;
        activePct = Math.max(8, Math.min(92, (c.timestamp / (totalSec * 1000)) * 100));
      }
    }
  }

  const nextCommentId = activeComment ? String(activeComment.id) : null;
  if (nextCommentId !== lastActiveCommentId) {
    lastActiveCommentId = nextCommentId;
    const avatarNodes = avatarsWrap.querySelectorAll('.sc-tp-wave-avatar');
    avatarNodes.forEach((node) => {
      const cid = node.getAttribute('data-cid');
      node.classList.toggle('active-comment', Boolean(nextCommentId && cid === nextCommentId));
    });

    if (activeComment && activeComment.user) {
      const uEl = document.getElementById('sc-tp-pop-user');
      const bEl = document.getElementById('sc-tp-pop-body');
      if (uEl) uEl.textContent = activeComment.user.username || 'User';
      if (bEl) bEl.textContent = activeComment.body || '';
      const clampedLeft = Math.max(16, Math.min(84, activePct));
      popEl.style.left = `${clampedLeft}%`;
      popEl.classList.add('visible');
    } else {
      popEl.classList.remove('visible');
    }
  } else if (activeComment && activeComment.user) {
    const clampedLeft = Math.max(16, Math.min(84, activePct));
    const targetLeft = `${clampedLeft}%`;
    if (popEl.style.left !== targetLeft) popEl.style.left = targetLeft;
  }
}

function drawTrackPageWaveformFrame() {
  if (!activeTrackPageState.visible) {
    waveformRafId = null;
    return;
  }

  const canvas = document.getElementById('sc-tp-waveform-canvas');
  if (canvas) {
    const nowPerf = performance.now();
    const dpr = window.devicePixelRatio || 1;
    if (nowPerf - lastWaveSizeCheckPerf > 250 || canvas.width === 0) {
      lastWaveSizeCheckPerf = nowPerf;
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;
      if (cw > 100) cachedWaveWidth = cw;
      if (ch > 40) cachedWaveHeight = ch;
    }
    const w = cachedWaveWidth;
    const h = cachedWaveHeight;

    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }

    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const isCurrent = isViewingCurrentlyPlayingTrack();
    const playBtn = document.querySelector('.playControl, .playControls__play');
    const isPlaying = isCurrent && playBtn ? playBtn.classList.contains('playing') : false;

    const { curSec, totalSec, progress } = getSmoothPlaybackProgress(isCurrent, isPlaying);

    // Instant 1:1 cursor position with smooth fade-in/out opacity
    if (waveHoverTargetRatio >= 0) {
      waveHoverDisplayRatio = waveHoverTargetRatio;
      waveHoverIntensity = Math.min(1, waveHoverIntensity + 0.22);
    } else {
      waveHoverIntensity = Math.max(0, waveHoverIntensity - 0.16);
      if (waveHoverIntensity === 0) waveHoverDisplayRatio = -1;
    }

    const displayClock = formatSecondsToClock(curSec);
    const curTimeNode = document.getElementById('sc-tp-cur-time');
    const durTimeNode = document.getElementById('sc-tp-dur-time');
    if (curTimeNode && curTimeNode.textContent !== displayClock) {
      curTimeNode.textContent = displayClock;
    }
    if (durTimeNode && totalSec > 0) {
      const durClock = formatSecondsToClock(totalSec);
      if (durTimeNode.textContent !== durClock) durTimeNode.textContent = durClock;
    }

    // Update dynamic "Comment at 0:18" placeholder only when integer second changes
    const hoverOrCurSec = Math.floor(
      waveHoverTargetRatio >= 0 && totalSec > 0 ? waveHoverTargetRatio * totalSec : curSec
    );
    if (hoverOrCurSec !== lastPlaceholderSec) {
      lastPlaceholderSec = hoverOrCurSec;
      const commentInp = document.getElementById('sc-tp-comment-input');
      if (commentInp) {
        commentInp.setAttribute('placeholder', `Comment at ${formatSecondsToClock(hoverOrCurSec)}`);
      }
    }

    const iconEl = document.getElementById('sc-tp-play-icon');
    const wantIcon = isPlaying ? 'pause' : 'play';
    if (iconEl && iconEl.getAttribute('data-state') !== wantIcon) {
      iconEl.setAttribute('data-state', wantIcon);
      iconEl.innerHTML = isPlaying
        ? '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>'
        : '<path d="M8 5v14l11-7z"/>';
    }

    updateTimedCommentPopover(curSec, totalSec, isPlaying);

    const rawSamples =
      activeTrackPageState.waveformSamples && activeTrackPageState.waveformSamples.length > 10
        ? activeTrackPageState.waveformSamples
        : generateDeterministicWaveform(activeTrackPageState.path || 'track', 180);

    const barWidth = 2;
    const gap = 2;
    const step = barWidth + gap;
    const numBars = Math.floor(w / step);
    const midY = Math.floor(h * 0.64);
    const maxTopH = midY - 6;
    const maxBotH = h - midY - 6;

    let maxSample = 1;
    for (let i = 0; i < rawSamples.length; i++) {
      if (rawSamples[i] > maxSample) maxSample = rawSamples[i];
    }

    if (animatedWaveformNorms.length !== numBars) {
      animatedWaveformNorms = new Array(numBars).fill(0.2);
    }

    const hoverR = waveHoverIntensity > 0.01 ? waveHoverDisplayRatio : -1;

    // Group bars into 3 batched paths (unplayed, hovered-preview, played) for zero GC/CPU lag
    const pathPlayedTop = new Path2D();
    const pathPlayedBot = new Path2D();
    const pathHoverTop = new Path2D();
    const pathHoverBot = new Path2D();
    const pathDimTop = new Path2D();
    const pathDimBot = new Path2D();
    let hasPlayed = false;
    let hasHover = false;
    let hasDim = false;

    for (let i = 0; i < numBars; i++) {
      const idx = Math.min(rawSamples.length - 1, Math.floor((i / numBars) * rawSamples.length));
      const targetNorm = Math.max(0.08, (rawSamples[idx] || 0) / maxSample);
      animatedWaveformNorms[i] += (targetNorm - animatedWaveformNorms[i]) * 0.22;
      const norm = animatedWaveformNorms[i];

      const topH = Math.max(3, Math.round(norm * maxTopH));
      const botH = Math.max(2, Math.round(norm * maxBotH * 0.55));
      const x = i * step;
      const barPos = i / numBars;

      if (hoverR >= 0) {
        if (barPos <= Math.min(progress, hoverR)) {
          pathPlayedTop.rect(x, midY - topH, barWidth, topH);
          pathPlayedBot.rect(x, midY + 2, barWidth, botH);
          hasPlayed = true;
        } else if (barPos <= Math.max(progress, hoverR)) {
          pathHoverTop.rect(x, midY - topH, barWidth, topH);
          pathHoverBot.rect(x, midY + 2, barWidth, botH);
          hasHover = true;
        } else {
          pathDimTop.rect(x, midY - topH, barWidth, topH);
          pathDimBot.rect(x, midY + 2, barWidth, botH);
          hasDim = true;
        }
      } else if (barPos <= progress) {
        pathPlayedTop.rect(x, midY - topH, barWidth, topH);
        pathPlayedBot.rect(x, midY + 2, barWidth, botH);
        hasPlayed = true;
      } else {
        pathDimTop.rect(x, midY - topH, barWidth, topH);
        pathDimBot.rect(x, midY + 2, barWidth, botH);
        hasDim = true;
      }
    }

    if (hasDim) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.38)';
      ctx.fill(pathDimTop);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.20)';
      ctx.fill(pathDimBot);
    }

    if (hasHover) {
      const hTopAlpha = hoverR > progress ? 0.38 + 0.50 * waveHoverIntensity : 1.0 - 0.24 * waveHoverIntensity;
      const hBotAlpha = hoverR > progress ? 0.20 + 0.28 * waveHoverIntensity : 0.56 - 0.14 * waveHoverIntensity;
      ctx.fillStyle = `rgba(255, 255, 255, ${hTopAlpha.toFixed(2)})`;
      ctx.fill(pathHoverTop);
      ctx.fillStyle = `rgba(255, 255, 255, ${hBotAlpha.toFixed(2)})`;
      ctx.fill(pathHoverBot);
    }

    if (hasPlayed) {
      ctx.fillStyle = '#ffffff';
      ctx.fill(pathPlayedTop);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.56)';
      ctx.fill(pathPlayedBot);
    }

    // Smooth 60 FPS Playhead Line
    if (progress > 0) {
      const playheadX = progress * w;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(playheadX, 4, 1.5, h - 8);
    }

    // Zero-lag Hover Cursor Guide Line & Time Pill on Waveform
    if (hoverR >= 0 && waveHoverIntensity > 0.02) {
      const hoverX = Math.round(hoverR * w);
      ctx.fillStyle = `rgba(255, 255, 255, ${(0.82 * waveHoverIntensity).toFixed(2)})`;
      ctx.fillRect(hoverX, 4, 1.5, h - 8);

      if (totalSec > 0) {
        const hoverTimeStr = formatSecondsToClock(hoverR * totalSec);
        ctx.font = '700 10.5px Inter, Cantarell, sans-serif';
        const tw = ctx.measureText(hoverTimeStr).width + 10;
        const bx = Math.max(2, Math.min(w - tw - 2, hoverX - tw / 2));
        ctx.fillStyle = `rgba(16, 16, 20, ${(0.9 * waveHoverIntensity).toFixed(2)})`;
        ctx.fillRect(bx, 2, tw, 17);
        ctx.fillStyle = `rgba(255, 255, 255, ${waveHoverIntensity.toFixed(2)})`;
        ctx.fillText(hoverTimeStr, bx + 5, 14);
      }
    }

    ctx.restore();
  }

  waveformRafId = requestAnimationFrame(drawTrackPageWaveformFrame);
}

function startWaveformLoop() {
  if (!waveformRafId && activeTrackPageState.visible) {
    waveformRafId = requestAnimationFrame(drawTrackPageWaveformFrame);
  }
}

function renderTrackCommentsAndAvatars() {
  const el = document.getElementById('sc-custom-track-page');
  if (!el) return;

  const tr = activeTrackPageState.track || {};
  const us = activeTrackPageState.user || tr.user || {};
  const defaultAvatar =
    (us.avatar_url ? us.avatar_url.replace(/-large\./, '-t300x300.') : '') ||
    'https://i.imgur.com/6bFDfYA.png';

  const rawComments = Array.isArray(activeTrackPageState.comments) ? [...activeTrackPageState.comments] : [];
  const totalCount = Math.max(Number(tr.comment_count) || 0, rawComments.length);

  const hdrNode = el.querySelector('#sc-tp-comments-hdr');
  if (hdrNode) hdrNode.textContent = `${totalCount} COMMENTS`;

  // Sort comments according to selected sort order
  const sortedComments = [...rawComments];
  if (activeTrackPageState.commentSort === 'oldest') {
    sortedComments.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
  } else if (activeTrackPageState.commentSort === 'timestamp') {
    sortedComments.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  } else {
    sortedComments.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  }

  const waveAvatarsEl = el.querySelector('#sc-tp-wave-avatars');
  const commentsListEl = el.querySelector('#sc-tp-comments-list');
  const totalMs = tr.duration || 180000;

  if (waveAvatarsEl) {
    waveAvatarsEl.innerHTML = '';
    const waveSample = rawComments.slice(0, 36);
    waveSample.forEach((c, idx) => {
      if (!c || !c.user) return;
      const img = document.createElement('img');
      img.className = 'sc-tp-wave-avatar';
      img.setAttribute('data-cid', String(c.id || idx));
      img.src = (c.user.avatar_url || defaultAvatar).replace(/-large\./, '-t120x120.');
      const pct = c.timestamp != null && totalMs > 0
        ? Math.max(2.5, Math.min(97.5, (c.timestamp / totalMs) * 100))
        : Math.max(4, Math.min(96, ((idx + 1) / (waveSample.length + 1)) * 100));
      img.style.left = `${pct}%`;

      img.addEventListener('mouseenter', () => {
        hoveredCommentObj = c;
        hoveredCommentPct = pct;
      });

      img.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (c.timestamp != null && totalMs > 0) {
          seekSoundCloudPlayerByRatio(c.timestamp / totalMs);
        }
      });

      waveAvatarsEl.appendChild(img);
    });
  }

  if (commentsListEl) {
    commentsListEl.innerHTML = '';
    if (sortedComments.length === 0) {
      const empty = document.createElement('div');
      empty.style.color = '#9a9aa6';
      empty.style.fontSize = '13.5px';
      empty.style.padding = '12px 0';
      empty.textContent = totalCount > 0 ? 'Загрузка комментариев...' : 'Комментариев пока нет.';
      commentsListEl.appendChild(empty);
    } else {
      sortedComments.forEach((c) => {
        if (!c) return;
        const item = document.createElement('div');
        item.className = 'sc-tp-comment-item';
        const uName = (c.user && (c.user.username || c.user.full_name)) || 'User';
        const uAv = ((c.user && c.user.avatar_url) || defaultAvatar).replace(/-large\./, '-t120x120.');
        const tsSec = c.timestamp != null ? Math.floor(c.timestamp / 1000) : null;
        const tsBadge = tsSec != null
          ? `<span>at</span> <span class="sc-tp-comment-ts" data-seek-sec="${tsSec}">${formatSecondsToClock(tsSec)}</span>`
          : '';
        const ago = c.created_at ? formatRelativeTimeAgo(c.created_at) : '';
        const likesCnt = Number(c.likes_count) || 0;

        item.innerHTML = `
          <img class="sc-tp-comment-avatar" src="${uAv}" alt="" />
          <div class="sc-tp-comment-main">
            <div class="sc-tp-comment-top">
              <span class="sc-tp-comment-user"></span>
              ${tsBadge}
              <span>&middot; ${ago}</span>
            </div>
            <div class="sc-tp-comment-text"></div>
            <div class="sc-tp-comment-actions">
              <span class="sc-tp-c-reply">Reply</span>
              <span class="sc-tp-c-more">&bull;&bull;&bull;</span>
            </div>
          </div>
          <div class="sc-tp-comment-like-col" title="Like comment">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
            </svg>
            <span class="sc-tp-c-likes">${likesCnt > 0 ? likesCnt : ''}</span>
          </div>
        `;
        item.querySelector('.sc-tp-comment-user').textContent = uName;
        item.querySelector('.sc-tp-comment-text').textContent = c.body || '';

        const tsEl = item.querySelector('[data-seek-sec]');
        if (tsEl && totalMs > 0) {
          tsEl.addEventListener('click', () => {
            seekSoundCloudPlayerByRatio((Number(tsEl.getAttribute('data-seek-sec')) * 1000) / totalMs);
          });
        }

        const replyBtn = item.querySelector('.sc-tp-c-reply');
        if (replyBtn) {
          replyBtn.addEventListener('click', () => {
            const inp = document.getElementById('sc-tp-comment-input');
            if (inp) {
              inp.value = `@${uName} `;
              inp.focus();
            }
          });
        }

        const likeCol = item.querySelector('.sc-tp-comment-like-col');
        const likesSpan = item.querySelector('.sc-tp-c-likes');
        if (likeCol && likesSpan) {
          likeCol.addEventListener('click', () => {
            const liked = likeCol.classList.toggle('liked');
            const cur = Number(likesSpan.textContent) || 0;
            const nextVal = liked ? cur + 1 : Math.max(0, cur - 1);
            likesSpan.textContent = nextVal > 0 ? String(nextVal) : '';
          });
        }

        commentsListEl.appendChild(item);
      });
    }
  }
}

function renderTrackFansList() {
  const el = document.getElementById('sc-custom-track-page');
  if (!el) return;
  const fansListEl = el.querySelector('#sc-tp-fans-list');
  if (!fansListEl) return;

  const tr = activeTrackPageState.track || {};
  const us = activeTrackPageState.user || tr.user || {};
  const defaultAvatar =
    (us.avatar_url ? us.avatar_url.replace(/-large\./, '-t300x300.') : '') ||
    'https://i.imgur.com/6bFDfYA.png';

  const comments = activeTrackPageState.comments || [];
  const rawFans =
    activeTrackPageState.fans && activeTrackPageState.fans.length > 0
      ? [...activeTrackPageState.fans]
      : comments.map((c) => c.user).filter(Boolean);

  if (activeTrackPageState.fansTab === 'first') {
    rawFans.reverse();
  }

  const seen = new Set();
  const uniqueFans = [];
  for (const f of rawFans) {
    if (!f || !f.username || seen.has(f.username)) continue;
    seen.add(f.username);
    uniqueFans.push(f);
    if (uniqueFans.length >= 5) break;
  }

  fansListEl.innerHTML = '';
  const basePlays = Math.max(18, Math.min(260, Math.round((Number(tr.playback_count) || 1200) / 65)));
  uniqueFans.forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'sc-tp-fan-row';
    const fanPlays = Math.max(3, Math.round(basePlays / (1 + i * 0.45)));
    row.innerHTML = `
      <div class="sc-tp-fan-left">
        <span style="width:14px; color:#9a9aa6; font-weight:700;">${i + 1}</span>
        <img class="sc-tp-fan-avatar" src="${(f.avatar_url || defaultAvatar).replace(/-large\./, '-t120x120.')}" alt="" />
        <span class="sc-tp-fan-name" style="font-weight:700; color:#fff; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"></span>
      </div>
      <span style="font-size:12px; color:#9a9aa6;">${fanPlays} plays</span>
    `;
    row.querySelector('.sc-tp-fan-name').textContent = f.username;
    fansListEl.appendChild(row);
  });
}

function populateCustomTrackPageDOM() {
  const el = ensureCustomTrackPageElement();
  const st = scrapeCurrentState();
  const tr = activeTrackPageState.track || {};
  const us = activeTrackPageState.user || tr.user || {};

  const title = tr.title || st.title || 'Unknown Track';
  const artist = us.username || st.artist || 'Unknown Artist';
  const artwork =
    (tr.artwork_url ? tr.artwork_url.replace(/-large\./, '-t500x500.') : '') ||
    st.artworkUrl ||
    (us.avatar_url ? us.avatar_url.replace(/-large\./, '-t500x500.') : '') ||
    'https://i.imgur.com/6bFDfYA.png';

  const avatar =
    (us.avatar_url ? us.avatar_url.replace(/-large\./, '-t300x300.') : '') || artwork;

  const setTxt = (id, v) => {
    const n = el.querySelector(`#${id}`);
    if (n) n.textContent = v;
  };

  setTxt('sc-tp-title', title);
  setTxt('sc-tp-artist-link', artist);
  setTxt('sc-tp-time-ago', tr.created_at ? formatRelativeTimeAgo(tr.created_at) : 'recently');

  const selfAvatarNode = el.querySelector('#sc-tp-self-avatar');
  if (selfAvatarNode) {
    selfAvatarNode.src = getLoggedInUserAvatar() || avatar;
  }

  const coverImg = el.querySelector('#sc-tp-cover-img');
  if (coverImg && coverImg.getAttribute('data-src') !== artwork) {
    coverImg.setAttribute('data-src', artwork);
    coverImg.src = artwork;
    extractDominantHeroColor(artwork, (col) => {
      const heroCard = document.getElementById('sc-tp-hero-card');
      if (heroCard) heroCard.style.setProperty('--sc-hero-bg', col);
    });
  }

  const artistAvatar = el.querySelector('#sc-tp-artist-avatar');
  if (artistAvatar) artistAvatar.src = avatar;
  setTxt('sc-tp-artist-name', artist);

  const verifiedBadge = el.querySelector('#sc-tp-artist-verified');
  if (verifiedBadge) {
    const isVer = Boolean(us.verified || (us.badges && us.badges.verified) || (Number(us.followers_count) >= 1000));
    verifiedBadge.style.display = isVer ? 'inline-flex' : 'none';
  }

  const locParts = [us.city, us.country_code].filter(Boolean);
  setTxt('sc-tp-artist-loc', locParts.join(', '));

  const followers = us.followers_count != null ? `${Number(us.followers_count).toLocaleString('en-US')} followers` : '';
  const tracksCnt = us.track_count != null ? `${us.track_count} tracks` : '';
  setTxt('sc-tp-artist-counts', [followers, tracksCnt].filter(Boolean).join(' · '));

  const likesCount = tr.likes_count ?? tr.favoritings_count ?? 0;
  const playsCount = tr.playback_count ?? 0;
  const repostsCount = tr.reposts_count ?? 0;

  setTxt('sc-tp-likes-pill-count', formatCompactCount(likesCount));
  setTxt('sc-tp-stat-plays', playsCount ? formatExactCount(playsCount) : '—');
  setTxt('sc-tp-stat-likes', likesCount ? formatExactCount(likesCount) : '—');
  setTxt('sc-tp-stat-reposts', repostsCount ? formatExactCount(repostsCount) : '—');

  // Collapsible DETAILS section (hidden if empty, collapsed with fade + Show more if present)
  const detailsWrap = el.querySelector('#sc-tp-details-wrap');
  const descEl = el.querySelector('#sc-tp-description');
  const showMoreBtn = el.querySelector('#sc-tp-show-more-btn');
  const showMoreLbl = el.querySelector('#sc-tp-show-more-lbl');
  const showMoreIco = el.querySelector('#sc-tp-show-more-ico');

  const rawDesc = (tr.description || '').trim();
  if (detailsWrap && descEl) {
    if (!rawDesc) {
      detailsWrap.style.display = 'none';
    } else {
      detailsWrap.style.display = 'block';
      descEl.textContent = rawDesc;
      descEl.classList.toggle('collapsed', !activeTrackPageState.detailsExpanded);
      if (showMoreBtn) {
        showMoreBtn.style.display = 'inline-flex';
      }
      if (showMoreLbl) {
        showMoreLbl.textContent = activeTrackPageState.detailsExpanded ? 'Show less' : 'Show more';
      }
      if (showMoreIco) {
        showMoreIco.innerHTML = activeTrackPageState.detailsExpanded
          ? '<polyline points="18 15 12 9 6 15"/>'
          : '<polyline points="6 9 12 15 18 9"/>';
      }
    }
  }

  renderTrackCommentsAndAvatars();
  renderTrackFansList();
  startWaveformLoop();
}

function hideCustomTrackPage() {
  activeTrackPageState.visible = false;
  if (waveformRafId) {
    cancelAnimationFrame(waveformRafId);
    waveformRafId = null;
  }
  if (document.body) {
    document.body.classList.remove('sc-custom-tp-open');
  }
  const el = document.getElementById('sc-custom-track-page');
  if (el) el.classList.remove('active');
}

function isTrackPermalinkPath(pathname) {
  if (!pathname) return false;
  const clean = pathname.replace(/\/+$/, '');
  if (!clean || clean === '/' || clean === '/discover' || clean === '/feed' || clean === '/stream') {
    return false;
  }
  const reservedFirst = new Set([
    'you',
    'search',
    'messages',
    'notifications',
    'settings',
    'upload',
    'signin',
    'connect',
    'pages',
    'charts',
    'stations',
    'people',
    'tags',
    'pro',
    'go'
  ]);
  const parts = clean.split('/').filter(Boolean);
  if (parts.length !== 2) return false;
  if (reservedFirst.has(parts[0].toLowerCase())) return false;
  if (
    [
      'sets',
      'likes',
      'following',
      'followers',
      'tracks',
      'albums',
      'playlists',
      'reposts',
      'comments',
      'popular-tracks'
    ].includes(parts[1].toLowerCase())
  ) {
    return false;
  }
  return true;
}

async function loadMoreTrackComments() {
  const tr = activeTrackPageState.track;
  if (!tr || !tr.id || activeTrackPageState.loadingMoreComments || !activeTrackPageState.hasMoreComments) return;
  const curLen = (activeTrackPageState.comments || []).length;
  const totalExpected = Number(tr.comment_count) || 0;
  if (totalExpected > 0 && curLen >= totalExpected) {
    activeTrackPageState.hasMoreComments = false;
    return;
  }

  activeTrackPageState.loadingMoreComments = true;
  try {
    const res = await ipcRenderer.invoke('sc:load-more-comments', {
      trackId: tr.id,
      offset: curLen,
      clientId: capturedClientId
    });
    if (res && Array.isArray(res.comments) && res.comments.length > 0) {
      const existingIds = new Set((activeTrackPageState.comments || []).map((c) => c.id));
      const newItems = res.comments.filter((c) => c && !existingIds.has(c.id));
      if (newItems.length > 0) {
        activeTrackPageState.comments = [...(activeTrackPageState.comments || []), ...newItems];
        localCommentsCache[String(tr.id)] = activeTrackPageState.comments;
        renderTrackCommentsAndAvatars();
      } else {
        activeTrackPageState.hasMoreComments = false;
      }
    } else {
      activeTrackPageState.hasMoreComments = false;
    }
  } catch (e) {
    activeTrackPageState.hasMoreComments = false;
  } finally {
    activeTrackPageState.loadingMoreComments = false;
  }
}

async function openAndRenderCustomTrackPage(targetUrl, fallbackMeta, opts = {}) {
  injectCustomThemeAndLayers();
  removeCookieBannersFromDOM();

  // Remove any accidental duplicate #sc-custom-track-page nodes so only 1 ever exists
  const allTpNodes = document.querySelectorAll('#sc-custom-track-page');
  if (allTpNodes.length > 1) {
    for (let i = 1; i < allTpNodes.length; i++) {
      allTpNodes[i].remove();
    }
  }

  const el = ensureCustomTrackPageElement();

  let urlObj;
  try {
    urlObj = new URL(targetUrl || window.location.href, window.location.origin);
  } catch (e) {
    return;
  }

  const cleanPath = urlObj.pathname.replace(/\/+$/, '').toLowerCase();

  // Deduplicate rapid identical calls so we never double-render or overlap
  if (
    activeTrackPageState.visible &&
    activeTrackPageState.path === cleanPath &&
    !opts.force &&
    activeTrackPageState.track &&
    activeTrackPageState.track.id
  ) {
    if (document.body) document.body.classList.add('sc-custom-tp-open');
    el.classList.add('active');
    populateCustomTrackPageDOM();
    return;
  }

  const reqId = ++currentTrackPageReqId;
  const wasAlreadyOpen = activeTrackPageState.visible && el.classList.contains('active');
  const prevWaveformSamples = activeTrackPageState.waveformSamples;
  const cachedTrack = localTrackCache[cleanPath] || null;
  const cachedComments =
    cachedTrack && cachedTrack.id && localCommentsCache[String(cachedTrack.id)]
      ? localCommentsCache[String(cachedTrack.id)]
      : [];
  const st = scrapeCurrentState();

  const badgePath = getNormalizedBadgePath();
  if (badgePath) lastKnownPlayingPath = badgePath;
  if (st.title) lastKnownPlayingKey = `${st.artist}:::${st.title}`.toLowerCase();

  activeTrackPageState = {
    visible: true,
    path: cleanPath,
    track: cachedTrack || {
      title: (fallbackMeta && fallbackMeta.title) || st.title || '',
      artwork_url: (fallbackMeta && fallbackMeta.artworkUrl) || st.artworkUrl || '',
      user: {
        username: (fallbackMeta && fallbackMeta.artist) || st.artist || ''
      }
    },
    user: (cachedTrack && cachedTrack.user) || {
      username: (fallbackMeta && fallbackMeta.artist) || st.artist || ''
    },
    comments: cachedComments,
    commentSort: 'newest',
    fans: [],
    fansTab: 'top',
    waveformSamples: prevWaveformSamples || null,
    detailsExpanded: false
  };

  activeTrackPageState.hasMoreComments = true;
  activeTrackPageState.loadingMoreComments = false;

  if (document.body) {
    document.body.classList.add('sc-custom-tp-open');
  }
  el.classList.add('active');

  if (wasAlreadyOpen) {
    el.classList.add('sc-tp-transition-out');
    if (el.scrollTop > 0) {
      el.scrollTo({ top: 0, behavior: 'smooth' });
    }
    setTimeout(() => {
      if (reqId === currentTrackPageReqId) {
        populateCustomTrackPageDOM();
        requestAnimationFrame(() => {
          el.classList.remove('sc-tp-transition-out');
        });
      }
    }, 130);
  } else {
    el.classList.remove('sc-tp-transition-out');
    el.scrollTop = 0;
    populateCustomTrackPageDOM();
  }

  try {
    const res = await ipcRenderer.invoke('sc:resolve-track-page', {
      url: urlObj.href,
      clientId: capturedClientId,
      title: activeTrackPageState.track.title,
      artist: activeTrackPageState.user.username
    });

    if (res && res.ok && reqId === currentTrackPageReqId && activeTrackPageState.path === cleanPath) {
      if (res.clientId && !capturedClientId) {
        capturedClientId = res.clientId;
      }
      if (res.track) {
        activeTrackPageState.track = res.track;
        localTrackCache[cleanPath] = res.track;
      }
      if (res.user) activeTrackPageState.user = res.user;
      if (Array.isArray(res.comments) && res.comments.length > 0) {
        activeTrackPageState.comments = res.comments;
        if (res.track && res.track.id) {
          localCommentsCache[String(res.track.id)] = res.comments;
        }
      }
      if (Array.isArray(res.fans)) activeTrackPageState.fans = res.fans;
      if (Array.isArray(res.waveformSamples)) activeTrackPageState.waveformSamples = res.waveformSamples;
      populateCustomTrackPageDOM();
      requestAnimationFrame(() => {
        el.classList.remove('sc-tp-transition-out');
      });

      // If comments are still empty despite track having comments, trigger Main-World cookie-authenticated fetch
      const tid = activeTrackPageState.track && activeTrackPageState.track.id;
      if (tid && (!activeTrackPageState.comments || activeTrackPageState.comments.length === 0)) {
        try {
          webFrame.executeJavaScript(
            `window.dispatchEvent(new CustomEvent('sc-mw-fetch-track-extras', { detail: ${JSON.stringify({
              trackId: tid,
              clientId: capturedClientId || (res && res.clientId) || ''
            })} }));`
          );
        } catch (e) {}
      }
    }
  } catch (e) {}
}

let trackPageSystemInstalled = false;

function setupTrackPageSystem() {
  if (trackPageSystemInstalled || !isMainSoundCloudApp()) return;
  trackPageSystemInstalled = true;

  // 1. Intercept clicks on track titles, cover art, and navigation links
  document.addEventListener(
    'click',
    (ev) => {
      // Never intercept clicks on action buttons (Like, Repost, Play, Queue, Follow, Share, More)
      if (
        ev.target &&
        ev.target.closest &&
        ev.target.closest(
          'button, .sc-button, .sc-button-like, .sc-button-repost, .sc-button-play, .sc-button-queue, .sc-button-follow, .sc-button-share, .sc-button-more, .playbackSoundBadge__actions, .playbackSoundBadge__like, .playbackSoundBadge__follow, .playbackSoundBadge__showQueue, .soundActions'
        )
      ) {
        return;
      }
      const anchor = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
      if (!anchor) return;
      if (anchor.closest('#sc-custom-track-page')) return;

      const rawHref = anchor.getAttribute('href') || '';
      if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:')) return;

      let resolved;
      try {
        resolved = new URL(rawHref, window.location.origin);
      } catch (e) {
        return;
      }
      if (!resolved.hostname.includes('soundcloud.com')) return;

      // Ignore header popup/dropdown toggle buttons (Profile menu toggle, Notifications, Messages, More menu)
      // so opening the top-right Profile menu does NOT hide the current Track Page or reveal a stale track!
      const isHeaderDropdownToggle = Boolean(
        anchor.classList.contains('userNav__button') ||
        anchor.classList.contains('header__userNavButton') ||
        anchor.classList.contains('header__moreButton') ||
        anchor.getAttribute('aria-haspopup') === 'true' ||
        (anchor.closest('.header__userNav, .userNav') && !anchor.closest('.dropdownMenu, .headerMenu, .userNav__menuList')) ||
        anchor.closest('.notifications, .messages')
      );
      if (isHeaderDropdownToggle) {
        return;
      }

      const isBadgeTitleOrAvatar = Boolean(
        anchor.classList.contains('playbackSoundBadge__titleLink') ||
          anchor.classList.contains('playbackSoundBadge__avatar')
      );

      const isLogoOrHome = Boolean(
        anchor.classList.contains('header__logoLink') ||
        anchor.closest('.header__logo, .header__logoLink') ||
        resolved.pathname === '/' ||
        resolved.pathname === '/discover'
      );

      if (isLogoOrHome) {
        const wasTpOpen = activeTrackPageState.visible;
        hideCustomTrackPage();
        const curPath = window.location.pathname.replace(/\/+$/, '') || '/';
        if (curPath === '/' || curPath === '/discover') {
          // Already on SoundCloud Home/Discover: prevent any full reload and scroll to top smoothly
          ev.preventDefault();
          ev.stopPropagation();
          if (!wasTpOpen) {
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }
          return;
        }
        const homeTabLink = document.querySelector('.header__navMenu a[href="/discover"], a.header__navMenuItem[href="/discover"]');
        if (homeTabLink && homeTabLink !== anchor) {
          ev.preventDefault();
          ev.stopPropagation();
          homeTabLink.click();
        }
        return;
      }

      if (isBadgeTitleOrAvatar || isTrackPermalinkPath(resolved.pathname)) {
        ev.preventDefault();
        ev.stopPropagation();
        const cardContainer = anchor.closest(
          '.sound, .soundList__item, .trackList__item, .compactTrackList__item, .playableTile, .searchItem'
        );
        if (cardContainer) {
          lastClickedCardPlayBtn = cardContainer.querySelector('.playButton, .sc-button-play');
        }

        const st = scrapeCurrentState();
        const fallbackMeta = isBadgeTitleOrAvatar
          ? { title: st.title, artist: st.artist, artworkUrl: st.artworkUrl }
          : { title: (anchor.getAttribute('title') || anchor.textContent || '').trim() };

        openAndRenderCustomTrackPage(resolved.href, fallbackMeta);
      } else {
        // User clicked a non-track navigation link (e.g., Profile inside dropdown, Feed, Library, Artist)
        hideCustomTrackPage();
      }
    },
    true
  );

  // 2. Hide custom track page when submitting a search & style search popup immediately on typing/focus
  document.addEventListener(
    'keydown',
    (ev) => {
      if (ev.key === 'Enter' && ev.target && ev.target.closest && ev.target.closest('.headerSearch')) {
        hideCustomTrackPage();
      }
    },
    true
  );

  document.addEventListener(
    'input',
    (ev) => {
      if (ev.target && ev.target.closest && ev.target.closest('.headerSearch')) {
        requestAnimationFrame(styleSearchAutocompletePopups);
        setTimeout(styleSearchAutocompletePopups, 80);
      }
    },
    true
  );

  document.addEventListener(
    'focusin',
    (ev) => {
      if (ev.target && ev.target.closest && ev.target.closest('.headerSearch')) {
        requestAnimationFrame(styleSearchAutocompletePopups);
        setTimeout(styleSearchAutocompletePopups, 80);
      }
    },
    true
  );

  // 3. Keep route state & automatic next-track switching synced with minimal CPU/RAM overhead
  let lastPath = window.location.pathname;
  let tickCount = 0;
  setInterval(() => {
    tickCount++;
    checkAutoTrackSwitch();
    if (tickCount % 5 === 0) {
      removeCookieBannersFromDOM();
    }
    if (tickCount % 12 === 0) {
      sendState();
    }
    if (window.location.pathname !== lastPath) {
      lastPath = window.location.pathname;
      if (startParticleLoopFn) startParticleLoopFn();
      removeCookieBannersFromDOM();
      if (isTrackPermalinkPath(lastPath)) {
        if (!activeTrackPageState.visible || activeTrackPageState.path !== lastPath.replace(/\/+$/, '').toLowerCase()) {
          openAndRenderCustomTrackPage(window.location.href, null);
        }
      } else {
        hideCustomTrackPage();
      }
    }
  }, 450);

  // Periodic Blink/WebFrame cache trim to keep renderer memory footprint low
  setInterval(() => {
    try {
      if (webFrame && typeof webFrame.clearCache === 'function') {
        webFrame.clearCache();
      }
    } catch (e) {}
  }, 180000);
}

async function initView() {
  if (!isMainSoundCloudApp()) return;
  try {
    const saved = await ipcRenderer.invoke('app:get-settings');
    if (saved) {
      currentSettings = { ...currentSettings, ...saved };
    }
  } catch (e) {}

  injectCustomThemeAndLayers();
  syncDrawerInputsFromSettings();
  applyVisualSettings();
  setupTrackPageSystem();
  removeCookieBannersFromDOM();
  setTimeout(removeCookieBannersFromDOM, 900);
  setTimeout(removeCookieBannersFromDOM, 2200);

  if (isTrackPermalinkPath(window.location.pathname)) {
    openAndRenderCustomTrackPage(window.location.href, null);
  }

  if (!attachObservers()) {
    const id = setInterval(() => {
      if (attachObservers()) clearInterval(id);
    }, 1000);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initView);
} else {
  initView();
}