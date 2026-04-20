(() => {
  "use strict";

  // =========================================================
  // DOM
  // =========================================================
  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d");
  const video = document.getElementById("video");

  const cameraSelect = document.getElementById("cameraSelect");
  const startBtn = document.getElementById("startBtn");
  const burstBtn = document.getElementById("burstBtn");
  const resetBtn = document.getElementById("resetBtn");
  const debugBtn = document.getElementById("debugBtn");

  // =========================================================
  // CONFIG
  // =========================================================
  const CONFIG = {
    particleCount: 1600,
    backgroundFade: 0.09,
    drag: 0.962,
    baseLineWidth: 1.1,
    maxSpeedBase: 4.5,
    targetPullBase: 0.010,
    swirlBase: 0.012,
    noiseScaleBase: 0.006,
    noiseStrengthBase: 0.55,
    spreadBase: 90,
    burstCount: 220,
    burstForce: 4.8,
    poseSmoothing: 0.18,
    energySmoothing: 0.12,
    spreadSmoothing: 0.12,
    shoulderConfidence: 0.25,
    wristConfidence: 0.2,
    defaultEnergy: 0.08,
    minHandDistance: 40,
    maxHandDistance: 350,
    minCanvasDimInfluence: 0.3,
    opticalFallbackThreshold: 32,
    opticalFallbackStep: 10,
    opticalFallbackMinActive: 55,
    debugVideoOpacity: 0.22
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

  const state = {
    targetX: W * 0.5,
    targetY: H * 0.5,
    rawTargetX: W * 0.5,
    rawTargetY: H * 0.5,
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
    shoulderCenter: null
  };

  // fallback motion tracking buffers
  let prevFrame = null;
  const motionCanvas = document.createElement("canvas");
  const motionCtx = motionCanvas.getContext("2d", { willReadFrequently: true });

  // =========================================================
  // UTILS
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
  // VIDEO DEBUG STYLE
  // =========================================================
  function updateDebugUI() {
    video.style.opacity = debugOn ? String(CONFIG.debugVideoOpacity) : "0";
    video.style.pointerEvents = "none";
    video.style.transform = "scaleX(-1)";
    debugBtn.textContent = debugOn ? "Debug: On" : "Debug: Off";
  }

  updateDebugUI();

  // =========================================================
  // CAMERA SETUP
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
  // TENSORFLOW POSE DETECTOR
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
  // PARTICLE SYSTEM
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

      const energy = state.energy;
      const spreadStrength = state.spread;

      const targetPull = CONFIG.targetPullBase + energy * 0.022;
      const swirl = CONFIG.swirlBase + energy * 0.038;
      const maxSpeed = CONFIG.maxSpeedBase + energy * 5.8;
      const noiseScale = CONFIG.noiseScaleBase + spreadStrength * 0.01;
      const noiseStrength =
        CONFIG.noiseStrengthBase + energy * 1.15 + (1 - state.leftHandYNorm) * 0.8;

      const angle = Math.atan2(dy, dx);

      const tangentialX = -Math.sin(angle) * swirl * 18 / (1 + d * 0.01);
      const tangentialY =  Math.cos(angle) * swirl * 18 / (1 + d * 0.01);

      const noise =
        Math.sin(this.x * noiseScale + t * 0.0007 + this.seed) +
        Math.cos(this.y * noiseScale - t * 0.0009 + this.seed * 0.7);

      const noiseX = Math.cos(noise + angle * 0.7) * noiseStrength * 0.09;
      const noiseY = Math.sin(noise - angle * 0.7) * noiseStrength * 0.09;

      this.vx += nx * targetPull + tangentialX + noiseX;
      this.vy += ny * targetPull + tangentialY + noiseY;

      this.vx *= CONFIG.drag;
      this.vy *= CONFIG.drag;

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
        const r = Math.random() * (CONFIG.spreadBase + spreadStrength * 240);
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

      const hue =
        (220 + t * 0.01 + this.seed * 40 + state.energy * 90 + (1 - state.leftHandYNorm) * 80) % 360;

      const alpha = clamp(0.05 + speed * 0.03 + state.energy * 0.14, 0.03, 0.35);
      const lw =
        CONFIG.baseLineWidth +
        this.width * 0.8 +
        state.spread * 1.8 +
        speed * 0.03;

      ctx.strokeStyle = `hsla(${hue}, 100%, ${58 + state.energy * 18}%, ${alpha})`;
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(this.px, this.py);
      ctx.lineTo(this.x, this.y);
      ctx.stroke();
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
  // POSE INPUT
  // =========================================================
  async function updatePoseInput() {
    if (!detectorReady || !video.videoWidth || !video.videoHeight) {
      state.activePose = false;
      return false;
    }

    let poses = [];
    try {
      poses = await detector.estimatePoses(video, {
        flipHorizontal: true
      });
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

    let spread = 0.22;
    if (leftWrist && rightWrist) {
      const handDistance = dist(leftWrist, rightWrist);
      spread = mapRange(
        handDistance,
        CONFIG.minHandDistance,
        CONFIG.maxHandDistance,
        0.08,
        1.0
      );
    }

    // Energy:
    // - right hand moving the target
    // - left hand higher = more chaos/energy
    // - hands apart = more spread
    const leftHandRaised = 1 - state.leftHandYNorm;
    const horizontalReach = Math.abs(state.rightHandXNorm - 0.5) * 2;

    const energy =
      0.08 +
      leftHandRaised * 0.42 +
      spread * 0.25 +
      horizontalReach * 0.18;

    state.rawEnergy = clamp(energy, CONFIG.defaultEnergy, 1);
    state.rawSpread = clamp(spread, 0.08, 1.0);

    // forward-ish gesture approximation:
    // if wrists come close to the nose / center quickly,
    // trigger a burst. not perfect depth, but reads well.
    if (nose && rightWrist) {
      const wristToNose = dist(rightWrist, nose);
      if (wristToNose < 65 && state.rawEnergy > 0.55) {
        state.burstRequested = true;
      }
    }

    state.activePose = true;
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

      if (state.rawEnergy > 0.7) {
        state.burstRequested = true;
      }
    } else {
      state.rawEnergy = lerp(state.rawEnergy, 0.08, 0.08);
      state.rawSpread = lerp(state.rawSpread, 0.2, 0.08);
    }
  }

  // =========================================================
  // DRAW DEBUG
  // =========================================================
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
    ctx.fillText(`Energy: ${state.energy.toFixed(2)}`, 20, 34);
    ctx.fillText(`Spread: ${state.spread.toFixed(2)}`, 20, 54);
    ctx.fillText(`Pose: ${state.activePose ? "ON" : "FALLBACK"}`, 20, 74);

    ctx.restore();
  }

  // =========================================================
  // ANIMATE
  // =========================================================
  async function animate(now) {
    if (!started) return;

    const dt = Math.min(0.033, (now - lastTime) / 1000);
    lastTime = now;

    const poseWorked = await updatePoseInput();
    if (!poseWorked) {
      updateMotionFallback();
    }

    state.targetX = lerp(state.targetX, state.rawTargetX, CONFIG.poseSmoothing);
    state.targetY = lerp(state.targetY, state.rawTargetY, CONFIG.poseSmoothing);
    state.energy = lerp(state.energy, state.rawEnergy, CONFIG.energySmoothing);
    state.spread = lerp(state.spread, state.rawSpread, CONFIG.spreadSmoothing);

    ctx.fillStyle = `rgba(0,0,0,${CONFIG.backgroundFade})`;
    ctx.fillRect(0, 0, W, H);

    ctx.globalCompositeOperation = "lighter";

    for (let i = 0; i < particles.length; i++) {
      particles[i].update(dt, now);
      particles[i].draw(now);
    }

    if (state.burstRequested) {
      burstAt(state.targetX, state.targetY);
      state.burstRequested = false;
    }

    ctx.globalCompositeOperation = "source-over";

    drawDebugHUD();

    animationId = requestAnimationFrame(animate);
  }

  // =========================================================
  // START EXPERIENCE
  // =========================================================
  async function startExperience() {
    if (started) return;

    startBtn.disabled = true;
    startBtn.textContent = "Starting...";

    try {
      await startCamera(selectedDeviceId || cameraSelect.value || undefined);
      await initDetector();

      ctx.fillStyle = "black";
      ctx.fillRect(0, 0, W, H);

      started = true;
      lastTime = performance.now();
      animationId = requestAnimationFrame(animate);

      startBtn.textContent = "Running";
    } catch (err) {
      console.error(err);
      startBtn.disabled = false;
      startBtn.textContent = "Start Experience";
      alert("Could not start camera/pose detection. Check camera permissions and reload.");
    }
  }

  // =========================================================
  // EVENTS
  // =========================================================
  startBtn.addEventListener("click", startExperience);

  burstBtn.addEventListener("click", () => {
    state.burstRequested = true;
  });

  resetBtn.addEventListener("click", () => {
    resetParticles();
  });

  debugBtn.addEventListener("click", () => {
    debugOn = !debugOn;
    updateDebugUI();
  });

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

  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", async () => {
      try {
        await populateCameraList();
      } catch (err) {
        console.error(err);
      }
    });
  }

  window.addEventListener("keydown", e => {
    const key = e.key.toLowerCase();

    if (key === "b") {
      state.burstRequested = true;
    }

    if (key === "d") {
      debugOn = !debugOn;
      updateDebugUI();
    }

    if (key === "r") {
      resetParticles();
    }
  });

  // =========================================================
  // INIT CAMERA MENU
  // =========================================================
  async function init() {
    try {
      // temporary permission request helps labels show up
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
  }

  init();
})();
