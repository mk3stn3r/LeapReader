// mappingReader.js — JSON-driven Leap Motion → MIDI interpreter
// Features: note scales + quantization, velocity curves, mono/poly modes,
//           per-device preset folders, hot-reload of mapping JSON.
'use strict';

const fs   = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

const clamp  = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const remap  = (v, i0, i1, o0, o1) =>
  clamp(Math.round(((v - i0) / (i1 - i0)) * (o1 - o0) + o0), o0, o1);

// ── Scale tables (intervals from root) ────────────────────────────────────────
const SCALES = {
  chromatic:       [0,1,2,3,4,5,6,7,8,9,10,11],
  major:           [0,2,4,5,7,9,11],
  minor:           [0,2,3,5,7,8,10],
  harmonic_minor:  [0,2,3,5,7,8,11],
  melodic_minor:   [0,2,3,5,7,9,11],
  dorian:          [0,2,3,5,7,9,10],
  phrygian:        [0,1,3,5,7,8,10],
  lydian:          [0,2,4,6,7,9,11],
  mixolydian:      [0,2,4,5,7,9,10],
  pentatonic:      [0,2,4,7,9],
  minor_pentatonic:[0,3,5,7,10],
  blues:           [0,3,5,6,7,10],
  whole_tone:      [0,2,4,6,8,10],
  diminished:      [0,2,3,5,6,8,9,11],
  augmented:       [0,3,4,7,8,11],
};

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

/** Parse a root note name like "C", "F#", "Bb" into a semitone offset 0-11 */
function parseRoot(rootStr) {
  if (!rootStr) return 0;
  const s = rootStr.trim().replace('b','#').toUpperCase();
  const flat = rootStr.includes('b');
  // Handle flats by normalising: Bb→A#, Eb→D#, Ab→G#, Db→C#, Gb→F#
  const flatMap = { 'BB':10,'EB':3,'AB':8,'DB':1,'GB':6 };
  const key = s.replace('#','').replace('B','B') ;
  if (flat) {
    const flatKey = rootStr.replace('b','').toUpperCase() + 'B';
    if (flatMap[flatKey] !== undefined) return flatMap[flatKey];
  }
  const idx = NOTE_NAMES.indexOf(s);
  return idx >= 0 ? idx : 0;
}

/**
 * Quantize a raw MIDI note to the nearest note in a given scale.
 * @param {number}   note      Raw MIDI note (0-127)
 * @param {number[]} intervals Scale intervals (semitones from root within one octave)
 * @param {number}   root      Root semitone (0-11)
 * @returns {number} Quantized MIDI note
 */
function quantizeToScale(note, intervals, root) {
  const octave    = Math.floor(note / 12);
  const semitone  = note % 12;
  // Normalise semitone relative to root
  const relative  = ((semitone - root) % 12 + 12) % 12;
  // Find nearest interval
  let best = intervals[0], bestDist = 12;
  for (const iv of intervals) {
    const d = Math.min(Math.abs(iv - relative), 12 - Math.abs(iv - relative));
    if (d < bestDist) { bestDist = d; best = iv; }
  }
  return clamp(octave * 12 + root + best, 0, 127);
}

// ── Velocity curves ────────────────────────────────────────────────────────────
/**
 * Apply a named velocity curve.
 * @param {number} vel    Raw velocity 0-127
 * @param {string} curve  'linear'|'soft'|'hard'|'exp'|'log'|'fixed:<N>'
 * @returns {number} Shaped velocity 0-127
 */
function applyVelocityCurve(vel, curve) {
  if (!curve || curve === 'linear') return vel;
  const n = vel / 127;   // normalise to 0-1
  if (curve === 'soft')  return Math.round(Math.pow(n, 1.8) * 127);
  if (curve === 'hard')  return Math.round(Math.pow(n, 0.5) * 127);
  if (curve === 'exp')   return Math.round(Math.pow(n, 3.0) * 127);
  if (curve === 'log')   return Math.round((Math.log(1 + n * (Math.E - 1))) * 127);
  if (curve.startsWith('fixed:')) return clamp(parseInt(curve.split(':')[1], 10), 1, 127);
  return vel;
}

