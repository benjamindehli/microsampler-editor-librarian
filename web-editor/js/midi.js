// =============================================================================
// Thin wrapper around the Web MIDI API.
//   - SysEx access requires a secure context (https:// or http://localhost) and
//     the user granting the "MIDI with SysEx" permission prompt.
//   - The original app warned that the microSAMPLER cannot share its USB-MIDI
//     port with a DAW; the same applies here. Close other MIDI software first.
// =============================================================================

export class MidiEngine extends EventTarget {
  constructor() {
    super();
    this.access = null;
    this.input = null;
    this.output = null;
  }

  get supported() {
    return typeof navigator !== 'undefined' && !!navigator.requestMIDIAccess;
  }

  async init() {
    if (!this.supported) {
      throw new Error(
        'Web MIDI is not available. Use Chrome, Edge or Opera, served over ' +
        'http://localhost or https://.'
      );
    }
    this.access = await navigator.requestMIDIAccess({ sysex: true });
    this.access.onstatechange = () => this.dispatchEvent(new Event('portschange'));
    this.dispatchEvent(new Event('portschange'));
    return this.access;
  }

  get inputs()  { return this.access ? [...this.access.inputs.values()]  : []; }
  get outputs() { return this.access ? [...this.access.outputs.values()] : []; }

  selectInput(id) {
    if (this.input) this.input.onmidimessage = null;
    this.input = this.inputs.find(p => p.id === id) || null;
    if (this.input) {
      this.input.onmidimessage = e => {
        this.dispatchEvent(new CustomEvent('message', {
          detail: { data: e.data, timeStamp: e.timeStamp },
        }));
      };
    }
    this.dispatchEvent(new Event('selectionchange'));
  }

  selectOutput(id) {
    this.output = this.outputs.find(p => p.id === id) || null;
    this.dispatchEvent(new Event('selectionchange'));
  }

  /** Try to auto-pick the microSAMPLER by name. */
  autoSelect() {
    const match = p => /microsampler|micro sampler|korg/i.test(p.name || '');
    const inp = this.inputs.find(match);
    const out = this.outputs.find(match);
    if (inp) this.selectInput(inp.id);
    if (out) this.selectOutput(out.id);
    return { input: inp || null, output: out || null };
  }

  send(bytes) {
    if (!this.output) throw new Error('No MIDI output selected.');
    this.output.send(bytes);
    this.dispatchEvent(new CustomEvent('sent', { detail: { data: bytes } }));
  }
}
