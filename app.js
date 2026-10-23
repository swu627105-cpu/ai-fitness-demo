// packages/platform-adapters/src/types.ts
var PoseAdapterError = class extends Error {
  code;
  cause;
  constructor(code, message, cause) {
    super(message);
    this.name = "PoseAdapterError";
    this.code = code;
    this.cause = cause;
  }
};

// packages/platform-adapters/src/web-camera.ts
var DEFAULT_OPTIONS = {
  idealWidth: 640,
  idealHeight: 480,
  facingMode: "user"
};
var WebCamera = class {
  video;
  options;
  stream = null;
  disposed = false;
  constructor(video2, options = {}) {
    this.video = video2;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }
  get isRunning() {
    return this.stream !== null && !this.disposed;
  }
  /** 申请权限并开始播放。约束失败会抛出带 code 的 PoseAdapterError。 */
  async start() {
    if (this.disposed) {
      throw new PoseAdapterError("disposed", "\u6444\u50CF\u5934\u5DF2\u91CA\u653E\uFF0C\u8BF7\u91CD\u65B0\u521B\u5EFA");
    }
    if (this.stream !== null) {
      return this.info();
    }
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      throw new PoseAdapterError("not_supported", "\u5F53\u524D\u73AF\u5883\u4E0D\u652F\u6301 getUserMedia\uFF08\u9700 HTTPS \u6216 localhost\uFF09");
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: this.options.idealWidth },
          height: { ideal: this.options.idealHeight },
          // ideal 而非精确值：桌面只有一个摄像头时，精确 facingMode 会直接报错
          facingMode: { ideal: this.options.facingMode }
        },
        audio: false
      });
    } catch (error) {
      throw mapGetUserMediaError(error);
    }
    this.stream = stream;
    this.video.srcObject = stream;
    this.video.playsInline = true;
    this.video.muted = true;
    try {
      await this.video.play();
    } catch (error) {
      await this.stop();
      throw new PoseAdapterError("runtime_failed", "\u89C6\u9891\u64AD\u653E\u542F\u52A8\u5931\u8D25", error);
    }
    return this.info();
  }
  /** 释放资源。幂等，可安全重复调用。 */
  async stop() {
    const stream = this.stream;
    this.stream = null;
    if (this.video) {
      try {
        this.video.pause();
      } catch {
      }
      this.video.srcObject = null;
    }
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    }
  }
  /** 彻底释放，之后不可再用。 */
  async dispose() {
    await this.stop();
    this.disposed = true;
  }
  get facing() {
    return this.options.facingMode;
  }
  /**
   * 前后摄像头切换：停掉当前流、翻转 facingMode、重新申请。
   * 手机上前置/后置是不同设备，必须重新 getUserMedia；切换期间画面会短暂黑屏。
   * 只有一颗摄像头的设备（多数桌面）切换后仍拿到同一颗，不报错。
   */
  async switchFacing() {
    const next = this.options.facingMode === "user" ? "environment" : "user";
    await this.stop();
    this.options.facingMode = next;
    try {
      return await this.start();
    } catch (error) {
      this.options.facingMode = this.options.facingMode === "user" ? "environment" : "user";
      await this.start();
      throw error;
    }
  }
  info() {
    const track = this.stream?.getVideoTracks()[0];
    return {
      width: this.video.videoWidth,
      height: this.video.videoHeight,
      trackLabel: track?.label ?? ""
    };
  }
};
function mapGetUserMediaError(error) {
  const name = error?.name ?? "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return new PoseAdapterError("permission_denied", "\u76F8\u673A\u6743\u9650\u88AB\u62D2\u7EDD", error);
    case "NotFoundError":
    case "OverconstrainedError":
      return new PoseAdapterError("device_missing", "\u672A\u627E\u5230\u53EF\u7528\u6444\u50CF\u5934\u6216\u8BBE\u5907\u4E0D\u6EE1\u8DB3\u53C2\u6570", error);
    case "NotReadableError":
    case "AbortError":
      return new PoseAdapterError("camera_busy", "\u6444\u50CF\u5934\u88AB\u5176\u4ED6\u7A0B\u5E8F\u5360\u7528", error);
    case "TypeError":
      return new PoseAdapterError("constraint_failed", "\u6444\u50CF\u5934\u53C2\u6570\u4E0D\u88AB\u652F\u6301", error);
    default:
      return new PoseAdapterError("runtime_failed", "\u76F8\u673A\u542F\u52A8\u5931\u8D25", error);
  }
}

// packages/platform-adapters/src/mediapipe-mapping.ts
var POSE_INDEX = {
  left_shoulder: 11,
  right_shoulder: 12,
  left_elbow: 13,
  right_elbow: 14,
  left_wrist: 15,
  right_wrist: 16,
  left_hip: 23,
  right_hip: 24,
  left_knee: 25,
  right_knee: 26,
  left_ankle: 27,
  right_ankle: 28,
  left_heel: 29,
  right_heel: 30,
  left_foot_index: 31,
  right_foot_index: 32
};
function toPixelLandmark(lm, width, height) {
  if (!lm) return void 0;
  if (!Number.isFinite(lm.x) || !Number.isFinite(lm.y)) return void 0;
  const confidence = typeof lm.visibility === "number" && Number.isFinite(lm.visibility) ? Math.min(1, Math.max(0, lm.visibility)) : 0;
  const point = {
    x: lm.x * width,
    y: lm.y * height,
    confidence
  };
  if (typeof lm.z === "number" && Number.isFinite(lm.z)) point.z = lm.z;
  return point;
}
function mapPoseLandmarks(landmarksPerPose, options) {
  const { width, height, timestampMs } = options;
  const joints = {};
  const first = landmarksPerPose[0];
  if (first) {
    for (const [name, index] of Object.entries(POSE_INDEX)) {
      const point = toPixelLandmark(first[index], width, height);
      if (point !== void 0) joints[name] = point;
    }
  }
  return {
    frame: { timestampMs, width, height, joints },
    poseCount: landmarksPerPose.length
  };
}

// packages/pose-core/src/angles.ts
function isFinitePoint(p) {
  return p !== void 0 && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.confidence);
}
function angleDegrees(a, b, c) {
  if (!isFinitePoint(a) || !isFinitePoint(b) || !isFinitePoint(c)) return null;
  const v1x = a.x - b.x;
  const v1y = a.y - b.y;
  const v2x = c.x - b.x;
  const v2y = c.y - b.y;
  const n1 = Math.hypot(v1x, v1y);
  const n2 = Math.hypot(v2x, v2y);
  if (n1 < 1e-6 || n2 < 1e-6) return null;
  const raw = (v1x * v2x + v1y * v2y) / (n1 * n2);
  const cos = Math.min(1, Math.max(-1, raw));
  const deg = Math.acos(cos) * 180 / Math.PI;
  return Number.isFinite(deg) ? deg : null;
}
function jointAngle(frame, vertex, from, to, minConfidence = 0) {
  const a = frame.joints[from];
  const b = frame.joints[vertex];
  const c = frame.joints[to];
  if (!isFinitePoint(a) || !isFinitePoint(b) || !isFinitePoint(c)) return null;
  if (a.confidence < minConfidence || b.confidence < minConfidence || c.confidence < minConfidence) {
    return null;
  }
  return angleDegrees(a, b, c);
}

// packages/pose-core/src/gate.ts
var DEFAULT_GATE = {
  minConfidence: 0.65,
  maxFrameAgeMs: 300
};
function checkFrame(frame, nowMs, required, config = DEFAULT_GATE) {
  const age = nowMs - frame.timestampMs;
  if (!Number.isFinite(age) || age > config.maxFrameAgeMs) {
    return { ok: false, reason: "stale" };
  }
  for (const name of required) {
    const p = frame.joints[name];
    if (p === void 0) return { ok: false, reason: "missing_joint", joint: name };
    if (!isFinitePoint(p)) return { ok: false, reason: "not_finite", joint: name };
    const threshold = config.jointOverrides?.[name] ?? config.minConfidence;
    if (p.confidence < threshold) {
      return { ok: false, reason: "low_confidence", joint: name, confidence: p.confidence };
    }
  }
  return { ok: true, reason: "ok" };
}
var QualityTracker = class {
  lostGraceMs;
  lastT = null;
  invalidSince = null;
  validMs = 0;
  invalidMs = 0;
  constructor(lostGraceMs = 500) {
    this.lostGraceMs = lostGraceMs;
  }
  observe(ok, timestampMs) {
    if (this.lastT !== null) {
      const delta = timestampMs - this.lastT;
      if (delta > 0) {
        if (ok) this.validMs += delta;
        else this.invalidMs += delta;
      }
    }
    if (ok) {
      this.invalidSince = null;
    } else if (this.invalidSince === null) {
      this.invalidSince = timestampMs;
    }
    this.lastT = timestampMs;
    const total = this.validMs + this.invalidMs;
    const trackingLost = this.invalidSince !== null && timestampMs - this.invalidSince >= this.lostGraceMs;
    return {
      validMs: this.validMs,
      invalidMs: this.invalidMs,
      coverage: total > 0 ? this.validMs / total : 1,
      trackingLost
    };
  }
  reset() {
    this.lastT = null;
    this.invalidSince = null;
    this.validMs = 0;
    this.invalidMs = 0;
  }
};

// packages/pose-core/src/rep-cycle.ts
var RepCycleCounter = class {
  config;
  phase = "idle";
  lastT = null;
  topSince = null;
  bottomSince = null;
  cycleStartMs = null;
  reachedBottom = false;
  /** 当前周期内到达的最小角度；beginAttempt 时重置。 */
  cycleMinAngle = null;
  /** 最近一次尝试的记录，供报告与事件上报使用。 */
  lastAttempt = null;
  reps = 0;
  attemptedReps = 0;
  incompleteReps = 0;
  lastRepDurationMs = null;
  lastRepAtMs = null;
  constructor(config) {
    this.config = config;
  }
  get phaseName() {
    return this.phase;
  }
  update(sample) {
    const t = sample.timestampMs;
    if (this.lastT !== null && t <= this.lastT) return this.snapshot(null);
    this.lastT = t;
    const angle = sample.angle;
    if (angle === null || !Number.isFinite(angle)) return this.discardPartial();
    const { topAngle, descendAngle, bottomAngle, stableMs } = this.config;
    if (this.cycleStartMs !== null) {
      this.cycleMinAngle = this.cycleMinAngle === null ? angle : Math.min(this.cycleMinAngle, angle);
    }
    if (angle >= topAngle) {
      if (this.topSince === null) this.topSince = t;
    } else {
      this.topSince = null;
    }
    if (angle <= bottomAngle) {
      if (this.bottomSince === null) this.bottomSince = t;
    } else {
      this.bottomSince = null;
    }
    const topStable = this.topSince !== null && t - this.topSince >= stableMs;
    const bottomStable = this.bottomSince !== null && t - this.bottomSince >= stableMs;
    let event = null;
    switch (this.phase) {
      case "idle": {
        if (topStable) {
          this.phase = "top";
          event = "top_established";
        }
        break;
      }
      case "top": {
        if (angle < descendAngle) {
          this.beginAttempt(t);
          event = "attempt_started";
        }
        break;
      }
      case "descending": {
        if (bottomStable) {
          this.phase = "bottom";
          this.reachedBottom = true;
        } else if (topStable) {
          event = this.finishAttempt(t);
          this.phase = "top";
        }
        break;
      }
      case "bottom": {
        if (angle > bottomAngle + 5) this.phase = "ascending";
        if (topStable) {
          event = this.finishAttempt(t);
          this.phase = "top";
        }
        break;
      }
      case "ascending": {
        if (bottomStable) {
          this.phase = "bottom";
          this.reachedBottom = true;
        } else if (topStable) {
          event = this.finishAttempt(t);
          this.phase = "top";
        }
        break;
      }
    }
    return this.snapshot(event);
  }
  beginAttempt(t) {
    this.phase = "descending";
    this.cycleStartMs = t;
    this.reachedBottom = false;
    this.cycleMinAngle = null;
    this.attemptedReps += 1;
  }
  finishAttempt(t) {
    const started = this.cycleStartMs;
    this.cycleStartMs = null;
    const minAngle = this.cycleMinAngle;
    this.cycleMinAngle = null;
    const reached = this.reachedBottom;
    this.reachedBottom = false;
    if (started === null) {
      this.incompleteReps += 1;
      this.lastRepDurationMs = null;
      return "attempt_incomplete";
    }
    const duration = t - started;
    const valid = reached && duration >= this.config.minCycleMs && duration <= this.config.maxCycleMs;
    this.lastAttempt = {
      startMs: started,
      endMs: t,
      durationMs: duration,
      minAngle,
      valid
    };
    if (valid) {
      this.reps += 1;
      this.lastRepDurationMs = duration;
      this.lastRepAtMs = t;
      return "rep_completed";
    }
    this.incompleteReps += 1;
    this.lastRepDurationMs = null;
    return "attempt_incomplete";
  }
  discardPartial() {
    const inCycle = this.phase === "descending" || this.phase === "bottom" || this.phase === "ascending";
    this.topSince = null;
    this.bottomSince = null;
    if (inCycle) {
      this.incompleteReps += 1;
      this.lastAttempt = {
        startMs: this.cycleStartMs ?? this.lastT ?? 0,
        endMs: this.lastT ?? 0,
        durationMs: this.cycleStartMs === null || this.lastT === null ? 0 : Math.max(0, this.lastT - this.cycleStartMs),
        minAngle: this.cycleMinAngle,
        valid: false
      };
      this.cycleStartMs = null;
      this.cycleMinAngle = null;
      this.reachedBottom = false;
      this.lastRepDurationMs = null;
      this.phase = "idle";
      return this.snapshot("attempt_discarded");
    }
    return this.snapshot(null);
  }
  snapshot(event) {
    return {
      phase: this.phase,
      reps: this.reps,
      attemptedReps: this.attemptedReps,
      incompleteReps: this.incompleteReps,
      lastRepDurationMs: this.lastRepDurationMs,
      lastRepAtMs: this.lastRepAtMs,
      event,
      lastAttempt: this.lastAttempt
    };
  }
};

// packages/pose-core/src/squat.ts
var DEFAULT_SQUAT_CONFIG = {
  standAngle: 160,
  descendAngle: 145,
  bottomAngle: 100,
  stableMs: 200,
  minCycleMs: 800,
  maxCycleMs: 8e3
};
function toSquatPhase(phase) {
  return phase === "top" ? "standing" : phase;
}
function toSquatEvent(event) {
  if (event === null) return null;
  return event === "top_established" ? "standing_established" : event;
}
var SquatCounter = class {
  counter;
  constructor(config = {}) {
    const merged = { ...DEFAULT_SQUAT_CONFIG, ...config };
    this.counter = new RepCycleCounter({
      topAngle: merged.standAngle,
      descendAngle: merged.descendAngle,
      bottomAngle: merged.bottomAngle,
      stableMs: merged.stableMs,
      minCycleMs: merged.minCycleMs,
      maxCycleMs: merged.maxCycleMs
    });
  }
  get phaseName() {
    return toSquatPhase(this.counter.phaseName);
  }
  update(sample) {
    const snap = this.counter.update(sample);
    return {
      phase: toSquatPhase(snap.phase),
      reps: snap.reps,
      attemptedReps: snap.attemptedReps,
      incompleteReps: snap.incompleteReps,
      lastRepDurationMs: snap.lastRepDurationMs,
      lastRepAtMs: snap.lastRepAtMs,
      event: toSquatEvent(snap.event),
      lastAttempt: snap.lastAttempt
    };
  }
};

// packages/pose-core/src/push-up.ts
var DEFAULT_PUSH_UP_CONFIG = {
  topAngle: 155,
  // 方案只给了顶位与底部阈值；中间阈值取 140 作为迟滞带，避免临界抖动
  descendAngle: 140,
  bottomAngle: 95,
  stableMs: 200,
  minCycleMs: 800,
  maxCycleMs: 1e4
};
var PushUpCounter = class {
  counter;
  constructor(config = {}) {
    this.counter = new RepCycleCounter({ ...DEFAULT_PUSH_UP_CONFIG, ...config });
  }
  get phaseName() {
    return this.counter.phaseName;
  }
  update(sample) {
    return this.counter.update(sample);
  }
};
var BodyLineMonitor = class {
  threshold;
  triggerMs;
  since = null;
  lastT = null;
  fired = false;
  constructor(threshold = 160, triggerMs = 500) {
    this.threshold = threshold;
    this.triggerMs = triggerMs;
  }
  /** 返回 null 的帧（不可评估）不累计，也不重置——避免丢点导致提示反复闪烁。 */
  observe(angle, timestampMs) {
    const t = timestampMs;
    if (this.lastT !== null && t <= this.lastT) {
      return this.report();
    }
    this.lastT = t;
    if (angle === null || !Number.isFinite(angle)) {
      return this.report();
    }
    if (angle < this.threshold) {
      if (this.since === null) this.since = t;
    } else {
      this.since = null;
      this.fired = false;
    }
    return this.report();
  }
  report() {
    const now = this.lastT ?? 0;
    const durationMs = this.since === null ? 0 : now - this.since;
    const deviating = durationMs >= this.triggerMs;
    const triggered = deviating && !this.fired;
    if (triggered) this.fired = true;
    return { deviating, durationMs, triggered };
  }
  reset() {
    this.since = null;
    this.lastT = null;
    this.fired = false;
  }
};

// packages/pose-core/src/plank.ts
var DEFAULT_PLANK_CONFIG = {
  minAngle: 160,
  maxAngle: 180,
  maxGapMs: 500
};
var PlankAccumulator = class {
  config;
  lastT = null;
  startedAt = null;
  validMs = 0;
  droppedMs = 0;
  gaps = 0;
  holding = false;
  /** 上一帧是否有效。跨无效帧的区间不能算有效时长：
   *  我们不知道那段时间用户是否保持，给它计时等于凭空加秒。 */
  prevValid = false;
  constructor(config = {}) {
    this.config = { ...DEFAULT_PLANK_CONFIG, ...config };
  }
  update(sample) {
    const t = sample.timestampMs;
    if (this.lastT !== null && t <= this.lastT) return this.snapshot();
    if (this.startedAt === null) this.startedAt = t;
    const previous = this.lastT;
    this.lastT = t;
    const angle = sample.angle;
    const angleValid = angle !== null && Number.isFinite(angle) && angle >= this.config.minAngle && angle <= this.config.maxAngle;
    const wasValid = this.prevValid;
    this.prevValid = angleValid;
    this.holding = angleValid;
    if (previous === null || !angleValid || !wasValid) return this.snapshot();
    const delta = t - previous;
    if (delta > this.config.maxGapMs) {
      this.droppedMs += delta;
      this.gaps += 1;
      return this.snapshot();
    }
    this.validMs += delta;
    return this.snapshot();
  }
  reset() {
    this.lastT = null;
    this.startedAt = null;
    this.validMs = 0;
    this.droppedMs = 0;
    this.gaps = 0;
    this.holding = false;
    this.prevValid = false;
  }
  snapshot() {
    const elapsedMs = this.startedAt === null || this.lastT === null ? 0 : this.lastT - this.startedAt;
    return {
      validMs: this.validMs,
      elapsedMs,
      ratio: elapsedMs > 0 ? this.validMs / elapsedMs : 0,
      holding: this.holding,
      droppedMs: this.droppedMs,
      gaps: this.gaps
    };
  }
};

