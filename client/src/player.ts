import * as Tone from 'tone';
import { getInstrumentFilters, getInstrumentSampler, Instrument } from './instruments';
import * as Samples from './samples';
import { Track } from './track';
import { compress } from './helper';

/**
 * The Player plays a Track through Tone.js.
 */
class Player {
  playlist: Track[] = [];

  currentPlayingIndex: number;

  /** Current track. Can be undefined */
  get currentTrack() {
    if (this.currentPlayingIndex !== undefined) {
      return this.playlist[this.currentPlayingIndex];
    }
    return undefined;
  }

  /** Whether the player is currently playing */
  private _isPlaying: boolean = false;

  get isPlaying() {
    return this._isPlaying;
  }

  set isPlaying(isPlaying: boolean) {
    this._isPlaying = isPlaying;
    this.onPlayingStateChange();
    if (this.gain) {
      this.gain.gain.value = +isPlaying;
    }
  }

  repeat: RepeatMode = RepeatMode.NONE;

  shuffle = false;

  /** Playing queue, used when shuffling */
  shuffleQueue: number[] = [];

  private _muted = false;

  get muted() {
    return this._muted;
  }

  set muted(muted: boolean) {
    this._muted = muted;
    if (muted) {
      this.previousGain = this.gain.gain.value;
      this.gain.gain.value = 0;
    } else {
      this.gain.gain.value = this.previousGain;
    }
  }

  previousGain: number;

  /** Function to update the playlist in the UI */
  updatePlaylistDisplay: () => void;

  /** Function to update track information in the UI */
  updateTrackDisplay: (seconds?: number) => void;

  /** Function to call when the track changes */
  onTrackChange: () => void;

  /** Function to call when isPlaying changes */
  onPlayingStateChange: () => void;

  samplePlayers: Map<string, Tone.Player[]>;

  instrumentSamplers: Map<Instrument, Tone.Sampler>;

  gain: Tone.Gain = new Tone.Gain();

  /** Filters */

  compressor: Tone.Compressor;

  lowPassFilter: Tone.Filter;

  highPassFilter: Tone.Filter;

  equalizer: Tone.EQ3;

  distortion: Tone.Distortion;

  reverb: Tone.Reverb;

  chebyshev: Tone.Chebyshev;

  bitcrusher: Tone.BitCrusher;

  defaultFilters: Tone.ToneAudioNode[];

  initDefaultFilters() {
    this.compressor = new Tone.Compressor(-15, 3);
    this.lowPassFilter = new Tone.Filter({
      type: 'lowpass',
      frequency: 5000
    });
    this.highPassFilter = new Tone.Filter({
      type: 'highpass',
      frequency: 0
    });
    this.equalizer = new Tone.EQ3(0, 0, 0);
    this.distortion = new Tone.Distortion(0);
    this.reverb = new Tone.Reverb({
      decay: 0.001,
      wet: 0,
      preDelay: 0
    });
    this.chebyshev = new Tone.Chebyshev(1);
    // this.bitcrusher = new Tone.BitCrusher(16);
    this.gain = new Tone.Gain();

    this.defaultFilters = [
      this.compressor,
      this.lowPassFilter,
      this.highPassFilter,
      this.reverb,
      // this.bitcrusher,
      // this.equalizer,
      this.chebyshev
      // this.distortion
    ];
  }

  connectFilter(filter: Tone.ToneAudioNode) {
    this.defaultFilters.splice(this.defaultFilters.indexOf(this.gain), 0, filter);
    for (const player of this.instrumentSamplers.values()) {
      player.disconnect();
      player.chain(...this.defaultFilters, this.gain, Tone.Destination);
    }
    for (const player of this.samplePlayers.values()) {
      for (const player2 of player.values()) {
        if (!player2) return;
        player2.disconnect();
        player2.chain(...this.defaultFilters, this.gain, Tone.Destination);
      }
    }
  }

  async addToPlaylist(track: Track) {
    this.playlist.push(track);
    this.updatePlaylistDisplay();
    if (!this.isPlaying) {
      await this.playTrack(this.playlist.length - 1);
    }
    this.fillShuffleQueue();
  }

  async playTrack(playlistIndex: number) {
    this.currentPlayingIndex = playlistIndex;
    this.onTrackChange();
    this.seek(0);
    this.stop();
    await this.play();
  }