// ── Axis resolution ────────────────────────────────────────────────────────────
function resolveAxis(hand, axis) {
  switch (axis) {
    case 'palm_y':    return hand.palmPosition[1];
    case 'palm_x':    return hand.palmPosition[0];
    case 'palm_z':    return hand.palmPosition[2];
    case 'grab':      return hand.grabStrength;
    case 'pinch':     return hand.pinchStrength;
    case 'roll':      return hand.palmNormal[0];
    case 'pitch':     return hand.direction[1];
    case 'yaw':       return hand.direction[0];
    case 'vel_x':     return hand.palmVelocity[0];
    case 'vel_y':     return hand.palmVelocity[1];
    case 'vel_z':     return hand.palmVelocity[2];
    default: return 0;
  }
}

const AXIS_RANGES = {
  palm_y: [80, 650], palm_x: [-250, 250], palm_z: [-250, 250],
  grab: [0, 1], pinch: [0, 1],
  roll: [-1, 1], pitch: [-1, 1], yaw: [-1, 1],
  vel_x: [-600, 600], vel_y: [-600, 600], vel_z: [-600, 600],
};

function axisToCCValue(axis, rawValue) {
  const [lo, hi] = AXIS_RANGES[axis] ?? [0, 127];
  return remap(rawValue, lo, hi, 0, 127);
}

// ── Swipe direction ────────────────────────────────────────────────────────────
function classifySwipeDirection(dir) {
  const [x, y, z] = dir;
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  if (ay > ax && ay > az) return y > 0 ? 'up'     : 'down';
  if (az > ax && az > ay) return z > 0 ? 'away'   : 'toward';
  return x > 0 ? 'right' : 'left';
}

// ═══════════════════════════════════════════════════════════════════════════════
// MappingReader
// ═══════════════════════════════════════════════════════════════════════════════

class MappingReader {
  /**
   * @param {string} mappingPath   Path to the JSON mapping file
   * @param {object} midiOutput    Open easymidi Output instance
   * @param {object} [options]
   * @param {boolean} [options.verbose]   Log every MIDI message
   * @param {boolean} [options.hotReload] Watch file and reload on change (default true)
   */
  constructor(mappingPath, midiOutput, options = {}) {
    this._out        = midiOutput;
    this._verbose    = options.verbose   ?? false;
    this._hotReload  = options.hotReload ?? true;
    this._mapPath    = path.resolve(mappingPath);

    this._map        = null;
    this._scaleInfo  = null;   // { intervals, root }
    this._gestureIdx = null;
    this._circleCCVal = { left: 64, right: 64, global: 64 };

    // Per-hand note state (mono + poly)
    this._heldNotes  = { left: new Set(), right: new Set() };
    this._palmNote   = { left: null, right: null };

    // Active gesture notes (debounce)
    this._activeGestureNotes = new Set();

    // CC dedup
    this._lastCC = new Map();

    this._loadMapping();

    if (this._hotReload) this._watchFile();
  }

  // ── Load / reload ──────────────────────────────────────────────────────────