// packages/pose-core/src/scoring.ts
function piecewise(value, points) {
  if (points.length === 0) throw new Error("piecewise \u9700\u8981\u81F3\u5C11\u4E00\u4E2A\u951A\u70B9");
  if (!Number.isFinite(value)) throw new Error("piecewise \u8F93\u5165\u5FC5\u987B\u4E3A\u6709\u9650\u6570");
  const first = points[0];
  if (value <= first.x) return first.y;
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const curr = points[i];
    if (value <= curr.x) {
      const span = curr.x - prev.x;
      if (span <= 0) return curr.y;
      const ratio = (value - prev.x) / span;
      return prev.y + (curr.y - prev.y) * ratio;
    }
  }
  return points[points.length - 1].y;
}
var DEFAULT_WEIGHTS = {
  compliance: 0.5,
  completion: 0.3,
  stability: 0.2
};
var MIN_COVERAGE = 0.8;
function clamp100(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.min(100, Math.max(0, v));
}
function scoreSession(input, weights = DEFAULT_WEIGHTS) {
  const subScores = {
    compliance: input.compliance === null ? null : clamp100(input.compliance),
    completion: input.completion === null ? null : clamp100(input.completion),
    stability: input.stability === null ? null : clamp100(input.stability)
  };
  const total = weights.compliance + weights.completion + weights.stability;
  if (Math.abs(total - 1) > 1e-9) {
    throw new Error(`\u6743\u91CD\u4E4B\u548C\u5FC5\u987B\u4E3A 1\uFF0C\u5F53\u524D\u4E3A ${total}`);
  }
  const parts = [];
  if (subScores.compliance !== null) parts.push({ value: subScores.compliance, weight: weights.compliance });
  if (subScores.completion !== null) parts.push({ value: subScores.completion, weight: weights.completion });
  if (subScores.stability !== null) parts.push({ value: subScores.stability, weight: weights.stability });
  if (parts.length === 0) {
    return {
      score: null,
      reason: "\u6CA1\u6709\u91C7\u96C6\u5230\u53EF\u8BC4\u4F30\u7684\u52A8\u4F5C\uFF0C\u5148\u8BA9\u8EAB\u4F53\u5B8C\u6574\u5165\u6846\u518D\u7EC3\u4E00\u6B21",
      provisional: true,
      subScores
    };
  }
  const weightSum = parts.reduce((acc, p) => acc + p.weight, 0);
  const raw = parts.reduce((acc, p) => acc + p.value * p.weight, 0) / weightSum;
  const notes = [];
  if (!Number.isFinite(input.coverage) || input.coverage < MIN_COVERAGE) {
    notes.push(`\u8986\u76D6\u7387\u4E3A ${(input.coverage * 100).toFixed(0)}%\uFF0C\u4F4E\u4E8E 80%\uFF0C\u5206\u6570\u4EC5\u4F5C\u53C2\u8003`);
  }
  if (parts.length < 3) {
    const missing = [];
    if (subScores.compliance === null) missing.push("\u89C4\u8303\u6027");
    if (subScores.completion === null) missing.push("\u5B8C\u6210\u5EA6");
    if (subScores.stability === null) missing.push("\u7A33\u5B9A\u6027");
    notes.push(`\u7F3A\u5C11${missing.join("\u3001")}\uFF0C\u5DF2\u6309\u53EF\u89C2\u6D4B\u9879\u6298\u7B97`);
  }
  return {
    score: Math.round(clamp100(raw) * 10) / 10,
    reason: notes.length > 0 ? notes.join("\uFF1B") : null,
    provisional: notes.length > 0,
    subScores
  };
}
function depthScoreOf(minAngle, bottomAngle) {
  if (minAngle === null || !Number.isFinite(minAngle)) return null;
  if (minAngle <= bottomAngle) return 100;
  return clamp100(100 - (minAngle - bottomAngle) * (100 / 35));
}
function paceScoreOf(durationMs, minCycleMs, maxCycleMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  const lower = Math.max(minCycleMs, 1200);
  const upper = Math.min(maxCycleMs, 4e3);
  if (durationMs < lower) return 70;
  if (durationMs <= upper) return 100;
  const over = durationMs - upper;
  return clamp100(100 - over / 6e3 * 60);
}
function scoreRep(input) {
  const depthScore = depthScoreOf(input.minAngle, input.bottomAngle);
  const paceScore = paceScoreOf(input.durationMs, input.minCycleMs, input.maxCycleMs);
  const parts = [];
  if (depthScore !== null) parts.push({ value: depthScore, weight: 0.7 });
  if (paceScore !== null) parts.push({ value: paceScore, weight: 0.3 });
  if (parts.length === 0) {
    return { score: null, depthScore, paceScore, label: "\u8FD9\u6B21\u6CA1\u770B\u6E05\uFF0C\u4E0D\u8BA1\u5206" };
  }
  const weightSum = parts.reduce((acc, p) => acc + p.weight, 0);
  const score = Math.round(parts.reduce((acc, p) => acc + p.value * p.weight, 0) / weightSum);
  const label = score >= 90 ? "\u8FD9\u6B21\u5F88\u6807\u51C6" : score >= 78 ? "\u8FD9\u6B21\u4E0D\u9519" : score >= 62 ? "\u8FD9\u6B21\u8FD8\u884C\uFF0C\u6DF1\u5EA6\u518D\u8DB3\u4E00\u70B9" : "\u8FD9\u6B21\u504F\u6D45\uFF0C\u6162\u4E00\u70B9\u8E72\u5230\u5E95";
  return { score, depthScore, paceScore, label };
}
var COMPLIANCE_CURVE = [
  { x: 0, y: 0 },
  { x: 0.5, y: 60 },
  { x: 0.8, y: 85 },
  { x: 1, y: 100 }
];

// packages/pose-core/src/stability.ts
var STABILITY_CURVE = [
  { x: 0, y: 100 },
  { x: 2, y: 100 },
  { x: 12, y: 0 }
];
var MIN_SAMPLES_PER_PHASE = 15;
var MAX_SAMPLES_PER_PHASE = 400;
function stdDev(values) {
  const n = values.length;
  if (n < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n;
  return Math.sqrt(variance);
}
var StabilityTracker = class {
  groups = /* @__PURE__ */ new Map();
  /**
   * 记录一个样本。phase 或 angle 无效时静默丢弃——
   * 调用方（门控之后）通常已过滤，这里再兜一层底。
   */
  add(phase, angleDeg) {
    if (phase === null || angleDeg === null || !Number.isFinite(angleDeg)) return;
    const arr = this.groups.get(phase) ?? [];
    arr.push(angleDeg);
    if (arr.length > MAX_SAMPLES_PER_PHASE) arr.shift();
    this.groups.set(phase, arr);
  }
  reset() {
    this.groups.clear();
  }
  snapshot() {
    let samples = 0;
    let weightedStdSum = 0;
    let phases = 0;
    for (const values of this.groups.values()) {
      if (values.length < MIN_SAMPLES_PER_PHASE) continue;
      const std2 = stdDev(values);
      weightedStdSum += std2 * values.length;
      samples += values.length;
      phases += 1;
    }
    if (samples === 0 || phases === 0) {
      return { stability: null, samples: 0, phases: 0, stdDeg: null };
    }
    const std = weightedStdSum / samples;
    return {
      stability: Math.round(piecewise(std, STABILITY_CURVE) * 10) / 10,
      samples,
      phases,
      stdDeg: Math.round(std * 10) / 10
    };
  }
};

// packages/pose-core/src/report.ts
var PACE_CV_STABLE = 0.25;
var PACE_CV_WILD = 0.4;
var MIN_INCOMPLETE_FOR_ISSUE = 1;
function fmtSec(ms) {
  return `${(ms / 1e3).toFixed(1)} \u79D2`;
}
function cv(values) {
  if (values.length < 3) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return null;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}
function buildWorkoutReport(input) {
  const highlights = [];
  const issues = [];
  const suggestions = [];
  const plan = [];
  const events = [];
  const completed = input.attempts.filter((a) => a.valid);
  for (const a of input.attempts) {
    events.push({
      code: a.valid ? "rep_completed" : "attempt_incomplete",
      startMs: a.startMs,
      endMs: a.endMs,
      observedValue: a.minAngle,
      thresholdValue: input.bottomAngle
    });
  }
  if (input.lostCount > 0) {
    events.push({
      code: "tracking_lost",
      startMs: 0,
      endMs: 0,
      observedValue: input.lostCount,
      thresholdValue: null
    });
  }
  if (input.bodyLineCount > 0) {
    events.push({
      code: "body_line_deviation",
      startMs: 0,
      endMs: 0,
      observedValue: input.bodyLineCount,
      thresholdValue: null
    });
  }
  if (input.mode === "rep") {
    if (completed.length > 0 && completed.length === input.attempted) {
      highlights.push(
        `\u5C1D\u8BD5 ${input.attempted} \u6B21\u3001\u5B8C\u6210 ${completed.length} \u6B21\u2014\u2014\u6CA1\u6709\u4E00\u6B21\u56E0\u4E3A\u5E45\u5EA6\u6216\u8282\u594F\u88AB\u6263`
      );
    }
    const depths = completed.map((a) => a.minAngle).filter((v) => v !== null);
    if (depths.length > 0 && input.bottomAngle !== null) {
      const worst = Math.max(...depths);
      if (worst <= input.bottomAngle) {
        highlights.push(`\u5E45\u5EA6\u5168\u90E8\u8FBE\u6807\uFF1A\u6700\u6DF1\u4E00\u6B21 ${Math.round(Math.min(...depths))}\xB0\uFF0C\u6700\u6D45\u4E00\u6B21\u4E5F\u5728 ${Math.round(worst)}\xB0 \u4EE5\u5185`);
      }
    }
    const durations = completed.map((a) => a.durationMs);
    const paceCv2 = cv(durations);
    if (paceCv2 !== null && paceCv2 < PACE_CV_STABLE) {
      highlights.push(`\u8282\u594F\u7A33\u5B9A\uFF1A\u5355\u6B21\u8017\u65F6\u5728 ${(Math.min(...durations) / 1e3).toFixed(1)}\u2013${(Math.max(...durations) / 1e3).toFixed(1)} \u79D2\u4E4B\u95F4`);
    }
  } else {
    if (input.validMs >= 3e4) highlights.push(`\u6709\u6548\u4FDD\u6301 ${fmtSec(input.validMs)}`);
    if (input.gaps === 0 && input.validMs > 0) highlights.push("\u5168\u7A0B\u65E0\u65AD\u6863");
  }
  if (input.lostCount === 0 && input.elapsedMs > 3e4) highlights.push("\u5168\u7A0B\u6CA1\u6709\u8DDF\u8E2A\u4E22\u5931");
  if (input.coverage >= 0.8) {
    highlights.push(`\u6709\u6548\u8986\u76D6\u7387 ${Math.round(input.coverage * 100)}%\uFF0C\u6570\u636E\u5B8C\u6574`);
  }
  const shallow = input.attempts.filter(
    (a) => !a.valid && a.minAngle !== null && (input.bottomAngle === null || a.minAngle > input.bottomAngle)
  );
  if (input.mode === "rep" && shallow.length >= MIN_INCOMPLETE_FOR_ISSUE) {
    const shallowest = Math.round(Math.max(...shallow.map((a) => a.minAngle)));
    issues.push({
      code: "depth_insufficient",
      text: `${shallow.length} \u6B21\u5E45\u5EA6\u4E0D\u8DB3\uFF1A\u6700\u6D45\u4E00\u6B21\u53EA\u5230 ${shallowest}\xB0\uFF08\u8981\u6C42 \u2264 ${input.bottomAngle}\xB0\uFF09`,
      count: shallow.length
    });
  }
  const tooFast = input.attempts.filter((a) => !a.valid && a.durationMs > 0 && a.minAngle !== null && (input.bottomAngle === null || a.minAngle <= input.bottomAngle));
  if (tooFast.length > 0) {
    issues.push({
      code: "pace_out_of_range",
      text: `${tooFast.length} \u6B21\u8282\u594F\u8D85\u51FA\u6709\u6548\u8303\u56F4\uFF08\u592A\u5FEB\u6216\u592A\u6162\uFF09`,
      count: tooFast.length
    });
  }
  const paceCv = cv(completed.map((a) => a.durationMs));
  if (paceCv !== null && paceCv > PACE_CV_WILD) {
    issues.push({
      code: "pace_inconsistent",
      text: "\u5B8C\u6210\u5468\u671F\u7684\u8017\u65F6\u957F\u77ED\u76F8\u5DEE\u8D85\u8FC7\u4E00\u500D\uFF0C\u8282\u594F\u5FFD\u5FEB\u5FFD\u6162",
      count: 1
    });
  }
  if (input.lostCount > 0) {
    issues.push({
      code: "tracking_lost",
      text: `\u8DDF\u8E2A\u4E22\u5931 ${input.lostCount} \u6B21\u3001\u5171 ${fmtSec(input.lostMs)}\uFF0C\u4E22\u5931\u671F\u95F4\u7684\u52A8\u4F5C\u65E0\u6CD5\u8BC4\u4F30`,
      count: input.lostCount
    });
  }
  if (input.bodyLineCount > 0) {
    issues.push({
      code: "body_line_deviation",
      text: `${input.bodyLineCount} \u6B21\u89C2\u5BDF\u5230\u80A9\u9ACB\u8E1D\u660E\u663E\u504F\u79BB\u76F4\u7EBF\uFF08\u4EC5\u63CF\u8FF0\u59FF\u6001\uFF0C\u4E0D\u6784\u6210\u53D7\u4F24\u5224\u65AD\uFF09`,
      count: input.bodyLineCount
    });
  }
  if (input.mode === "hold" && input.gaps > 0) {
    issues.push({
      code: "hold_breaks",
      text: `\u4FDD\u6301\u4E2D\u9014\u65AD\u6863 ${input.gaps} \u6B21\uFF0C\u65AD\u6863\u671F\u95F4\u4E0D\u8BA1\u5165\u6709\u6548\u65F6\u957F`,
      count: input.gaps
    });
  }
  if (input.coverage < 0.8 && input.validMs > 0) {
    issues.push({
      code: "low_coverage",
      text: `\u6709\u6548\u8986\u76D6\u7387\u53EA\u6709 ${Math.round(input.coverage * 100)}%\u2014\u2014\u753B\u9762\u91CC\u770B\u4E0D\u5168\u4F60\u65F6\uFF0C\u90A3\u4E00\u6574\u6BB5\u65F6\u95F4\u90FD\u65E0\u6CD5\u8BC4\u5206`,
      count: 1
    });
  }
  const has = (code) => issues.some((i) => i.code === code);
  if (has("depth_insufficient")) {
    suggestions.push("\u5E45\u5EA6\uFF1A\u4E0B\u8E72\u5230\u5927\u817F\u63A5\u8FD1\u5E73\u884C\u5730\u9762\u518D\u8D77\u8EAB\u3002\u5B81\u53EF\u6162\u4E00\u70B9\uFF0C\u5148\u505A\u8DB3\u6DF1\u5EA6\u518D\u63D0\u901F\u3002");
  }
  if (has("pace_out_of_range")) {
    suggestions.push("\u8282\u594F\uFF1A\u8BD5\u7740\u7528\u300C2 \u79D2\u4E0B\u3001\u5E95\u90E8\u7A0D\u505C\u30012 \u79D2\u8D77\u300D\u7684\u53E3\u4EE4\u63A7\u5236\u901F\u5EA6\u3002");
  }
  if (has("pace_inconsistent")) {
    suggestions.push("\u8282\u594F\uFF1A\u4FDD\u6301\u5300\u901F\uFF0C\u5FFD\u5FEB\u5FFD\u6162\u4F1A\u8BA9\u540E\u534A\u7A0B\u8D8A\u6765\u8D8A\u96BE\u4FDD\u6301\u540C\u6837\u7684\u5E45\u5EA6\u3002");
  }
  if (has("tracking_lost") || has("low_coverage")) {
    suggestions.push("\u73AF\u5883\uFF1A\u76F8\u673A\u653E\u8FDC\u4E00\u70B9\u3001\u5149\u7EBF\u4ECE\u6B63\u9762\u6765\uFF0C\u5168\u7A0B\u8BA9\u6574\u4E2A\u8EAB\u4F53\u7559\u5728\u753B\u9762\u91CC\u3002");
  }
  if (has("body_line_deviation")) {
    suggestions.push("\u59FF\u6001\uFF1A\u7559\u610F\u80A9\u3001\u9ACB\u3001\u8E1D\u662F\u5426\u6210\u4E00\u6761\u76F4\u7EBF\uFF0C\u8170\u8179\u6536\u7D27\u540E\u518D\u5F00\u59CB\u4E0B\u4E00\u6B21\u3002");
  }
  if (has("hold_breaks")) {
    suggestions.push("\u4FDD\u6301\uFF1A\u7D2F\u4E86\u5C31\u4F11\u606F\u4E00\u7EC4\u518D\u7EE7\u7EED\uFF0C\u786C\u6491\u7684\u65AD\u6863\u4E0D\u4F1A\u8BA1\u5165\u6709\u6548\u65F6\u957F\u3002");
  }
  if (suggestions.length === 0 && (input.reps > 0 || input.validMs > 0)) {
    suggestions.push("\u672C\u6B21\u6CA1\u6709\u89C2\u5BDF\u5230\u660E\u663E\u95EE\u9898\uFF0C\u6309\u5F53\u524D\u5E45\u5EA6\u548C\u8282\u594F\u7EE7\u7EED\u5373\u53EF\u3002");
  }
  if (input.mode === "rep") {
    if (input.reps >= 5) {
      const next = Math.ceil(input.reps * 1.2);
      plan.push(`\u4E0B\u6B21\u76EE\u6807 ${next} \u6B21\uFF08\u672C\u6B21 ${input.reps} \u6B21\uFF0C+20%\uFF09\uFF0C\u5206 2 \u7EC4\u5B8C\u6210\u3002`);
    } else if (input.reps > 0) {
      plan.push(`\u4E0B\u6B21\u4FDD\u6301 ${input.reps} \u6B21\u518D\u7EC3\u4E00\u7EC4\uFF0C\u5148\u7A33\u5B9A\u6570\u91CF\u3002`);
    } else {
      plan.push("\u5148\u4E0D\u8FFD\u6C42\u6570\u91CF\uFF1A\u5B8C\u6210 3 \u6B21\u5E45\u5EA6\u8FBE\u6807\u7684\u52A8\u4F5C\u5C31\u7B97\u8FBE\u6807\u3002");
    }
    if (has("depth_insufficient")) plan.push("\u7EC3\u5E45\u5EA6\u7684\u4E00\u5468\uFF1A\u6BCF\u6B21\u5230\u5E95\u90E8\u505C 1 \u79D2\uFF0C\u901F\u5EA6\u653E\u6162\u3002");
  } else {
    const targetSec = Math.max(10, Math.round(input.validMs * 1.15 / 5e3) * 5);
    plan.push(`\u4E0B\u6B21\u76EE\u6807\u4FDD\u6301 ${targetSec} \u79D2\uFF08\u672C\u6B21 ${fmtSec(input.validMs)}\uFF09\uFF0C\u5206 2 \u7EC4\u5B8C\u6210\u3002`);
  }
  if (input.stability !== null && input.stability < 60) {
    plan.push("\u7A33\u5B9A\u6027\u5206\u504F\u4F4E\uFF1A\u5BF9\u955C\u7EC3\u4E60\u5300\u901F\u8D77\u843D\uFF0C\u52A8\u4F5C\u8FC7\u7A0B\u4E2D\u5C3D\u91CF\u51CF\u5C11\u8EAB\u4F53\u6643\u52A8\u3002");
  }
  return { highlights, issues, suggestions, plan, events };
}

// packages/pose-core/src/form-coach.ts
var STALL_MS = 1500;
var COOLDOWN_MS = 5e3;
var FAST_REP_MS = 1500;
var FormCoach = class {
  /** 本组尝试中到达的最小角度 */
  best = Number.POSITIVE_INFINITY;
  /** 最后一次改善的时间 */
  bestAt = 0;
  lastHintAt = {};
  inCycle = false;
  reset() {
    this.best = Number.POSITIVE_INFINITY;
    this.bestAt = 0;
    this.lastHintAt = {};
    this.inCycle = false;
  }
  /** 返回本帧触发的建议；没有则 null。 */
  onFrame(sample) {
    const { phase, angle, timestampMs, bottomAngle, slackDeg } = sample;
    const cycleNow = phase === "descending" || phase === "bottom" || phase === "ascending";
    if (!cycleNow) {
      if (this.inCycle) this.reset();
      return null;
    }
    this.inCycle = true;
    if (angle === null || !Number.isFinite(angle)) return null;
    if (angle < this.best - 1) {
      this.best = angle;
      this.bestAt = timestampMs;
    }
    const reached = bottomAngle !== null && angle <= bottomAngle + slackDeg;
    if (!reached && bottomAngle !== null && angle > bottomAngle + 10 && timestampMs - this.bestAt >= STALL_MS) {
      if (this.passCooldown("deeper", timestampMs)) {
        this.bestAt = timestampMs;
        return "deeper";
      }
    }
    return null;
  }
  /** 单次完成后调用；返回节奏建议（可空）。 */
  onRepCompleted(durationMs, timestampMs) {
    if (durationMs < FAST_REP_MS && this.passCooldown("pace_fast", timestampMs)) {
      return "pace_fast";
    }
    return null;
  }
  passCooldown(key, now) {
    const last = this.lastHintAt[key];
    if (last !== void 0 && now - last < COOLDOWN_MS) return false;
    this.lastHintAt[key] = now;
    return true;
  }
};
var FORM_HINT_TEXT = {
  deeper: "\u518D\u8E72\u6DF1\u4E00\u70B9\uFF0C\u8E72\u5230\u5927\u817F\u63A5\u8FD1\u5E73\u884C",
  pace_fast: "\u8282\u594F\u6709\u70B9\u5FEB\uFF0C\u6162\u4E0B\u6162\u8D77\uFF0C\u5E45\u5EA6\u522B\u7F29\u6C34"
};

// packages/pose-core/src/calibrate.ts
var MIN_SAMPLES = 12;
var MIN_SPAN_MS = 500;
var MIN_PLAUSIBLE_STAND = 135;
var StandingCalibrator = class {
  samples = [];
  reset() {
    this.samples = [];
  }
  get sampleCount() {
    return this.samples.length;
  }
  /**
   * 喂入一帧角度；返回 null 表示样本还不够。
   * 只应在「用户应该站着」的时候调用（进入训练后的前几秒）。
   */
  observe(angle, timestampMs) {
    if (angle === null || !Number.isFinite(angle)) return null;
    this.samples.push({ angle, t: timestampMs });
    const cutoff = timestampMs - 3e3;
    while (this.samples.length > 0 && this.samples[0].t < cutoff) this.samples.shift();
    if (this.samples.length < MIN_SAMPLES) return null;
    const span = this.samples[this.samples.length - 1].t - this.samples[0].t;
    if (span < MIN_SPAN_MS) return null;
    return deriveThresholds(this.samples.map((s) => s.angle));
  }
};
function deriveThresholds(angles, mode = "side") {
  const valid = angles.filter((a) => Number.isFinite(a));
  if (valid.length < MIN_SAMPLES) return null;
  const sorted = [...valid].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9));
  const standRef = Math.round(sorted[idx]);
  if (standRef < MIN_PLAUSIBLE_STAND) return null;
  const depth = mode === "front" ? 65 : 80;
  const lo = mode === "front" ? 110 : 95;
  const hi = mode === "front" ? 125 : 105;
  const bottomAngle = Math.min(hi, Math.max(lo, standRef - depth));
  return {
    standRef,
    topAngle: standRef - 10,
    descendAngle: Math.max(bottomAngle + 12, standRef - 28),
    bottomAngle
  };
}