  async play() {
    if (!this.currentTrack) {
      return;
    }
    this.isPlaying = true;
    this.setAudioWebApiMetadata();

    // wait 500ms before trying to play the track
    // this is needed due to Tone.js scheduling conflicts if the user rapidly changes the track
    const trackToPlayIndex = this.currentPlayingIndex;
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (trackToPlayIndex !== this.currentPlayingIndex || !this.isPlaying) {
      return;
    }

    await Tone.start();
    Tone.Transport.bpm.value = this.currentTrack.bpm;

    this.samplePlayers = new Map();
    this.instrumentSamplers = new Map();

    this.initDefaultFilters();

    // load samples
    for (const [sampleGroupName, sampleIndex] of this.currentTrack.samples) {
      const sampleGroup = Samples.SAMPLEGROUPS.get(sampleGroupName);
      const player = new Tone.Player({
        url: sampleGroup.getSampleUrl(sampleIndex),
        volume: sampleGroup.volume,
        loop: true,
        fadeIn: '4n',
        fadeOut: '4n'
      })
        .chain(...sampleGroup.getFilters(), ...this.defaultFilters, this.gain, Tone.Destination)
        .sync();

      if (!this.samplePlayers.has(sampleGroupName)) {
        this.samplePlayers.set(sampleGroupName, Array(sampleGroup.size));
      }
      this.samplePlayers.get(sampleGroupName)[sampleIndex] = player;
    }

    // load instruments
    for (const instrument of this.currentTrack.instruments) {
      const sampler = getInstrumentSampler(instrument)
        .chain(
          ...getInstrumentFilters(instrument),
          ...this.defaultFilters,
          this.gain,
          Tone.Destination
        )
        .sync();
      this.instrumentSamplers.set(instrument, sampler);
    }

    // wait until all samples are loaded
    await Tone.loaded();
    await this.reverb.generate();

    for (const sampleLoop of this.currentTrack.sampleLoops) {
      const samplePlayer = this.samplePlayers.get(sampleLoop.sampleGroupName)[
        sampleLoop.sampleIndex
      ];
      samplePlayer.start(sampleLoop.startTime);
      samplePlayer.stop(sampleLoop.stopTime);
    }

    for (const noteTiming of this.currentTrack.instrumentNotes) {
      const instrumentSampler = this.instrumentSamplers.get(noteTiming.instrument);
      instrumentSampler.triggerAttackRelease(
        noteTiming.pitch,
        noteTiming.duration,
        noteTiming.time
      );
    }

    Tone.Transport.scheduleRepeat((time) => {
      const seconds = Tone.Transport.getSecondsAtTime(time);
      this.updateTrackDisplay(seconds);
      this.updateAudioWebApiPosition();

      if (this.currentTrack.length - seconds < 0) {
        this.playNext();
      }
    }, 0.1);

    Tone.Transport.start();
  }

  seek(seconds: number) {
    if (!this.currentTrack) return;
    this.instrumentSamplers?.forEach((s) => s.releaseAll());
    Tone.Transport.seconds = seconds;
    this.updateTrackDisplay(seconds);
  }

  seekRelative(seconds: number) {
    if (!this.currentTrack) return;
    const position = Math.max(0, Tone.Transport.seconds + seconds);
    if (position > this.currentTrack.length) {
      this.stop();
    }
    this.seek(position);
  }

  continue() {
    if (this.currentTrack) {
      this.isPlaying = true;
      Tone.Transport.start();
      this.seek(Tone.Transport.seconds);
    }
  }

  pause() {
    this.isPlaying = false;
    Tone.Transport.pause();
  }

  stop() {
    Tone.Transport.cancel();
    Tone.Transport.stop();
    this.instrumentSamplers?.forEach((s) => s.dispose());
    this.samplePlayers?.forEach((s) => s.forEach((t) => t.dispose()));
    this.isPlaying = false;
  }

  /** Stops playback and unloads the current track in the UI */
  unload() {
    this.stop();
    this.currentPlayingIndex = undefined;
    this.updateTrackDisplay();
    navigator.mediaSession.metadata = null;
  }

  playPrevious() {
    let nextTrackIndex = null;
    if (this.currentPlayingIndex > 0) {
      nextTrackIndex = this.currentPlayingIndex - 1;
    } else if (this.currentPlayingIndex === 0) {
      if (this.repeat === RepeatMode.ALL) {
        nextTrackIndex = this.playlist.length - 1;
      } else {
        this.seek(0);
      }
    }

    if (nextTrackIndex !== null) {
      this.playTrack(nextTrackIndex);
    }
  }

  playNext() {
    if (this.repeat === RepeatMode.ONE) {
      this.seek(0);
      return;
    }

    let nextTrackIndex = null;
    if (this.shuffle) {
      if (this.shuffleQueue.length === 0) this.fillShuffleQueue();
      nextTrackIndex = this.shuffleQueue.shift();
    } else if (this.currentPlayingIndex < this.playlist.length - 1) {
      nextTrackIndex = this.currentPlayingIndex + 1;
    } else if (
      this.currentPlayingIndex === this.playlist.length - 1 &&
      this.repeat === RepeatMode.ALL
    ) {
      nextTrackIndex = 0;
    }

    if (nextTrackIndex !== null) {
      this.playTrack(nextTrackIndex);
    } else {
      this.unload();
    }
  }

  fillShuffleQueue() {
    this.shuffleQueue = [...Array(this.playlist.length).keys()];

    // shuffle
    for (let i = this.shuffleQueue.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.shuffleQueue[i], this.shuffleQueue[j]] = [this.shuffleQueue[j], this.shuffleQueue[i]];
    }
  }

  deleteTrack(index: number) {
    this.playlist.splice(index, 1);
    if (index === this.currentPlayingIndex) {
      this.unload();
    } else if (index < this.currentPlayingIndex) {
      this.currentPlayingIndex -= 1;
    }
    this.updatePlaylistDisplay();
  }

  getExportUrl() {
    const json = JSON.stringify(this.playlist.map((t) => t.outputParams));
    const compressed = compress(json);
    return `${window.location.origin}${window.location.pathname}?${compressed}`.replace('home.in.tum.de/~zhangja/lofi', 'lofi.jacobzhang.de');
  }

  setAudioWebApiMetadata() {
    if (!('mediaSession' in navigator) || !this.currentTrack) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: this.currentTrack.title,
      artist: 'Lofi generator',
      artwork: [
        { src: './background.jpg', type: 'image/jpg' }
      ]
    });
    this.updateAudioWebApiPosition();
  }

  updateAudioWebApiPosition() {
    if (!('mediaSession' in navigator) || !this.currentTrack) return;
    navigator.mediaSession.setPositionState({
      duration: this.currentTrack.length,
      position: Math.max(0, Tone.Transport.seconds)
    });
  }
}

export enum RepeatMode {
  NONE,
  ALL,
  ONE
}

export default Player;