  _loadMapping() {
    if (!fs.existsSync(this._mapPath)) {
      console.error(`❌ Mapping file not found: ${this._mapPath}`);
      process.exit(1);
    }
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this._mapPath, 'utf8'));
    } catch (e) {
      console.error(`❌ JSON parse error in mapping file: ${e.message}`);
      if (!this._map) process.exit(1);
      return;  // keep old map on hot-reload failure
    }

    this._map        = raw;
    this._ch         = raw.midi_channel ?? 0;
    this._noteDurMs  = Math.round((raw.gesture_note_duration ?? 0.10) * 1000);
    this._scaleInfo  = this._parseScale(raw.scale);
    this._gestureIdx = this._buildGestureIndex(raw.gestures ?? {});

    console.log(`📄 Mapping loaded: ${path.basename(this._mapPath)}`);
    if (raw._info) console.log(`   ${raw._info}`);
    if (this._scaleInfo) {
      console.log(`   Scale: ${raw.scale?.name ?? 'chromatic'} root ${raw.scale?.root ?? 'C'}`);
    }
  }

  _watchFile() {
    let debounce = null;
    fs.watch(this._mapPath, () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        console.log(`🔄 Mapping file changed — reloading…`);
        this._releaseAll();
        this._loadMapping();
      }, 150);
    });
    console.log(`👁  Watching mapping file for changes.`);
  }

  // ── Scale parsing ──────────────────────────────────────────────────────────

  _parseScale(scaleCfg) {
    if (!scaleCfg) return null;
    const name      = scaleCfg.name ?? 'chromatic';
    const intervals = SCALES[name] ?? SCALES.chromatic;
    const root      = parseRoot(scaleCfg.root ?? 'C');
    return { intervals, root };
  }

  _quantize(note) {
    if (!this._scaleInfo) return note;
    return quantizeToScale(note, this._scaleInfo.intervals, this._scaleInfo.root);
  }

  // ── Gesture index ──────────────────────────────────────────────────────────

  _buildGestureIndex(raw) {
    const idx = { swipe: {}, screenTap: {}, keyTap: {} };
    for (const [key, entry] of Object.entries(raw)) {
      if (key.startsWith('_') || !entry?.type) continue;
      if (entry.type === 'swipe')      idx.swipe[entry.direction]              = entry;
      if (entry.type === 'screenTap')  idx.screenTap[`${entry.hand}_${entry.finger}`] = entry;
      if (entry.type === 'keyTap')     idx.keyTap[`${entry.hand}_${entry.finger}`]    = entry;
    }
    return idx;
  }

  // ── Public: process one parsed Leap frame ─────────────────────────────────

  processFrame(data) {
    const presentSides = new Set(data.hands.map(h => h.type));

    for (const hand of data.hands) this._processHand(hand);

    // Release palm notes for hands that left the field
    for (const side of ['left', 'right']) {
      if (!presentSides.has(side) && this._palmNote[side] !== null) {
        this._doNoteOff(this._palmNote[side], `${side} hand lost`);
        this._palmNote[side] = null;
        this._heldNotes[side].clear();
      }
    }

    for (const gesture of data.gestures) this._processGesture(gesture, data.hands);
  }

  // ── Hand → notes + CC ─────────────────────────────────────────────────────

  _processHand(hand) {
    const side  = hand.type;
    const cfg   = this._map[`${side}_hand`];
    if (!cfg) return;

    if (hand.confidence < (cfg.min_confidence ?? 0.3)) {
      this._releaseHand(side);
      return;
    }

    const polyphonic = cfg.polyphonic ?? false;
    const mode       = cfg.trigger_mode ?? 'retrigger';
    const vcurve     = cfg.velocity_curve ?? this._map.velocity_curve ?? 'linear';

    // ── Derive velocity ──────────────────────────────────────────────────────
    let vel;
    if (this._map.velocity_fixed != null) {
      vel = this._map.velocity_fixed;
    } else if (cfg.velocity_axis) {
      const raw = resolveAxis(hand, cfg.velocity_axis);
      vel = axisToCCValue(cfg.velocity_axis, raw);
    } else {
      vel = clamp(Math.abs(Math.round(hand.palmVelocity[1] / 4)), 40, 127);
    }
    vel = applyVelocityCurve(clamp(vel, 1, 127), vcurve);

    // ── Palm note ────────────────────────────────────────────────────────────
    const axisVal = resolveAxis(hand, cfg.axis ?? 'palm_y');
    const rawNote = remap(axisVal, 80, 650, cfg.note_min ?? 36, cfg.note_max ?? 60);
    const note    = this._quantize(rawNote);

    if (polyphonic) {
      // Polyphonic mode: track all notes played this frame
      if (!this._heldNotes[side].has(note)) {
        this._doNoteOn(note, vel, `${side} poly`);
        this._heldNotes[side].add(note);
      }
    } else {
      // Monophonic mode
      if (mode === 'retrigger') {
        if (this._palmNote[side] !== note) {
          if (this._palmNote[side] !== null) {
            this._doNoteOff(this._palmNote[side], `${side} retrigger`);
            this._heldNotes[side].clear();
          }
          this._doNoteOn(note, vel, `${side} mono`);
          this._palmNote[side] = note;
          this._heldNotes[side].add(note);
        }
      } else if (mode === 'hold') {
        if (this._palmNote[side] === null) {
          this._doNoteOn(note, vel, `${side} hold`);
          this._palmNote[side] = note;
          this._heldNotes[side].add(note);
        }
      } else if (mode === 'gate') {
        // Gate: note on while hand is present; same note retriggers if it changes
        if (this._palmNote[side] !== note) {
          if (this._palmNote[side] !== null) this._doNoteOff(this._palmNote[side], `${side} gate`);
          this._doNoteOn(note, vel, `${side} gate`);
          this._palmNote[side] = note;
        }
      }
    }

    // ── CC from hand axis ────────────────────────────────────────────────────
    const ccSends = Array.isArray(cfg.cc_send) ? cfg.cc_send
      : (cfg.cc_send && cfg.cc_number != null ? [{ cc_number: cfg.cc_number, cc_axis: cfg.cc_axis }] : []);

    for (const cc of ccSends) {
      if (!cc.cc_axis || cc.cc_number == null) continue;
      const ccRaw = resolveAxis(hand, cc.cc_axis);
      let ccVal   = axisToCCValue(cc.cc_axis, ccRaw);
      if (cc.velocity_curve) ccVal = applyVelocityCurve(ccVal, cc.velocity_curve);
      this._sendCC(cc.cc_number, ccVal, `${side} ${cc.cc_axis}→CC${cc.cc_number}`);
    }
    // Also handle legacy single-CC format from example mapping
    if (!Array.isArray(cfg.cc_send) && cfg.cc_send && cfg.cc_number != null && cfg.cc_axis) {
      const ccRaw = resolveAxis(hand, cfg.cc_axis);
      const ccVal = axisToCCValue(cfg.cc_axis, ccRaw);
      this._sendCC(cfg.cc_number, ccVal, `${side} ${cfg.cc_axis}→CC${cfg.cc_number}`);
    }
  }

  _releaseHand(side) {
    for (const note of this._heldNotes[side]) this._doNoteOff(note, `${side} release`);
    this._heldNotes[side].clear();
    this._palmNote[side] = null;
  }

  // ── Gesture → note ─────────────────────────────────────────────────────────

  _processGesture(gesture, hands) {
    if (gesture.state !== 'stop' && gesture.state !== 'update') return;

    switch (gesture.type) {

      case 'swipe': {
        if (gesture.state !== 'stop') break;
        const dir   = classifySwipeDirection(gesture.direction);
        const entry = this._gestureIdx.swipe[dir];
        if (!entry) break;
        const rawVel = this._map.velocity_fixed ?? entry.velocity ?? 100;
        const vel    = applyVelocityCurve(rawVel, entry.velocity_curve ?? this._map.velocity_curve ?? 'linear');
        const note   = this._quantize(entry.note);
        this._fireGestureNote(note, vel, `swipe ${dir}`);
        break;
      }

      case 'circle': {
        const circleCfg = this._map.circle_cc;
        if (circleCfg) {
          if (gesture.state !== 'update') break;
          // Support per-hand circle CC if the gesture can be attributed to a hand
          const key = 'global';
          const step = circleCfg.step ?? 4;
          this._circleCCVal[key] = clamp(
            this._circleCCVal[key] + (gesture.clockwise ? step : -step), 0, 127
          );
          this._sendCC(circleCfg.cc_number, this._circleCCVal[key],
            `circle ${gesture.clockwise ? 'CW' : 'CCW'}→CC${circleCfg.cc_number}`);
        } else {
          if (gesture.state !== 'stop') break;
          const val = gesture.clockwise ? 127 : 0;
          this._out.send('cc', { channel: this._ch, controller: 64, value: val });
          this._log(`⭕ circle → CC64 sustain ${val}`);
        }
        break;
      }

      case 'screenTap': {
        if (gesture.state !== 'stop') break;
        const match = this._resolveFingerGesture('screenTap', gesture, hands);
        if (!match) break;
        const rawVel = this._map.velocity_fixed ?? match.velocity ?? 110;
        const vel    = applyVelocityCurve(rawVel, match.velocity_curve ?? this._map.velocity_curve ?? 'linear');
        this._fireGestureNote(this._quantize(match.note), vel, `screenTap ${match._key}`);
        break;
      }

      case 'keyTap': {
        if (gesture.state !== 'stop') break;
        const match = this._resolveFingerGesture('keyTap', gesture, hands);
        if (!match) break;
        const rawVel = this._map.velocity_fixed ?? match.velocity ?? 110;
        const vel    = applyVelocityCurve(rawVel, match.velocity_curve ?? this._map.velocity_curve ?? 'linear');
        this._fireGestureNote(this._quantize(match.note), vel, `keyTap ${match._key}`);
        break;
      }
    }
  }

  // ── Resolve finger gesture by tip proximity ────────────────────────────────

  _resolveFingerGesture(type, gesture, hands) {
    if (!hands.length || !gesture.position) return null;
    let bestEntry = null, bestDist = Infinity;
    for (const hand of hands) {
      for (const finger of hand.fingers) {
        const tp  = finger.tipPosition;
        const gp  = gesture.position;
        const dSq = (tp[0]-gp[0])**2 + (tp[1]-gp[1])**2 + (tp[2]-gp[2])**2;
        if (dSq < bestDist) {
          const k     = `${hand.type}_${finger.type}`;
          const entry = this._gestureIdx[type][k];
          if (entry) { bestDist = dSq; bestEntry = { ...entry, _key: k }; }
        }
      }
    }
    return bestEntry;
  }

  // ── Note fire helpers ──────────────────────────────────────────────────────

  _fireGestureNote(note, velocity, label) {
    const key = `g:${note}`;
    if (this._activeGestureNotes.has(key)) return;
    this._activeGestureNotes.add(key);
    this._doNoteOn(note, velocity, label);
    setTimeout(() => {
      this._doNoteOff(note, `${label} off`);
      this._activeGestureNotes.delete(key);
    }, this._noteDurMs);
  }

  // ── MIDI primitives ────────────────────────────────────────────────────────

  _doNoteOn(note, velocity, label) {
    this._out.send('noteon', { channel: this._ch, note, velocity });
    this._log(`♪  NoteOn  note${note} vel${velocity}  [${label}]`);
  }

  _doNoteOff(note, label) {
    this._out.send('noteoff', { channel: this._ch, note, velocity: 0 });
    this._log(`♩  NoteOff note${note}  [${label}]`);
  }

  _sendCC(controller, value, label) {
    const key = String(controller);
    if (this._lastCC.get(key) === value) return;
    this._lastCC.set(key, value);
    this._out.send('cc', { channel: this._ch, controller, value });
    this._log(`🎛  CC cc${controller}=${value}  [${label}]`);
  }

  _log(msg) { if (this._verbose) console.log(msg); }

  // ── Release everything ─────────────────────────────────────────────────────

  _releaseAll() {
    for (const side of ['left', 'right']) this._releaseHand(side);
  }

  close() {
    this._releaseAll();
  }
}

module.exports = MappingReader;