// preview/live/announcer.ts
var VoiceAnnouncer = class {
  lastAt = /* @__PURE__ */ new Map();
  synth;
  makeUtterance;
  /** 静音开关：训练页按钮控制。 */
  enabled = true;
  constructor(synth, makeUtterance) {
    this.synth = synth;
    this.makeUtterance = makeUtterance;
  }
  /**
   * 播报一条消息。
   * @param key 冷却键——同 key 的消息在冷却期内只播一次（如 'tracking_lost'）
   * @param cooldownMs 冷却时长；计数类消息给短冷却，提示类给长冷却
   */
  say(key, text, cooldownMs = 6e3) {
    if (!this.enabled || this.synth === null) return;
    const now = performance.now();
    const last = this.lastAt.get(key);
    if (last !== void 0 && now - last < cooldownMs) return;
    this.lastAt.set(key, now);
    this.synth.cancel();
    this.synth.speak(this.makeUtterance(text));
  }
  /** 会话重置时清冷却，否则上一组的静默会带到下一组。 */
  reset() {
    this.lastAt.clear();
  }
};
function createBrowserAnnouncer() {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
  const synth = window.speechSynthesis;
  return new VoiceAnnouncer(
    synth,
    (text) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "zh-CN";
      u.rate = 1;
      return u;
    }
  );
}

// preview/live/coach.ts
var COACH = {
  /** 门控稳定后：可以开始动了 */
  ready: "\u5DF2\u7ECF\u770B\u6E05\u4F60\u7684\u52A8\u4F5C\uFF0C\u53EF\u4EE5\u5F00\u59CB\u4E86",
  /** 跟踪丢失 */
  trackingLost: "\u6211\u8DDF\u4E0D\u4E0A\u4F60\u4E86\uFF0C\u5F80\u753B\u9762\u4E2D\u95F4\u7AD9\u4E00\u7AD9",
  /** 幅度/节奏不达标 */
  incomplete: "\u8FD9\u6B21\u5DEE\u4E00\u70B9\uFF0C\u5E45\u5EA6\u505A\u5230\u4F4D\u518D\u8D77\u6765",
  /** 关键点丢失作废 */
  discarded: "\u521A\u624D\u6CA1\u770B\u5168\uFF0C\u90A3\u4E00\u6B21\u4E0D\u7B97\uFF0C\u7AD9\u7A33\u6211\u4EEC\u518D\u6765",
  /** 身体线条偏离（俯卧撑） */
  bodyLine: "\u8170\u80CC\u6709\u70B9\u584C\uFF0C\u6536\u7D27\u6838\u5FC3\u518D\u6765\u4E00\u6B21",
  /** 多人 */
  multiPerson: "\u753B\u9762\u91CC\u4EBA\u591A\uFF0C\u6211\u5206\u4E0D\u6E05\u54EA\u4E2A\u662F\u4F60",
  /** 暂停 / 继续 */
  paused: "\u5DF2\u6682\u505C\uFF0C\u4F11\u606F\u4E00\u4E0B",
  /** 进入组间休息 */
  restStart: "\u76EE\u6807\u8FBE\u6210\uFF0C\u4F11\u606F\u4E00\u4E0B\uFF0C\u5598\u53E3\u6C14",
  /** 休息结束 */
  restEnd: "\u4F11\u606F\u7ED3\u675F\uFF0C\u5F00\u59CB\u4E0B\u4E00\u7EC4",
  /** 断档（平板） */
  holdBreak: (sec) => `\u65AD\u4E86 ${sec} \u79D2\uFF0C\u56DE\u6765\u7EE7\u7EED`
};
function countVoice(reps, goal) {
  if (goal === null || goal <= 0) return `${reps} \u6B21`;
  const remain = goal - reps;
  if (remain <= 0) return `${reps} \u6B21\uFF0C\u76EE\u6807\u8FBE\u6210`;
  if (remain <= 2) return `${reps} \u6B21\uFF0C\u8FD8\u5DEE ${remain} \u6B21`;
  if (reps === Math.ceil(goal / 2)) return `${reps} \u6B21\uFF0C\u8FC7\u534A\u4E86\uFF0C\u8282\u594F\u5F88\u597D`;
  return `${reps} \u6B21\uFF0C\u8FD8\u5DEE ${remain} \u6B21`;
}
function goalDoneVoice(reps, mode) {
  return mode === "rep" ? `\u76EE\u6807\u8FBE\u6210\uFF0C\u4E00\u5171 ${reps} \u6B21\uFF0C\u505A\u5F97\u597D\uFF01\u4F11\u606F\u4E00\u4E0B\uFF0C\u6216\u8005\u7EE7\u7EED\u52A0\u7EC3` : `\u76EE\u6807\u8FBE\u6210\uFF0C\u4FDD\u6301\u4E86 ${Math.round(reps)} \u79D2\uFF0C\u505A\u5F97\u597D\uFF01`;
}
function goalStatusText(done, goal, mode) {
  const unit = mode === "rep" ? "\u6B21" : "\u79D2";
  if (done >= goal) return `\u76EE\u6807 ${goal} ${unit} \xB7 \u5DF2\u8FBE\u6210 \u2713`;
  const pct = Math.min(100, Math.round(done / goal * 100));
  return `\u76EE\u6807 ${goal} ${unit} \xB7 \u5B8C\u6210 ${pct}%`;
}

// preview/live/local.ts
var storage = null;
function st() {
  if (storage !== null) return storage;
  if (typeof localStorage === "undefined") {
    throw new Error("\u65E0\u53EF\u7528\u5B58\u50A8\uFF08\u975E\u6D4F\u89C8\u5668\u73AF\u5883\u4E14\u672A\u6CE8\u5165\uFF09");
  }
  return localStorage;
}
var USERS_KEY = "af_local_users";
var AUTH_KEY = "af_local_auth";
var SESSIONS_KEY = "af_local_sessions";
var MAX_SESSIONS = 500;
async function pwHash(email, password) {
  const data = new TextEncoder().encode(`af-v1:${email}:${password}`);
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  let h = 0;
  for (const byte of data) h = h * 31 + byte >>> 0;
  return `fallback:${h}`;
}
function readUsers() {
  const raw = st().getItem(USERS_KEY);
  return raw ? JSON.parse(raw) : [];
}
function writeUsers(users) {
  st().setItem(USERS_KEY, JSON.stringify(users));
}
async function localRegister(email, password) {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) throw new Error("\u8BF7\u8F93\u5165\u6709\u6548\u90AE\u7BB1");
  if (password.length < 8) throw new Error("\u5BC6\u7801\u81F3\u5C11 8 \u4F4D");
  const users = readUsers();
  if (users.some((u) => u.email === normalized)) throw new Error("\u8BE5\u90AE\u7BB1\u5DF2\u5728\u672C\u673A\u6CE8\u518C\u8FC7");
  users.push({ email: normalized, pwHash: await pwHash(normalized, password), createdAt: Date.now() });
  writeUsers(users);
  localSetAuth(normalized);
}
async function localLogin(email, password) {
  const normalized = email.trim().toLowerCase();
  const user = readUsers().find((u) => u.email === normalized);
  if (!user) throw new Error("\u672C\u673A\u6CA1\u6709\u8FD9\u4E2A\u8D26\u53F7\uFF0C\u8BF7\u5148\u6CE8\u518C");
  if (await pwHash(normalized, password) !== user.pwHash) throw new Error("\u5BC6\u7801\u4E0D\u6B63\u786E");
  localSetAuth(normalized);
}
function localSetAuth(email) {
  st().setItem(AUTH_KEY, JSON.stringify({ email: email.trim().toLowerCase(), at: Date.now() }));
}
function localClearAuth() {
  st().removeItem(AUTH_KEY);
}
function localAuthEmail() {
  const raw = st().getItem(AUTH_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed.email ?? null;
  } catch {
    return null;
  }
}
function localSaveSession(email, payload, detail) {
  const row = {
    id: String(payload.client_session_id ?? crypto.randomUUID()),
    email,
    exercise_id: String(payload.exercise_id ?? "unknown"),
    rule_version: payload.rule_version === void 0 ? void 0 : String(payload.rule_version),
    started_at: String(payload.started_at ?? (/* @__PURE__ */ new Date()).toISOString()),
    ended_at: payload.ended_at === void 0 ? void 0 : String(payload.ended_at),
    active_ms: typeof payload.active_ms === "number" ? payload.active_ms : void 0,
    valid_ms: Number(payload.valid_ms ?? 0),
    reps: Number(payload.reps ?? 0),
    attempted_reps: Number(payload.attempted_reps ?? 0),
    incomplete_reps: Number(payload.incomplete_reps ?? 0),
    score: typeof payload.score === "number" ? payload.score : null,
    detail
  };
  const raw = st().getItem(SESSIONS_KEY);
  const all = raw ? JSON.parse(raw) : [];
  all.push(row);
  st().setItem(SESSIONS_KEY, JSON.stringify(all.slice(-MAX_SESSIONS)));
  return row;
}
function localListSessions(email) {
  const raw = st().getItem(SESSIONS_KEY);
  const all = raw ? JSON.parse(raw) : [];
  return all.filter((r) => r.email === email).sort((a, b) => a.started_at < b.started_at ? 1 : -1);
}
function localTrend(email, days = 7) {
  const since = Date.now() - days * 24 * 3600 * 1e3;
  const rows = localListSessions(email).filter((r) => new Date(r.started_at).getTime() >= since);
  const groups = /* @__PURE__ */ new Map();
  for (const r of rows) {
    const g = groups.get(r.exercise_id) ?? { sessions: 0, reps: 0 };
    g.sessions += 1;
    g.reps += r.reps;
    groups.set(r.exercise_id, g);
  }
  return Array.from(groups.entries()).map(([exercise_id, v]) => ({ exercise_id, ...v }));
}
function localClearSessions(email) {
  const raw = st().getItem(SESSIONS_KEY);
  const all = raw ? JSON.parse(raw) : [];
  const kept = all.filter((r) => r.email !== email);
  st().setItem(SESSIONS_KEY, JSON.stringify(kept));
  return all.length - kept.length;
}
function exportData(email) {
  const bundle = {
    app: "ai-fitness",
    version: 1,
    email,
    exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
    sessions: localListSessions(email)
  };
  return JSON.stringify(bundle, null, 2);
}
function importData(email, jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("\u6587\u4EF6\u4E0D\u662F\u6709\u6548\u7684 JSON");
  }
  const bundle = parsed;
  if (bundle.app !== "ai-fitness" || bundle.version !== 1 || !Array.isArray(bundle.sessions)) {
    throw new Error("\u4E0D\u662F\u672C\u5E94\u7528\u5BFC\u51FA\u7684\u5907\u4EFD\u6587\u4EF6");
  }
  const raw = st().getItem(SESSIONS_KEY);
  const all = raw ? JSON.parse(raw) : [];
  const ids = new Set(all.map((r) => r.id));
  let added = 0;
  let skipped = 0;
  for (const row of bundle.sessions) {
    if (!row || typeof row.id !== "string" || ids.has(row.id)) {
      skipped += 1;
      continue;
    }
    all.push({ ...row, email });
    ids.add(row.id);
    added += 1;
  }
  st().setItem(SESSIONS_KEY, JSON.stringify(all.slice(-MAX_SESSIONS)));
  return { added, skipped };
}

