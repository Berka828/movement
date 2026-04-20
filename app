/* app.js
   Browser-based Tendrils Interactive
   - Fullscreen canvas
   - Webcam input
   - MediaPipe Pose control if available
   - Motion-tracking fallback if MediaPipe is not loaded
   - Optional HTML elements:
       #startButton
       #cameraSelect
       #statusText
       #loadingText
       #splashScreen
       #videoPreview
*/

(() => {
  "use strict";

  // ------------------------------------------------------------
  // CONFIG
  // ------------------------------------------------------------
  const CONFIG = {
    particleCount: 1400,
    maxSpeed: 5.0,
    trailAlpha: 0.08,
    backgroundAlpha: 0.08,
    spawnRadius: 90,
    centerPull: 0.0015,
    drag: 0.965,
    lineWidthMin: 0.3,
    lineWidthMax: 2.2,
    burstCooldownMs: 900,
    motionThreshold: 28,
    motionSampleStep: 8,
    webcamWidth: 320,
    webcamHeight: 240,
    smoothing: 0.16,
    energySmoothing: 0.12,
    calmNoise: 0.002,
    activeNoise: 0.01,
    targetLerp: 0.14,
    poseConfidence: 0.45,
    motionFallbackMinPixels: 70,
    idleEnergyFloor: 0.03,
    burstVelocity: 3.5,
    burstCount: 180,
    opticalFlowGain: 1.2,
    debugVideoOpacity: 0.0
  };

  // ------------------------------------------------------------
  // DOM
  // ------------------------------------------------------------
  const startButton = document.getElementById("startButton");
  const cameraSelect = document.getElementById("cameraSelect");
  const statusText = document.getElementById("statusText");
  const loadingText = document.getElementById("loadingText");
  const splashScreen = document.getElementById("splashScreen");
  const videoPreview = document.getElementById("videoPreview");

  // ------------------------------------------------------------
  // CANVAS
  // ------------------------------------------------------------
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { alpha: true });
  document.body.appendChild(canvas);

  let W = window.innerWidth;
  let H = window.innerHeight;
  let DPR = Math.min(window.devicePixelRatio || 1, 2);

  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  resize();
  window.addEventListener("resize", resize);

  Object.assign(canvas.style, {
    position: "fixed",
    inset: "0",
    width: "100vw",
    height: "100vh",
    zIndex: "1",
    background: "black",
    display: "block"
  });

  // ------------------------------------------------------------
  // VIDEO
  // ------------------------------------------------------------
  const video = document.createElement("video");
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "true");
  video.width = CONFIG.webcamWidth;
  video.height = CONFIG.webcamHeight;

  Object.assign(video.style, {
    position: "fixed",
    right: "16px",
    bottom: "16px",
    width: "220px",
    height: "165px",
    opacity: String(CONFIG.debugVideoOpacity),
    zIndex: "2",
    pointerEvents: "none",
    borderRadius: "12px",
    objectFit: "cover",
    transform: "scaleX(-1)"
  });

  if (videoPreview) {
    videoPreview.appendChild(video);
  } else {
    document.body.appendChild(video);
  }

  let stream = null;
  let selectedDeviceId = null;
  let isRunning = false;

  function setStatus(msg) {
    console.log(msg);
    if (statusText) statusText.textContent = msg;
    if (loadingText) loadingText.textContent = msg;
  }

  async function listCameras() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter(d => d.kind === "videoinput");

      if (cameraSelect) {
        cameraSelect.innerHTML = "";
        cams.forEach((cam, i) => {
          const opt = document.createElement("option");
          opt.value = cam.deviceId;
          opt.textContent = cam.label || `Camera ${i + 1}`;
          cameraSelect.appendChild(opt);
        });

        if (!selectedDeviceId && cams.length > 0) {
          selectedDeviceId = cams[0].deviceId;
          cameraSelect.value = selectedDeviceId;
        }
      }

      return cams;
    } catch (err) {
      console.error(err);
      setStatus("Could not list cameras.");
      return [];
    }
  }

  async function startCamera(deviceId = null) {
    try {
      if (stream) {
        stream.getTracks().forEach(t => t.stop());
        stream = null;
      }

      const constraints = {
        audio: false,
        video: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          width: { ideal: CONFIG.webcamWidth },
          height: { ideal: CONFIG.webcamHeight },
          frameRate: { ideal: 30, max: 30 }
        }
      };

      stream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = stream;

      await video.play();

      const track = stream.getVideoTracks()[0];
      const settings = track.getSettings();
      if (settings.deviceId) selectedDeviceId = settings.deviceId;

      await listCameras();

      if (cameraSelect && selectedDeviceId) {
        cameraSelect.value = selectedDeviceId;
      }

      setStatus("Camera ready.");
      return true;
    } catch (err) {
      console.error(err);
      setStatus("Camera access failed.");
      return false;
    }
  }

  if (cameraSelect) {
    cameraSelect.addEventListener("change", async e => {
      selectedDeviceId = e.target.value;
      await startCamera(selectedDeviceId);
    });
  }

  // ------------------------------------------------------------
  // INPUT STATE
  // ------------------------------------------------------------
  const inputState = {
    targetX: W * 0.5,
    targetY: H * 0.5,
    rawX: W * 0.5,
    rawY: H * 0.5,
    energy: 0.1,
    rawEnergy: 0.1,
    spread: 0.25,
    burst: false,
    lastBurstTime: 0,
    mode: "motion",
    wristLeft: null,
    wristRight: null,
    shoulderCenter: null
  };

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function mapRange(v, inMin, inMax, outMin, outMax) {
    const t = clamp((v - inMin) / (inMax - inMin), 0, 1);
    return outMin + (outMax - outMin) * t;
  }

  // ------------------------------------------------------------
  // PARTICLE SYSTEM
  // ------------------------------------------------------------
  class Particle {
    constructor(x, y) {
      this.reset(x, y);
    }

    reset(x = Math.random() * W, y = Math.random() * H) {
      this.x = x;
      this.y = y;
      this.px = x;
      this.py = y;
      this.vx = (Math.random() - 0.5) * 1.5;
      this.vy = (Math.random() - 0.5) * 1.5;
      this.life = Math.random() * 200 + 80;
      this.width = Math.random();
      this.hueOffset = Math.random() * 50;
    }

    update(dt, field) {
      this.px = this.x;
      this.py = this.y;

      const dx = inputState.targetX - this.x;
      const dy = inputState.targetY - this.y;
      const dist = Math.sqrt(dx * dx + dy * dy) + 0.0001;

      const centerForce = CONFIG.centerPull * (0.5 + inputState.energy * 2.5);
      this.vx += (dx / dist) * centerForce * dt * 60;
      this.vy += (dy / dist) * centerForce * dt * 60;

      const fieldVec = field(this.x, this.y, dt);
      this.vx += fieldVec.x;
      this.vy += fieldVec.y;

      this.vx *= CONFIG.drag;
      this.vy *= CONFIG.drag;

      const speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
      const maxSpeed = CONFIG.maxSpeed + inputState.energy * 6.0;
      if (speed > maxSpeed) {
        const s = maxSpeed / speed;
        this.vx *= s;
        this.vy *= s;
      }

      this.x += this.vx * dt * 60;
      this.y += this.vy * dt * 60;

      this.life -= dt * 60;

      if (
        this.life <= 0 ||
        this.x < -60 || this.x > W + 60 ||
        this.y < -60 || this.y > H + 60
      ) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * (CONFIG.spawnRadius + inputState.spread * 240);
        this.reset(
          inputState.targetX + Math.cos(a) * r,
          inputState.targetY + Math.sin(a) * r
        );
      }
    }

    draw(time) {
      const dx = this.x - this.px;
      const dy = this.y - this.py;
      const speed = Math.sqrt(dx * dx + dy * dy);

      const hue =
        (time * 0.03 +
          inputState.energy * 120 +
          this.hueOffset +
          mapRange(this.x, 0, W, 0, 80)) % 360;

      const alpha = clamp(0.06 + speed * 0.08 + inputState.energy * 0.2, 0.03, 0.42);
      const lw = mapRange(this.width + speed * 0.08, 0, 2.2, CONFIG.lineWidthMin, CONFIG.lineWidthMax + inputState.spread * 2.5);

      ctx.strokeStyle = `hsla(${hue}, 85%, ${55 + inputState.energy * 20}%, ${alpha})`;
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(this.px, this.py);
      ctx.lineTo(this.x, this.y);
      ctx.stroke();
    }
  }

  const particles = [];
  for (let i = 0; i < CONFIG.particleCount; i++) {
    particles.push(new Particle(Math.random() * W, Math.random() * H));
  }

  function burstAt(x, y) {
    for (let i = 0; i < CONFIG.burstCount; i++) {
      const p = particles[(Math.random() * particles.length) | 0];
      const a = Math.random() * Math.PI * 2;
      const sp = Math.random() * CONFIG.burstVelocity + 1.2;
      p.x = x;
      p.y = y;
      p.px = x;
      p.py = y;
      p.vx = Math.cos(a) * sp;
      p.vy = Math.sin(a) * sp;
      p.life = Math.random() * 120 + 50;
    }
  }

  function fieldFunction(x, y, dt) {
    const dx = x - inputState.targetX;
    const dy = y - inputState.targetY;
    const d = Math.sqrt(dx * dx + dy * dy) + 0.0001;

    const angle = Math.atan2(dy, dx);
    const swirl =
      0.02 +
      inputState.energy * 0.08 +
      inputState.spread * 0.03;

    const noiseStrength = lerp(CONFIG.calmNoise, CONFIG.activeNoise, inputState.energy);
    const n =
      Math.sin((x * 0.008) + performance.now() * noiseStrength * 0.06) +
      Math.cos((y * 0.008) - performance.now() * noiseStrength * 0.08);

    const radialFalloff = 1 / (1 + d * 0.01);
    const tangentialX = -Math.sin(angle) * swirl * radialFalloff * 12;
    const tangentialY =  Math.cos(angle) * swirl * radialFalloff * 12;

    const inwardX = -dx * 0.0008 * (0.5 + inputState.energy);
    const inwardY = -dy * 0.0008 * (0.5 + inputState.energy);

    const noiseX = Math.cos(angle + n) * noiseStrength * 11;
    const noiseY = Math.sin(angle + n) * noiseStrength * 11;

    return {
      x: (tangentialX + inwardX + noiseX) * dt * 60,
      y: (tangentialY + inwardY + noiseY) * dt * 60
    };
  }

  // ------------------------------------------------------------
  // MOTION TRACKING FALLBACK
  // ------------------------------------------------------------
  const analysisCanvas = document.createElement("canvas");
  analysisCanvas.width = CONFIG.webcamWidth;
  analysisCanvas.height = CONFIG.webcamHeight;
  const analysisCtx = analysisCanvas.getContext("2d", { willReadFrequently: true });

  let prevFrame = null;

  function analyzeMotionFrame() {
    if (!video.videoWidth || !video.videoHeight) return;

    analysisCtx.save();
    analysisCtx.scale(-1, 1);
    analysisCtx.drawImage(video, -analysisCanvas.width, 0, analysisCanvas.width, analysisCanvas.height);
    analysisCtx.restore();

    const frame = analysisCtx.getImageData(0, 0, analysisCanvas.width, analysisCanvas.height);
    const data = frame.data;

    if (!prevFrame) {
      prevFrame = new Uint8ClampedArray(data);
      return;
    }

    let sumX = 0;
    let sumY = 0;
    let active = 0;

    for (let y = 0; y < analysisCanvas.height; y += CONFIG.motionSampleStep) {
      for (let x = 0; x < analysisCanvas.width; x += CONFIG.motionSampleStep) {
        const i = (y * analysisCanvas.width + x) * 4;

        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        const pr = prevFrame[i];
        const pg = prevFrame[i + 1];
        const pb = prevFrame[i + 2];

        const diff =
          Math.abs(r - pr) +
          Math.abs(g - pg) +
          Math.abs(b - pb);

        if (diff > CONFIG.motionThreshold) {
          sumX += x;
          sumY += y;
          active++;
        }
      }
    }

    prevFrame.set(data);

    if (active >= CONFIG.motionFallbackMinPixels) {
      const mx = sumX / active;
      const my = sumY / active;

      inputState.rawX = mapRange(mx, 0, analysisCanvas.width, 0, W);
      inputState.rawY = mapRange(my, 0, analysisCanvas.height, 0, H);
      inputState.rawEnergy = clamp(active / 500, CONFIG.idleEnergyFloor, 1);
      inputState.spread = clamp(active / 800, 0.12, 1);

      const now = performance.now();
      if (
        inputState.rawEnergy > 0.72 &&
        now - inputState.lastBurstTime > CONFIG.burstCooldownMs
      ) {
        inputState.burst = true;
        inputState.lastBurstTime = now;
      }
    } else {
      inputState.rawEnergy = lerp(inputState.rawEnergy, CONFIG.idleEnergyFloor, 0.08);
    }
  }

  // ------------------------------------------------------------
  // MEDIAPIPE POSE (OPTIONAL)
  // ------------------------------------------------------------
  let poseLandmarker = null;
  let poseReady = false;
  let lastVideoTime = -1;

  async function initPoseIfAvailable() {
    try {
      if (!window.FilesetResolver || !window.PoseLandmarker) {
        setStatus("MediaPipe Pose not found. Using motion fallback.");
        inputState.mode = "motion";
        return false;
      }

      const vision = await window.FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
      );

      poseLandmarker = await window.PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task"
        },
        runningMode: "VIDEO",
        numPoses: 1
      });

      poseReady = true;
      inputState.mode = "pose";
      setStatus("MediaPipe Pose ready.");
      return true;
    } catch (err) {
      console.error(err);
      poseReady = false;
      inputState.mode = "motion";
      setStatus("Pose init failed. Using motion fallback.");
      return false;
    }
  }

  function getLandmark(arr, idx) {
    if (!arr || !arr[idx]) return null;
    const p = arr[idx];
    if ((p.visibility ?? 1) < CONFIG.poseConfidence) return null;
    return p;
  }

  function screenPointFromLandmark(p) {
    return {
      x: (1 - p.x) * W,
      y: p.y * H
    };
  }

  function dist2D(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function analyzePoseFrame() {
    if (!poseReady || !poseLandmarker || !video.videoWidth) return false;
    if (video.currentTime === lastVideoTime) return false;

    lastVideoTime = video.currentTime;
    const result = poseLandmarker.detectForVideo(video, performance.now());

    if (!result.landmarks || !result.landmarks.length) return false;

    const lm = result.landmarks[0];

    const leftWrist = getLandmark(lm, 15);
    const rightWrist = getLandmark(lm, 16);
    const leftShoulder = getLandmark(lm, 11);
    const rightShoulder = getLandmark(lm, 12);
    const nose = getLandmark(lm, 0);

    if (!leftShoulder || !rightShoulder || !nose) return false;

    const shoulderCenterNorm = {
      x: (leftShoulder.x + rightShoulder.x) * 0.5,
      y: (leftShoulder.y + rightShoulder.y) * 0.5,
      z: ((leftShoulder.z ?? 0) + (rightShoulder.z ?? 0)) * 0.5
    };

    const shoulderCenter = screenPointFromLandmark(shoulderCenterNorm);
    inputState.shoulderCenter = shoulderCenter;

    let primary = null;
    if (rightWrist) primary = screenPointFromLandmark(rightWrist);
    else if (leftWrist) primary = screenPointFromLandmark(leftWrist);
    else primary = shoulderCenter;

    inputState.rawX = primary.x;
    inputState.rawY = primary.y;

    let spread = 0.22;
    let energy = 0.15;

    if (leftWrist && rightWrist) {
      const lw = screenPointFromLandmark(leftWrist);
      const rw = screenPointFromLandmark(rightWrist);
      inputState.wristLeft = lw;
      inputState.wristRight = rw;

      const handDistance = dist2D(lw, rw);
      spread = clamp(mapRange(handDistance, 40, 500, 0.08, 1.0), 0.08, 1.0);

      const avgHandY = (lw.y + rw.y) * 0.5;
      const raisedAmount = clamp(mapRange(H - avgHandY, 0, H, 0, 1), 0, 1);
      energy = clamp(0.12 + raisedAmount * 0.55 + spread * 0.25, 0.08, 1);
    } else {
      inputState.wristLeft = null;
      inputState.wristRight = null;
    }

    if (nose && shoulderCenterNorm) {
      const zDelta = Math.abs((nose.z ?? 0) - (shoulderCenterNorm.z ?? 0));
      const now = performance.now();
      if (zDelta > 0.18 && now - inputState.lastBurstTime > CONFIG.burstCooldownMs) {
        inputState.burst = true;
        inputState.lastBurstTime = now;
      }
    }

    inputState.rawEnergy = energy;
    inputState.spread = spread;
    return true;
  }

  // ------------------------------------------------------------
  // UPDATE INPUT
  // ------------------------------------------------------------
  function updateInput() {
    const usedPose = analyzePoseFrame();

    if (!usedPose) {
      analyzeMotionFrame();
    }

    inputState.targetX = lerp(inputState.targetX, inputState.rawX, CONFIG.targetLerp);
    inputState.targetY = lerp(inputState.targetY, inputState.rawY, CONFIG.targetLerp);
    inputState.energy = lerp(inputState.energy, inputState.rawEnergy, CONFIG.energySmoothing);

    if (!Number.isFinite(inputState.targetX)) inputState.targetX = W * 0.5;
    if (!Number.isFinite(inputState.targetY)) inputState.targetY = H * 0.5;
    if (!Number.isFinite(inputState.energy)) inputState.energy = 0.1;
  }

  // ------------------------------------------------------------
  // DRAW OVERLAYS
  // ------------------------------------------------------------
  function drawHUD() {
    ctx.save();

    const glow = 12 + inputState.energy * 26;
    const hue = (performance.now() * 0.02 + inputState.energy * 140) % 360;

    ctx.shadowBlur = glow;
    ctx.shadowColor = `hsla(${hue}, 100%, 70%, 0.8)`;

    ctx.fillStyle = `hsla(${hue}, 100%, 70%, 0.9)`;
    ctx.beginPath();
    ctx.arc(inputState.targetX, inputState.targetY, 5 + inputState.spread * 10, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowBlur = 0;

    if (inputState.wristLeft) {
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(inputState.wristLeft.x, inputState.wristLeft.y, 10, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (inputState.wristRight) {
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(inputState.wristRight.x, inputState.wristRight.y, 10, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  // ------------------------------------------------------------
  // ANIMATION LOOP
  // ------------------------------------------------------------
  let lastTime = performance.now();

  function animate(now) {
    if (!isRunning) return;

    const dt = Math.min(0.033, (now - lastTime) / 1000);
    lastTime = now;

    updateInput();

    ctx.fillStyle = `rgba(0,0,0,${CONFIG.backgroundAlpha})`;
    ctx.fillRect(0, 0, W, H);

    ctx.globalCompositeOperation = "lighter";

    for (let i = 0; i < particles.length; i++) {
      particles[i].update(dt, fieldFunction);
      particles[i].draw(now);
    }

    if (inputState.burst) {
      burstAt(inputState.targetX, inputState.targetY);
      inputState.burst = false;
    }

    drawHUD();

    ctx.globalCompositeOperation = "source-over";

    requestAnimationFrame(animate);
  }

  // ------------------------------------------------------------
  // START
  // ------------------------------------------------------------
  async function startExperience() {
    setStatus("Starting experience...");

    const ok = await startCamera(selectedDeviceId);
    if (!ok) return;

    await initPoseIfAvailable();

    if (splashScreen) {
      splashScreen.style.opacity = "0";
      splashScreen.style.pointerEvents = "none";
      setTimeout(() => {
        splashScreen.style.display = "none";
      }, 500);
    }

    isRunning = true;
    lastTime = performance.now();
    requestAnimationFrame(animate);
    setStatus(`Running (${inputState.mode} control).`);
  }

  if (startButton) {
    startButton.addEventListener("click", startExperience);
  } else {
    window.addEventListener("load", startExperience, { once: true });
  }

  // ------------------------------------------------------------
  // CAMERA CHANGE EVENTS
  // ------------------------------------------------------------
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", async () => {
      await listCameras();
    });
  }

  // ------------------------------------------------------------
  // KEYBOARD DEBUG
  // ------------------------------------------------------------
  window.addEventListener("keydown", e => {
    if (e.key.toLowerCase() === "b") {
      inputState.burst = true;
    }
    if (e.key.toLowerCase() === "c") {
      ctx.fillStyle = "black";
      ctx.fillRect(0, 0, W, H);
    }
  });

  // ------------------------------------------------------------
  // INITIAL STATUS
  // ------------------------------------------------------------
  setStatus("Ready. Start camera to begin.");
})();
