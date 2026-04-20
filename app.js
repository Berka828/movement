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
  const revealTypeSelect = document.getElementById("revealTypeSelect");
  const fogStyleSelect = document.getElementById("fogStyleSelect");
  const modeSelect = document.getElementById("modeSelect");
  const startBtn = document.getElementById("startBtn");
  const resetBtn = document.getElementById("resetBtn");
  const soundBtn = document.getElementById("soundBtn");
  const debugBtn = document.getElementById("debugBtn");

  // =========================================================
  // CONFIG
  // =========================================================
  const CONFIG = {
    logoPath: "bxcm-logo.png",
    imagePath: "reveal-image.jpg",
    videoPath: "reveal-video.mp4",

    cameraWidth: 640,
    cameraHeight: 480,

    diffWidth: 320,
    diffHeight: 240,
    diffStep: 6,
    diffThreshold: 34,

    eraseRadiusBase: 9,
    eraseRadiusMax: 24,
    eraseStrengthBase: 0.10,
    eraseStrengthMax: 0.18,

    fogReturnAlphaBase: 0.0105,

    revealCheckEvery: 10,
    autoHideMs: 5000,
    introFadeAfterMs: 8500
  };

  const BXCM_COLORS = [
    "#f8c400",
    "#f28c1b",
    "#1fa5dc",
    "#a12c92",
    "#4a9a3f",
    "#4b2ca3"
  ];

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
    revealType: "logo",
    fogStyle: "smoke",
    mode: "AUTO",
    autoModeResolved: "GLOW",
    motionEnergy: 0,
    revealRatio: 0,
    introVisible: true,
    soundEnabled: false
  };

  // =========================================================
  // ASSETS
  // =========================================================
  const logoImg = new Image();
  let logoReady = false;
  logoImg.onload = () => {
    logoReady = true;
    renderHiddenLayer();
  };
  logoImg.src = CONFIG.logoPath;

  const revealImg = new Image();
  let revealImgReady = false;
  revealImg.onload = () => {
    revealImgReady = true;
    renderHiddenLayer();
  };
  revealImg.src = CONFIG.imagePath;

  const revealVideo = document.createElement("video");
  revealVideo.src = CONFIG.videoPath;
  revealVideo.loop = true;
  revealVideo.muted = true;
  revealVideo.playsInline = true;
  revealVideo.crossOrigin = "anonymous";

  // =========================================================
  // OFFSCREEN CANVASES
  // =========================================================
  const diffCanvas = document.createElement("canvas");
  const diffCtx = diffCanvas.getContext("2d", { willReadFrequently: true });

  const fogCanvas = document.createElement("canvas");
  const fogCtx = fogCanvas.getContext("2d");

  const hiddenCanvas = document.createElement("canvas");
  const hiddenCtx = hiddenCanvas.getContext("2d");

  const revealSampleCanvas = document.createElement("canvas");
  const revealSampleCtx = revealSampleCanvas.getContext("2d", { willReadFrequently: true });

  let prevFrame = null;

  // =========================================================
  // AUDIO
  // =========================================================
  let audioCtx = null;
  let humOsc = null;
  let humGain = null;

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
    if (!audioCtx || !humOsc || !humGain) return;

    const master = state.soundEnabled ? 1 : 0;
    const e = state.motionEnergy;

    humOsc.frequency.setTargetAtTime(82 + e * 14, audioCtx.currentTime, 0.08);
    humGain.gain.setTargetAtTime((0.003 + e * 0.004) * master, audioCtx.currentTime, 0.12);
  }

  // =========================================================
  // UI HELPERS
  // =========================================================
  function updateSoundButton() {
    soundBtn.textContent = state.soundEnabled ? "Sound: On" : "Sound: Off";
  }

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
  // OVERLAYS
  // =========================================================
  const intro = document.createElement("div");
  intro.innerHTML = `
    <div id="bxcmIntroInner">
      <div class="museum">BRONX CHILDREN’S MUSEUM</div>
      <div class="big">REVEAL WHAT’S HIDDEN</div>
      <div class="line">Move your body to brush away the cover.</div>
      <div class="line">Try different reveal layers and fog styles.</div>
      <div class="line">Work together to uncover what’s underneath.</div>
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
    maxWidth: "980px"
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
        fontSize: "72px",
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

  // =========================================================
  // RESIZE
  // =========================================================
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

    hiddenCanvas.width = W;
    hiddenCanvas.height = H;

    revealSampleCanvas.width = 160;
    revealSampleCanvas.height = 90;

    buildFog(true);
    renderHiddenLayer();
  }

  window.addEventListener("resize", resize);
  resize();

  // =========================================================
  // MATH / UTILS
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

  function hexToRGBA(hex, alpha) {
    const h = hex.replace("#", "");
    const bigint = parseInt(h, 16);
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;
    return `rgba(${r},${g},${b},${alpha})`;
  }

  // =========================================================
  // CAMERA
  // =========================================================
  async function getCameras() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === "videoinput");
  }

  async function populateCameraList() {
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
  // MODES
  // =========================================================
  function resolveAutoMode() {
    const e = state.motionEnergy;
    const r = state.revealRatio;

    if (e > 0.72) return "STORM";
    if (r > 0.70) return "SPACE";
    if (e > 0.40) return "TWIN";
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
        eraseBoost: 1.22,
        returnAlphaBoost: 1.0,
        mirror: false
      };
    }

    if (mode === "TWIN") {
      return {
        eraseBoost: 1.0,
        returnAlphaBoost: 1.0,
        mirror: true
      };
    }

    if (mode === "SPACE") {
      return {
        eraseBoost: 0.82,
        returnAlphaBoost: 0.72,
        mirror: false
      };
    }

    return {
      eraseBoost: 0.95,
      returnAlphaBoost: 1.0,
      mirror: false
    };
  }

  // =========================================================
  // HIDDEN LAYER
  // =========================================================
  function drawCenteredAsset(drawFn, assetW, assetH) {
    const maxW = W * 0.72;
    const maxH = H * 0.44;
    const scale = Math.min(maxW / assetW, maxH / assetH);
    const drawW = assetW * scale;
    const drawH = assetH * scale;
    const x = (W - drawW) / 2;
    const y = (H - drawH) / 2;
    drawFn(x, y, drawW, drawH);
  }

  function renderHiddenLayer() {
    hiddenCtx.clearRect(0, 0, W, H);

    hiddenCtx.fillStyle = "#f8fbff";
    hiddenCtx.fillRect(0, 0, W, H);

    const gradA = hiddenCtx.createRadialGradient(W * 0.35, H * 0.4, 0, W * 0.35, H * 0.4, W * 0.45);
    gradA.addColorStop(0, "rgba(31,165,220,0.10)");
    gradA.addColorStop(1, "rgba(31,165,220,0)");
    hiddenCtx.fillStyle = gradA;
    hiddenCtx.fillRect(0, 0, W, H);

    const gradB = hiddenCtx.createRadialGradient(W * 0.68, H * 0.42, 0, W * 0.68, H * 0.42, W * 0.42);
    gradB.addColorStop(0, "rgba(161,44,146,0.08)");
    gradB.addColorStop(1, "rgba(161,44,146,0)");
    hiddenCtx.fillStyle = gradB;
    hiddenCtx.fillRect(0, 0, W, H);

    if (state.revealType === "logo") {
      if (logoReady) {
        hiddenCtx.save();
        hiddenCtx.shadowBlur = 28;
        hiddenCtx.shadowColor = "rgba(31,165,220,0.15)";
        drawCenteredAsset((x, y, w, h) => hiddenCtx.drawImage(logoImg, x, y, w, h), logoImg.width, logoImg.height);
        hiddenCtx.restore();
        drawCenteredAsset((x, y, w, h) => hiddenCtx.drawImage(logoImg, x, y, w, h), logoImg.width, logoImg.height);
      } else {
        hiddenCtx.fillStyle = "#0f2a44";
        hiddenCtx.font = "bold 84px Arial";
        hiddenCtx.textAlign = "center";
        hiddenCtx.fillText("BxCM", W / 2, H / 2);
      }
      return;
    }

    if (state.revealType === "image") {
      if (revealImgReady) {
        hiddenCtx.save();
        hiddenCtx.shadowBlur = 24;
        hiddenCtx.shadowColor = "rgba(31,165,220,0.12)";
        drawCenteredAsset((x, y, w, h) => hiddenCtx.drawImage(revealImg, x, y, w, h), revealImg.width, revealImg.height);
        hiddenCtx.restore();
      } else {
        hiddenCtx.fillStyle = "#0f2a44";
        hiddenCtx.font = "bold 54px Arial";
        hiddenCtx.textAlign = "center";
        hiddenCtx.fillText("Add reveal-image.jpg", W / 2, H / 2);
      }
      return;
    }

    if (state.revealType === "video") {
      if (revealVideo.readyState >= 2) {
        const vw = revealVideo.videoWidth || 1920;
        const vh = revealVideo.videoHeight || 1080;
        drawCenteredAsset((x, y, w, h) => hiddenCtx.drawImage(revealVideo, x, y, w, h), vw, vh);
      } else {
        hiddenCtx.fillStyle = "#0f2a44";
        hiddenCtx.font = "bold 54px Arial";
        hiddenCtx.textAlign = "center";
        hiddenCtx.fillText("Add reveal-video.mp4", W / 2, H / 2);
      }
    }
  }

  // =========================================================
  // FOG BUILD
  // =========================================================
  function buildFog(fullReset = false) {
    if (fullReset) {
      fogCtx.clearRect(0, 0, W, H);

      if (state.fogStyle === "frosted") {
        fogCtx.fillStyle = "rgba(255,255,255,0.985)";
      } else if (state.fogStyle === "dust") {
        fogCtx.fillStyle = "rgba(252,250,246,0.995)";
      } else {
        fogCtx.fillStyle = "rgba(255,255,255,0.995)";
      }

      fogCtx.fillRect(0, 0, W, H);
    }

    if (state.fogStyle === "smoke") {
      for (let i = 0; i < 34; i++) {
        const x = rand(0, W);
        const y = rand(0, H);
        const r = rand(70, 220);
        const g = fogCtx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, "rgba(255,255,255,0.22)");
        g.addColorStop(0.55, "rgba(246,249,255,0.10)");
        g.addColorStop(1, "rgba(255,255,255,0)");
        fogCtx.fillStyle = g;
        fogCtx.beginPath();
        fogCtx.arc(x, y, r, 0, Math.PI * 2);
        fogCtx.fill();
      }
      return;
    }

    if (state.fogStyle === "dust") {
      for (let i = 0; i < 2600; i++) {
        const x = rand(0, W);
        const y = rand(0, H);
        const s = rand(0.5, 2.2);
        fogCtx.fillStyle = `rgba(210, 200, 185, ${rand(0.02, 0.08)})`;
        fogCtx.beginPath();
        fogCtx.arc(x, y, s, 0, Math.PI * 2);
        fogCtx.fill();
      }
      return;
    }

    if (state.fogStyle === "frosted") {
      for (let i = 0; i < 90; i++) {
        const x = rand(0, W);
        const y = rand(0, H);
        const w = rand(80, 180);
        const h = rand(18, 44);
        fogCtx.save();
        fogCtx.translate(x, y);
        fogCtx.rotate(rand(-0.8, 0.8));
        fogCtx.fillStyle = `rgba(255,255,255,${rand(0.04, 0.09)})`;
        fogCtx.fillRect(-w / 2, -h / 2, w, h);
        fogCtx.restore();
      }
    }
  }

  // =========================================================
  // SOFT WIPE BLOOMS
  // =========================================================
  const blooms = [];

  function spawnBloom(x, y, strength = 1) {
    if (blooms.length > 120) return;
    blooms.push({
      x,
      y,
      r: rand(14, 40) * strength,
      life: rand(18, 40),
      maxLife: 0,
      color: pick(BXCM_COLORS)
    });
    blooms[blooms.length - 1].maxLife = blooms[blooms.length - 1].life;
  }

  function updateAndDrawBlooms() {
    for (let i = blooms.length - 1; i >= 0; i--) {
      const b = blooms[i];
      b.life -= 1;
      b.r *= 1.01;

      if (b.life <= 0) {
        blooms.splice(i, 1);
        continue;
      }

      const alpha = (b.life / b.maxLife) * 0.20;
      const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
      g.addColorStop(0, hexToRGBA(b.color, alpha));
      g.addColorStop(1, "rgba(255,255,255,0)");

      ctx.save();
      ctx.globalCompositeOperation = "multiply";
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // =========================================================
  // MOTION + WIPE
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

    const returnAlpha = CONFIG.fogReturnAlphaBase * params.returnAlphaBoost;

    fogCtx.save();
    fogCtx.globalCompositeOperation = "source-over";

    if (state.fogStyle === "dust") {
      fogCtx.fillStyle = `rgba(252,250,246,${returnAlpha})`;
    } else {
      fogCtx.fillStyle = `rgba(255,255,255,${returnAlpha})`;
    }

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

          const strength = clamp(
            mapRange(diff, CONFIG.diffThreshold, 180, 0.18, 1.0),
            0.18,
            1.0
          );

          const radius =
            (CONFIG.eraseRadiusBase +
              strength * (CONFIG.eraseRadiusMax - CONFIG.eraseRadiusBase)) *
            params.eraseBoost;

          const eraseAlpha = lerp(CONFIG.eraseStrengthBase, CONFIG.eraseStrengthMax, strength);

          fogCtx.save();
          fogCtx.globalCompositeOperation = "destination-out";
          fogCtx.beginPath();
          fogCtx.arc(screenX, screenY, radius, 0, Math.PI * 2);
          fogCtx.fillStyle = `rgba(0,0,0,${eraseAlpha})`;
          fogCtx.fill();
          fogCtx.restore();

          // edge treatment based on fog style
          if (state.fogStyle === "smoke") {
            fogCtx.save();
            fogCtx.globalCompositeOperation = "source-over";
            const glow = fogCtx.createRadialGradient(screenX, screenY, 0, screenX, screenY, radius * 1.8);
            glow.addColorStop(0, hexToRGBA(pick(BXCM_COLORS), 0.028));
            glow.addColorStop(1, "rgba(255,255,255,0)");
            fogCtx.fillStyle = glow;
            fogCtx.beginPath();
            fogCtx.arc(screenX, screenY, radius * 1.8, 0, Math.PI * 2);
            fogCtx.fill();
            fogCtx.restore();
          } else if (state.fogStyle === "dust") {
            if (Math.random() < 0.18) {
              spawnBloom(screenX, screenY, strength * 0.9);
            }
          } else if (state.fogStyle === "frosted") {
            fogCtx.save();
            fogCtx.globalCompositeOperation = "destination-out";
            fogCtx.beginPath();
            fogCtx.arc(screenX, screenY, radius * 0.55, 0, Math.PI * 2);
            fogCtx.fillStyle = `rgba(0,0,0,${eraseAlpha * 0.35})`;
            fogCtx.fill();
            fogCtx.restore();
          }

          if (params.mirror) {
            const mx = W - screenX;
            fogCtx.save();
            fogCtx.globalCompositeOperation = "destination-out";
            fogCtx.beginPath();
            fogCtx.arc(mx, screenY, radius * 0.95, 0, Math.PI * 2);
            fogCtx.fillStyle = `rgba(0,0,0,${eraseAlpha * 0.92})`;
            fogCtx.fill();
            fogCtx.restore();
          }
        }
      }
    }

    prevFrame.set(data);

    const energyNorm = active > 0
      ? clamp(mapRange(energyAccum / Math.max(active, 1), CONFIG.diffThreshold, 180, 0.08, 1.0), 0, 1)
      : 0;

    state.motionEnergy = lerp(state.motionEnergy, energyNorm, 0.12);
  }

  // =========================================================
  // REVEAL CHECK
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
      if (alpha < 0.30) visibleCount++;
    }

    state.revealRatio = visibleCount / total;
  }

  function maybeCelebrate() {
    if (state.revealRatio > 0.80 && !celebrationOn) {
      celebrationOn = true;
      lastCelebrationAt = performance.now();
    }
  }

  // =========================================================
  // DRAW
  // =========================================================
  function drawBackground() {
    ctx.fillStyle = "#f8fbff";
    ctx.fillRect(0, 0, W, H);
  }

  function drawHiddenLayer() {
    // keep video fresh if needed
    if (state.revealType === "video" && revealVideo.readyState >= 2) {
      renderHiddenLayer();
    }

    ctx.drawImage(hiddenCanvas, 0, 0);

    const reveal = state.revealRatio;
    if (reveal > 0.18) {
      ctx.save();
      ctx.globalAlpha = clamp(reveal * 0.18, 0, 0.15);

      const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.35);
      g.addColorStop(0, "rgba(31,165,220,0.18)");
      g.addColorStop(0.45, "rgba(161,44,146,0.10)");
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
    const alpha = clamp(1 - t / 1.4, 0, 1);

    if (alpha <= 0) {
      celebrationOn = false;
      return;
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.textAlign = "center";
    ctx.font = "bold 44px Arial";
    ctx.fillStyle = "#0f2a44";
    ctx.fillText("Revealed!", W / 2, H * 0.16);
    ctx.restore();
  }

  function drawDebugHUD() {
    if (!debugOn) return;

    ctx.save();
    ctx.fillStyle = "rgba(17,50,79,0.95)";
    ctx.font = "14px Arial";
    ctx.fillText(`Motion Energy: ${state.motionEnergy.toFixed(2)}`, 20, 68);
    ctx.fillText(`Reveal: ${(state.revealRatio * 100).toFixed(1)}%`, 20, 88);
    ctx.fillText(`Reveal Type: ${state.revealType}`, 20, 108);
    ctx.fillText(`Fog Style: ${state.fogStyle}`, 20, 128);
    ctx.fillText(`Mode: ${state.mode === "AUTO" ? `AUTO · ${state.autoModeResolved}` : state.mode}`, 20, 148);
    ctx.fillText(`Sound: ${state.soundEnabled ? "On" : "Off"}`, 20, 168);
    ctx.restore();
  }

  // =========================================================
  // LOOP
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
    drawHiddenLayer();
    updateAndDrawBlooms();
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

    startBtn.disabled = true;
    startBtn.textContent = "Starting...";

    try {
      await resumeAudio();
      await startCamera(selectedDeviceId || cameraSelect.value);

      try {
        await revealVideo.play();
      } catch (_) {
        // ignore autoplay block
      }

      buildFog(true);
      renderHiddenLayer();

      started = true;
      experienceStartedAt = performance.now();
      scheduleUIHide();
      animationId = requestAnimationFrame(animate);

      startBtn.textContent = "Running";
    } catch (err) {
      console.error(err);
      startBtn.disabled = false;
      startBtn.textContent = "Start";
      alert("Could not start the camera. Check permissions and reload.");
    }
  }

  function resetExperience() {
    buildFog(true);
    renderHiddenLayer();
    blooms.length = 0;
    state.revealRatio = 0;
    state.motionEnergy = 0;
    celebrationOn = false;
  }

  // =========================================================
  // EVENTS
  // =========================================================
  startBtn.addEventListener("click", async () => {
    firstGestureActivated = true;
    await resumeAudio();
    await startExperience();
  });

  resetBtn.addEventListener("click", () => {
    resetExperience();
    scheduleUIHide();
  });

  soundBtn.addEventListener("click", async () => {
    await resumeAudio();
    state.soundEnabled = !state.soundEnabled;
    updateSoundButton();
    scheduleUIHide();
  });

  debugBtn.addEventListener("click", () => {
    debugOn = !debugOn;
    video.style.opacity = debugOn ? "0.18" : "0";
    debugBtn.textContent = debugOn ? "Debug: On" : "Debug: Off";
  });

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

  revealTypeSelect.addEventListener("change", async () => {
    state.revealType = revealTypeSelect.value;
    renderHiddenLayer();

    if (state.revealType === "video") {
      try {
        await revealVideo.play();
      } catch (_) {}
    }

    scheduleUIHide();
  });

  fogStyleSelect.addEventListener("change", () => {
    state.fogStyle = fogStyleSelect.value;
    buildFog(true);
    scheduleUIHide();
  });

  modeSelect.addEventListener("change", () => {
    state.mode = modeSelect.value;
    updateModeBadge();
    scheduleUIHide();
  });

  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", async () => {
      try {
        await populateCameraList();
      } catch (err) {
        console.error(err);
      }
    });
  }

  window.addEventListener("keydown", async (e) => {
    const key = e.key.toLowerCase();

    if (key === "r") resetExperience();
    if (key === "u") showUI();
    if (key === "h") hideUIForKiosk();
    if (key === "m") {
      await resumeAudio();
      state.soundEnabled = !state.soundEnabled;
      updateSoundButton();
    }
    if (key === "d") {
      debugOn = !debugOn;
      video.style.opacity = debugOn ? "0.18" : "0";
      debugBtn.textContent = debugOn ? "Debug: On" : "Debug: Off";
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

    state.revealType = "logo";
    state.fogStyle = "smoke";
    state.mode = "AUTO";
    state.soundEnabled = false;

    revealTypeSelect.value = state.revealType;
    fogStyleSelect.value = state.fogStyle;
    modeSelect.value = state.mode;

    updateModeBadge();
    updateSoundButton();

    try {
      initAudio();
    } catch (err) {
      console.warn(err);
    }

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