// preview/live/standards.ts
var STANDARDS = {
  squat: {
    id: "squat",
    name: "\u6DF1\u8E72",
    view: "\u4FA7\u9762\u89C6\u89D2 \xB7 \u5168\u8EAB\u5165\u6846",
    goal: "\u9ACB\u90E8\u540E\u5750\u3001\u819D\u89D2\u8E72\u5230\u7EA6 100\xB0\uFF0C\u5168\u7A0B\u5300\u901F\u3001\u8EAB\u4F53\u7A33\u5B9A\u3002",
    metrics: [
      {
        label: "\u5E95\u90E8\u819D\u89D2",
        value: "\u2264 100\xB0",
        hint: "KIMORE \u4E13\u5BB6\u8BA4\u5B9A\u6B63\u786E\u7684\u6DF1\u8E72\uFF0C\u819D\u5C48\u5CF0\u503C\u4E2D\u4F4D\u7EA6 80.8\xB0\uFF08\u819D\u89D2\u7EA6 99\xB0\uFF09\u3002\u6B63\u9762\u673A\u4F4D\u6295\u5F71\u4F1A\u4F4E\u4F30\u5C48\u66F2\uFF0C\u9608\u503C\u653E\u5BBD\u5230 115\xB0",
        source: "dataset"
      },
      {
        label: "\u5355\u6B21\u8282\u594F",
        value: "0.8 \u2013 8 \u79D2",
        hint: "\u4F4E\u4E8E 0.8 \u79D2\u591A\u534A\u662F\u6296\u52A8\u8BEF\u5224\uFF0C\u8D85\u8FC7 8 \u79D2\u89C6\u4E3A\u4E2D\u65AD",
        source: "assumption"
      },
      {
        label: "\u5E95\u90E8\u505C\u7559",
        value: "\u2265 200 ms",
        hint: "\u907F\u514D\u300C\u8DEF\u8FC7\u300D\u76EE\u6807\u89D2\u5EA6\u5C31\u8D77\u8EAB",
        source: "assumption"
      },
      {
        label: "\u6709\u6548\u8986\u76D6\u7387",
        value: "\u2265 80% \u4E3A\u6B63\u5F0F\u5206",
        hint: "\u8EAB\u4F53\u5B8C\u6574\u5165\u6846\u7684\u65F6\u95F4\u5360\u6BD4\uFF1B\u4F4E\u4E8E 80% \u4ECD\u51FA\u5206\uFF0C\u4F46\u6807\u6CE8\u300C\u53C2\u8003\u300D",
        source: "assumption"
      }
    ],
    steps: [
      "\u53CC\u811A\u4E0E\u80A9\u540C\u5BBD\uFF0C\u811A\u5C16\u7565\u5916\u5C55\uFF0C\u4FA7\u8EAB\u7AD9\u5728\u79BB\u955C\u5934 2\u20133 \u7C73\u5904",
      "\u9ACB\u90E8\u5148\u5411\u540E\u5750\uFF0C\u819D\u76D6\u671D\u811A\u5C16\u65B9\u5411\uFF0C\u4E0D\u8981\u5185\u6263",
      "\u8E72\u5230\u5927\u817F\u63A5\u8FD1\u4E0E\u5730\u9762\u5E73\u884C\uFF08\u819D\u89D2\u7EA6 100\xB0\uFF09\uFF0C\u5E95\u90E8\u505C\u4E00\u4E0B",
      "\u5300\u901F\u8D77\u8EAB\u56DE\u5230\u7AD9\u76F4\uFF0C\u819D\u76D6\u4E0D\u8FC7\u5EA6\u9501\u6B7B"
    ],
    mistakes: [
      {
        name: "\u4E0B\u8E72\u8FC7\u6D45",
        detail: "\u819D\u89D2\u5927\u4E8E 100\xB0 \u5C31\u8D77\u8EAB\uFF0C\u4E3B\u8981\u9760\u819D\u800C\u975E\u9ACB\u53D1\u529B",
        detectable: true,
        note: "\u4F1A\u5728\u5C4F\u5E55\u63D0\u793A\u300C\u518D\u8E72\u6DF1\u4E00\u70B9\u300D\uFF0C\u4E14\u8BE5\u6B21\u4E0D\u8BA1\u5165\u6709\u6548\u6B21\u6570"
      },
      {
        name: "\u8282\u594F\u8FC7\u5FEB",
        detail: "\u5355\u6B21\u4E0D\u8DB3 1.5 \u79D2\uFF0C\u5E45\u5EA6\u901A\u5E38\u8DDF\u7740\u7F29\u6C34",
        detectable: true,
        note: "\u5B8C\u6210\u540E\u64AD\u62A5\u300C\u8282\u594F\u6709\u70B9\u5FEB\uFF0C\u6162\u4E0B\u6162\u8D77\u300D"
      },
      {
        name: "\u819D\u76D6\u5185\u6263",
        detail: "\u819D\u76D6\u5411\u5185\u4FA7\u5012\uFF08Fitness-AQA \u7684 Knees Inward\uFF09",
        detectable: false,
        note: "\u4FA7\u9762\u673A\u4F4D\u770B\u4E0D\u5230\uFF0C\u9700\u8981\u6B63\u9762\u673A\u4F4D\uFF0C\u6682\u4E0D\u5224\u5B9A"
      },
      {
        name: "\u819D\u76D6\u8FC7\u5EA6\u524D\u79FB",
        detail: "\u819D\u76D6\u660E\u663E\u8D8A\u8FC7\u811A\u5C16\u3001\u91CD\u5FC3\u8FC7\u5EA6\u524D\u538B",
        detectable: false,
        note: "\u9700\u7A33\u5B9A\u7684\u8DB3\u90E8\u5173\u952E\u70B9\uFF0C\u5F53\u524D\u6A21\u578B\u7CBE\u5EA6\u4E0D\u8DB3"
      }
    ],
    notJudged: ["\u819D\u76D6\u5185\u6263 / \u5916\u7FFB", "\u5F13\u80CC\u7EC6\u8282", "\u8DB3\u5F13\u584C\u9677"]
  },
  push_up: {
    id: "push_up",
    name: "\u4FEF\u5367\u6491",
    view: "\u4FA7\u9762\u89C6\u89D2 \xB7 \u9700\u8981\u770B\u5230\u80A9\u3001\u9ACB\u3001\u8E1D",
    goal: "\u8EAB\u4F53\u4ECE\u5934\u5230\u811A\u6210\u4E00\u6761\u76F4\u7EBF\uFF0C\u8098\u90E8\u4E0B\u964D\u5230\u7EA6 95\xB0 \u518D\u63A8\u8D77\u3002",
    metrics: [
      {
        label: "\u5E95\u90E8\u8098\u89D2",
        value: "\u2264 95\xB0",
        hint: "\u5DE5\u7A0B\u521D\u59CB\u503C\uFF0C\u5F85\u7528 UI-PRMD \u7684\u6B63\u786E/\u9519\u8BEF\u53D8\u4F53\u6821\u51C6",
        source: "assumption"
      },
      {
        label: "\u8EAB\u4F53\u7EBF\u6761",
        value: "\u2265 160\xB0",
        hint: "\u80A9\u2013\u9ACB\u2013\u8E1D\u5939\u89D2\u4F4E\u4E8E 160\xB0 \u6301\u7EED 500ms \u4F1A\u63D0\u793A\uFF08\u4EC5\u63CF\u8FF0\uFF0C\u4E0D\u505A\u53D7\u4F24\u5224\u65AD\uFF09",
        source: "assumption"
      },
      {
        label: "\u5355\u6B21\u8282\u594F",
        value: "0.8 \u2013 10 \u79D2",
        hint: "\u4FEF\u5367\u6491\u6BD4\u6DF1\u8E72\u5E45\u5EA6\u5927\uFF0C\u5141\u8BB8\u66F4\u6162",
        source: "assumption"
      },
      {
        label: "\u6709\u6548\u8986\u76D6\u7387",
        value: "\u2265 80%",
        hint: "\u80A9\u8098\u8155/\u9ACB\u8E1D\u90FD\u8981\u7A33\u5B9A\u53EF\u89C1",
        source: "assumption"
      }
    ],
    steps: [
      "\u4FA7\u5BF9\u955C\u5934\u6491\u5730\uFF08\u8D34\u5730\u52A8\u4F5C\u5EFA\u8BAE\u5207\u540E\u7F6E\u6444\u50CF\u5934\uFF09\uFF0C\u53CC\u624B\u7565\u5BBD\u4E8E\u80A9",
      "\u6536\u7D27\u6838\u5FC3\u4E0E\u81C0\u90E8\uFF0C\u5934\u3001\u80CC\u3001\u9ACB\u3001\u817F\u6210\u4E00\u6761\u76F4\u7EBF",
      "\u8098\u90E8\u5F2F\u66F2\u4E0B\u964D\uFF0C\u80F8\u53E3\u63A5\u8FD1\u5730\u9762\uFF08\u4E0D\u89E6\u5730\uFF09\uFF0C\u8098\u89D2\u7EA6 95\xB0",
      "\u63A8\u8D77\u56DE\u5230\u8D77\u59CB\u4F4D\uFF0C\u5168\u7A0B\u8170\u4E0D\u8981\u584C"
    ],
    mistakes: [
      {
        name: "\u584C\u8170",
        detail: "\u8170\u90E8\u4E0B\u6C89\uFF0C\u80A9\u9ACB\u8E1D\u4E0D\u5728\u4E00\u6761\u7EBF\u4E0A",
        detectable: true,
        note: "\u4F1A\u64AD\u62A5\u300C\u8170\u80CC\u6709\u70B9\u584C\uFF0C\u6536\u7D27\u6838\u5FC3\u518D\u6765\u4E00\u6B21\u300D"
      },
      {
        name: "\u5E45\u5EA6\u4E0D\u8DB3",
        detail: "\u8098\u90E8\u6CA1\u6709\u964D\u5230 95\xB0 \u5C31\u63A8\u8D77",
        detectable: true,
        note: "\u8BE5\u6B21\u4E0D\u8BA1\u5165\u6709\u6548\u6B21\u6570\uFF0C\u5E76\u63D0\u793A\u5E45\u5EA6"
      },
      {
        name: "\u80A9\u80DB\u8FC7\u5EA6\u524D\u4F38 / \u624B\u8098\u5916\u5F20\u89D2\u5EA6",
        detail: "\u5C5E\u4E8E\u7CBE\u7EC6\u52A8\u4F5C\u8D28\u91CF\uFF0C\u9700\u8981 3D \u59FF\u6001",
        detectable: false,
        note: "2D \u5173\u952E\u70B9\u65E0\u6CD5\u53EF\u9760\u5224\u65AD\uFF0C\u6682\u4E0D\u5224\u5B9A"
      }
    ],
    notJudged: ["\u624B\u8098\u5916\u5F20\u89D2\u5EA6", "\u80A9\u80DB\u7A33\u5B9A\u7EC6\u8282", "\u624B\u8155\u538B\u529B"]
  },
  plank: {
    id: "plank",
    name: "\u5E73\u677F\u652F\u6491",
    view: "\u4FA7\u9762\u89C6\u89D2 \xB7 \u9700\u8981\u770B\u5230\u80A9\u3001\u9ACB\u3001\u8E1D",
    goal: "\u80A9\u9ACB\u8E1D\u6210\u4E00\u6761\u76F4\u7EBF\uFF0C\u4FDD\u6301\u671F\u95F4\u5C3D\u91CF\u4E0D\u6643\u52A8\u3002",
    metrics: [
      {
        label: "\u8EAB\u4F53\u7EBF\u6761",
        value: "160 \u2013 180\xB0",
        hint: "\u4F4E\u4E8E 160\xB0 \u89C6\u4E3A\u584C\u8170\uFF0C\u8D85\u8FC7 180\xB0 \u89C6\u4E3A\u6485\u81C0\uFF08\u89D2\u5EA6\u4E0A\u4E0D\u53EF\u8FBE\uFF0C\u7B49\u4EF7\u4E8E\u59FF\u6001\u5F02\u5E38\uFF09",
        source: "assumption"
      },
      {
        label: "\u65AD\u6863\u5224\u5B9A",
        value: "> 500 ms",
        hint: "\u6389\u51FA\u8303\u56F4\u8D85\u8FC7 0.5 \u79D2\u8BB0\u4E3A\u4E00\u6B21\u65AD\u6863",
        source: "assumption"
      },
      {
        label: "\u8BA1\u65F6\u53E3\u5F84",
        value: "\u524D\u540E\u5E27\u90FD\u6709\u6548",
        hint: "\u5173\u952E\u70B9\u4E22\u5931\u7684\u533A\u95F4\u4E0D\u8BA1\u65F6\u2014\u2014\u5B81\u53EF\u5C11\u7B97\uFF0C\u4E0D\u865A\u589E",
        source: "assumption"
      }
    ],
    steps: [
      "\u8098\u90E8\u4F4D\u4E8E\u80A9\u6B63\u4E0B\u65B9\uFF0C\u524D\u81C2\u8D34\u5730",
      "\u6536\u7D27\u8170\u8179\u4E0E\u81C0\u90E8\uFF0C\u80A9\u2013\u9ACB\u2013\u8E1D\u6210\u4E00\u6761\u76F4\u7EBF",
      "\u5934\u90E8\u4FDD\u6301\u4E2D\u7ACB\uFF0C\u5747\u5300\u547C\u5438\uFF0C\u4E0D\u8981\u618B\u6C14",
      "\u611F\u5230\u8170\u584C\u5C31\u5148\u4F11\u606F\uFF0C\u786C\u6491\u7684\u65AD\u6863\u4E0D\u8BA1\u5165\u6709\u6548\u65F6\u957F"
    ],
    mistakes: [
      {
        name: "\u584C\u8170",
        detail: "\u9ACB\u90E8\u4E0B\u6C89\uFF0C\u8170\u690E\u8FC7\u5EA6\u524D\u51F8",
        detectable: true,
        note: "\u65AD\u6863\u63D0\u793A\u4F1A\u544A\u77E5\u4E22\u5F03\u4E86\u591A\u5C11\u79D2"
      },
      {
        name: "\u6485\u81C0",
        detail: "\u9ACB\u90E8\u62AC\u5F97\u8FC7\u9AD8\uFF0C\u8EAB\u4F53\u5448\u5012 V",
        detectable: false,
        note: "\u89D2\u5EA6\u6A21\u578B\u5BF9\u300C\u8FC7\u9AD8\u300D\u4E0D\u654F\u611F\uFF0C\u6682\u4E0D\u5355\u72EC\u5224\u5B9A"
      }
    ],
    notJudged: ["\u9AA8\u76C6\u524D\u540E\u503E", "\u80A9\u80DB\u7A33\u5B9A\u6027"]
  }
};
var STANDARD_DISCLAIMER = "\u6570\u503C\u7684\u4E24\u4E2A\u6765\u6E90\u5DF2\u5728\u6BCF\u9879\u6807\u6CE8\uFF1A\u6570\u636E = \u516C\u5F00\u6570\u636E\u96C6\u7EDF\u8BA1\uFF08KIMORE 78 \u4EBA / Fitness-AQA \u6559\u7EC3\u6807\u6CE8\uFF09\uFF0C\u5047\u8BBE = \u5DE5\u7A0B\u521D\u59CB\u503C\uFF0C\u5F85\u771F\u5B9E\u6570\u636E\u6821\u51C6\u3002\u672C\u9875\u53EA\u63CF\u8FF0\u8FD0\u52A8\u5B66\u4E8B\u5B9E\uFF0C\u4E0D\u6784\u6210\u533B\u7597\u5EFA\u8BAE\u3002";

// apps/client/src/platform/web/pose-runtime.ts
var DEFAULTS = {
  wasmPath: "/static/wasm",
  modelPath: "/static/models/pose_landmarker_lite.task",
  targetHz: 15,
  numPoses: 1,
  // 首帧要编译计算图，慢机器上可能 2–3 秒，留足余量
  stallMs: 6e3,
  workerType: "module"
};
var MediaPipePoseRuntime = class {
  capabilities = {
    jointSet: [
      "left_shoulder",
      "right_shoulder",
      "left_elbow",
      "right_elbow",
      "left_wrist",
      "right_wrist",
      "left_hip",
      "right_hip",
      "left_knee",
      "right_knee",
      "left_ankle",
      "right_ankle",
      "left_heel",
      "right_heel",
      "left_foot_index",
      "right_foot_index"
    ],
    coordinateSpace: "pixels-rotated-unmirrored",
    confidenceSemantics: "adapter-mapped-v1",
    runtimeVersion: "mediapipe-tasks-vision-1.1.1",
    modelVersion: "pose_landmarker_lite-1",
    supportedViews: ["side", "front"],
    maxInferenceHz: 15
  };
  options;
  worker = null;
  video = null;
  running = false;
  rafId = 0;
  seq = 0;
  /** 在途帧。非空时丢弃新帧，这是背压的唯一手段。 */
  inFlight = null;
  lastSentAtMs = 0;
  consecutiveErrors = 0;
  /** 诊断计数：出问题时能定位是「没发出去」还是「没回来」。 */
  stats = { sent: 0, results: 0, stalls: 0, errors: 0, lastSentId: 0, lastResultId: 0 };
  getStats() {
    return { ...this.stats };
  }
  frameHandlers = /* @__PURE__ */ new Set();
  errorHandlers = /* @__PURE__ */ new Set();
  poseCountHandlers = /* @__PURE__ */ new Set();
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
  }
  onPose(handler) {
    this.frameHandlers.add(handler);
    return () => this.frameHandlers.delete(handler);
  }
  onError(handler) {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }
  /** 每帧检测到的人数，用于提示「画面里有多人」。 */
  onPoseCount(handler) {
    this.poseCountHandlers.add(handler);
    return () => this.poseCountHandlers.delete(handler);
  }
  async start(video2) {
    if (this.running) return;
    if (!video2) throw new PoseAdapterError("runtime_failed", "\u7F3A\u5C11\u89C6\u9891\u5143\u7D20");
    if (typeof Worker === "undefined") {
      throw new PoseAdapterError("not_supported", "\u5F53\u524D\u73AF\u5883\u4E0D\u652F\u6301 Web Worker");
    }
    this.video = video2;
    this.running = true;
    const workerUrl = this.options.workerUrl ?? new URL("./pose-worker.ts", import.meta.url);
    const worker = new Worker(
      workerUrl,
      this.options.workerType === "classic" ? void 0 : { type: "module" }
    );
    this.worker = worker;
    try {
      await this.initWorker(worker);
    } catch (error) {
      this.running = false;
      this.worker = null;
      worker.terminate();
      throw error instanceof PoseAdapterError ? error : new PoseAdapterError("runtime_failed", "\u63A8\u7406\u8FD0\u884C\u65F6\u542F\u52A8\u5931\u8D25", error);
    }
    this.loop();
  }
  async stop() {
    this.running = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    const worker = this.worker;
    this.worker = null;
    this.inFlight = null;
    this.video = null;
    if (worker) {
      worker.postMessage({ type: "stop" });
      worker.terminate();
    }
  }
  /** 运行状态，供页面显示「仅预览 / 正在评估」。 */
  get isRunning() {
    return this.running && this.worker !== null;
  }
  initWorker(worker) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new PoseAdapterError("runtime_failed", "\u6A21\u578B\u52A0\u8F7D\u8D85\u65F6\uFF0815 \u79D2\uFF09"));
      }, 15e3);
      const cleanup = () => {
        clearTimeout(timeout);
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
      };
      const onMessage = (event) => {
        const data = event.data;
        if (data.type === "ready") {
          cleanup();
          resolve();
        } else if (data.type === "error") {
          cleanup();
          reject(new PoseAdapterError("runtime_failed", data.message ?? "\u6A21\u578B\u52A0\u8F7D\u5931\u8D25"));
        }
      };
      const onError = (event) => {
        cleanup();
        reject(new PoseAdapterError("runtime_failed", event.message || "Worker \u542F\u52A8\u5931\u8D25"));
      };
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      worker.addEventListener("message", this.handleWorkerMessage);
      worker.postMessage({
        type: "init",
        wasmPath: this.options.wasmPath,
        modelPath: this.options.modelPath,
        numPoses: this.options.numPoses
      });
    });
  }
  handleWorkerMessage = (event) => {
    const data = event.data;
    if (data.type === "result") {
      this.inFlight = null;
      this.consecutiveErrors = 0;
      this.stats.results += 1;
      this.stats.lastResultId = data.id ?? 0;
      const video2 = this.video;
      if (!video2) return;
      const { frame, poseCount } = mapPoseLandmarks(
        data.landmarks ?? [],
        {
          width: video2.videoWidth,
          height: video2.videoHeight,
          timestampMs: data.timestampMs ?? performance.now()
        }
      );
      for (const handler of this.poseCountHandlers) handler(poseCount);
      for (const handler of this.frameHandlers) handler(frame);
      return;
    }
    if (data.type === "error") {
      this.inFlight = null;
      this.consecutiveErrors += 1;
      this.emitError(new PoseAdapterError("runtime_failed", data.message ?? "\u63A8\u7406\u5931\u8D25"));
      if (this.consecutiveErrors >= 3) {
        void this.stop();
        this.emitError(
          new PoseAdapterError("runtime_failed", "\u8FDE\u7EED\u63A8\u7406\u5931\u8D25\uFF0C\u5DF2\u505C\u6B62\u8BC4\u4F30\uFF1B\u8BF7\u5237\u65B0\u9875\u9762\u91CD\u8BD5")
        );
      }
    }
  };
  loop = () => {
    if (!this.running) return;
    const now = performance.now();
    const warmedUp = this.stats.results > 0;
    if (warmedUp && this.inFlight && now - this.inFlight.sentAtMs > this.options.stallMs) {
      this.stats.stalls += 1;
      this.inFlight = null;
      this.consecutiveErrors += 1;
      this.emitError(new PoseAdapterError("runtime_failed", "\u63A8\u7406\u8D85\u65F6\uFF0C\u5DF2\u4E22\u5F03\u8BE5\u5E27"));
    }
    const interval = 1e3 / this.options.targetHz;
    if (!this.inFlight && now - this.lastSentAtMs >= interval) {
      void this.capture(now);
    }
    this.rafId = requestAnimationFrame(this.loop);
  };
  async capture(timestampMs) {
    const video2 = this.video;
    const worker = this.worker;
    if (!video2 || !worker || !this.running || this.inFlight) return;
    if (video2.readyState < 2 || video2.videoWidth === 0) return;
    this.lastSentAtMs = timestampMs;
    const id = ++this.seq;
    this.inFlight = { id, sentAtMs: timestampMs };
    this.stats.sent += 1;
    this.stats.lastSentId = id;
    try {
      const bitmap = await createImageBitmap(video2);
      if (!this.running) {
        bitmap.close();
        return;
      }
      worker.postMessage({ type: "frame", id, bitmap, timestampMs: Math.round(timestampMs) }, [
        bitmap
      ]);
    } catch (error) {
      this.inFlight = null;
      this.emitError(new PoseAdapterError("runtime_failed", "\u6293\u5E27\u5931\u8D25", error));
    }
  }
  emitError(error) {
    for (const handler of this.errorHandlers) handler(error);
  }
};
function createPoseRuntime(options = {}) {
  return new MediaPipePoseRuntime(options);
}

