'use strict';
const Leap = require('leapjs');
const { EventEmitter } = require('events');

class LeapReader extends EventEmitter {
  constructor(options = {}) {
    super();
    this._controller = new Leap.Controller({
      background: options.background ?? true,
      enableGestures: options.enableGestures ?? true,
      optimizeHMD: options.optimizeHMD ?? false,
    });
    this._frameSkip = options.frameSkip ?? 0;
    this._frameCount = 0;
    this._bindEvents();
  }

  _bindEvents() {
    const c = this._controller;
    c.on('connect', () => { console.log('✅ Connected to Leap Motion service.'); this.emit('connect'); });
    c.on('disconnect', () => { console.log('🔌 Disconnected from Leap Motion service.'); this.emit('disconnect'); });
    c.on('streamingStarted', (info) => { console.log('🖐️  Streaming started:', info); this.emit('streamingStarted', info); });
    c.on('streamingStopped', (info) => { console.log('✋ Streaming stopped:', info); this.emit('streamingStopped', info); });
    c.on('focus', () => { console.log('🟢 App gained focus.'); this.emit('focus'); });
    c.on('blur', () => { console.log('🟡 App lost focus (background mode).'); this.emit('blur'); });
    c.on('frame', (frame) => this._onFrame(frame));
  }

  _onFrame(frame) {
    if (!frame.valid || !frame.hands?.length) return;
    if (this._frameSkip > 0) {
      this._frameCount = (this._frameCount + 1) % (this._frameSkip + 1);
      if (this._frameCount !== 0) return;
    }
    this.emit('frame', this._parseFrame(frame));
  }

  _parseFrame(frame) {
    const FINGER_NAMES = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];
    const hands = frame.hands.map((hand) => ({
      id: hand.id,
      type: hand.type,
      confidence: hand.confidence,
      palmPosition: [...hand.palmPosition],
      palmVelocity: [...hand.palmVelocity],
      palmNormal: [...hand.palmNormal],
      direction: [...hand.direction],
      grabStrength: hand.grabStrength,
      pinchStrength: hand.pinchStrength,
      sphereRadius: hand.sphereRadius,
      fingers: hand.fingers.map((f) => ({
        type: f.type,
        name: FINGER_NAMES[f.type],
        tipPosition: [...f.tipPosition],
        tipVelocity: [...f.tipVelocity],
        extended: f.extended,
      })),
    }));
    const gestures = (frame.gestures ?? []).map((g) => {
      const base = { type: g.type, state: g.state, id: g.id };
      switch (g.type) {
        case 'circle': return { ...base, clockwise: g.clockwise, progress: g.progress, radius: g.radius };
        case 'swipe': return { ...base, speed: g.speed, direction: [...g.direction] };
        case 'keyTap':
        case 'screenTap': return { ...base, position: [...g.position], direction: [...g.direction] };
        default: return base;
      }
    });
    return {
      id: frame.id,
      fps: frame.currentFrameRate,
      timestamp: frame.timestamp,
      handsCount: hands.length,
      fingersCount: frame.fingers.length,
      hands,
      gestures,
    };
  }

  displayFrame(data) {
    console.log(`\n─── Frame #${data.id} ─────────────────────────────────`);
    console.log(`    Hands: ${data.handsCount}  |  Fingers: ${data.fingersCount}  |  FPS: ${data.fps.toFixed(1)}`);
    for (const hand of data.hands) {
      const [px, py, pz] = hand.palmPosition;
      const [vx, vy, vz] = hand.palmVelocity;
      const [nx, ny, nz] = hand.palmNormal;
      const [dx, dy, dz] = hand.direction;
      console.log(`\n  ✋ ${hand.type.toUpperCase()} hand  (confidence: ${hand.confidence.toFixed(2)})`);
      console.log(`     Palm position : [${px.toFixed(1)}, ${py.toFixed(1)}, ${pz.toFixed(1)}] mm`);
      console.log(`     Palm velocity : [${vx.toFixed(1)}, ${vy.toFixed(1)}, ${vz.toFixed(1)}] mm/s`);
      console.log(`     Palm normal   : [${nx.toFixed(2)}, ${ny.toFixed(2)}, ${nz.toFixed(2)}]`);
      console.log(`     Direction     : [${dx.toFixed(2)}, ${dy.toFixed(2)}, ${dz.toFixed(2)}]`);
      console.log(`     Grab strength : ${hand.grabStrength.toFixed(2)}`);
      console.log(`     Pinch strength: ${hand.pinchStrength.toFixed(2)}`);
      console.log(`     Sphere radius : ${hand.sphereRadius.toFixed(1)} mm`);
      for (const f of hand.fingers) {
        const [tx, ty, tz] = f.tipPosition;
        const [uvx, uvy, uvz] = f.tipVelocity;
        console.log(`       ${f.name.padEnd(6)} tip: [${tx.toFixed(1)}, ${ty.toFixed(1)}, ${tz.toFixed(1)}]  vel: [${uvx.toFixed(0)}, ${uvy.toFixed(0)}, ${uvz.toFixed(0)}]  extended: ${f.extended ? 'yes' : 'no '}`);
      }
    }
  }

  connect() { this._controller.connect(); }
  disconnect() { this._controller.disconnect(); }
}

module.exports = LeapReader;
