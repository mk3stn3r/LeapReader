#!/usr/bin/env node
'use strict';

const LeapReader          = require('./leap-reader');
const LeapMidiInterpreter = require('./leap-midi-interpreter');
const MappingReader       = require('./mappingReader');
const easymidi            = require('easymidi');

// ── CLI helpers ───────────────────────────────────────────────────────────────

const args        = process.argv.slice(2);
const getFlag     = (name) => args.includes(name);
const getFlagVal  = (name) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : undefined; };

// ── --list-ports ──────────────────────────────────────────────────────────────

if (getFlag('--list-ports') || getFlag('-l')) {
  LeapMidiInterpreter.listPorts();
  process.exit(0);
}

// ── --help ────────────────────────────────────────────────────────────────────

if (getFlag('--help') || getFlag('-h')) {
  console.log(`
Usage:
  node index.js --port <number>  [options]
  node index.js --list-ports

Port selection:
  --port N            Use the port at index N from --list-ports output
  --virtual           Open a virtual MIDI port (macOS/Linux only).
                      When combined with --port, the index N names the port.

Mapping:
  --mapping <path>    Path to a JSON mapping file (e.g. mappings/minitaur.json).
                      When supplied, MappingReader is used instead of the
                      built-in gesture interpreter.

Options:
  --verbose           Log every MIDI message sent
  --display           Print raw Leap frame data to the console
  --frame-skip N      Process every N+1 frames to reduce CPU (default: 2)
  --list-ports        List available MIDI output ports and exit
  --help              Show this help message

Examples:
  node index.js --list-ports
  node index.js --port 0
  node index.js --port 1 --mapping mappings/minitaur.json --verbose
  node index.js --port 0 --frame-skip 3 --display
  node index.js --virtual --mapping mappings/minitaur.json
`);
  process.exit(0);
}

// ── Resolve port ──────────────────────────────────────────────────────────────

const isVirtual    = getFlag('--virtual');
const isVerbose    = getFlag('--verbose');
const showDisplay  = getFlag('--display');
const mappingPath  = getFlagVal('--mapping');
const frameSkipRaw = getFlagVal('--frame-skip');
const frameSkip    = frameSkipRaw !== undefined ? parseInt(frameSkipRaw, 10) : 2;

let portName;

if (isVirtual) {
  // Virtual port — use index value as name if numeric, else treat as name, fallback to 'LeapMIDI'
  const raw = getFlagVal('--port');
  portName  = (raw && isNaN(Number(raw))) ? raw : (raw ? `LeapMIDI-${raw}` : 'LeapMIDI');
} else {
  const portIndexRaw = getFlagVal('--port');
  if (portIndexRaw === undefined) {
    console.error('❌ No port specified.\n   Use --port <number> to select a port, or --list-ports to see options.');
    process.exit(1);
  }
  const portIndex = parseInt(portIndexRaw, 10);
  if (isNaN(portIndex) || portIndex < 0) {
    console.error(`❌ Invalid port index: "${portIndexRaw}". Must be a non-negative integer.`);
    process.exit(1);
  }
  const available = easymidi.getOutputs();
  if (!available.length) {
    console.error('❌ No MIDI output ports found. Is your MIDI software/driver running?');
    process.exit(1);
  }
  if (portIndex >= available.length) {
    console.error(`❌ Port index ${portIndex} out of range. Available ports (0–${available.length - 1}):`);
    available.forEach((p, i) => console.error(`   [${i}] ${p}`));
    process.exit(1);
  }
  portName = available[portIndex];
  console.log(`🔌 Selected port [${portIndex}]: "${portName}"`);
}

// ── Open MIDI output ──────────────────────────────────────────────────────────

let rawOutput;
if (isVirtual) {
  rawOutput = new easymidi.Output(portName, true);
  console.log(`🎹 Opened virtual MIDI port: "${portName}"`);
} else {
  rawOutput = new easymidi.Output(portName);
  console.log(`🎹 Opened MIDI port: "${portName}"`);
}

// ── Select interpreter ────────────────────────────────────────────────────────

let interpreter;    // has .processFrame(data) and .close()

if (mappingPath) {
  interpreter = new MappingReader(mappingPath, rawOutput, { verbose: isVerbose });
} else {
  // Built-in interpreter manages its own output internally; wrap for uniform API
  // Pass an already-open output so it doesn't double-open the port.
  // LeapMidiInterpreter accepts a pre-opened output when given portName + existing output.
  interpreter = new LeapMidiInterpreter(portName, {
    verbose: isVerbose,
    virtual: isVirtual,
    _output: rawOutput,   // injected — see note below
  });
}

// ── Wire Leap → interpreter ───────────────────────────────────────────────────

const reader = new LeapReader({ frameSkip });

reader.on('frame', (data) => {
  if (showDisplay) reader.displayFrame(data);
  interpreter.processFrame(data);
});

reader.on('disconnect', () => {
  console.log('⚠️  Leap Motion disconnected — awaiting reconnection…');
});

// ── Startup banner ────────────────────────────────────────────────────────────

const mode = mappingPath ? `mapping: ${mappingPath}` : 'built-in interpreter';
console.log(`
┌──────────────────────────────────────────────────────┐
│  🖐  Leap Motion → MIDI                              │
│  Port      : ${portName.padEnd(38)}│
│  Mode      : ${mode.padEnd(38)}│
│  Frame skip: every ${String(frameSkip + 1).padEnd(2)} frames                      │
│  Verbose   : ${String(isVerbose).padEnd(38)}│
│  Display   : ${String(showDisplay).padEnd(38)}│
└──────────────────────────────────────────────────────┘
`);

reader.connect();

// ── Graceful shutdown ─────────────────────────────────────────────────────────

process.on('SIGINT', () => {
  console.log('\n👋 Shutting down…');
  interpreter.close();
  rawOutput.close();
  reader.disconnect();
  process.exit(0);
});