// preview/live/app.ts
var $ = (id) => {
  const el2 = document.getElementById(id);
  if (!el2) throw new Error(`\u7F3A\u5C11\u5143\u7D20 #${id}`);
  return el2;
};
function show(name) {
  for (const node of document.querySelectorAll(".screen")) {
    node.classList.toggle("show", node.id === `screen-${name}`);
  }
  document.body.dataset.screen = name;
}
var EXERCISES = {
  squat: {
    id: "squat",
    label: "\u6DF1\u8E72",
    unit: "rep",
    rule: "squat-side-0.1.0",
    bottomAngle: 100,
    minCycleMs: 800,
    maxCycleMs: 8e3,
    joints: (side) => ({
      vertex: `${side}_knee`,
      from: `${side}_hip`,
      to: `${side}_ankle`,
      required: [`${side}_hip`, `${side}_knee`, `${side}_ankle`]
    })
  },
  push_up: {
    id: "push_up",
    label: "\u4FEF\u5367\u6491",
    unit: "rep",
    rule: "push-up-side-0.1.0",
    bottomAngle: 95,
    minCycleMs: 800,
    maxCycleMs: 1e4,
    joints: (side) => ({
      vertex: `${side}_elbow`,
      from: `${side}_shoulder`,
      to: `${side}_wrist`,
      required: [`${side}_shoulder`, `${side}_elbow`, `${side}_wrist`]
    })
  },
  plank: {
    id: "plank",
    label: "\u5E73\u677F\u652F\u6491",
    unit: "hold",
    rule: "plank-side-0.1.0",
    bottomAngle: null,
    minCycleMs: 0,
    maxCycleMs: 0,
    joints: (side) => ({
      vertex: `${side}_hip`,
      from: `${side}_shoulder`,
      to: `${side}_ankle`,
      required: [`${side}_shoulder`, `${side}_hip`, `${side}_ankle`]
    })
  }
};
var HINTS = {
  squat: "\u4FA7\u8EAB\u7AD9\u5728\u79BB\u955C\u5934 2\u20133 \u7C73\u5904\uFF08\u5168\u8EAB\u5165\u6846\u7684\u6B63\u5E38\u8DDD\u79BB\uFF09\uFF0C\u4E0B\u8E72\u5230\u819D\u89D2\u63A5\u8FD1 100\xB0 \u518D\u8D77\u8EAB\u3002",
  push_up: "\u4FA7\u5BF9\u955C\u5934\u6491\u5730\uFF08\u4FEF\u5367\u6491\u65F6\u53EF\u4EE5\u5207\u5230\u540E\u7F6E\u6444\u50CF\u5934\uFF09\uFF0C\u8098\u90E8\u4E0B\u964D\u5230\u7EA6 95\xB0\uFF1B\u8EAB\u4F53\u4FDD\u6301\u4E00\u6761\u76F4\u7EBF\u3002",
  plank: "\u4FA7\u5BF9\u955C\u5934\uFF0C\u80A9\u9ACB\u8E1D\u63A5\u8FD1 180\xB0\uFF0C\u4FDD\u6301\u671F\u95F4\u5C3D\u91CF\u4E0D\u52A8\u3002"
};
var account = null;
var activeExercise = "squat";
var camera = null;
var runtime = null;
var tracker = new QualityTracker(500);
var squatCounter = new SquatCounter();
var pushUpCounter = new PushUpCounter();
var bodyLine = new BodyLineMonitor();
var plankAcc = new PlankAccumulator();
var lockedSide = null;
var running = false;
var paused = false;
var sessionStartMs = Date.now();
var lastWindow = { validMs: 0, invalidMs: 0, coverage: 0 };
var lastSquat = { reps: 0, attemptedReps: 0, incompleteReps: 0 };
var lastPushUp = { reps: 0, attemptedReps: 0, incompleteReps: 0 };
var lastPlank = { validMs: 0, gaps: 0, droppedMs: 0 };
var sessionAttempts = [];
var lostCount = 0;
var lostMs = 0;
var lostAt = null;
var bodyLineCount = 0;
var frameCount = 0;
var fpsWindowStart = 0;
var trackerStarted = false;
var stabilityTracker = new StabilityTracker();
var compliantMs = 0;
var lastComplianceTs = null;
var angleHistory = [];
var lastScore = null;
var lastReport = null;
var lastDetail = null;
var lastCard = null;
var repScores = [];
var calibrator = new StandingCalibrator();
var calibration = null;
var incompleteStreak = 0;
var announcer = createBrowserAnnouncer();
var sessionGoal = 10;
var goalDoneAnnounced = false;
var sets = [];
var resting = false;
var restEndsAt = 0;
var restLastAnnounced = -1;
var setStartMs = 0;
var setStartReps = 0;
var setStartValidMs = 0;
var restTimer = null;
var REST_KEY = "af_rest_seconds";
var REST_OPTIONS = [30, 45, 60, 90];
var restSeconds = (() => {
  const saved = Number(localStorage.getItem(REST_KEY));
  return REST_OPTIONS.includes(saved) ? saved : 60;
})();
var formCoach = new FormCoach();
var VIEW_KEY = "af_view_mode";
var viewMode = localStorage.getItem(VIEW_KEY) === "front" ? "front" : "side";
var FRONT_SQUAT = { standAngle: 172, descendAngle: 158, bottomAngle: 115 };
function currentBottomAngle() {
  if (activeExercise === "squat") {
    if (calibration !== null) return calibration.bottomAngle;
    return viewMode === "front" ? FRONT_SQUAT.bottomAngle : EXERCISES.squat.bottomAngle;
  }
  return EXERCISES[activeExercise].bottomAngle;
}
function updateCalibHint() {
  const el2 = document.getElementById("calibHint");
  if (!el2) return;
  if (activeExercise !== "squat") {
    el2.textContent = "";
    return;
  }
  el2.textContent = calibration === null ? "\u6821\u51C6\u4E2D\u2026 \u8BF7\u5148\u7AD9\u76F4 1\u20132 \u79D2" : `\u5DF2\u6821\u51C6\uFF1A\u7AD9\u7ACB ${calibration.standRef}\xB0 \xB7 \u76EE\u6807 \u2264${calibration.bottomAngle}\xB0`;
}
var SENS_KEY = "af_sensitivity";
var sensitivity = localStorage.getItem(SENS_KEY) === "sensitive" ? "sensitive" : "standard";
function gateConfig() {
  if (sensitivity !== "sensitive") return void 0;
  return {
    minConfidence: 0.5,
    maxFrameAgeMs: 450,
    // 侧面机位最常丢的是远端踝：单独放宽，而不是整体降门槛
    jointOverrides: { left_ankle: 0.38, right_ankle: 0.38, left_wrist: 0.4, right_wrist: 0.4 }
  };
}
var readySince = null;
var readyAnnounced = false;
function defaultGoal(mode) {
  return mode === "rep" ? 10 : 30;
}
function renderGoalBar() {
  const def = EXERCISES[activeExercise];
  const options = def.unit === "rep" ? [5, 10, 15, 20] : [30, 45, 60, 90];
  const bar = document.getElementById("goalBar");
  if (!bar) return;
  bar.innerHTML = "";
  for (const v of options) {
    const btn = document.createElement("button");
    btn.className = "goal-chip" + (v === sessionGoal ? " active" : "");
    btn.textContent = def.unit === "rep" ? `${v} \u6B21` : `${v} \u79D2`;
    btn.addEventListener("click", () => {
      sessionGoal = v;
      goalDoneAnnounced = false;
      for (const other of bar.querySelectorAll(".goal-chip")) {
        other.classList.remove("active");
      }
      btn.classList.add("active");
      updateGoalStatus();
    });
    bar.appendChild(btn);
  }
}
function updateGoalStatus() {
  const def = EXERCISES[activeExercise];
  const done = def.unit === "rep" ? (activeExercise === "squat" ? lastSquat.reps : lastPushUp.reps) - setStartReps : Math.round((lastPlank.validMs - setStartValidMs) / 1e3);
  const el2 = document.getElementById("goalStatus");
  if (el2) el2.textContent = goalStatusText(Math.max(0, done), sessionGoal, def.unit);
}
var video = $("video");
var canvas = $("overlay");
var ctx = canvas.getContext("2d");
var el = {
  loginMsg: $("loginMsg"),
  email: $("email"),
  password: $("password"),
  greeting: $("greeting"),
  homeSub: $("homeSub"),
  avatar: $("avatar"),
  weekCount: $("weekCount"),
  weekReps: $("weekReps"),
  weekSec: $("weekSec"),
  recentHint: $("recentHint"),
  recentList: $("recentList"),
  hudLeft: $("hudLeft"),
  hudRight: $("hudRight"),
  prompt: $("prompt"),
  reps: $("reps"),
  counterLabel: $("counterLabel"),
  angle: $("angle"),
  camNotice: $("camNotice"),
  noticeTitle: $("noticeTitle"),
  noticeText: $("noticeText"),
  noticeSteps: $("noticeSteps"),
  retryCam: $("retryCam"),
  cancelCam: $("cancelCam"),
  restOverlay: $("restOverlay"),
  restCount: $("restCount"),
  flipCam: $("flipCam"),
  depthText: $("depthText"),
  depthFill: $("depthFill"),
  skipRest: $("skipRest"),
  rSets: $("rSets"),
  rDepth: $("rDepth"),
  rTempo: $("rTempo"),
  rSummary: $("rSummary"),
  pauseBtn: $("pauseBtn"),
  finishBtn: $("finishBtn"),
  reportSub: $("reportSub"),
  rReps: $("rReps"),
  rAttempts: $("rAttempts"),
  rValid: $("rValid"),
  rCoverage: $("rCoverage"),
  rScoreBox: $("rScoreBox"),
  rScoreNote: $("rScoreNote"),
  rFeedback: $("rFeedback"),
  rFeedbackBody: $("rFeedbackBody"),
  voiceBtn: $("voiceBtn"),
  repScore: $("repScore"),
  saveBtn: $("saveBtn"),
  saveMsg: $("saveMsg"),
  historyBody: $("historyBody"),
  trendBox: $("trendBox"),
  historySub: $("historySub"),
  profileSub: $("profileSub"),
  accountTag: $("accountTag"),
  accountText: $("accountText"),
  logoutBtn: $("logoutBtn"),
  sideAccount: $("sideAccount"),
  sideRole: $("sideRole"),
  sideFps: $("sideFps"),
  sideAngle: $("sideAngle"),
  sideCoverage: $("sideCoverage"),
  sidePhase: $("sidePhase"),
  sideHint: $("sideHint"),
  quickStart: $("quickStart"),
  cancelTrain: $("cancelTrain"),
  sideLogin: $("sideLogin"),
  guestBanner: $("guestBanner"),
  bannerLogin: $("bannerLogin"),
  profileGuest: $("profileGuest"),
  profileUser: $("profileUser"),
  pEmail: $("pEmail"),
  pPassword: $("pPassword"),
  pLogin: $("pLogin"),
  pRegister: $("pRegister"),
  profileMsg: $("profileMsg"),
  onlineBanner: $("onlineBanner")
};
var IS_LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
var CLOUD = IS_LOCAL && new URLSearchParams(location.search).get("auth") !== "local";
var API_BASE = "http://localhost:8000/api/v1";
function csrfToken() {
  const m = document.cookie.match(/(^|;\s*)af_csrf=([^;]*)/);
  return m?.[2] ? decodeURIComponent(m[2]) : null;
}
async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json" };
  const token = csrfToken();
  if (token) headers["X-CSRF-Token"] = token;
  const res = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? "GET",
    headers,
    credentials: "include",
    body: options.body === void 0 ? void 0 : JSON.stringify(options.body)
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(data?.message ?? `HTTP ${res.status}`);
  }
  return data;
}
function setLoginMsg(text, kind = "idle") {
  el.loginMsg.textContent = text;
  el.loginMsg.className = `msg${kind === "ok" ? " ok" : kind === "err" ? " err" : ""}`;
}
function applyAccount(next) {
  account = next;
  const guest = next === null;
  el.avatar.textContent = guest ? "\u8BBF" : next.email.slice(0, 1).toUpperCase();
  el.sideAccount.textContent = guest ? "\u672A\u767B\u5F55" : next.email;
  el.sideRole.textContent = guest ? "\u6E38\u5BA2\u6A21\u5F0F" : next.source === "cloud" ? "\u5DF2\u767B\u5F55 \xB7 \u4E91\u7AEF\u540C\u6B65" : "\u5DF2\u767B\u5F55 \xB7 \u6570\u636E\u5728\u672C\u673A";
  const displayName = next ? (next.email.split("@")[0] ?? "").replace(/[_-]?\d{6,}$/, "") : "";
  el.greeting.textContent = guest ? "\u4ECA\u5929\u7EC3\u70B9\u4EC0\u4E48" : `\u4F60\u597D\uFF0C${displayName}`;
  el.homeSub.textContent = guest ? "\u6E38\u5BA2\u6A21\u5F0F \xB7 \u8BB0\u5F55\u4EC5\u5B58\u672C\u673A" : "\u8BB0\u5F55\u4F1A\u540C\u6B65\u5230\u4E91\u7AEF";
  el.profileSub.textContent = guest ? "\u672A\u767B\u5F55" : next.email;
  el.accountTag.textContent = guest ? "\u6E38\u5BA2" : "\u5DF2\u767B\u5F55";
  el.accountText.textContent = guest ? "\u6E38\u5BA2\u6A21\u5F0F\u4E0B\u8BAD\u7EC3\u53EF\u4EE5\u6B63\u5E38\u8FDB\u884C\uFF0C\u4F46\u6210\u7EE9\u4E0D\u4F1A\u4FDD\u5B58\u3002\u767B\u5F55\u540E\u53EF\u4FDD\u5B58\u4E0E\u67E5\u770B\u5386\u53F2\u3002" : next.source === "cloud" ? `\u5F53\u524D\u8D26\u53F7\uFF1A${next.email}\u3002\u8BAD\u7EC3\u6458\u8981\u4F1A\u540C\u6B65\uFF0C\u753B\u9762\u4E0D\u4F1A\u4E0A\u4F20\u3002` : `\u5F53\u524D\u8D26\u53F7\uFF1A${next.email}\u3002\u8D26\u53F7\u4E0E\u8BB0\u5F55\u90FD\u4FDD\u5B58\u5728\u8FD9\u53F0\u8BBE\u5907\u4E0A\uFF0C\u6E05\u9664\u6D4F\u89C8\u5668\u6570\u636E\u4F1A\u5220\u9664\u5B83\u4EEC\u3002`;
  el.logoutBtn.style.display = guest ? "none" : "block";
  el.sideLogin.style.display = guest ? "block" : "none";
  el.guestBanner.style.display = guest ? "block" : "none";
  el.profileGuest.style.display = guest ? "block" : "none";
  el.profileUser.style.display = guest ? "none" : "block";
  el.saveBtn.disabled = guest;
  el.saveBtn.textContent = guest ? "\u767B\u5F55\u540E\u624D\u80FD\u4FDD\u5B58" : "\u4FDD\u5B58\u8BAD\u7EC3";
  if (!guest) void refreshHome();
}
var BONES = [
  ["left_shoulder", "right_shoulder"],
  ["left_shoulder", "left_elbow"],
  ["left_elbow", "left_wrist"],
  ["right_shoulder", "right_elbow"],
  ["right_elbow", "right_wrist"],
  ["left_shoulder", "left_hip"],
  ["right_shoulder", "right_hip"],
  ["left_hip", "right_hip"],
  ["left_hip", "left_knee"],
  ["left_knee", "left_ankle"],
  ["right_hip", "right_knee"],
  ["right_knee", "right_ankle"]
];
var MIN_DRAW_CONFIDENCE = 0.5;
function drawSkeleton(frame) {
  if (canvas.width !== frame.width || canvas.height !== frame.height) {
    canvas.width = frame.width;
    canvas.height = frame.height;
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const scale = canvas.width / 640;
  ctx.lineWidth = Math.max(2, 3 * scale);
  ctx.lineCap = "round";
  for (const [a, b] of BONES) {
    const pa = frame.joints[a];
    const pb = frame.joints[b];
    if (!pa || !pb) continue;
    if (pa.confidence < MIN_DRAW_CONFIDENCE || pb.confidence < MIN_DRAW_CONFIDENCE) continue;
    const active = lockedSide !== null && (a.startsWith(lockedSide) || b.startsWith(lockedSide));
    ctx.strokeStyle = active ? "#3fb950" : "rgba(110,168,254,.55)";
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }
  for (const [name, p] of Object.entries(frame.joints)) {
    if (!p || p.confidence < MIN_DRAW_CONFIDENCE) continue;
    const active = lockedSide !== null && name.startsWith(lockedSide);
    ctx.fillStyle = active ? "#3fb950" : "#6ea8fe";
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(3, 4 * scale), 0, Math.PI * 2);
    ctx.fill();
  }
}
function setPrompt(text) {
  if (!text) {
    el.prompt.classList.remove("show");
    el.prompt.textContent = "";
    return;
  }
  el.prompt.textContent = text;
  announcer?.say(`prompt:${text}`, text, 8e3);
  el.prompt.classList.add("show");
}
function resetTrainingState() {
  tracker = new QualityTracker(500);
  calibrator = new StandingCalibrator();
  calibration = null;
  incompleteStreak = 0;
  updateCalibHint();
  squatCounter = new SquatCounter(
    activeExercise === "squat" && viewMode === "front" ? {
      standAngle: FRONT_SQUAT.standAngle,
      descendAngle: FRONT_SQUAT.descendAngle,
      bottomAngle: FRONT_SQUAT.bottomAngle
    } : {}
  );
  pushUpCounter = new PushUpCounter();
  stabilityTracker = new StabilityTracker();
  compliantMs = 0;
  lastComplianceTs = null;
  angleHistory = [];
  lastScore = null;
  sessionAttempts = [];
  announcer?.reset();
  lostCount = 0;
  lostMs = 0;
  lostAt = null;
  bodyLineCount = 0;
  trackerStarted = false;
  renderViewBar();
  renderSensitivityBar();
  renderRestBar();
  const spark = document.getElementById("sparkLine");
  if (spark) spark.setAttribute("points", "");
  bodyLine = new BodyLineMonitor();
  plankAcc = new PlankAccumulator();
  formCoach.reset();
  lockedSide = null;
  sessionGoal = defaultGoal(EXERCISES[activeExercise].unit);
  goalDoneAnnounced = false;
  readySince = null;
  readyAnnounced = false;
  sets = [];
  repScores = [];
  resting = false;
  if (restTimer !== null) {
    window.clearInterval(restTimer);
    restTimer = null;
  }
  restLastAnnounced = -1;
  setStartMs = Date.now();
  setStartReps = 0;
  setStartValidMs = 0;
  el.restOverlay.style.display = "none";
  renderGoalBar();
  updateGoalStatus();
  lastWindow = { validMs: 0, invalidMs: 0, coverage: 0 };
  lastSquat = { reps: 0, attemptedReps: 0, incompleteReps: 0 };
  lastPushUp = { reps: 0, attemptedReps: 0, incompleteReps: 0 };
  lastPlank = { validMs: 0, gaps: 0, droppedMs: 0 };
  frameCount = 0;
  fpsWindowStart = 0;
  sessionStartMs = Date.now();
  paused = false;
  el.reps.textContent = EXERCISES[activeExercise].unit === "hold" ? "0.0" : "0";
  el.counterLabel.textContent = EXERCISES[activeExercise].unit === "hold" ? "\u6709\u6548\u79D2\u6570" : "\u6709\u6548\u6B21\u6570";
  el.angle.textContent = "\u2014";
  el.hudLeft.textContent = "\u2014";
  el.hudRight.textContent = "\u672A\u8BC4\u4F30";
  el.pauseBtn.textContent = "\u6682\u505C";
  el.sideFps.textContent = "\u2014";
  el.sideAngle.textContent = "\u2014";
  el.sideCoverage.textContent = "\u2014";
  el.sidePhase.textContent = "\u2014";
  el.sideHint.textContent = HINTS[activeExercise];
  setPrompt(null);
}
var camRetryAttempted = false;
function showCameraNotice(kind, message) {
  el.camNotice.style.display = "flex";
  el.noticeTitle.textContent = kind === "permission" ? "\u9700\u8981\u6444\u50CF\u5934\u6743\u9650" : "\u65E0\u6CD5\u542F\u52A8\u6444\u50CF\u5934";
  el.noticeText.textContent = message;
  el.noticeSteps.style.display = kind === "permission" ? "block" : "none";
  if (kind === "permission" && camRetryAttempted) {
    el.noticeTitle.textContent = "\u6743\u9650\u4ECD\u88AB\u62D2\u7EDD\uFF0C\u9700\u8981\u624B\u52A8\u5141\u8BB8";
    el.noticeText.textContent = "\u6D4F\u89C8\u5668\u4E0D\u4F1A\u518D\u6B21\u5F39\u51FA\u6388\u6743\u7A97\u53E3\u2014\u2014\u5FC5\u987B\u6309\u4E0B\u9762\u4E09\u6B65\u624B\u52A8\u6539\uFF0C\u6539\u5B8C\u540E\u70B9\u300C\u91CD\u65B0\u7533\u8BF7\u6743\u9650\u300D\u3002";
  }
}
function hideCameraNotice() {
  el.camNotice.style.display = "none";
}
async function enterTraining(exercise) {
  activeExercise = exercise;
  camRetryAttempted = false;
  resetTrainingState();
  hideCameraNotice();
  show("train");
  showPoseGuide(exercise);
  await startCameraAndRuntime();
}
function showPoseGuide(exercise) {
  const guide = document.getElementById("poseGuide");
  if (!guide) return;
  const text = document.getElementById("poseGuideText");
  const tips = {
    squat: viewMode === "front" ? "\u6B63\u9762\u7AD9\u7ACB \xB7 \u624B\u673A\u6B63\u5BF9\u81EA\u5DF1 \xB7 \u5168\u8EAB\u5165\u6846" : "\u4FA7\u8EAB\u7AD9\u7ACB \xB7 \u5168\u8EAB\u5165\u6846 \xB7 \u79BB\u955C\u5934 2\u20133 \u7C73",
    push_up: "\u4FA7\u5BF9\u955C\u5934\u6491\u5730 \xB7 \u80A9\u9ACB\u8E1D\u5168\u90E8\u5165\u6846\uFF08\u8D34\u5730\u53EF\u5207\u540E\u7F6E\u6444\u50CF\u5934\uFF09",
    plank: "\u4FA7\u5BF9\u955C\u5934 \xB7 \u80A9\u9ACB\u8E1D\u6210\u4E00\u6761\u7EBF\u5168\u90E8\u5165\u6846"
  };
  if (text) text.textContent = tips[exercise];
  guide.style.display = "flex";
  announcer?.say("poseGuide", "\u8BF7\u4FA7\u8EAB\u7AD9\u7ACB\uFF0C\u8BA9\u6574\u4E2A\u8EAB\u4F53\u8FDB\u5165\u753B\u9762", 3e3);
  window.setTimeout(hidePoseGuide, 6e3);
}
function hidePoseGuide() {
  const guide = document.getElementById("poseGuide");
  if (guide) guide.style.display = "none";
}
function renderViewBar() {
  const bar = document.getElementById("viewBar");
  if (!bar) return;
  bar.innerHTML = "";
  for (const mode of ["side", "front"]) {
    const btn = document.createElement("button");
    btn.className = "goal-chip" + (mode === viewMode ? " active" : "");
    btn.textContent = mode === "side" ? "\u4FA7\u9762" : "\u6B63\u9762";
    btn.addEventListener("click", () => {
      if (mode === viewMode) return;
      viewMode = mode;
      localStorage.setItem(VIEW_KEY, mode);
      resetTrainingState();
      renderViewBar();
      const hint = document.getElementById("viewHint");
      if (hint) {
        hint.textContent = mode === "front" ? activeExercise === "squat" ? "\u6B63\u9762\uFF1A\u624B\u673A\u6B63\u5BF9\u81EA\u5DF1\uFF0C\u53CC\u819D\u5E73\u5747\u5224\u5B9A\uFF0C\u9608\u503C\u653E\u5BBD\u5230 115\xB0\uFF08\u6295\u5F71\u4F1A\u4F4E\u4F30\u5C48\u66F2\uFF09" : "\u8BE5\u52A8\u4F5C\u6B63\u9762\u5224\u5B9A\u4E0D\u66F4\u51C6\uFF0C\u4ECD\u6309\u4FA7\u9762\u89C4\u5219\u6267\u884C" : "\u4FA7\u9762\uFF1A\u5224\u5B9A\u6700\u51C6\uFF0C\u5EFA\u8BAE\u4F18\u5148\u4F7F\u7528";
      }
      announcer?.say("view", mode === "side" ? "\u5DF2\u5207\u6362\u5230\u4FA7\u9762\u673A\u4F4D" : "\u5DF2\u5207\u6362\u5230\u6B63\u9762\u673A\u4F4D", 800);
      showPoseGuide(activeExercise);
    });
    bar.appendChild(btn);
  }
}
function renderRestBar() {
  const bar = document.getElementById("restBar");
  if (!bar) return;
  bar.innerHTML = "";
  for (const sec of REST_OPTIONS) {
    const btn = document.createElement("button");
    btn.className = "goal-chip" + (sec === restSeconds ? " active" : "");
    btn.textContent = `${sec} \u79D2`;
    btn.addEventListener("click", () => {
      restSeconds = sec;
      localStorage.setItem(REST_KEY, String(sec));
      renderRestBar();
    });
    bar.appendChild(btn);
  }
}
function setupTrainDrawer() {
  const drawer = document.querySelector(".train-side");
  const scrim = document.getElementById("sideScrim");
  const toggle = document.getElementById("sideToggle");
  if (!drawer || !scrim || !toggle) return;
  const open = () => {
    drawer.classList.add("open");
    scrim.classList.add("show");
  };
  const close = () => {
    drawer.classList.remove("open");
    scrim.classList.remove("show");
  };
  toggle.addEventListener("click", open);
  scrim.addEventListener("click", close);
  document.getElementById("cancelTrain")?.addEventListener("click", close);
}
function renderSensitivityBar() {
  const bar = document.getElementById("sensBar");
  if (!bar) return;
  bar.innerHTML = "";
  for (const mode of ["standard", "sensitive"]) {
    const btn = document.createElement("button");
    btn.className = "goal-chip" + (mode === sensitivity ? " active" : "");
    btn.textContent = mode === "standard" ? "\u6807\u51C6" : "\u7075\u654F";
    btn.addEventListener("click", () => {
      sensitivity = mode;
      localStorage.setItem(SENS_KEY, mode);
      renderSensitivityBar();
      const hint = document.getElementById("sensHint");
      if (hint) {
        hint.textContent = mode === "sensitive" ? "\u7075\u654F\uFF1A\u5173\u952E\u70B9\u7F6E\u4FE1\u5EA6\u653E\u5BBD\u5230 0.5\uFF0C\u66F4\u5BB9\u6613\u8BC6\u522B\uFF1B\u4EE3\u4EF7\u662F\u8BEF\u5224\u6982\u7387\u7565\u5347" : "\u6807\u51C6\uFF1A\u7F6E\u4FE1\u5EA6\u8981\u6C42 0.65\uFF0C\u66F4\u7A33\u4F46\u4FA7\u9762\u673A\u4F4D\u53EF\u80FD\u9891\u7E41\u300C\u770B\u4E0D\u6E05\u300D";
      }
      announcer?.say("sens", mode === "standard" ? "\u5DF2\u5207\u6362\u5230\u6807\u51C6\u7075\u654F\u5EA6" : "\u5DF2\u5207\u6362\u5230\u7075\u654F\u7075\u654F\u5EA6", 800);
    });
    bar.appendChild(btn);
  }
}
function applyCameraMirror() {
  const wrap = document.querySelector(".cam-wrap");
  if (!wrap) return;
  wrap.classList.toggle("front", camera?.facing === "user");
}
async function startCameraAndRuntime() {
  try {
    camera = new WebCamera(video, { idealWidth: 640, idealHeight: 480 });
    const info = await camera.start();
    canvas.width = info.width;
    canvas.height = info.height;
    applyCameraMirror();
    el.hudLeft.textContent = `${info.width}\xD7${info.height}`;
    hideCameraNotice();
    runtime = createPoseRuntime({
      // 相对路径：本地根路径与 GitHub Pages 子路径部署都能命中
      wasmPath: "wasm",
      modelPath: "models/pose_landmarker_lite.task",
      workerUrl: "worker.js",
      workerType: "classic",
      targetHz: 15
    });
    runtime.onPose(onFrame);
    runtime.onPoseCount((count) => {
      if (count > 1) setPrompt(COACH.multiPerson);
    });
    runtime.onError((error) => {
      el.hudRight.textContent = "\u8BC4\u4F30\u5DF2\u505C\u6B62";
      setPrompt(`\u8BC4\u4F30\u51FA\u9519\uFF1A${error.message}`);
    });
    await runtime.start(video);
    running = true;
    el.hudRight.textContent = "\u5B9E\u65F6\u8BC4\u4F30";
    el.pauseBtn.disabled = false;
  } catch (error) {
    const code = error.code ?? "";
    const message = error instanceof Error ? error.message : String(error);
    if (code === "permission_denied") {
      showCameraNotice("permission", "\u6D4F\u89C8\u5668\u5DF2\u62D2\u7EDD\u8BBF\u95EE\u6444\u50CF\u5934\u3002\u6388\u6743\u4E00\u6B21\u540E\u4F1A\u8BB0\u4F4F\uFF0C\u4E4B\u540E\u53EF\u76F4\u63A5\u8BAD\u7EC3\u3002");
      camRetryAttempted = true;
    } else if (code === "camera_busy") {
      showCameraNotice("fatal", "\u6444\u50CF\u5934\u88AB\u5176\u4ED6\u7A0B\u5E8F\u5360\u7528\uFF0C\u8BF7\u5173\u95ED\u5176\u4ED6\u4F7F\u7528\u6444\u50CF\u5934\u7684\u5E94\u7528\u540E\u91CD\u8BD5\u3002");
    } else if (code === "device_missing") {
      showCameraNotice("fatal", "\u6CA1\u6709\u627E\u5230\u53EF\u7528\u6444\u50CF\u5934\u3002");
    } else {
      showCameraNotice("fatal", message);
    }
  }
}
async function stopCameraAndRuntime() {
  running = false;
  paused = false;
  await runtime?.stop();
  await camera?.dispose();
  runtime = null;
  camera = null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}
