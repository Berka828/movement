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
  const startBtn = document.getElementById("startBtn");
  const burstBtn = document.getElementById("burstBtn");
  const resetBtn = document.getElementById("resetBtn");
  const debugBtn = document.getElementById("debugBtn");

  // =========================================================
  // CONFIG
  // =========================================================
  const CONFIG = {
    particleCount: 1800,
    backgroundFade: 0.085,
    dragBase: 0.965,
    baseLineWidth: 1.0,
    maxSpeedBase: 4.2,
    targetPullBase: 0.010,
    swirlBase: 0.014,
    noiseScaleBase: 0.006,
    noiseStrengthBase: 0.40,
    spreadBase: 90,
    burstCount: 280,
    burstForce: 6.2,
    poseSmoothing: 0.16,
    energySmoothing: 0.10,
    spreadSmoothing: 0.12,
    shoulderConfidence: 0.25,
    wristConfidence: 0.20,
    defaultEnergy: 0.08,
    minHandDistance: 40,
    maxHandDistance: 380,
    opticalFallbackThreshold: 32,
    opticalFallbackStep: 10,
    opticalFallbackMinActive: 55,
    debugVideoOpacity: 0.18,
    stateHoldMs: 1200,
    burstCooldownMs: 900,
    idleStillnessThreshold: 14,
    bigGestureThreshold: 150,
    kioskHideDelayMs: 5000,
    instructionFadeAfterMs: 9000,
    instructionPulseSpeed: 0.002
  };

  // =========================================================
  // STATE
  // =========================================================
  let W = window.innerWidth;
  let H = window.innerHeight;
  let DPR = Math.min(window.devicePixelRatio || 1, 2);

  let animationId = null;
  let stream = null;
  let detector = null;
  let detectorReady = false;
  let started = false;
  let debugOn = false;
  let selectedDeviceId = null;
  let lastTime = performance.now();
  let lastBurstAt = 0;
  let kioskMode = false;
  let uiHideTimeout = null;
  let experienceStartedAt = 0;
  let firstGestureActivated = false;

  const state = {
    targetX: W * 0.5,
    targetY: H * 0.5,
    rawTargetX: W * 0.5,
    rawTargetY: H * 0.5,
    prevRawTargetX: W * 0.5,
    prevRawTargetY: W * 0.5,
    velocityMag: 0,
    energy: 0.1,
    rawEnergy: 0.1,
    spread: 0.25,
    rawSpread: 0.25,
    leftHandYNorm: 0.5,
    rightHandXNorm: 0.5,
    rightHandYNorm: 0.5,
    activePose: false,
    burstRequested: false,
    wristLeft: null,
    wristRight: null,
    shoulderCenter: null,
    handsUp: false,
    handsWide: false,
    bigGesture: false,
    stillness: 0,
    currentMode: "CALM",
    modeSince: performance.now(),
    mirrorActive: false,
    galaxySpin: 0,
    lastPoseSeenAt: 0
  };

  // motion fallback
  let prevFrame = null;
  const motionCanvas = document.createElement("canvas");
  const motionCtx = motionCanvas.getContext("2d", { willReadFrequently: true });

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

  function dist(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function nowMs() {
    return performance.now();
  }

  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    DPR = Math.min(window.devicePixelRatio || 1, 2);

    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    motionCanvas.width = 320;
    motionCanvas.height = 240;
  }

  window.addEventListener("resize", resize);
  resize();

  // =========================================================
  // EXTRA OVERLAYS
  // =========================================================
  const instructionOverlay = document.createElement("div");
  instructionOverlay.id = "instructionOverlay";
  instructionOverlay.innerHTML = `
  <div id="instructionInner">
    <div class="line museum">BRONX CHILDREN’S MUSEUM</div>
    <div class="line big">MOVE THE ENERGY</div>
    <div class="line">Use your body to explore light, motion, color, and sound.</div>
    <div class="line">Move one hand to guide the flow.</div>
    <div class="line">Lift your hands to brighten the energy.</div>
    <div class="line">Stretch wide to discover new modes.</div>
    <div class="line">Fast movement creates bigger reactions.</div>
  </div>
`;
  document.body.appendChild(instructionOverlay);

  Object.assign(instructionOverlay.style, {
    position: "fixed",
    inset: "0",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    pointerEvents: "none",
    zIndex: "30",
    transition: "opacity 0.8s ease",
    opacity: "1"
  });

  const instructionInner = instructionOverlay.querySelector("#instructionInner");
  Object.assign(instructionInner.style, {
    color: "white",
    textAlign: "center",
    fontFamily: "Arial, sans-serif",
    textShadow: "0 0 12px rgba(0,0,0,0.6), 0 0 28px rgba(0,120,255,0.35)",
    letterSpacing: "1px",
    maxWidth: "900px",
    padding: "24px"
  });

 Array.from(instructionInner.querySelectorAll(".line")).forEach((line, index) => {
  let fontSize = "22px";
  let fontWeight = "500";
  let color = "#ffffff";
  let margin = "10px 0";

  if (line.classList.contains("museum")) {
    fontSize = "16px";
    fontWeight = "700";
    color = "#8fe9ff";
    margin = "0 0 10px 0";
    line.style.letterSpacing = "2px";
  }

  if (line.classList.contains("big")) {
    fontSize = "76px";
    fontWeight = "800";
    color = "#ffffff";
    margin = "0 0 18px 0";
    line.style.lineHeight = "0.95";
    line.style.textShadow = "0 0 24px rgba(0,184,255,0.22), 0 0 30px rgba(255,0,140,0.12)";
  }

  Object.assign(line.style, {
    margin,
    fontSize,
    fontWeight,
    color
  });
});

  const modeBadge = document.createElement("div");
  modeBadge.id = "modeBadge";
  modeBadge.textContent = "MODE: CALM";
  document.body.appendChild(modeBadge);

