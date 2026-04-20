(() => {
  "use strict";

  // =========================================================
  // DOM
  // =========================================================
  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d");
  const video = document.getElementById("video");

  const ui = document.getElementById("ui");
  const cameraSelect = document.getElementById("cameraSelect");
  const modeSelect = document.getElementById("modeSelect");
  const startBtn = document.getElementById("startBtn");
  const burstBtn = document.getElementById("burstBtn");
  const resetBtn = document.getElementById("resetBtn");
  const debugBtn = document.getElementById("debugBtn");

  // =========================================================
  // CONFIG
  // =========================================================
  const CONFIG = {
    logoPath: "bxcm-logo.png",

    cameraWidth: 640,
    cameraHeight: 480,

    diffWidth: 320,
    diffHeight: 240,
    diffStep: 6,
    diffThreshold: 34,
    minActiveCells: 24,

    fogReturnAlphaBase: 0.010,
    fogTextureDensity: 28,
    fogTextureSizeMin: 50,
    fogTextureSizeMax: 180,

    eraseRadiusBase: 28,
    eraseRadiusMax: 85,
    eraseStrength: 0.95,

    sparkleLifeMin: 16,
    sparkleLifeMax: 40,
    sparkleMax: 220,

    revealCheckEvery: 12,
    autoHideMs: 5000,
    introFadeAfterMs: 8500
  };

  // =========================================================
  // BxCM COLORS
  // =========================================================
  const BXCM_COLORS = [
    "#f8c400", // yellow
    "#f28c1b", // orange
    "#1fa5dc", // blue
    "#a12c92", // magenta
    "#4a9a3f", // green
    "#4b2ca3"  // purple
  ];

  function colorAt(i) {
    return BXCM_COLORS[i % BXCM_COLORS.length];
  }

  // =========================================================
  // STATE
  // =========================================================
  let W = window.innerWidth;
  let H = window.innerHeight;
  let DPR = Math.min(window.devicePixelRatio || 1, 2);

  let stream = null;
  let selectedDeviceId = null;
  let started = false;
  let debugOn = false;
  let frameCount = 0;
  let animationId = null;
  let uiHideTimeout = null;
  let experienceStartedAt = 0;
  let firstGestureActivated = false;
  let celebrationOn = false;
  let lastCelebrationAt = 0;

  const state = {
    mode: "AUTO",
    autoModeResolved: "GLOW",
    motionEnergy: 0,
    revealRatio: 0,
    introVisible: true
  };

  // =========================================================
  // LOGO IMAGE
  // =========================================================
  const logoImg = new Image();
  let logoReady = false;
  logoImg.onload = () => {
    logoReady = true;
  };
  logoImg.onerror = () => {
    console.warn("Could not load logo at:", CONFIG.logoPath);
  };
  logoImg.src = CONFIG.logoPath;

  // =========================================================
  // OFFSCREEN CANVASES
  // =========================================================
  const diffCanvas = document.createElement("canvas");
  const diffCtx = diffCanvas.getContext("2d", { willReadFrequently: true });

  const fogCanvas = document.createElement("canvas");
  const fogCtx = fogCanvas.getContext("2d");

  const logoCanvas = document.createElement("canvas");
  const logoCtx = logoCanvas.getContext("2d");

  const revealSampleCanvas = document.createElement("canvas");
  const revealSampleCtx = revealSampleCanvas.getContext("2d", { willReadFrequently: true });

  let prevFrame = null;

  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    DPR = Math.min(window.devicePixelRatio || 1, 2);

    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    diffCanvas.width = CONFIG.diffWidth;
    diffCanvas.height = CONFIG.diffHeight;

    fogCanvas.width = W;
    fogCanvas.height = H;

    logoCanvas.width = W;
    logoCanvas.height = H;

    revealSampleCanvas.width = 160;
    revealSampleCanvas.height = 90;

    buildFog(true);
    renderLogoLayer();
  }

  window.addEventListener("resize", resize);
  resize();

  // =========================================================
  // UTIL
  // =========================================================
  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function mapRange(v, inMin, inMax, outMin, outMax) {
    const t = clamp((v - inMin) / (inMax - inMin), 0, 1);
    return outMin + (outMax - outMin) * t;
  }

  function rand(min, max) {
    return Math.random() * (max - min) + min;
  }

  function pick(arr) {
    return arr[(Math.random() * arr.length) | 0];
  }

  // =========================================================
  // UI / OVERLAY
  // =========================================================
  const intro = document.createElement("div");
  intro.innerHTML = `
    <div id="bxcmIntroInner">
      <div class="museum">BRONX CHILDREN’S MUSEUM</div>
      <div class="big">REVEAL THE LOGO</div>
      <div class="line">Move your body to brush away the cloud.</div>
      <div class="line">Work together to uncover BxCM.</div>
      <div class="line">Fast motion reveals more.</div>
    </div>
  `;
  document.body.appendChild(intro);

  Object.assign(intro.style, {
    position: "fixed",
    inset: "0",
    zIndex: "30",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    pointerEvents: "none",
    transition: "opacity 0.8s ease",
    opacity: "1"
  });

  const introInner = intro.querySelector("#bxcmIntroInner");
  Object.assign(introInner.style, {
    textAlign: "center",
    fontFamily: "Arial, sans-serif",
    color: "#17324d",
    textShadow: "0 2px 10px rgba(255,255,255,0.8), 0 0 24px rgba(31,165,220,0.18)",
    padding: "24px",
    maxWidth: "960px"
  });

  Array.from(introInner.children).forEach((el) => {
    if (el.classList.contains("museum")) {
      Object.assign(el.style, {
        fontSize: "16px",
        fontWeight: "700",
        letterSpacing: "2px",
        color: "#1fa5dc",
        margin: "0 0 10px 0"
      });
    } else if (el.classList.contains("big")) {
      Object.assign(el.style, {
        fontSize: "76px",
        fontWeight: "800",
        lineHeight: "0.95",
        color: "#0f2a44",
        margin: "0 0 18px 0"
      });
    } else {
      Object.assign(el.style, {
        fontSize: "22px",
        fontWeight: "500",
        color: "#17324d",
        margin: "10px 0"
      });
    }
  });

  const modeBadge = document.createElement("div");
  modeBadge.textContent = "MODE: AUTO";
  document.body.appendChild(modeBadge);

  Object.assign(modeBadge.style, {
    position: "fixed",
    left: "20px",
    top: "20px",
    zIndex: "25",
    color: "#11324f",
    fontFamily: "Arial, sans-serif",
    fontSize: "15px",
    letterSpacing: "1px",
    padding: "10px 16px",
    borderRadius: "999px",
    background: "linear-gradient(180deg, rgba(31,165,220,0.18), rgba(161,44,146,0.10))",
    border: "1px solid rgba(31,165,220,0.18)",
    backdropFilter: "blur(6px)",
    boxShadow: "0 0 20px rgba(31,165,220,0.10)",
    opacity: "0.96",
    transition: "opacity 0.5s ease"
  });

  function updateModeBadge() {
    const label = state.mode === "AUTO" ? `AUTO · ${state.autoModeResolved}` : state.mode;
    modeBadge.textContent = `MODE: ${label}`;
  }

  function hideUIForKiosk() {
    if (!ui) return;
    ui.style.transition = "opacity 0.7s ease";
    ui.style.opacity = "0";
    ui.style.pointerEvents = "none";
  }

  function showUI() {
    if (!ui) return;
    ui.style.opacity = "1";
    ui.style.pointerEvents = "auto";
  }

  function scheduleUIHide() {
    if (uiHideTimeout) clearTimeout(uiHideTimeout);
    uiHideTimeout = setTimeout(() => hideUIForKiosk(), CONFIG.autoHideMs);
  }

  function fadeIntroIfNeeded(now) {
    const elapsed = now - experienceStartedAt;
    if (elapsed > CONFIG.introFadeAfterMs) {
      intro.style.opacity = "0";
      state.introVisible = false;
    }
  }

  // =========================================================
  // AUDIO
  // =========================================================
  let audioCtx = null;
  let humOsc = null;
  let humGain = null;
  let revealOsc = null;
  let revealGain = null;

  function initAudio() {
    if (audioCtx) return;

    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;

    audioCtx = new AC();

    humOsc = audioCtx.createOscillator();
    humGain = audioCtx.createGain();
    humOsc.type = "sine";
    humOsc.frequency.value = 90;
    humGain.gain.value = 0.0001;
    humOsc.connect(humGain);
    humGain.connect(audioCtx.destination);
    humOsc.start();

    revealOsc = audioCtx.createOscillator();
    revealGain = audioCtx.createGain();
    revealOsc.type = "triangle";
    revealOsc.frequency.value = 180;
    revealGain.gain.value = 0.0001;
    revealOsc.connect(revealGain);
    revealGain.connect(audioCtx.destination);
    revealOsc.start();
  }

  async function resumeAudio() {
    if (!audioCtx) initAudio();
    if (audioCtx && audioCtx.state === "suspended") {
      try {
        await audioCtx.resume();
      } catch (err) {
        console.warn(err);
      }
    }
  }

  function updateAudio() {
    if (!audioCtx) return;

    const e = state.motionEnergy;
    const reveal = state.revealRatio;

    humOsc.frequency.setTargetAtTime(82 + e * 22, audioCtx.currentTime, 0.08);
    humGain.gain.setTargetAtTime(0.008 + (1 - e) * 0.01, audioCtx.currentTime, 0.12);

    revealOsc.frequency.setTargetAtTime(160 + e * 240 + reveal * 120, audioCtx.currentTime, 0.08);
    revealGain.gain.setTargetAtTime(0.001 + e * 0.02 + reveal * 0.01, audioCtx.currentTime, 0.08);
  }

  function playCelebrateSound() {
    if (!audioCtx) return;

    const t = audioCtx.currentTime;
    [0, 4, 7].forEach((semitones, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();

      osc.type = "triangle";
      osc.frequency.value = 440 * Math.pow(2, semitones / 12);

      gain.gain.setValueAtTime(0.0001, t + i * 0.04);
      gain.gain.linearRampToValueAtTime(0.05, t + i * 0.04 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.04 + 0.35);

      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(t + i * 0.04);
      osc.stop(t + i * 0.04 + 0.4);
    });
  }

  // =========================================================
  // CAMERA
  // =========================================================
  async function getCameras() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === "videoinput");
  }

  async function populateCameraList() {
    if (!cameraSelect) return;

    const cameras = await getCameras();
    cameraSelect.innerHTML = "";

    cameras.forEach((cam, index) => {
      const option = document.createElement("option");
      option.value = cam.deviceId;
      option.textContent = cam.label || `Camera ${index + 1}`;
      cameraSelect.appendChild(option);
    });

    if (!selectedDeviceId && cameras.length > 0) {
      selectedDeviceId = cameras[0].deviceId;
      cameraSelect.value = selectedDeviceId;
    } else if (selectedDeviceId) {
      cameraSelect.value = selectedDeviceId;
    }
  }

  async function startCamera(deviceId) {
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }

    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: CONFIG.cameraWidth },
        height: { ideal: CONFIG.cameraHeight },
        frameRate: { ideal: 30, max: 30 }
      }
    });

    video.srcObject = stream;
    await video.play();

    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings();
    if (settings.deviceId) selectedDeviceId = settings.deviceId;

    await populateCameraList();
  }

  // =========================================================
  // LOGO LAYER
  // =========================================================
  function renderLogoLayer() {
    logoCtx.clearRect(0, 0, W, H);

    // white background
    logoCtx.fillStyle = "#f8fbff";
    logoCtx.fillRect(0, 0, W, H);

    // ambient BxCM color wash
    const gradA = logoCtx.createRadialGradient(W * 0.35, H * 0.4, 0, W * 0.35, H * 0.4, W * 0.45);
    gradA.addColorStop(0, "rgba(31,165,220,0.12)");
    gradA.addColorStop(1, "rgba(31,165,220,0)");
    logoCtx.fillStyle = gradA;
    logoCtx.fillRect(0, 0, W, H);

    const gradB = logoCtx.createRadialGradient(W * 0.68, H * 0.42, 0, W * 0.68, H * 0.42, W * 0.42);
    gradB.addColorStop(0, "rgba(161,44,146,0.10)");
    gradB.addColorStop(1, "rgba(161,44,146,0)");
    logoCtx.fillStyle = gradB;
    logoCtx.fillRect(0, 0, W, H);

    if (!logoReady) {
      // fallback text if logo image is not available
      logoCtx.fillStyle = "#0f2a44";
      logoCtx.font = "bold 84px Arial";
      logoCtx.textAlign = "center";
      logoCtx.fillText("BxCM", W / 2, H / 2);
      return;
    }

    const maxW = W * 0.68;
    const maxH = H * 0.38;
    const scale = Math.min(maxW / logoImg.width, maxH / logoImg.height);
    const drawW = logoImg.width * scale;
    const drawH = logoImg.height * scale;
    const x = (W - drawW) / 2;
    const y = (H - drawH) / 2;

    // halo
    logoCtx.save();
    logoCtx.shadowBlur = 42;
    logoCtx.shadowColor = "rgba(31,165,220,0.22)";
    logoCtx.drawImage(logoImg, x, y, drawW, drawH);
    logoCtx.restore();

    // actual logo
    logoCtx.drawImage(logoImg, x, y, drawW, drawH);
  }

  // =========================================================
  // FOG BUILD
  // =========================================================
  function buildFog(fullReset = false) {
    if (fullReset) {
      fogCtx.clearRect(0, 0, W, H);
      fogCtx.fillStyle = "rgba(255,255,255,0.98)";
      fogCtx.fillRect(0, 0, W, H);
    }

    // soft cloud puffs
    for (let i = 0; i < CONFIG.fogTextureDensity; i++) {
      const x = rand(0, W);
      const y = rand(0, H);
      const r = rand(CONFIG.fogTextureSizeMin, CONFIG.fogTextureSizeMax);

      const g = fogCtx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, "rgba(255,255,255,0.24)");
      g.addColorStop(0.6, "rgba(244,248,255,0.12)");
      g.addColorStop(1, "rgba(255,255,255,0)");

      fogCtx.fillStyle = g;
      fogCtx.beginPath();
      fogCtx.arc(x, y, r, 0, Math.PI * 2);
      fogCtx.fill();
    }
  }

  // =========================================================
  // SPARKLES
  // =========================================================
  const sparkles = [];

  function spawnSparkle(x, y, strength = 1) {
    if (sparkles.length > CONFIG.sparkleMax) return;

    const count = 2 + ((strength * 5) | 0);
    for (let i = 0; i < count; i++) {
      sparkles.push({
        x,
        y,
        vx: rand(-1.8, 1.8) * strength,
        vy: rand(-2.0, 0.6) * strength,
        life: rand(CONFIG.sparkleLifeMin, CONFIG.sparkleLifeMax),
        maxLife: 0,
        size: rand(2, 7),
        color: pick(BXCM_COLORS)
      });
      sparkles[sparkles.length - 1].maxLife = sparkles[sparkles.length - 1].life;
    }
  }

  function updateAndDrawSparkles() {
    for (let i = sparkles.length - 1; i >= 0; i--) {
      const p = sparkles[i];
      p.life -= 1;
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.02;

      if (p.life <= 0) {
        sparkles.splice(i, 1);
        continue;
      }

      const alpha = p.life / p.maxLife;
      ctx.save();
      ctx.globalAlpha = alpha * 0.8;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // =========================================================
  // MODE FEEL
  // =========================================================
  function resolveAutoMode() {
    const e = state.motionEnergy;
    const r = state.revealRatio;

    if (e > 0.62) return "STORM";
    if (r > 0.68) return "SPACE";
    if (e > 0.32) return "TWIN";
    return "GLOW";
  }

  function getActiveMode() {
    if (state.mode === "AUTO") {
      state.autoModeResolved = resolveAutoMode();
      return state.autoModeResolved;
    }
    return state.mode;
  }

  function modeParams() {
    const mode = getActiveMode();

    if (mode === "STORM") {
      return {
        eraseBoost: 1.55,
        returnAlpha: CONFIG.fogReturnAlphaBase * 0.55,
        mirror: false,
        sparkleBoost: 1.5
      };
    }

    if (mode === "TWIN") {
      return {
        eraseBoost: 1.05,
        returnAlpha: CONFIG.fogReturnAlphaBase * 0.9,
        mirror: true,
        sparkleBoost: 1.0
      };
    }

    if (mode === "SPACE") {
      return {
        eraseBoost: 0.92,
        returnAlpha: CONFIG.fogReturnAlphaBase * 0.45,
        mirror: false,
        sparkleBoost: 0.8
      };
    }

    return {
      eraseBoost: 1.0,
      returnAlpha: CONFIG.fogReturnAlphaBase,
      mirror: false,
      sparkleBoost: 1.0
    };
  }

  // =========================================================
  // MOTION DETECTION + WIPE
  // =========================================================
  function updateMotionAndWipe() {
    if (!video.videoWidth || !video.videoHeight) return;

    const params = modeParams();

    diffCtx.save();
    diffCtx.scale(-1, 1);
    diffCtx.drawImage(video, -diffCanvas.width, 0, diffCanvas.width, diffCanvas.height);
    diffCtx.restore();

    const frame = diffCtx.getImageData(0, 0, diffCanvas.width, diffCanvas.height);
    const data = frame.data;

    if (!prevFrame) {
      prevFrame = new Uint8ClampedArray(data);
      return;
    }

    let active = 0;
    let energyAccum = 0;

    // fog slowly comes back
    fogCtx.save();
    fogCtx.globalCompositeOperation = "source-over";
    fogCtx.fillStyle = `rgba(255,255,255,${params.returnAlpha})`;
    fogCtx.fillRect(0, 0, W, H);
    fogCtx.restore();

    for (let y = 0; y < diffCanvas.height; y += CONFIG.diffStep) {
      for (let x = 0; x < diffCanvas.width; x += CONFIG.diffStep) {
        const i = (y * diffCanvas.width + x) * 4;

        const dr = Math.abs(data[i] - prevFrame[i]);
        const dg = Math.abs(data[i + 1] - prevFrame[i + 1]);
        const db = Math.abs(data[i + 2] - prevFrame[i + 2]);
        const diff = dr + dg + db;

        if (diff > CONFIG.diffThreshold) {
          active++;
          energyAccum += diff;

          const screenX = mapRange(x, 0, diffCanvas.width, 0, W);
          const screenY = mapRange(y, 0, diffCanvas.height, 0, H);
          const strength = clamp(mapRange(diff, CONFIG.diffThreshold, 180, 0.25, 1.0), 0.25, 1.0);
          const radius = (CONFIG.eraseRadiusBase + strength * (CONFIG.eraseRadiusMax - CONFIG.eraseRadiusBase)) * params.eraseBoost;

          // wipe away fog
          fogCtx.save();
          fogCtx.globalCompositeOperation = "destination-out";
          fogCtx.beginPath();
          fogCtx.arc(screenX, screenY, radius, 0, Math.PI * 2);
          fogCtx.fillStyle = `rgba(0,0,0,${CONFIG.eraseStrength})`;
          fogCtx.fill();
          fogCtx.restore();

          // soft edge color glow
          fogCtx.save();
          fogCtx.globalCompositeOperation = "source-over";
          const glow = fogCtx.createRadialGradient(screenX, screenY, 0, screenX, screenY, radius * 1.45);
          const c1 = pick(BXCM_COLORS);
          glow.addColorStop(0, `${hexToRGBA(c1, 0.055)}`);
          glow.addColorStop(1, "rgba(255,255,255,0)");
          fogCtx.fillStyle = glow;
          fogCtx.beginPath();
          fogCtx.arc(screenX, screenY, radius * 1.45, 0, Math.PI * 2);
          fogCtx.fill();
          fogCtx.restore();

          spawnSparkle(screenX, screenY, strength * params.sparkleBoost);

          // mirrored wipe in Twin mode
          if (params.mirror) {
            const mx = W - screenX;

            fogCtx.save();
            fogCtx.globalCompositeOperation = "destination-out";
            fogCtx.beginPath();
            fogCtx.arc(mx, screenY, radius * 0.95, 0, Math.PI * 2);
            fogCtx.fillStyle = `rgba(0,0,0,${CONFIG.eraseStrength})`;
            fogCtx.fill();
            fogCtx.restore();
          }
        }
      }
    }

    prevFrame.set(data);

    const energyNorm = active > 0
      ? clamp(mapRange(energyAccum / Math.max(active, 1), CONFIG.diffThreshold, 180, 0.1, 1.0), 0, 1)
      : 0;

    state.motionEnergy = lerp(state.motionEnergy, energyNorm, 0.14);
  }

  function hexToRGBA(hex, alpha) {
    const h = hex.replace("#", "");
    const bigint = parseInt(h, 16);
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;
    return `rgba(${r},${g},${b},${alpha})`;
  }

  // =========================================================
  // REVEAL ESTIMATION
  // =========================================================
  function updateRevealRatio() {
    revealSampleCtx.clearRect(0, 0, revealSampleCanvas.width, revealSampleCanvas.height);
    revealSampleCtx.drawImage(fogCanvas, 0, 0, revealSampleCanvas.width, revealSampleCanvas.height);

    const img = revealSampleCtx.getImageData(0, 0, revealSampleCanvas.width, revealSampleCanvas.height);
    const d = img.data;

    let visibleCount = 0;
    const total = revealSampleCanvas.width * revealSampleCanvas.height;

    for (let i = 3; i < d.length; i += 4) {
      const alpha = d[i] / 255;
      if (alpha < 0.55) visibleCount++;
    }

    state.revealRatio = visibleCount / total;
  }

  // =========================================================
  // DRAW LAYERS
  // =========================================================
  function drawBackground() {
    ctx.fillStyle = "#f8fbff";
    ctx.fillRect(0, 0, W, H);
  }

  function drawLogo() {
    ctx.drawImage(logoCanvas, 0, 0);

    const reveal = state.revealRatio;
    if (reveal > 0.35) {
      ctx.save();
      ctx.globalAlpha = clamp(reveal * 0.25, 0, 0.22);

      const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.35);
      g.addColorStop(0, "rgba(31,165,220,0.22)");
      g.addColorStop(0.45, "rgba(161,44,146,0.14)");
      g.addColorStop(1, "rgba(255,255,255,0)");

      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
  }

  function drawFog() {
    ctx.drawImage(fogCanvas, 0, 0);
  }

  function drawCelebration() {
    if (!celebrationOn) return;

    const t = (performance.now() - lastCelebrationAt) / 1000;
    const alpha = clamp(1 - t / 1.2, 0, 1);

    if (alpha <= 0) {
      celebrationOn = false;
      return;
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.textAlign = "center";
    ctx.font = "bold 48px Arial";
    ctx.fillStyle = "#0f2a44";
    ctx.fillText("You revealed BxCM!", W / 2, H * 0.16);
    ctx.restore();
  }

  function maybeCelebrate() {
    if (state.revealRatio > 0.62 && !celebrationOn) {
      celebrationOn = true;
      lastCelebrationAt = performance.now();
      playCelebrateSound();

      for (let i = 0; i < 80; i++) {
        spawnSparkle(rand(W * 0.25, W * 0.75), rand(H * 0.25, H * 0.7), rand(0.8, 1.6));
      }
    }
  }

  function drawDebugHUD() {
    if (!debugOn) return;

    ctx.save();
    ctx.fillStyle = "rgba(17,50,79,0.95)";
    ctx.font = "14px Arial";
    ctx.fillText(`Motion Energy: ${state.motionEnergy.toFixed(2)}`, 20, 68);
    ctx.fillText(`Reveal: ${(state.revealRatio * 100).toFixed(1)}%`, 20, 88);
    ctx.fillText(`Mode: ${state.mode === "AUTO" ? `AUTO · ${state.autoModeResolved}` : state.mode}`, 20, 108);
    ctx.restore();
  }

  // =========================================================
  // MAIN LOOP
  // =========================================================
  function animate() {
    if (!started) return;

    frameCount++;

    updateMotionAndWipe();

    if (frameCount % CONFIG.revealCheckEvery === 0) {
      updateRevealRatio();
      maybeCelebrate();
      updateModeBadge();
    }

    updateAudio();

    drawBackground();
    drawLogo();
    updateAndDrawSparkles();
    drawFog();
    drawCelebration();
    drawDebugHUD();

    fadeIntroIfNeeded(performance.now());

    animationId = requestAnimationFrame(animate);
  }

  // =========================================================
  // START / RESET
  // =========================================================
  async function startExperience() {
    if (started) return;

    if (startBtn) {
      startBtn.disabled = true;
      startBtn.textContent = "Starting...";
    }

    try {
      await resumeAudio();
      await startCamera(selectedDeviceId || (cameraSelect ? cameraSelect.value : undefined));

      buildFog(true);
      renderLogoLayer();

      started = true;
      experienceStartedAt = performance.now();
      scheduleUIHide();
      animationId = requestAnimationFrame(animate);

      if (startBtn) {
        startBtn.textContent = "Running";
      }
    } catch (err) {
      console.error(err);
      if (startBtn) {
        startBtn.disabled = false;
        startBtn.textContent = "Start";
      }
      alert("Could not start the camera. Check permissions and reload.");
    }
  }

  function resetExperience() {
    buildFog(true);
    renderLogoLayer();
    sparkles.length = 0;
    state.revealRatio = 0;
    state.motionEnergy = 0;
    celebrationOn = false;
  }

  // =========================================================
  // EVENTS
  // =========================================================
  if (startBtn) {
    startBtn.addEventListener("click", async () => {
      firstGestureActivated = true;
      await resumeAudio();
      await startExperience();
    });
  }

  if (burstBtn) {
    burstBtn.addEventListener("click", () => {
      // manual “burst” = punch a hole in the fog at center
      const radius = 120;
      fogCtx.save();
      fogCtx.globalCompositeOperation = "destination-out";
      fogCtx.beginPath();
      fogCtx.arc(W / 2, H / 2, radius, 0, Math.PI * 2);
      fogCtx.fillStyle = "rgba(0,0,0,1)";
      fogCtx.fill();
      fogCtx.restore();

      for (let i = 0; i < 30; i++) {
        spawnSparkle(W / 2, H / 2, 1.4);
      }
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      resetExperience();
      scheduleUIHide();
    });
  }

  if (debugBtn) {
    debugBtn.addEventListener("click", () => {
      debugOn = !debugOn;
      video.style.opacity = debugOn ? "0.18" : "0";
      if (debugBtn) debugBtn.textContent = debugOn ? "Debug: On" : "Debug: Off";
    });
  }

  if (cameraSelect) {
    cameraSelect.addEventListener("change", async () => {
      selectedDeviceId = cameraSelect.value;
      if (started) {
        try {
          await startCamera(selectedDeviceId);
        } catch (err) {
          console.error(err);
        }
      }
    });
  }

  if (modeSelect) {
    modeSelect.addEventListener("change", () => {
      state.mode = modeSelect.value;
      updateModeBadge();
      scheduleUIHide();
    });
  }

  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", async () => {
      try {
        await populateCameraList();
      } catch (err) {
        console.error(err);
      }
    });
  }

  window.addEventListener("keydown", (e) => {
    const key = e.key.toLowerCase();

    if (key === "r") resetExperience();
    if (key === "u") showUI();
    if (key === "h") hideUIForKiosk();
    if (key === "d") {
      debugOn = !debugOn;
      video.style.opacity = debugOn ? "0.18" : "0";
      if (debugBtn) debugBtn.textContent = debugOn ? "Debug: On" : "Debug: Off";
    }
  });

  document.addEventListener("pointerdown", async () => {
    if (!firstGestureActivated) {
      firstGestureActivated = true;
      await resumeAudio();
      if (!started) await startExperience();
    } else {
      await resumeAudio();
    }
  }, { passive: true });

  // =========================================================
  // INIT
  // =========================================================
  async function init() {
    try {
      const warmup = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      warmup.getTracks().forEach(t => t.stop());
    } catch (err) {
      console.warn("Warmup skipped:", err);
    }

    try {
      await populateCameraList();
    } catch (err) {
      console.error("Could not populate cameras:", err);
    }

    if (modeSelect) {
      modeSelect.value = "AUTO";
      state.mode = "AUTO";
      updateModeBadge();
    }

    try {
      initAudio();
    } catch (err) {
      console.warn(err);
    }

    // light auto-start attempt
    setTimeout(async () => {
      if (!started) {
        try {
          await startExperience();
        } catch (err) {
          console.warn("Auto-start blocked or failed:", err);
        }
      }
    }, 400);
  }

  init();
})();