function pickSide(frame, def) {
  const score = (side) => {
    const { required } = def.joints(side);
    return Math.min(...required.map((n) => frame.joints[n]?.confidence ?? 0));
  };
  return score("left") >= score("right") ? "left" : "right";
}
function pushSpark(angle) {
  angleHistory.push(angle);
  if (angleHistory.length > 90) angleHistory.shift();
  const spark = document.getElementById("sparkLine");
  if (!spark) return;
  const lo = 60;
  const hi = 185;
  const w = 220;
  const h = 56;
  const pts = angleHistory.map((a, i) => {
    const x = i / Math.max(1, angleHistory.length - 1) * w;
    const y = h - (Math.min(hi, Math.max(lo, a)) - lo) / (hi - lo) * (h - 6) - 3;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  spark.setAttribute("points", pts);
}
if (new URLSearchParams(location.search).get("debug") === "1") {
  window.__startRest = () => startRest(performance.now());
  window.__simulateSession = (reps) => {
    sessionStartMs = Date.now() - 3e4;
    sessionAttempts = Array.from({ length: reps }, (_, i) => ({
      startMs: i * 3e3,
      endMs: i * 3e3 + 2100,
      durationMs: 2100,
      minAngle: 118,
      valid: true
    }));
    lastSquat = { reps, attemptedReps: reps + 2, incompleteReps: 2 };
    lastWindow = { validMs: 12e3, invalidMs: 18e3, coverage: 0.4 };
    compliantMs = 7e3;
    sessionGoal = 10;
    void finishTraining();
  };
}
function startRest(now) {
  resting = true;
  restEndsAt = now + restSeconds * 1e3;
  restLastAnnounced = -1;
  el.restOverlay.style.display = "flex";
  el.restCount.textContent = String(restSeconds);
  setPrompt(COACH.restStart);
  restTimer = window.setInterval(() => {
    const remaining = Math.max(0, Math.ceil((restEndsAt - performance.now()) / 1e3));
    el.restCount.textContent = String(remaining);
    if (remaining !== restLastAnnounced && [10, 5, 4, 3, 2, 1].includes(remaining)) {
      restLastAnnounced = remaining;
      announcer?.say(`rest${remaining}`, String(remaining), 700);
    }
    if (remaining <= 0) {
      if (restTimer !== null) {
        window.clearInterval(restTimer);
        restTimer = null;
      }
      endRest(performance.now());
    }
  }, 250);
}
function endRest(now) {
  resting = false;
  if (restTimer !== null) {
    window.clearInterval(restTimer);
    restTimer = null;
  }
  el.restOverlay.style.display = "none";
  setStartMs = now;
  setStartReps = activeExercise === "squat" ? lastSquat.reps : lastPushUp.reps;
  setStartValidMs = lastPlank.validMs;
  goalDoneAnnounced = false;
  readySince = null;
  readyAnnounced = true;
  announcer?.say("restEnd", COACH.restEnd, 1e3);
  setPrompt("\u5F00\u59CB\u4E0B\u4E00\u7EC4");
  updateGoalStatus();
}
function updateDepthBar(angle, bottomAngle) {
  const wrap = document.getElementById("depthWrap");
  if (!wrap) return;
  if (bottomAngle === null) {
    wrap.style.display = "none";
    return;
  }
  wrap.style.display = "block";
  if (angle === null) {
    el.depthText.textContent = "\u2014";
    el.depthFill.style.width = "0%";
    return;
  }
  const top = 185;
  const pct = Math.max(0, Math.min(100, (top - angle) / (top - bottomAngle) * 100));
  el.depthText.textContent = `\u5F53\u524D ${Math.round(angle)}\xB0 / \u76EE\u6807 \u2264 ${bottomAngle}\xB0`;
  el.depthFill.style.width = `${pct.toFixed(1)}%`;
  el.depthFill.style.background = angle <= bottomAngle ? "#12b76a" : "#2563eb";
}
function onFrame(frame) {
  if (!running) return;
  frameCount += 1;
  const now = performance.now();
  if (fpsWindowStart === 0) fpsWindowStart = now;
  if (now - fpsWindowStart >= 1e3) {
    const hz = Math.round(frameCount * 1e3 / (now - fpsWindowStart));
    el.hudRight.textContent = `\u5B9E\u65F6\u8BC4\u4F30 ${hz}Hz`;
    el.sideFps.textContent = `${hz} Hz`;
    frameCount = 0;
    fpsWindowStart = now;
  }
  drawSkeleton(frame);
  if (paused) return;
  const def = EXERCISES[activeExercise];
  const side = lockedSide ?? "left";
  const joints = def.joints(side);
  const gate = checkFrame(frame, now, joints.required, gateConfig());
  if (gate.ok && !trackerStarted) {
    tracker.reset();
    trackerStarted = true;
    hidePoseGuide();
  }
  const window2 = tracker.observe(gate.ok, now);
  const dt = lastComplianceTs === null ? 0 : Math.max(0, frame.timestampMs - lastComplianceTs);
  lastComplianceTs = frame.timestampMs;
  lastWindow = { validMs: window2.validMs, invalidMs: window2.invalidMs, coverage: window2.coverage };
  el.sideCoverage.textContent = `${Math.round(window2.coverage * 100)}%`;
  if (!gate.ok) {
    if (window2.trackingLost) {
      if (lostAt === null) lostAt = now;
      lockedSide = null;
      readySince = null;
      readyAnnounced = false;
      setPrompt(COACH.trackingLost);
      if (activeExercise === "plank") plankAcc.update({ angle: null, timestampMs: frame.timestampMs });
      else if (activeExercise === "squat")
        squatCounter.update({ angle: null, timestampMs: frame.timestampMs });
      else pushUpCounter.update({ angle: null, timestampMs: frame.timestampMs });
    }
    return;
  }
  if (lostAt !== null) {
    lostCount += 1;
    lostMs += now - lostAt;
    lostAt = null;
  }
  if (readySince === null) readySince = now;
  if (!readyAnnounced && now - readySince >= 1500) {
    readyAnnounced = true;
    announcer?.say("ready", COACH.ready, 2500);
  }
  updateGoalStatus();
  if (lockedSide === null) lockedSide = pickSide(frame, def);
  let frontKnee = null;
  if (activeExercise === "squat" && viewMode === "front") {
    const l = jointAngle(frame, "left_hip", "left_knee", "left_ankle", 0.5);
    const r = jointAngle(frame, "right_hip", "right_knee", "right_ankle", 0.5);
    if (l !== null && r !== null) frontKnee = (l + r) / 2;
    else frontKnee = l ?? r;
  }
  const angle = frontKnee ?? jointAngle(frame, joints.vertex, joints.from, joints.to, 0.65);
  el.angle.textContent = angle === null ? "\u2014" : `${Math.round(angle)}\xB0`;
  el.sideAngle.textContent = el.angle.textContent ?? "\u2014";
  if (activeExercise === "squat" && calibration === null && angle !== null && gate.ok) {
    const result = calibrator.observe(angle, frame.timestampMs);
    if (result !== null) {
      calibration = result;
      squatCounter = new SquatCounter({
        standAngle: result.topAngle,
        descendAngle: result.descendAngle,
        bottomAngle: result.bottomAngle
      });
      lastSquat = { reps: 0, attemptedReps: 0, incompleteReps: 0 };
      updateCalibHint();
      announcer?.say("calib", `\u5DF2\u6821\u51C6\uFF0C\u7AD9\u7ACB\u89D2\u5EA6 ${result.standRef} \u5EA6`, 2e3);
    }
  }
  if (activeExercise === "plank") {
    const snap = plankAcc.update({ angle, timestampMs: frame.timestampMs });
    lastPlank = { validMs: snap.validMs, gaps: snap.gaps, droppedMs: snap.droppedMs };
    stabilityTracker.add(snap.holding ? "holding" : "rest", angle);
    if (angle !== null) pushSpark(angle);
    el.reps.textContent = (snap.validMs / 1e3).toFixed(1);
    el.sidePhase.textContent = snap.holding ? "\u4FDD\u6301\u4E2D" : "\u672A\u4FDD\u6301";
    if (snap.gaps > 0 && snap.droppedMs > 0) {
      setPrompt(COACH.holdBreak(Math.round(snap.droppedMs / 1e3)));
    } else if (snap.holding) {
      setPrompt(null);
    }
    const setSec = Math.round((lastPlank.validMs - setStartValidMs) / 1e3);
    if (!goalDoneAnnounced && setSec >= sessionGoal) {
      goalDoneAnnounced = true;
      sets.push({ reps: setSec, durationMs: now - setStartMs });
      announcer?.say("goalDone", goalDoneVoice(setSec, "hold"), 1500);
      startRest(now);
    }
    return;
  }
  const snapshot = activeExercise === "squat" ? squatCounter.update({ angle, timestampMs: frame.timestampMs }) : pushUpCounter.update({ angle, timestampMs: frame.timestampMs });
  if (activeExercise === "squat") lastSquat = snapshot;
  else lastPushUp = snapshot;
  if (snapshot.lastAttempt && (snapshot.event === "rep_completed" || snapshot.event === "attempt_incomplete" || snapshot.event === "attempt_discarded")) {
    sessionAttempts.push(snapshot.lastAttempt);
  }
  stabilityTracker.add(snapshot.phase, angle);
  if (snapshot.phase === "top" || snapshot.phase === "idle") compliantMs += dt;
  const hint = formCoach.onFrame({
    phase: snapshot.phase,
    angle,
    timestampMs: frame.timestampMs,
    bottomAngle: def.bottomAngle,
    slackDeg: 5
  });
  if (hint === "deeper") setPrompt(FORM_HINT_TEXT.deeper);
  updateDepthBar(angle, currentBottomAngle());
  if (snapshot.event === "rep_completed") compliantMs += snapshot.lastRepDurationMs ?? 0;
  if (angle !== null) pushSpark(angle);
  el.reps.textContent = String(snapshot.reps);
  el.sidePhase.textContent = snapshot.phase;
  if (activeExercise === "push_up") {
    const lineAngle = jointAngle(frame, `${side}_hip`, `${side}_shoulder`, `${side}_ankle`, 0.65);
    const line = bodyLine.observe(lineAngle, now);
    if (line.triggered) {
      bodyLineCount += 1;
      setPrompt(COACH.bodyLine);
    }
  }
  if (snapshot.event === "rep_completed") {
    const paceHint = formCoach.onRepCompleted(snapshot.lastRepDurationMs ?? 0, frame.timestampMs);
    if (paceHint === "pace_fast") setPrompt(FORM_HINT_TEXT.pace_fast);
    else setPrompt(null);
    const setReps = snapshot.reps - setStartReps;
    const attempt = snapshot.lastAttempt;
    const repScore = attempt ? scoreRep({
      minAngle: attempt.minAngle,
      bottomAngle: currentBottomAngle() ?? 100,
      durationMs: attempt.durationMs,
      minCycleMs: def.minCycleMs,
      maxCycleMs: def.maxCycleMs
    }) : null;
    repScores.push(repScore?.score ?? null);
    if (repScore && repScore.score !== null) {
      el.repScore.style.display = "block";
      el.repScore.innerHTML = `<b>${repScore.score}</b> \u5206 \xB7 ${repScore.label}`;
      announcer?.say("count", `${setReps} \u6B21\uFF0C${repScore.score} \u5206`, 700);
    } else {
      el.repScore.style.display = "none";
      announcer?.say("count", countVoice(setReps, sessionGoal), 800);
    }
    if (!goalDoneAnnounced && setReps >= sessionGoal) {
      goalDoneAnnounced = true;
      sets.push({ reps: setReps, durationMs: now - setStartMs });
      announcer?.say("goalDone", goalDoneVoice(setReps, "rep"), 1500);
      startRest(now);
    }
  }
  if (snapshot.event === "attempt_incomplete") {
    incompleteStreak += 1;
    setPrompt(incompleteStreak >= 3 ? "\u8D77\u8EAB\u7AD9\u76F4\u3001\u819D\u76D6\u4F38\u76F4\u4E00\u70B9\uFF0C\u624D\u7B97\u4E00\u6B21" : COACH.incomplete);
    el.repScore.style.display = "none";
  }
  if (snapshot.event === "rep_completed") incompleteStreak = 0;
  if (snapshot.event === "attempt_discarded") setPrompt(COACH.discarded);
}
function currentMetrics() {
  if (activeExercise === "plank") {
    return {
      reps: 0,
      attempted: 0,
      incomplete: 0,
      validMs: Math.round(lastPlank.validMs),
      coverage: lastWindow.coverage
    };
  }
  const snap = activeExercise === "squat" ? lastSquat : lastPushUp;
  return {
    reps: snap.reps,
    attempted: snap.attemptedReps,
    incomplete: snap.incompleteReps,
    validMs: Math.round(lastWindow.validMs),
    coverage: lastWindow.coverage
  };
}
async function finishTraining() {
  await stopCameraAndRuntime();
  const def = EXERCISES[activeExercise];
  const m = currentMetrics();
  el.reportSub.textContent = `${def.label} \xB7 \u4FA7\u9762`;
  el.rReps.textContent = def.unit === "hold" ? `${(m.validMs / 1e3).toFixed(1)} \u79D2` : String(m.reps);
  el.rAttempts.textContent = `${m.attempted} / ${m.incomplete}`;
  el.rSets.textContent = sets.length > 0 ? `${sets.length} \u7EC4\uFF08${sets.map((x) => x.reps).join(" / ")}\uFF09` : "1 \u7EC4";
  el.rValid.textContent = `${(m.validMs / 1e3).toFixed(1)} \u79D2`;
  el.rCoverage.textContent = `${Math.round(m.coverage * 100)}%`;
  const validAttempts = sessionAttempts.filter((a) => a.valid);
  const depths = validAttempts.map((a) => a.minAngle).filter((v) => v !== null);
  const avgDepth = depths.length > 0 ? Math.round(depths.reduce((x, y) => x + y, 0) / depths.length) : null;
  const avgTempo = validAttempts.length > 0 ? (validAttempts.reduce((x, y) => x + y.durationMs, 0) / validAttempts.length / 1e3).toFixed(1) : null;
  el.rDepth.textContent = avgDepth === null ? "\u2014" : `${avgDepth}\xB0`;
  el.rTempo.textContent = avgTempo === null ? "\u2014" : `${avgTempo} \u79D2`;
  el.rSummary.textContent = def.unit === "hold" ? `\u672C\u6B21\u4FDD\u6301 ${(m.validMs / 1e3).toFixed(1)} \u79D2\uFF0C\u65AD\u6863 ${lastPlank.gaps} \u6B21\u3002` : `\u672C\u6B21\u5B8C\u6210 ${m.reps} \u6B21\uFF08\u76EE\u6807 ${sessionGoal} \u6B21\uFF0C${Math.min(100, Math.round(m.reps / Math.max(1, sessionGoal) * 100))}%\uFF09\uFF0C\u5C1D\u8BD5 ${m.attempted} \u6B21${avgDepth === null ? "" : `\uFF0C\u5E73\u5747\u6DF1\u5EA6 ${avgDepth}\xB0`}${avgTempo === null ? "" : `\uFF0C\u5E73\u5747\u6BCF\u6B21 ${avgTempo} \u79D2`}\u3002`;
  const elapsedMs = Math.max(1, Date.now() - sessionStartMs);
  let compliance;
  let completion;
  if (def.unit === "hold") {
    compliance = m.validMs > 0 ? piecewise(Math.min(1, m.validMs / elapsedMs), COMPLIANCE_CURVE) : null;
    completion = null;
  } else {
    compliance = m.validMs > 0 ? piecewise(Math.min(1, compliantMs / m.validMs), COMPLIANCE_CURVE) : null;
    completion = m.attempted > 0 ? m.reps / m.attempted * 100 : null;
  }
  const stabilitySnap = stabilityTracker.snapshot();
  const result = scoreSession({
    compliance,
    completion,
    stability: stabilitySnap.stability,
    coverage: m.coverage
  });
  lastScore = result.score;
  const report = buildWorkoutReport({
    mode: def.unit,
    reps: m.reps,
    attempted: m.attempted,
    incomplete: m.incomplete,
    validMs: m.validMs,
    elapsedMs,
    coverage: m.coverage,
    completion: def.unit === "rep" ? completion : null,
    stability: stabilitySnap.stability,
    attempts: sessionAttempts,
    lostMs: Math.round(lostMs),
    lostCount,
    bodyLineCount,
    gaps: lastPlank.gaps,
    bottomAngle: def.bottomAngle
  });
  lastReport = report;
  lastDetail = {
    goal: sessionGoal,
    avgDepthDeg: avgDepth,
    avgTempoSec: avgTempo === null ? null : Number(avgTempo),
    coverage: m.coverage,
    attempted: m.attempted,
    incomplete: m.incomplete,
    sets: sets.map((x) => x.reps),
    highlights: report.highlights,
    issues: report.issues.map((i) => i.text),
    suggestions: report.suggestions,
    plan: report.plan
  };
  const section = (title, items, cls) => items.length === 0 ? "" : `<div class="fb-sec ${cls}"><div class="fb-title">${title}</div>` + items.map((t) => `<div class="fb-item">${t}</div>`).join("") + `</div>`;
  el.rFeedbackBody.innerHTML = section("\u505A\u5F97\u597D\u7684", report.highlights, "fb-good") + section("\u53D1\u73B0\u7684\u95EE\u9898", report.issues.map((i) => i.text), "fb-issue") + section("\u6539\u8FDB\u5EFA\u8BAE", report.suggestions, "fb-tip") + section("\u4E0B\u4E00\u6B65\u8BA1\u5212", report.plan, "fb-plan");
  const hasAnyContent = report.highlights.length + report.issues.length + report.suggestions.length + report.plan.length > 0;
  el.rFeedback.style.display = hasAnyContent ? "" : "none";
  if (!hasAnyContent) {
    el.rFeedbackBody.innerHTML = '<div class="fb-sec fb-tip"><div class="fb-item">\u6CA1\u6709\u91C7\u96C6\u5230\u6709\u6548\u52A8\u4F5C\uFF1A\u786E\u8BA4\u8EAB\u4F53\u5B8C\u6574\u5165\u6846\u540E\u518D\u5F00\u59CB\uFF0C\u6216\u628A\u7075\u654F\u5EA6\u5207\u5230\u300C\u7075\u654F\u300D\u3002</div></div>';
    el.rFeedback.style.display = "";
  }
  const setSub = (barId, valId, value) => {
    const bar = document.getElementById(barId);
    const val = document.getElementById(valId);
    if (!bar || !val) return;
    if (value === null) {
      bar.style.width = "0%";
      bar.classList.add("na");
      val.textContent = "\u2014";
      return;
    }
    bar.classList.remove("na");
    bar.style.width = `${Math.max(2, Math.min(100, Math.round(value)))}%`;
    val.textContent = String(Math.round(value));
  };
  setSub("subCompliance", "subComplianceVal", compliance);
  setSub("subCompletion", "subCompletionVal", completion);
  setSub("subStability", "subStabilityVal", stabilitySnap.stability);
  const fmt = (v) => v === null ? "\u2014" : String(Math.round(v));
  const subLine = `\u89C4\u8303\u6027 ${fmt(compliance)} \xB7 \u5B8C\u6210\u5EA6 ${fmt(completion)} \xB7 \u7A33\u5B9A\u6027 ${fmt(stabilitySnap.stability)}` + (stabilitySnap.stdDeg === null ? "" : `\uFF08\u6CE2\u52A8 ${stabilitySnap.stdDeg}\xB0\uFF09`);
  if (result.score !== null) {
    el.rScoreBox.textContent = `${result.score} \u5206${result.provisional ? "\uFF08\u53C2\u8003\uFF09" : ""}`;
    el.rScoreBox.className = "score-good";
  } else {
    el.rScoreBox.textContent = "\u672C\u6B21\u6CA1\u770B\u6E05\u52A8\u4F5C";
    el.rScoreBox.className = "score-empty";
  }
  const avgRepScore = repScores.filter((v) => v !== null);
  const avgRep = avgRepScore.length > 0 ? Math.round(avgRepScore.reduce((a, b) => a + b, 0) / avgRepScore.length) : null;
  el.rScoreNote.textContent = result.reason ?? subLine;
  if (avgRep !== null) {
    el.rScoreNote.textContent += `\u3002\u5355\u6B21\u5E73\u5747 ${avgRep} \u5206\uFF08\u6700\u9AD8 ${Math.max(...avgRepScore)}\u3001\u6700\u4F4E ${Math.min(...avgRepScore)}\uFF09`;
  }
  if (result.score === null) {
    el.rScoreNote.textContent += `\u3002\u8FD9\u6B21\u51E0\u4E4E\u6CA1\u91C7\u96C6\u5230\u6709\u6548\u52A8\u4F5C\uFF08\u8986\u76D6\u7387 ${Math.round(m.coverage * 100)}%\uFF09\uFF1A\u8BA9\u5168\u8EAB\u8FDB\u5165\u753B\u9762\u3001\u5149\u7EBF\u4ECE\u6B63\u9762\u6765\uFF0C\u6216\u628A\u7075\u654F\u5EA6\u5207\u5230\u300C\u7075\u654F\u300D\u518D\u8BD5\u4E00\u6B21\u3002`;
  }
  lastCard = {
    exercise: def.label,
    date: (/* @__PURE__ */ new Date()).toLocaleString("zh-CN", { hour12: false }),
    score: result.score,
    provisional: result.provisional,
    reps: m.reps,
    goal: sessionGoal,
    unit: def.unit,
    validMs: m.validMs,
    avgDepth,
    avgTempo,
    coverage: m.coverage,
    split: [
      { label: "\u89C4\u8303\u6027", value: compliance === null ? "\u2014" : String(Math.round(compliance)) },
      { label: "\u5B8C\u6210\u5EA6", value: completion === null ? "\u2014" : String(Math.round(completion)) },
      { label: "\u7A33\u5B9A\u6027", value: stabilitySnap.stability === null ? "\u2014" : String(Math.round(stabilitySnap.stability)) }
    ]
  };
  el.saveMsg.textContent = "";
  el.saveBtn.disabled = account === null;
  el.saveBtn.textContent = account === null ? "\u767B\u5F55\u540E\u624D\u80FD\u4FDD\u5B58" : "\u4FDD\u5B58\u8BAD\u7EC3";
  show("report");
}
function buildPayload() {
  const def = EXERCISES[activeExercise];
  const m = currentMetrics();
  const endedAt = Date.now();
  const activeMs = Math.max(1, endedAt - sessionStartMs);
  return {
    client_session_id: crypto.randomUUID(),
    exercise_id: def.id,
    rule_version: def.rule,
    started_at: new Date(sessionStartMs).toISOString(),
    ended_at: new Date(endedAt).toISOString(),
    active_ms: activeMs,
    valid_ms: Math.min(m.validMs, activeMs),
    reps: m.reps,
    attempted_reps: m.attempted,
    incomplete_reps: m.incomplete,
    score: lastScore,
    platform: "web",
    runtime_version: "mediapipe-tasks-vision-1.1.1",
    model_version: "pose_landmarker_lite-1",
    quality: {
      schema_version: 1,
      coverage: Math.min(1, Math.max(0, m.coverage)),
      valid_ms: Math.min(m.validMs, activeMs),
      invalid_ms: Math.round(lastWindow.invalidMs),
      lost_tracking_count: 0,
      min_confidence_observed: null
    },
    events: (lastReport?.events ?? []).map((e) => ({
      code: e.code,
      start_ms: Math.max(0, Math.round(e.startMs)),
      end_ms: Math.max(0, Math.round(e.endMs)),
      observed_value: e.observedValue,
      threshold_value: e.thresholdValue
    })),
    source: "client_evaluated"
  };
}
async function saveTraining() {
  if (account === null) return;
  el.saveBtn.disabled = true;
  el.saveMsg.textContent = "\u4FDD\u5B58\u4E2D\u2026";
  el.saveMsg.className = "msg";
  if (!CLOUD) {
    try {
      localSaveSession(account.email, buildPayload(), lastDetail ?? void 0);
      el.saveMsg.textContent = "\u5DF2\u4FDD\u5B58\u5230\u672C\u673A";
      el.saveMsg.className = "msg ok";
      setTimeout(() => {
        void refreshHome();
        show("home");
      }, 700);
    } catch (error) {
      el.saveMsg.textContent = `\u4FDD\u5B58\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`;
      el.saveMsg.className = "msg err";
      el.saveBtn.disabled = false;
    }
    return;
  }
  try {
    const res = await api("/sessions", {
      method: "POST",
      body: buildPayload()
    });
    el.saveMsg.textContent = res.idempotent_replay ? "\u5DF2\u5B58\u5728\u540C\u4E00\u6761\u8BB0\u5F55\uFF08\u5E42\u7B49\u547D\u4E2D\uFF09" : "\u5DF2\u4FDD\u5B58\u5230\u4E91\u7AEF";
    el.saveMsg.className = "msg ok";
    setTimeout(() => {
      void refreshHome();
      show("home");
    }, 700);
  } catch (error) {
    el.saveMsg.textContent = `\u4FDD\u5B58\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`;
    el.saveMsg.className = "msg err";
    el.saveBtn.disabled = false;
  }
}
async function refreshHome() {
  if (account === null) {
    el.weekCount.textContent = "0";
    el.weekReps.textContent = "0";
    el.weekSec.textContent = "0";
    el.recentHint.textContent = "\u767B\u5F55\u540E\u53EF\u540C\u6B65";
    el.recentList.textContent = "\u6E38\u5BA2\u6A21\u5F0F\u4E0D\u4FDD\u5B58\u8BAD\u7EC3\u8BB0\u5F55";
    return;
  }
  if (!CLOUD) {
    const rows = localListSessions(account.email).map((r) => ({
      id: r.id,
      exercise_id: r.exercise_id,
      reps: r.reps,
      valid_ms: r.valid_ms,
      score: r.score,
      started_at: r.started_at
    }));
    applyHomeStats(rows);
    return;
  }
  try {
    const rows = await api("/sessions?limit=50");
    applyHomeStats(rows);
  } catch {
    el.recentHint.textContent = "\u79BB\u7EBF";
    el.recentList.textContent = "\u6682\u65F6\u8FDE\u4E0D\u4E0A\u670D\u52A1\u5668\uFF0C\u8BAD\u7EC3\u4ECD\u53EF\u8FDB\u884C";
  }
}
function applyHomeStats(rows) {
  {
    const weekAgo = Date.now() - 7 * 24 * 3600 * 1e3;
    const week = rows.filter((r) => new Date(r.started_at).getTime() >= weekAgo);
    el.weekCount.textContent = String(week.length);
    el.weekReps.textContent = String(week.reduce((s, r) => s + r.reps, 0));
    el.weekSec.textContent = String(Math.round(week.reduce((s, r) => s + r.valid_ms, 0) / 1e3));
    el.recentHint.textContent = rows.length > 0 ? `\u5171 ${rows.length} \u6761` : "";
    el.recentList.innerHTML = rows.length === 0 ? "\u8FD8\u6CA1\u6709\u8BB0\u5F55\uFF0C\u9009\u4E00\u4E2A\u52A8\u4F5C\u5F00\u59CB\u5427" : rows.slice(0, 3).map((r) => {
      const label = EXERCISES[r.exercise_id]?.label ?? r.exercise_id;
      const value = r.exercise_id === "plank" ? `${(r.valid_ms / 1e3).toFixed(1)} \u79D2` : `${r.reps} \u6B21`;
      return `<div class="record-line"><span>${label} \xB7 ${value}</span><span class="muted">${new Date(r.started_at).toLocaleDateString()}</span></div>`;
    }).join("");
  }
}
async function renderTrend() {
  const box = el.trendBox;
  if (!box) return;
  const pts = CLOUD ? await api(
    "/reports/trend?days=7"
  ).then((t) => t.points) : localTrend(account?.email ?? "", 7);
  {
    const filtered = pts.filter((p) => p.sessions > 0 || p.reps > 0);
    const points = filtered;
    if (points.length === 0) {
      box.innerHTML = '<div class="card-title" style="margin-bottom:6px">\u8FD1 7 \u5929</div><div class="muted">\u6682\u65E0\u8BAD\u7EC3\uFF0C\u5B8C\u6210\u4E00\u6B21\u540E\u4F1A\u5728\u8FD9\u91CC\u770B\u5230\u8D8B\u52BF\u3002</div>';
      return;
    }
    const maxReps = Math.max(...points.map((p) => p.reps), 1);
    const rows = points.map((p) => {
      const label = EXERCISES[p.exercise_id]?.label ?? p.exercise_id;
      const pct = Math.round(p.reps / maxReps * 100);
      const value = p.exercise_id === "plank" ? `${p.sessions} \u6B21\u8BAD\u7EC3` : `${p.reps} \u6B21`;
      return `<div class="trend-row">
          <span class="trend-label">${label}</span>
          <div class="trend-track"><div class="trend-bar" style="width:${Math.max(pct, 4)}%"></div></div>
          <span class="trend-value">${value}</span>
        </div>`;
    }).join("");
    const totalSessions = points.reduce((sum, p) => sum + p.sessions, 0);
    const totalReps = points.reduce((sum, p) => sum + p.reps, 0);
    box.innerHTML = `<div class="card-title" style="margin-bottom:8px">\u8FD1 7 \u5929\u8D8B\u52BF</div><div class="trend-summary">
         <span><b>${totalSessions}</b> \u6B21\u8BAD\u7EC3</span>
         <span><b>${totalReps}</b> \u6B21\u52A8\u4F5C</span>
       </div>` + rows;
  }
}
async function loadHistory() {
  el.historyBody.innerHTML = '<div class="muted">\u52A0\u8F7D\u4E2D\u2026</div>';
  if (account === null) {
    el.historyBody.innerHTML = '<div class="card"><div style="font-size:14px;font-weight:600">\u6E38\u5BA2\u6A21\u5F0F</div><div class="muted" style="margin-top:6px">\u767B\u5F55\u540E\u4F1A\u5728\u8FD9\u91CC\u770B\u5230\u5386\u53F2\u8BB0\u5F55\u4E0E\u8D8B\u52BF\u3002</div></div>';
    return;
  }
  if (!CLOUD) {
    const rows = localListSessions(account.email).map((r) => ({
      id: r.id,
      exercise_id: r.exercise_id,
      reps: r.reps,
      valid_ms: r.valid_ms,
      score: r.score,
      started_at: r.started_at,
      // 详情必须一起带出，否则「详情」按钮永远不出现
      detail: r.detail
    }));
    renderHistoryTable(rows);
    return;
  }
  try {
    const rows = await api("/sessions?limit=30");
    renderHistoryTable(rows);
  } catch (error) {
    el.historyBody.innerHTML = `<div class="card"><div class="msg err">\u8BFB\u53D6\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}</div></div>`;
  }
}
var lastHistoryRows = [];
function renderHistoryTable(rows) {
  lastHistoryRows = rows;
  {
    if (rows.length === 0) {
      el.historyBody.innerHTML = '<div class="card"><div class="muted">\u8FD8\u6CA1\u6709\u8BB0\u5F55</div></div>';
      void renderTrend();
      return;
    }
    const body = rows.map((r) => {
      const label = EXERCISES[r.exercise_id]?.label ?? r.exercise_id;
      const value = r.exercise_id === "plank" ? `${(r.valid_ms / 1e3).toFixed(1)} \u79D2` : `${r.reps} \u6B21`;
      const duration = `${(r.valid_ms / 1e3).toFixed(0)} \u79D2`;
      const when = new Date(r.started_at).toLocaleString();
      const score = r.score === null ? '<span class="tag">\u6570\u636E\u4E0D\u8DB3</span>' : `<span class="tag ok">${r.score} \u5206</span>`;
      const detailBtn = r.detail ? `<button class="link-btn" data-detail="${r.id}">\u8BE6\u60C5</button>` : '<span class="muted">\u2014</span>';
      return `<tr><td><b>${label}</b></td><td>${value}</td><td>${duration}</td><td>${score}</td><td class="muted">${when}</td><td>${detailBtn}</td></tr>`;
    }).join("");
    el.historyBody.innerHTML = `
      <div class="card" style="overflow:hidden">
        <table class="table">
          <thead><tr><th>\u52A8\u4F5C</th><th>\u6210\u7EE9</th><th>\u6709\u6548\u65F6\u957F</th><th>\u8BC4\u5206</th><th>\u5F00\u59CB\u65F6\u95F4</th><th></th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
    void renderTrend();
  }
}
function buildWorkoutCard() {
  const c = lastCard;
  if (!c) return null;
  const W = 900;
  const H = 1180;
  const canvas2 = document.createElement("canvas");
  canvas2.width = W;
  canvas2.height = H;
  const ctx2 = canvas2.getContext("2d");
  if (!ctx2) return null;
  const bg = ctx2.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#0b1220");
  bg.addColorStop(1, "#101f3a");
  ctx2.fillStyle = bg;
  ctx2.fillRect(0, 0, W, H);
  ctx2.fillStyle = "rgba(37, 99, 235, 0.25)";
  ctx2.beginPath();
  ctx2.arc(W - 120, 140, 220, 0, Math.PI * 2);
  ctx2.fill();
  ctx2.fillStyle = "#93c5fd";
  ctx2.font = '600 26px "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx2.fillText("AI \u5065\u8EAB \xB7 \u7AEF\u4FA7\u8BC6\u522B", 64, 96);
  ctx2.fillStyle = "#ffffff";
  ctx2.font = '700 64px "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx2.fillText(c.exercise, 64, 200);
  ctx2.fillStyle = "rgba(255,255,255,.62)";
  ctx2.font = '400 26px "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx2.fillText(c.date, 64, 244);
  ctx2.fillStyle = "#ffffff";
  ctx2.font = '800 150px "DIN Alternate", "PingFang SC", sans-serif';
  const scoreText = c.score === null ? "\u2014" : String(Math.round(c.score));
  ctx2.fillText(scoreText, 56, 420);
  const scoreW = ctx2.measureText(scoreText).width;
  ctx2.fillStyle = "rgba(255,255,255,.6)";
  ctx2.font = '600 34px "PingFang SC", sans-serif';
  ctx2.fillText("\u5206", 56 + scoreW + 12, 420);
  if (c.provisional) {
    ctx2.fillStyle = "#fbbf24";
    ctx2.font = '600 26px "PingFang SC", sans-serif';
    ctx2.fillText("\u53C2\u8003\u5206", 56 + scoreW + 70, 420);
  }
  const unit = c.unit === "rep" ? "\u6B21" : "\u79D2";
  const rows = [
    ["\u5B8C\u6210 / \u76EE\u6807", `${c.reps} / ${c.goal} ${unit}`],
    ["\u5E73\u5747\u6DF1\u5EA6", c.avgDepth === null ? "\u2014" : `${c.avgDepth}\xB0`],
    ["\u5E73\u5747\u6BCF\u6B21", c.avgTempo === null ? "\u2014" : `${c.avgTempo} \u79D2`],
    ["\u6709\u6548\u8986\u76D6\u7387", `${Math.round(c.coverage * 100)}%`]
  ];
  let y = 560;
  for (const [k, v] of rows) {
    ctx2.fillStyle = "rgba(255,255,255,.55)";
    ctx2.font = '400 30px "PingFang SC", sans-serif';
    ctx2.fillText(k, 64, y);
    ctx2.fillStyle = "#ffffff";
    ctx2.font = '600 34px "PingFang SC", sans-serif';
    const w = ctx2.measureText(v).width;
    ctx2.fillText(v, W - 64 - w, y);
    ctx2.strokeStyle = "rgba(255,255,255,.12)";
    ctx2.beginPath();
    ctx2.moveTo(64, y + 26);
    ctx2.lineTo(W - 64, y + 26);
    ctx2.stroke();
    y += 96;
  }
  y += 10;
  ctx2.fillStyle = "rgba(255,255,255,.55)";
  ctx2.font = '600 26px "PingFang SC", sans-serif';
  ctx2.fillText("\u8BC4\u5206\u6784\u6210", 64, y);
  y += 56;
  const colW = (W - 128) / 3;
  c.split.forEach((item, i) => {
    const x = 64 + colW * i;
    ctx2.fillStyle = "#ffffff";
    ctx2.font = '700 44px "PingFang SC", sans-serif';
    ctx2.fillText(item.value, x, y);
    ctx2.fillStyle = "rgba(255,255,255,.55)";
    ctx2.font = '400 24px "PingFang SC", sans-serif';
    ctx2.fillText(item.label, x, y + 34);
  });
  ctx2.fillStyle = "rgba(255,255,255,.4)";
  ctx2.font = '400 22px "PingFang SC", sans-serif';
  ctx2.fillText("\u753B\u9762\u5728\u8BBE\u5907\u5185\u5904\u7406\uFF0C\u4E0D\u4E0A\u4F20\u89C6\u9891", 64, H - 56);
  return canvas2.toDataURL("image/png");
}
function saveWorkoutCard() {
  const dataUrl = buildWorkoutCard();
  if (!dataUrl) return;
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = `ai-fitness-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.png`;
  a.click();
  el.saveMsg.textContent = "\u7ED3\u679C\u56FE\u7247\u5DF2\u4FDD\u5B58";
  el.saveMsg.className = "msg ok";
}
function openHistoryDetail(row) {
  const modal = document.getElementById("histDetail");
  const title = document.getElementById("histTitle");
  const body = document.getElementById("histBody");
  if (!modal || !title || !body) return;
  const label = EXERCISES[row.exercise_id]?.label ?? row.exercise_id;
  title.textContent = `${label} \xB7 ${new Date(row.started_at).toLocaleString()}`;
  const d = row.detail;
  if (!d) {
    body.innerHTML = '<div class="muted">\u8FD9\u6761\u8BB0\u5F55\u7531\u4E91\u7AEF\u4FDD\u5B58\uFF0C\u6CA1\u6709\u9644\u5E26\u52A8\u4F5C\u5206\u6790\u3002\u4E4B\u540E\u7684\u8BAD\u7EC3\u4F1A\u8BB0\u5F55\u5B8C\u6574\u8BE6\u60C5\u3002</div>';
  } else {
    const metric = (k, v) => `<div class="hist-metric"><span>${k}</span><b>${v}</b></div>`;
    const list = (title2, items, cls) => items.length === 0 ? "" : `<div class="fb-sec ${cls}"><div class="fb-title">${title2}</div>` + items.map((t) => `<div class="fb-item">${t}</div>`).join("") + "</div>";
    body.innerHTML = `
      <div class="hist-metrics">
        ${metric("\u5B8C\u6210 / \u76EE\u6807", `${row.reps} / ${d.goal} ${row.exercise_id === "plank" ? "\u79D2" : "\u6B21"}`)}
        ${metric("\u5C1D\u8BD5 / \u672A\u5B8C\u6210", `${d.attempted} / ${d.incomplete}`)}
        ${metric("\u5E73\u5747\u6DF1\u5EA6", d.avgDepthDeg === null ? "\u2014" : `${d.avgDepthDeg}\xB0`)}
        ${metric("\u5E73\u5747\u6BCF\u6B21", d.avgTempoSec === null ? "\u2014" : `${d.avgTempoSec} \u79D2`)}
        ${metric("\u8986\u76D6\u7387", `${Math.round(d.coverage * 100)}%`)}
        ${metric("\u7EC4\u6570", d.sets.length === 0 ? "1 \u7EC4" : `${d.sets.length} \u7EC4\uFF08${d.sets.join(" / ")}\uFF09`)}
      </div>
      ${list("\u505A\u5F97\u597D\u7684", d.highlights, "fb-good")}
      ${list("\u53D1\u73B0\u7684\u95EE\u9898", d.issues, "fb-issue")}
      ${list("\u6539\u8FDB\u5EFA\u8BAE", d.suggestions, "fb-tip")}
      ${list("\u4E0B\u4E00\u6B65\u8BA1\u5212", d.plan, "fb-plan")}`;
  }
  modal.style.display = "flex";
}
function closeHistoryDetail() {
  const modal = document.getElementById("histDetail");
  if (modal) modal.style.display = "none";
}
var activeStandard = "squat";
function renderStandards(id) {
  activeStandard = id;
  const std = STANDARDS[id];
  const body = document.getElementById("stdBody");
  if (!body) return;
  const metric = (m) => `
    <div class="std-metric">
      <div class="std-metric-head">
        <span class="std-label">${m.label}</span>
        <span class="src-tag ${m.source}">${m.source === "dataset" ? "\u6570\u636E" : "\u5047\u8BBE"}</span>
      </div>
      <div class="std-value">${m.value}</div>
      <div class="std-hint">${m.hint}</div>
    </div>`;
  const mistake = (m) => `
    <div class="std-mistake ${m.detectable ? "yes" : "no"}">
      <div class="std-mistake-head">
        <b>${m.name}</b>
        <span class="tag ${m.detectable ? "ok" : ""}">${m.detectable ? "\u4F1A\u5224\u5B9A" : "\u6682\u4E0D\u5224\u5B9A"}</span>
      </div>
      <div class="muted">${m.detail}</div>
      <div class="std-note">${m.note}</div>
    </div>`;
  body.innerHTML = `
    <div class="card card-pad std-goal">
      <div class="std-goal-label">\u8FD9\u4E2A\u52A8\u4F5C\u7684\u76EE\u6807</div>
      <div class="std-goal-text">${std.goal}</div>
      <div class="std-view">${std.view}</div>
    </div>

    <div class="std-section">
      <div class="card-title">\u5173\u952E\u6307\u6807</div>
      <div class="std-metrics">${std.metrics.map(metric).join("")}</div>
    </div>

    <div class="std-section">
      <div class="card-title">\u6B63\u786E\u505A\u6CD5</div>
      <ol class="std-steps">${std.steps.map((t) => `<li>${t}</li>`).join("")}</ol>
    </div>

    <div class="std-section">
      <div class="card-title">\u5E38\u89C1\u9519\u8BEF\u4E0E\u7CFB\u7EDF\u7684\u5224\u5B9A\u80FD\u529B</div>
      ${std.mistakes.map(mistake).join("")}
    </div>

    <div class="std-section">
      <div class="card-title">\u4FA7\u9762\u89C6\u89D2\u770B\u4E0D\u5230\u7684</div>
      <div class="std-chips">${std.notJudged.map((t) => `<span class="chip">${t}</span>`).join("")}</div>
      <div class="muted" style="margin-top:8px;font-size:12px">
        \u8FD9\u4E9B\u9700\u8981\u6B63\u9762\u673A\u4F4D\u6216 3D \u59FF\u6001\uFF0C\u5F53\u524D\u7248\u672C\u4E0D\u5224\u5B9A\u2014\u2014\u4E0D\u4F1A\u5047\u88C5\u7ED9\u7ED3\u8BBA\u3002
      </div>
    </div>

    <div class="std-disclaimer">${STANDARD_DISCLAIMER}</div>`;
}
for (const tab of document.querySelectorAll("[data-std]")) {
  tab.addEventListener("click", () => {
    const id = tab.dataset.std;
    if (!id) return;
    for (const other of document.querySelectorAll("[data-std]")) {
      other.classList.toggle("on", other === tab);
    }
    renderStandards(id);
  });
}
async function authenticate(email, password, mode, report) {
  const normalized = email.trim();
  if (!normalized || password.length < 8) {
    report("\u90AE\u7BB1\u5FC5\u586B\uFF0C\u5BC6\u7801\u81F3\u5C11 8 \u4F4D", "err");
    return;
  }
  try {
    if (CLOUD) {
      const user = await api(`/auth/${mode}`, {
        method: "POST",
        body: { email: normalized, password }
      });
      applyAccount({ email: user.email, source: "cloud" });
    } else {
      if (mode === "register") await localRegister(normalized, password);
      else await localLogin(normalized, password);
      applyAccount({ email: normalized.toLowerCase(), source: "local" });
    }
    report("", "idle");
    goTo("home");
    await refreshHome();
  } catch (error) {
    report(error instanceof Error ? error.message : String(error), "err");
  }
}
function doAuth(mode) {
  return authenticate(el.email.value, el.password.value, mode, setLoginMsg);
}
for (const card of document.querySelectorAll(".exercise")) {
  card.addEventListener("click", () => {
    const id = card.dataset.ex;
    if (id) void enterTraining(id);
  });
}
function goTo(go) {
  show(go);
  for (const item of document.querySelectorAll("[data-go]")) {
    item.classList.toggle("on", item.dataset.go === go);
  }
  if (go === "home") void refreshHome();
  if (go === "history") void loadHistory();
  if (go === "standards") renderStandards(activeStandard);
}
for (const item of document.querySelectorAll("[data-go]")) {
  item.addEventListener("click", () => {
    const go = item.dataset.go;
    if (go) goTo(go);
  });
}
$("loginBtn").addEventListener("click", () => void doAuth("login"));
$("registerBtn").addEventListener("click", () => void doAuth("register"));
$("guestBtn").addEventListener("click", () => {
  applyAccount(null);
  show("home");
});
el.quickStart.addEventListener("click", () => void enterTraining(activeExercise));
el.cancelTrain.addEventListener("click", () => {
  void stopCameraAndRuntime();
  goTo("home");
});
window.addEventListener("keydown", (event) => {
  const trainVisible = document.getElementById("screen-train")?.classList.contains("show");
  if (!trainVisible) return;
  if (event.code === "Space") {
    event.preventDefault();
    el.pauseBtn.click();
  } else if (event.code === "Escape") {
    void stopCameraAndRuntime();
    goTo("home");
  }
});
el.pLogin.addEventListener("click", () => {
  void authenticate(el.pEmail.value, el.pPassword.value, "login", (text, kind) => {
    el.profileMsg.textContent = text;
    el.profileMsg.className = `msg${kind === "ok" ? " ok" : kind === "err" ? " err" : ""}`;
  });
});
el.pRegister.addEventListener("click", () => {
  void authenticate(el.pEmail.value, el.pPassword.value, "register", (text, kind) => {
    el.profileMsg.textContent = text;
    el.profileMsg.className = `msg${kind === "ok" ? " ok" : kind === "err" ? " err" : ""}`;
  });
});
document.getElementById("historyBody")?.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-detail]");
  if (!btn) return;
  const row = lastHistoryRows.find((r) => r.id === btn.dataset.detail);
  if (row) openHistoryDetail(row);
});
document.getElementById("histClose")?.addEventListener("click", closeHistoryDetail);
document.getElementById("histDetail")?.addEventListener("click", (event) => {
  if (event.target === event.currentTarget) closeHistoryDetail();
});
for (const entry of [el.sideLogin, el.bannerLogin]) {
  entry.addEventListener("click", () => {
    show("login");
    el.email.focus();
  });
}
var dataMsg = document.getElementById("dataMsg");
var say = (text, kind = "ok") => {
  if (!dataMsg) return;
  dataMsg.textContent = text;
  dataMsg.className = `msg${kind === "ok" ? " ok" : " err"}`;
};
document.getElementById("exportData")?.addEventListener("click", () => {
  if (account === null) return;
  const json = exportData(account.email);
  const blob = new Blob([json], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `ai-fitness-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  say(`\u5DF2\u5BFC\u51FA ${JSON.parse(json).sessions.length} \u6761\u8BB0\u5F55`);
});
var importInput = document.getElementById("importFile");
document.getElementById("importData")?.addEventListener("click", () => importInput?.click());
importInput?.addEventListener("change", () => {
  const file = importInput.files?.[0];
  if (!file || account === null) return;
  const email = account.email;
  void file.text().then((text) => {
    try {
      const res = importData(email, text);
      say(`\u5BFC\u5165\u5B8C\u6210\uFF1A\u65B0\u589E ${res.added} \u6761\uFF0C\u8DF3\u8FC7\u91CD\u590D ${res.skipped} \u6761`);
      void refreshHome();
      void loadHistory();
    } catch (error) {
      say(error instanceof Error ? error.message : String(error), "err");
    } finally {
      importInput.value = "";
    }
  });
});
document.getElementById("clearData")?.addEventListener("click", () => {
  if (account === null) return;
  if (!window.confirm("\u786E\u5B9A\u6E05\u7A7A\u672C\u673A\u7684\u5168\u90E8\u8BAD\u7EC3\u8BB0\u5F55\u5417\uFF1F\u5EFA\u8BAE\u5148\u5BFC\u51FA\u5907\u4EFD\u3002")) return;
  const removed = localClearSessions(account.email);
  say(`\u5DF2\u6E05\u9664 ${removed} \u6761\u672C\u673A\u8BB0\u5F55`);
  void refreshHome();
  void loadHistory();
});
setupTrainDrawer();
renderRestBar();
document.getElementById("saveCard")?.addEventListener("click", saveWorkoutCard);
if (new URLSearchParams(location.search).get("debug") === "1") {
  window.__buildCard = buildWorkoutCard;
}
if (announcer === null) el.voiceBtn.style.display = "none";
el.voiceBtn.addEventListener("click", () => {
  if (announcer === null) return;
  announcer.enabled = !announcer.enabled;
  el.voiceBtn.textContent = `\u8BED\u97F3\u64AD\u62A5\uFF1A${announcer.enabled ? "\u5F00" : "\u5173"}`;
  if (!announcer.enabled && typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
});
el.retryCam.addEventListener("click", () => {
  void (async () => {
    hideCameraNotice();
    await runtime?.stop();
    runtime = null;
    await camera?.dispose();
    camera = null;
    resetTrainingState();
    el.pauseBtn.disabled = true;
    await startCameraAndRuntime();
  })();
});
el.cancelCam.addEventListener("click", () => {
  void (async () => {
    await stopCameraAndRuntime();
    hideCameraNotice();
    show("home");
  })();
});
el.flipCam.addEventListener("click", () => {
  void (async () => {
    if (camera === null || !camera.isRunning) return;
    el.flipCam.disabled = true;
    try {
      const info = await camera.switchFacing();
      canvas.width = info.width;
      canvas.height = info.height;
      applyCameraMirror();
      el.hudLeft.textContent = `${info.width}\xD7${info.height}`;
      const nowFacing = camera.facing === "environment" ? "\u540E\u7F6E" : "\u524D\u7F6E";
      announcer?.say("flip", `\u5DF2\u5207\u6362\u5230${nowFacing}\u6444\u50CF\u5934`, 500);
      setPrompt(null);
    } catch {
      setPrompt("\u5207\u6362\u5931\u8D25\uFF0C\u8FD9\u53F0\u8BBE\u5907\u53EF\u80FD\u53EA\u6709\u4E00\u9897\u6444\u50CF\u5934");
    } finally {
      el.flipCam.disabled = false;
    }
  })();
});
el.skipRest.addEventListener("click", () => {
  if (resting) endRest(performance.now());
});
el.pauseBtn.addEventListener("click", () => {
  paused = !paused;
  el.pauseBtn.textContent = paused ? "\u7EE7\u7EED" : "\u6682\u505C";
  setPrompt(paused ? COACH.paused : null);
});
el.finishBtn.addEventListener("click", () => void finishTraining());
el.saveBtn.addEventListener("click", () => void saveTraining());
$("doneBtn").addEventListener("click", () => {
  show("home");
  void refreshHome();
});
el.logoutBtn.addEventListener("click", () => {
  void (async () => {
    if (account?.source === "cloud") {
      try {
        await api("/auth/logout", { method: "POST" });
      } catch {
      }
    } else {
      localClearAuth();
    }
    applyAccount(null);
    show("login");
  })();
});
async function boot() {
  if (!CLOUD) {
    const email = localAuthEmail();
    applyAccount(email === null ? null : { email, source: "local" });
    el.onlineBanner.innerHTML = "<b>\u672C\u673A\u7248</b> \xB7 \u8D26\u53F7\u4E0E\u8BAD\u7EC3\u6570\u636E\u4FDD\u5B58\u5728\u8FD9\u53F0\u8BBE\u5907\u4E0A\uFF0C\u65E0\u9700\u8054\u7F51\uFF1B\u753B\u9762\u4E0D\u4F1A\u79BB\u5F00\u8BBE\u5907";
    el.onlineBanner.style.display = "block";
    el.guestBanner.style.display = email === null ? "block" : "none";
    if (email === null) {
      if (document.body.dataset.screen !== "train") show("login");
    } else {
      goTo("home");
    }
    return;
  }
  try {
    const me = await api("/auth/me");
    applyAccount({ email: me.email, source: "cloud" });
    goTo("home");
  } catch {
    applyAccount(null);
    if (document.body.dataset.screen !== "train") show("login");
  }
}
void boot();
var params = new URLSearchParams(location.search);
if (params.get("auto") === "train") {
  const ex = params.get("ex") ?? "squat";
  void enterTraining(EXERCISES[ex] ? ex : "squat");
}
window.__app = {
  enterTraining,
  finishTraining,
  saveTraining,
  doAuth,
  applyAccount,
  currentMetrics,
  loadHistory,
  refreshHome
};
//# sourceMappingURL=app.js.map