Object.assign(modeBadge.style, {
  position: "fixed",
  left: "20px",
  top: "20px",
  zIndex: "25",
  color: "#ffffff",
  fontFamily: "Arial, sans-serif",
  fontSize: "15px",
  letterSpacing: "1px",
  padding: "10px 16px",
  borderRadius: "999px",
  background: "linear-gradient(180deg, rgba(0,184,255,0.24), rgba(255,0,140,0.16))",
  border: "1px solid rgba(255,255,255,0.12)",
  backdropFilter: "blur(6px)",
  boxShadow: "0 0 20px rgba(0,184,255,0.12)",
  opacity: "0.95",
  transition: "opacity 0.5s ease"
});

  // =========================================================
  // VIDEO STYLE
  // =========================================================
  function updateDebugUI() {
    video.style.opacity = debugOn ? String(CONFIG.debugVideoOpacity) : "0";
    video.style.pointerEvents = "none";
    video.style.transform = "scaleX(-1)";
    video.style.position = "fixed";
    video.style.right = "20px";
    video.style.bottom = "20px";
    video.style.width = "220px";
    video.style.height = "165px";
    video.style.objectFit = "cover";
    video.style.borderRadius = "14px";
    video.style.zIndex = "22";
    video.style.boxShadow = "0 0 20px rgba(0,0,0,0.3)";
    if (debugBtn) {
      debugBtn.textContent = debugOn ? "Debug: On" : "Debug: Off";
    }
  }

  updateDebugUI();

  // =========================================================
  // AUDIO
  // =========================================================
  let audioCtx = null;
  let humOsc = null;
  let humGain = null;
  let energyOsc = null;
  let energyGain = null;
  let filterNode = null;

  function initAudio() {
    if (audioCtx) return;

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    audioCtx = new AudioContextClass();

    humOsc = audioCtx.createOscillator();
    humGain = audioCtx.createGain();
    filterNode = audioCtx.createBiquadFilter();
    energyOsc = audioCtx.createOscillator();
    energyGain = audioCtx.createGain();

    humOsc.type = "sine";
    humOsc.frequency.value = 72;

    filterNode.type = "lowpass";
    filterNode.frequency.value = 500;
    filterNode.Q.value = 0.8;

    humGain.gain.value = 0.0001;

    energyOsc.type = "triangle";
    energyOsc.frequency.value = 180;
    energyGain.gain.value = 0.0001;

    humOsc.connect(filterNode);
    filterNode.connect(humGain);
    humGain.connect(audioCtx.destination);

    energyOsc.connect(energyGain);
    energyGain.connect(audioCtx.destination);

    humOsc.start();
    energyOsc.start();
  }

  async function resumeAudio() {
    if (!audioCtx) initAudio();
    if (audioCtx && audioCtx.state === "suspended") {
      try {
        await audioCtx.resume();
      } catch (err) {
        console.warn("Audio resume failed:", err);
      }
    }
  }

  function updateAudio() {
    if (!audioCtx || !humOsc || !humGain || !energyOsc || !energyGain || !filterNode) return;

    const e = state.energy;
    const brightness = 1 - state.leftHandYNorm;
    const idleAmt = clamp(1 - e * 2.5, 0, 1);

    humOsc.frequency.setTargetAtTime(65 + idleAmt * 18, audioCtx.currentTime, 0.08);
    humGain.gain.setTargetAtTime(0.01 + idleAmt * 0.02, audioCtx.currentTime, 0.12);

    energyOsc.frequency.setTargetAtTime(170 + e * 420 + brightness * 120, audioCtx.currentTime, 0.05);
    energyGain.gain.setTargetAtTime(0.001 + e * 0.035, audioCtx.currentTime, 0.08);

    filterNode.frequency.setTargetAtTime(350 + e * 900, audioCtx.currentTime, 0.08);
  }

  function playBurstSound() {
    if (!audioCtx) return;

    const t = audioCtx.currentTime;

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const filter = audioCtx.createBiquadFilter();

    osc.type = "square";
    osc.frequency.setValueAtTime(240, t);
    osc.frequency.exponentialRampToValueAtTime(75, t + 0.18);

    filter.type = "bandpass";
    filter.frequency.value = 800;
    filter.Q.value = 1.2;

    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.07, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(audioCtx.destination);

    osc.start(t);
    osc.stop(t + 0.25);
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
      stream.getTracks().forEach(track => track.stop());
      stream = null;
    }

    const constraints = {
      audio: false,
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30, max: 30 }
      }
    };

    stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;
    await video.play();

    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings();
    if (settings.deviceId) {
      selectedDeviceId = settings.deviceId;
    }

    await populateCameraList();
  }

  // =========================================================
  // TENSORFLOW
  // =========================================================
  async function initDetector() {
    if (!window.poseDetection) {
      throw new Error("pose-detection library not loaded.");
    }

    await tf.setBackend("webgl");
    await tf.ready();

    detector = await poseDetection.createDetector(
      poseDetection.SupportedModels.MoveNet,
      {
        modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
        enableSmoothing: true
      }
    );

    detectorReady = true;
  }

  function getKeypoint(pose, name, minScore = 0.2) {
    if (!pose || !pose.keypoints) return null;
    const kp = pose.keypoints.find(k => k.name === name);
    if (!kp) return null;
    if ((kp.score ?? 0) < minScore) return null;
    return kp;
  }

  // =========================================================
  // PARTICLES
  // =========================================================
  class Particle {
    constructor() {
      this.reset(Math.random() * W, Math.random() * H);
    }

    reset(x, y) {
      this.x = x;
      this.y = y;
      this.px = x;
      this.py = y;
      this.vx = (Math.random() - 0.5) * 1.2;
      this.vy = (Math.random() - 0.5) * 1.2;
      this.life = Math.random() * 180 + 60;
      this.seed = Math.random() * 1000;
      this.width = Math.random();
    }

    update(dt, t) {
      this.px = this.x;
      this.py = this.y;

      const dx = state.targetX - this.x;
      const dy = state.targetY - this.y;
      const d = Math.sqrt(dx * dx + dy * dy) + 0.0001;
      const nx = dx / d;
      const ny = dy / d;

      const mode = state.currentMode;
      const speedHeat = clamp(state.velocityMag / 180, 0, 1);
      const leftHigh = 1 - state.leftHandYNorm;

      let drag = CONFIG.dragBase;
      let swirl = CONFIG.swirlBase + state.energy * 0.03;
      let targetPull = CONFIG.targetPullBase + state.energy * 0.018;
      let maxSpeed = CONFIG.maxSpeedBase + state.energy * 5.0;
      let noiseScale = CONFIG.noiseScaleBase + state.spread * 0.008;
      let noiseStrength = CONFIG.noiseStrengthBase + leftHigh * 0.9 + state.energy * 0.7;
      let orbitBoost = 1;
      let galaxySpiral = 0;

      if (mode === "CALM") {
        drag = 0.975;
        swirl *= 0.65;
        targetPull *= 0.9;
        noiseStrength *= 0.55;
        maxSpeed *= 0.85;
      } else if (mode === "CHAOS") {
        drag = 0.952;
        swirl *= 1.9;
        targetPull *= 1.4;
        noiseStrength *= 1.9;
        maxSpeed *= 1.6;
      } else if (mode === "MIRROR") {
        drag = 0.967;
        swirl *= 1.2;
        targetPull *= 1.05;
        noiseStrength *= 0.9;
        orbitBoost = 1.35;
      } else if (mode === "GALAXY") {
        drag = 0.971;
        swirl *= 1.35;
        targetPull *= 0.72;
        noiseStrength *= 0.65;
        maxSpeed *= 0.95;
        galaxySpiral = 0.04;
      }

      const angle = Math.atan2(dy, dx);
      const tangentialX = -Math.sin(angle) * swirl * 18 * orbitBoost / (1 + d * 0.01);
      const tangentialY =  Math.cos(angle) * swirl * 18 * orbitBoost / (1 + d * 0.01);

      const noise =
        Math.sin(this.x * noiseScale + t * 0.0007 + this.seed) +
        Math.cos(this.y * noiseScale - t * 0.0009 + this.seed * 0.7);

      const noiseX = Math.cos(noise + angle * 0.7) * noiseStrength * 0.09;
      const noiseY = Math.sin(noise - angle * 0.7) * noiseStrength * 0.09;

      const spiralX = Math.cos(angle + state.galaxySpin) * galaxySpiral;
      const spiralY = Math.sin(angle + state.galaxySpin) * galaxySpiral;

      this.vx += nx * targetPull + tangentialX + noiseX + spiralX;
      this.vy += ny * targetPull + tangentialY + noiseY + spiralY;

      if (mode === "MIRROR" && this.x > W * 0.5) {
        this.vx -= (this.x - W * 0.5) * 0.0008;
      }

      this.vx *= drag;
      this.vy *= drag;

      const speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
      if (speed > maxSpeed) {
        const m = maxSpeed / speed;
        this.vx *= m;
        this.vy *= m;
      }

      this.x += this.vx * dt * 60;
      this.y += this.vy * dt * 60;

      this.life -= dt * 60;

      if (
        this.life <= 0 ||
        this.x < -120 || this.x > W + 120 ||
        this.y < -120 || this.y > H + 120
      ) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * (CONFIG.spreadBase + state.spread * 240);
        this.reset(
          state.targetX + Math.cos(a) * r,
          state.targetY + Math.sin(a) * r
        );
      }
    }

    draw(t) {
      const dx = this.x - this.px;
      const dy = this.y - this.py;
      const speed = Math.sqrt(dx * dx + dy * dy);
      const moveHeat = clamp(speed / 5.5, 0, 1);
      const handBright = 1 - state.leftHandYNorm;

      let hue;
      let sat = 100;
      let light = 58 + state.energy * 16 + handBright * 12;

      if (state.currentMode === "CALM") {
        hue = 210 + moveHeat * 25 + this.seed * 8;
        sat = 85;
        light = 52 + handBright * 8 + moveHeat * 6;
      } else if (state.currentMode === "CHAOS") {
        hue = 18 + moveHeat * 35 + handBright * 18 + (t * 0.04 + this.seed * 40) % 30;
        sat = 100;
        light = 55 + handBright * 18 + moveHeat * 14;
      } else if (state.currentMode === "MIRROR") {
        hue = 290 + moveHeat * 35 + this.seed * 16;
        sat = 90;
        light = 58 + handBright * 10;
      } else {
        hue = 220 + state.galaxySpin * 100 + this.seed * 28;
        sat = 95;
        light = 55 + handBright * 12 + moveHeat * 8;
      }

      const alpha = clamp(0.05 + speed * 0.03 + state.energy * 0.14, 0.03, 0.38);
      const lw =
        CONFIG.baseLineWidth +
        this.width * 0.8 +
        state.spread * 1.8 +
        speed * 0.03;

      ctx.strokeStyle = `hsla(${hue % 360}, ${sat}%, ${light}%, ${alpha})`;
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(this.px, this.py);
      ctx.lineTo(this.x, this.y);
      ctx.stroke();

      if (state.currentMode === "MIRROR") {
        const mx1 = W - this.px;
        const mx2 = W - this.x;
        ctx.strokeStyle = `hsla(${(hue + 18) % 360}, ${sat}%, ${light}%, ${alpha * 0.72})`;
        ctx.beginPath();
        ctx.moveTo(mx1, this.py);
        ctx.lineTo(mx2, this.y);
        ctx.stroke();
      }
    }
  }

  const particles = Array.from({ length: CONFIG.particleCount }, () => new Particle());

  function burstAt(x, y) {
    for (let i = 0; i < CONFIG.burstCount; i++) {
      const p = particles[(Math.random() * particles.length) | 0];
      const a = Math.random() * Math.PI * 2;
      const f = Math.random() * CONFIG.burstForce + 1.0;

      p.x = x;
      p.y = y;
      p.px = x;
      p.py = y;
      p.vx = Math.cos(a) * f;
      p.vy = Math.sin(a) * f;
      p.life = Math.random() * 100 + 60;
    }
  }

  function resetParticles() {
    for (const p of particles) {
      p.reset(Math.random() * W, Math.random() * H);
    }
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, W, H);
  }

  // =========================================================
  // MODE CONTROL
  // =========================================================
  function setMode(mode) {
    if (state.currentMode === mode) return;
    state.currentMode = mode;
    state.modeSince = nowMs();
    modeBadge.textContent = `MODE: ${mode}`;
  }

  function updateModeLogic() {
    const t = nowMs();
    const heldLongEnough = (t - state.modeSince) > CONFIG.stateHoldMs;

    if (state.handsWide) {
      setMode("MIRROR");
      return;
    }

    if (state.bigGesture) {
      setMode("CHAOS");
      return;
    }

    if (state.handsUp) {
      setMode("CALM");
      return;
    }

    if (state.stillness > 0.75) {
      setMode("GALAXY");
      return;
    }

    if (!heldLongEnough && state.currentMode !== "CALM") return;

    if (state.energy < 0.22) setMode("CALM");
    else if (state.energy > 0.62) setMode("CHAOS");
    else setMode("CALM");
  }

  // =========================================================
  // POSE INPUT
  // =========================================================
  async function updatePoseInput() {
    if (!detectorReady || !video.videoWidth || !video.videoHeight) {
      state.activePose = false;
      return false;
    }

    let poses = [];
    try {
      poses = await detector.estimatePoses(video, { flipHorizontal: true });
    } catch (err) {
      console.error("Pose estimation error:", err);
      state.activePose = false;
      return false;
    }

    if (!poses || !poses.length) {
      state.activePose = false;
      return false;
    }

    const pose = poses[0];

    const leftWrist = getKeypoint(pose, "left_wrist", CONFIG.wristConfidence);
    const rightWrist = getKeypoint(pose, "right_wrist", CONFIG.wristConfidence);
    const leftShoulder = getKeypoint(pose, "left_shoulder", CONFIG.shoulderConfidence);
    const rightShoulder = getKeypoint(pose, "right_shoulder", CONFIG.shoulderConfidence);
    const nose = getKeypoint(pose, "nose", 0.2);

    if (!leftShoulder || !rightShoulder) {
      state.activePose = false;
      return false;
    }

    const shoulderCenter = {
      x: (leftShoulder.x + rightShoulder.x) * 0.5,
      y: (leftShoulder.y + rightShoulder.y) * 0.5
    };

    state.shoulderCenter = {
      x: mapRange(shoulderCenter.x, 0, video.videoWidth, W, 0),
      y: mapRange(shoulderCenter.y, 0, video.videoHeight, 0, H)
    };

    let primaryX = shoulderCenter.x;
    let primaryY = shoulderCenter.y;

    if (rightWrist) {
      primaryX = rightWrist.x;
      primaryY = rightWrist.y;
      state.rightHandXNorm = clamp(rightWrist.x / video.videoWidth, 0, 1);
      state.rightHandYNorm = clamp(rightWrist.y / video.videoHeight, 0, 1);
      state.wristRight = {
        x: mapRange(rightWrist.x, 0, video.videoWidth, W, 0),
        y: mapRange(rightWrist.y, 0, video.videoHeight, 0, H)
      };
    } else {
      state.wristRight = null;
    }

    if (leftWrist) {
      state.leftHandYNorm = clamp(leftWrist.y / video.videoHeight, 0, 1);
      state.wristLeft = {
        x: mapRange(leftWrist.x, 0, video.videoWidth, W, 0),
        y: mapRange(leftWrist.y, 0, video.videoHeight, 0, H)
      };
    } else {
      state.wristLeft = null;
      state.leftHandYNorm = 0.5;
    }

    state.rawTargetX = mapRange(primaryX, 0, video.videoWidth, W, 0);
    state.rawTargetY = mapRange(primaryY, 0, video.videoHeight, 0, H);

    const dx = state.rawTargetX - state.prevRawTargetX;
    const dy = state.rawTargetY - state.prevRawTargetY;
    state.velocityMag = lerp(state.velocityMag, Math.sqrt(dx * dx + dy * dy), 0.22);
    state.prevRawTargetX = state.rawTargetX;
    state.prevRawTargetY = state.rawTargetY;

    let spread = 0.22;
    let handsWide = false;
    let handsUp = false;

    if (leftWrist && rightWrist) {
      const handDistance = dist(leftWrist, rightWrist);
      spread = mapRange(
        handDistance,
        CONFIG.minHandDistance,
        CONFIG.maxHandDistance,
        0.08,
        1.0
      );
      handsWide = handDistance > CONFIG.bigGestureThreshold * 1.6;

      const avgWristY = (leftWrist.y + rightWrist.y) * 0.5;
      const avgShoulderY = (leftShoulder.y + rightShoulder.y) * 0.5;
      handsUp = avgWristY < avgShoulderY - 18;
    }

    const leftHandRaised = 1 - state.leftHandYNorm;
    const horizontalReach = Math.abs(state.rightHandXNorm - 0.5) * 2;
    const bigGesture = state.velocityMag > CONFIG.bigGestureThreshold;

    const energy =
      0.07 +
      leftHandRaised * 0.36 +
      spread * 0.22 +
      horizontalReach * 0.16 +
      clamp(state.velocityMag / 220, 0, 0.32);

    state.rawEnergy = clamp(energy, CONFIG.defaultEnergy, 1);
    state.rawSpread = clamp(spread, 0.08, 1.0);
    state.handsWide = handsWide;
    state.handsUp = handsUp;
    state.bigGesture = bigGesture;

    const stillAmt = clamp(1 - state.velocityMag / CONFIG.idleStillnessThreshold, 0, 1);
    state.stillness = lerp(state.stillness, stillAmt, 0.08);

    if (nose && rightWrist) {
      const wristToNose = dist(rightWrist, nose);
      if (
        wristToNose < 65 &&
        state.rawEnergy > 0.55 &&
        nowMs() - lastBurstAt > CONFIG.burstCooldownMs
      ) {
        state.burstRequested = true;
        lastBurstAt = nowMs();
      }
    }

    state.activePose = true;
    state.lastPoseSeenAt = nowMs();
    return true;
  }

  // =========================================================
  // MOTION FALLBACK
  // =========================================================
  function updateMotionFallback() {
    if (!video.videoWidth || !video.videoHeight) return;

    motionCtx.save();
    motionCtx.scale(-1, 1);
    motionCtx.drawImage(video, -motionCanvas.width, 0, motionCanvas.width, motionCanvas.height);
    motionCtx.restore();

    const frame = motionCtx.getImageData(0, 0, motionCanvas.width, motionCanvas.height);
    const data = frame.data;

    if (!prevFrame) {
      prevFrame = new Uint8ClampedArray(data);
      return;
    }

    let active = 0;
    let sumX = 0;
    let sumY = 0;

    for (let y = 0; y < motionCanvas.height; y += CONFIG.opticalFallbackStep) {
      for (let x = 0; x < motionCanvas.width; x += CONFIG.opticalFallbackStep) {
        const i = (y * motionCanvas.width + x) * 4;

        const dr = Math.abs(data[i] - prevFrame[i]);
        const dg = Math.abs(data[i + 1] - prevFrame[i + 1]);
        const db = Math.abs(data[i + 2] - prevFrame[i + 2]);

        const diff = dr + dg + db;

        if (diff > CONFIG.opticalFallbackThreshold) {
          active++;
          sumX += x;
          sumY += y;
        }
      }
    }

    prevFrame.set(data);

    if (active >= CONFIG.opticalFallbackMinActive) {
      const mx = sumX / active;
      const my = sumY / active;

      state.rawTargetX = mapRange(mx, 0, motionCanvas.width, 0, W);
      state.rawTargetY = mapRange(my, 0, motionCanvas.height, 0, H);
      state.rawEnergy = clamp(active / 320, 0.08, 0.85);
      state.rawSpread = clamp(active / 480, 0.12, 0.9);
      state.velocityMag = lerp(state.velocityMag, active * 1.8, 0.15);
      state.bigGesture = active > 140;
      state.handsWide = false;
      state.handsUp = false;
      state.stillness = lerp(state.stillness, active < 65 ? 0.8 : 0.15, 0.06);

      if (state.rawEnergy > 0.7 && nowMs() - lastBurstAt > CONFIG.burstCooldownMs) {
        state.burstRequested = true;
        lastBurstAt = nowMs();
      }
    } else {
      state.rawEnergy = lerp(state.rawEnergy, 0.08, 0.08);
      state.rawSpread = lerp(state.rawSpread, 0.2, 0.08);
      state.velocityMag = lerp(state.velocityMag, 0, 0.06);
      state.bigGesture = false;
      state.handsWide = false;
      state.handsUp = false;
      state.stillness = lerp(state.stillness, 1, 0.04);
    }
  }

  // =========================================================
  // VISUAL HELPERS
  // =========================================================
  function drawBackgroundGlow(t) {
    const pulse = 0.5 + Math.sin(t * 0.001) * 0.5;
    let hue = 215;
    let alpha = 0.06;

    if (state.currentMode === "CALM") {
      hue = 210;
      alpha = 0.05;
    } else if (state.currentMode === "CHAOS") {
      hue = 18;
      alpha = 0.08;
    } else if (state.currentMode === "MIRROR") {
      hue = 290;
      alpha = 0.06;
    } else if (state.currentMode === "GALAXY") {
      hue = 235 + Math.sin(t * 0.0005) * 20;
      alpha = 0.075;
    }

    const grad = ctx.createRadialGradient(
      state.targetX, state.targetY, 0,
      state.targetX, state.targetY, Math.max(W, H) * 0.45
    );
    grad.addColorStop(0, `hsla(${hue}, 100%, 60%, ${alpha + pulse * 0.03})`);
    grad.addColorStop(0.4, `hsla(${hue}, 100%, 35%, ${alpha * 0.4})`);
    grad.addColorStop(1, "rgba(0,0,0,0)");

    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  function drawGalaxyStars(t) {
    if (state.currentMode !== "GALAXY") return;

    ctx.save();
    const starCount = 36;
    for (let i = 0; i < starCount; i++) {
      const a = i / starCount * Math.PI * 2 + t * 0.00015;
      const r = 80 + (i % 8) * 28 + Math.sin(t * 0.001 + i) * 12;
      const x = state.targetX + Math.cos(a) * r;
      const y = state.targetY + Math.sin(a) * r;
      const size = 1.2 + (i % 3);
      ctx.fillStyle = `rgba(255,255,255,${0.18 + (i % 4) * 0.06})`;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawDebugHUD() {
    if (!debugOn) return;

    ctx.save();

    if (state.wristLeft) {
      ctx.strokeStyle = "rgba(255,255,255,0.7)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(state.wristLeft.x, state.wristLeft.y, 10, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (state.wristRight) {
      ctx.strokeStyle = "rgba(0,255,255,0.8)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(state.wristRight.x, state.wristRight.y, 10, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (state.shoulderCenter) {
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      ctx.beginPath();
      ctx.arc(state.shoulderCenter.x, state.shoulderCenter.y, 5, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.beginPath();
    ctx.arc(state.targetX, state.targetY, 18 + state.spread * 20, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.font = "14px Arial";
    ctx.fillText(`Energy: ${state.energy.toFixed(2)}`, 20, 64);
    ctx.fillText(`Spread: ${state.spread.toFixed(2)}`, 20, 84);
    ctx.fillText(`Velocity: ${state.velocityMag.toFixed(1)}`, 20, 104);
    ctx.fillText(`Pose: ${state.activePose ? "ON" : "FALLBACK"}`, 20, 124);
    ctx.fillText(`Mode: ${state.currentMode}`, 20, 144);
    ctx.fillText(`Hands Up: ${state.handsUp}`, 20, 164);
    ctx.fillText(`Hands Wide: ${state.handsWide}`, 20, 184);

    ctx.restore();
  }

  function updateInstructionOverlay(t) {
    const elapsed = nowMs() - experienceStartedAt;
    let opacity = 1;

    if (elapsed > CONFIG.instructionFadeAfterMs) {
      opacity = 0;
    } else if (elapsed > CONFIG.instructionFadeAfterMs - 2000) {
      opacity = mapRange(
        elapsed,
        CONFIG.instructionFadeAfterMs - 2000,
        CONFIG.instructionFadeAfterMs,
        1,
        0
      );
    }

    const pulse = 0.9 + Math.sin(t * CONFIG.instructionPulseSpeed) * 0.1;
    instructionOverlay.style.opacity = String(opacity);
    instructionInner.style.transform = `scale(${pulse})`;
  }

  function enterFullscreenIfPossible() {
    const el = document.documentElement;
    if (document.fullscreenElement) return;

    const fn =
      el.requestFullscreen ||
      el.webkitRequestFullscreen ||
      el.msRequestFullscreen;

    if (fn) {
      try {
        fn.call(el);
      } catch (err) {
        console.warn("Fullscreen request failed:", err);
      }
    }
  }

  function hideUIForKiosk() {
    if (!ui) return;
    kioskMode = true;
    ui.style.transition = "opacity 0.7s ease";
    ui.style.opacity = "0";
    ui.style.pointerEvents = "none";
  }

  function showUI() {
    if (!ui) return;
    ui.style.opacity = "1";
    ui.style.pointerEvents = "auto";
  }

  function scheduleKioskHide() {
    if (uiHideTimeout) clearTimeout(uiHideTimeout);
    uiHideTimeout = setTimeout(() => {
      hideUIForKiosk();
    }, CONFIG.kioskHideDelayMs);
  }

  // =========================================================
  // ANIMATE
  // =========================================================
  async function animate(t) {
    if (!started) return;

    const dt = Math.min(0.033, (t - lastTime) / 1000);
    lastTime = t;

    const poseWorked = await updatePoseInput();
    if (!poseWorked) {
      updateMotionFallback();
    }

    state.targetX = lerp(state.targetX, state.rawTargetX, CONFIG.poseSmoothing);
    state.targetY = lerp(state.targetY, state.rawTargetY, CONFIG.poseSmoothing);
    state.energy = lerp(state.energy, state.rawEnergy, CONFIG.energySmoothing);
    state.spread = lerp(state.spread, state.rawSpread, CONFIG.spreadSmoothing);
    state.galaxySpin += state.currentMode === "GALAXY" ? 0.01 : 0.002;

    updateModeLogic();
    updateAudio();

    ctx.fillStyle = `rgba(0,0,0,${CONFIG.backgroundFade})`;
    ctx.fillRect(0, 0, W, H);

    drawBackgroundGlow(t);
    drawGalaxyStars(t);

    ctx.globalCompositeOperation = "lighter";

    for (let i = 0; i < particles.length; i++) {
      particles[i].update(dt, t);
      particles[i].draw(t);
    }

    if (state.burstRequested) {
      burstAt(state.targetX, state.targetY);
      playBurstSound();
      state.burstRequested = false;
    }

    ctx.globalCompositeOperation = "source-over";

    updateInstructionOverlay(t);
    drawDebugHUD();

    animationId = requestAnimationFrame(animate);
  }

  // =========================================================
  // START
  // =========================================================
  async function startExperience() {
    if (started) return;

    if (startBtn) {
      startBtn.disabled = true;
      startBtn.textContent = "Starting...";
    }

    try {
      await resumeAudio();
      await startCamera(selectedDeviceId || (cameraSelect ? cameraSelect.value : undefined) || undefined);
      await initDetector();

      ctx.fillStyle = "black";
      ctx.fillRect(0, 0, W, H);

      started = true;
      experienceStartedAt = nowMs();
      lastTime = performance.now();

      scheduleKioskHide();
      animationId = requestAnimationFrame(animate);

      if (startBtn) {
        startBtn.textContent = "Running";
      }
    } catch (err) {
      console.error(err);
      if (startBtn) {
        startBtn.disabled = false;
        startBtn.textContent = "Start Experience";
      }
      alert("Could not start camera/pose detection. Check camera permissions and reload.");
    }
  }

  // =========================================================
  // EVENTS
  // =========================================================
  if (startBtn) {
    startBtn.addEventListener("click", async () => {
      firstGestureActivated = true;
      await resumeAudio();
      enterFullscreenIfPossible();
      await startExperience();
    });
  }

  if (burstBtn) {
    burstBtn.addEventListener("click", async () => {
      await resumeAudio();
      state.burstRequested = true;
      scheduleKioskHide();
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      resetParticles();
      scheduleKioskHide();
    });
  }

  if (debugBtn) {
    debugBtn.addEventListener("click", () => {
      debugOn = !debugOn;
      updateDebugUI();
      if (!debugOn && kioskMode) hideUIForKiosk();
    });
  }

  if (cameraSelect) {
    cameraSelect.addEventListener("change", async () => {
      selectedDeviceId = cameraSelect.value;
      if (started) {
        try {
          await startCamera(selectedDeviceId);
        } catch (err) {
          console.error("Camera switch failed:", err);
        }
      }
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

  window.addEventListener("keydown", async e => {
    const key = e.key.toLowerCase();

    if (key === "b") {
      await resumeAudio();
      state.burstRequested = true;
    }
    if (key === "d") {
      debugOn = !debugOn;
      updateDebugUI();
    }
    if (key === "r") {
      resetParticles();
    }
    if (key === "f") {
      enterFullscreenIfPossible();
    }
    if (key === "u") {
      showUI();
      kioskMode = false;
    }
    if (key === "h") {
      hideUIForKiosk();
    }
  });

  document.addEventListener("pointerdown", async () => {
    if (!firstGestureActivated) {
      firstGestureActivated = true;
      await resumeAudio();
      enterFullscreenIfPossible();
      if (!started) {
        await startExperience();
      }
    } else {
      await resumeAudio();
    }
  }, { passive: true });

  // =========================================================
  // INIT
  // =========================================================
  async function init() {
    try {
      const temp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      temp.getTracks().forEach(t => t.stop());
    } catch (err) {
      console.warn("Initial permission warmup skipped:", err);
    }

    try {
      await populateCameraList();
    } catch (err) {
      console.error("Could not populate cameras:", err);
    }

    try {
      initAudio();
    } catch (err) {
      console.warn("Audio init skipped:", err);
    }

    // Try auto-start lightly; browser may block until user gesture.
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
