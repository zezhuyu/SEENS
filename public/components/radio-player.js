// No YouTube IFrame needed — audio streams via /api/stream/:videoId proxy

// ─── RadioPlayer ───────────────────────────────────────────────────────────────
export class RadioPlayer {
  constructor(container) {
    this.container  = container;
    this.audio      = new Audio();  // main music player
    this.ttsAudio   = new Audio();  // DJ voice
    this.isPlaying  = false;
    this.ttsQueue   = [];
    this.ttsPlaying = false;
    this.currentTrack  = null;
    this.started       = false;  // true after user taps Start Radio
    // Pending DJ intro: held until current track is nearly done
    this.pendingIntroTTS     = null;
    this.introFired          = false;   // prevents firing twice per track
    this.transitionRequested = false;   // prevents duplicate /api/transition calls per track
    this.render();
    this.bind();
    this.loadNowPlaying();
  }

  render() {
    this.container.innerHTML = `
      <div id="art-wrap">
        <div id="art-bg"></div>
        <div id="art-img">
          <img id="art-imgel" alt="" style="display:none;width:100%;height:100%;object-fit:cover" />
          <svg id="art-placeholder" viewBox="0 0 48 48" fill="none" stroke="#fff" stroke-width="1.5">
            <circle cx="24" cy="24" r="20"/><circle cx="24" cy="24" r="6"/>
            <line x1="24" y1="4" x2="24" y2="18"/><line x1="24" y1="30" x2="24" y2="44"/>
            <line x1="4" y1="24" x2="18" y2="24"/><line x1="30" y1="24" x2="44" y2="24"/>
          </svg>
        </div>
      </div>

      <div id="track-info">
        <div id="track-title">Seens Radio</div>
        <div id="track-artist">Your personal AI DJ</div>
        <div id="track-source"></div>
      </div>

      <div id="progress-wrap">
        <span id="time-current">0:00</span>
        <div id="progress-bar"><div id="progress-fill"></div></div>
        <span id="time-total">0:00</span>
      </div>

      <div id="controls">
        <button class="ctrl-btn" id="btn-prev" title="Previous">
          <svg viewBox="0 0 24 24"><polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/></svg>
        </button>
        <button class="ctrl-btn" id="btn-play" title="Play/Pause">
          <svg id="ico-play"  viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          <svg id="ico-pause" viewBox="0 0 24 24" style="display:none"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
        </button>
        <button class="ctrl-btn" id="btn-next" title="Next">
          <svg viewBox="0 0 24 24"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></svg>
        </button>
      </div>

      <div id="volume-wrap">
        <svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/></svg>
        <input type="range" id="volume-slider" min="0" max="100" value="80" />
        <svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
      </div>

      <div id="up-next">Up next: <span id="up-next-text">—</span></div>

      <div id="dj-wrap">
        <div id="dj-header">
          <div id="dj-dot"></div>
          <span id="dj-label">DJ Commentary</span>
          <span id="dj-agent"></span>
        </div>
        <div id="dj-text">Ask me what to play...</div>
      </div>

      <div id="chat-wrap">
        <textarea id="chat-input" placeholder="Ask the DJ..." rows="1"></textarea>
        <button id="btn-send">
          <svg viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </div>
    `;
    this.$ = id => document.getElementById(id);
  }

  bind() {
    this.$('btn-play').addEventListener('click', () => {
      this.waitingForInteraction = false;
      // Hide tap-to-play prompt if it was showing
      const prompt = this.$('play-prompt');
      if (prompt) prompt.style.display = 'none';
      this.togglePlay();
    });
    this.$('btn-next').addEventListener('click', () => this.skipNext());

    this.$('volume-slider').addEventListener('input', e => {
      if (!this.ttsPlaying) this.audio.volume = e.target.value / 100;
      this.ttsAudio.volume = e.target.value / 100;
    });

    this.$('progress-bar').addEventListener('click', e => {
      const pct = e.offsetX / e.currentTarget.offsetWidth;
      if (this.audio.duration) this.audio.currentTime = pct * this.audio.duration;
    });

    this.audio.addEventListener('timeupdate', () => this.updateProgress());
    this.audio.addEventListener('ended',      () => this.onTrackEnded());
    this.audio.addEventListener('playing',    () => this.setPlaying(true));
    this.audio.addEventListener('pause',      () => this.setPlaying(false));
    this.audio.addEventListener('error', () => {
      const log = window.dbg ?? console.error;
      log('AUDIO ERR', `code=${this.audio.error?.code} src=${this.audio.src}`);
      // Don't auto-skip if we're waiting for the user to tap play first
      if (this.waitingForInteraction) return;
      log('AUDIO ERR', 'auto-skipping');
      setTimeout(() => this.skipNext(), 1500);
    });

    this.$('chat-input').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.sendChat(); }
    });
    this.$('btn-send').addEventListener('click', () => this.sendChat());

    // After TTS finishes → restore volume; play queued track if set
    this.ttsAudio.addEventListener('ended', () => {
      this.audio.volume = parseInt(this.$('volume-slider').value) / 100;
      this.ttsPlaying = false;
      this.playNextTTS();
      if (this._coldStartTrack) {
        const track = this._coldStartTrack;
        this._coldStartTrack = null;
        this.audio.pause();
        // Advance server queue pointer and get upNext for display
        fetch('/api/next', { method: 'POST' })
          .then(r => r.json())
          .then(({ upNext }) => this.updateUpNext(upNext))
          .catch(() => {});
        this.playTrack(track);
      } else if (this._skipAfterTTS) {
        this._skipAfterTTS = false;
        this.skipNext();
      }
    });
    this.ttsAudio.addEventListener('error', () => {
      const log = window.dbg ?? console.error;
      log('TTS ERR', `code=${this.ttsAudio.error?.code}`);
      this.ttsPlaying = false;
      this.audio.volume = parseInt(this.$('volume-slider').value) / 100;
      // If TTS fails mid-cold-start, still play the queued track so music isn't silently lost
      if (this._coldStartTrack) {
        const track = this._coldStartTrack;
        this._coldStartTrack = null;
        fetch('/api/next', { method: 'POST' })
          .then(r => r.json())
          .then(({ upNext }) => this.updateUpNext(upNext))
          .catch(() => {});
        this.playTrack(track);
      }
    });
  }

  async loadNowPlaying() {
    try {
      const res = await fetch('/api/now');
      const { nowPlaying, upNext } = await res.json();
      if (nowPlaying) this.showTrackInfo(nowPlaying);
      if (upNext) this.$('up-next-text').textContent =
        `${upNext.resolvedTitle ?? upNext.title} — ${upNext.resolvedArtist ?? upNext.artist ?? ''}`;
    } catch { /* server not ready */ }
  }

  // Show track metadata in UI (no audio start)
  showTrackInfo(track) {
    this.currentTrack = track;
    this.$('track-title').textContent  = track.resolvedTitle  ?? track.title  ?? 'Unknown';
    this.$('track-artist').textContent = track.resolvedArtist ?? track.artist ?? '';
    this.$('track-source').innerHTML   = track.source
      ? `<span class="badge" style="color:#888;border-color:#333">${track.source}</span>` : '';

    if (track.artworkUrl) {
      const img = this.$('art-imgel');
      img.src = track.artworkUrl;
      img.onload = () => {
        img.style.display = 'block';
        this.$('art-placeholder').style.display = 'none';
        this.$('art-bg').style.backgroundImage = `url(${track.artworkUrl})`;
      };
    }
  }

  // Start audio playback for a track
  playTrack(track) {
    this.showTrackInfo(track);
    this.introFired = false;          // reset so next intro can fire near end of this track
    this.transitionRequested = false; // reset so transition will be triggered for this track
    const log = window.dbg ?? console.log;

    const src = track.streamUrl ?? track.previewUrl ?? null;
    log('playTrack', `"${track.resolvedTitle ?? track.title}" streamUrl=${track.streamUrl ?? 'null'} previewUrl=${track.previewUrl ?? 'null'}`);

    if (!src) {
      log('playTrack', 'NO audio source — skipping to next');
      setTimeout(() => this.skipNext(), 1500);
      return;
    }

    log('playTrack', `loading src: ${src}`);
    this.audio.src = src;
    this.audio.volume = parseInt(this.$('volume-slider').value) / 100;
    this.audio.load();
    this.waitingForInteraction = false;
    this.audio.play()
      .then(() => log('playTrack', 'playing ✓'))
      .catch(e => {
        if (e.name === 'NotAllowedError') {
          this.waitingForInteraction = true;
          this.showPlayPrompt(track);  // silent — user just needs to tap
        } else {
          log('playTrack ERR', e.message);
        }
      });
  }

  // WebSocket: DJ responded with tracks + TTS
  onDJResponse(msg) {
    const log = window.dbg ?? console.log;
    if (msg.say) this.$('dj-text').textContent = msg.say;
    this.$('dj-dot').classList.add('pulsing');
    // Dismiss the start overlay as soon as DJ has something to say
    if (msg.say || msg.firstTrack) window._dismissOverlay?.();

    if (msg.agent) {
      this.$('dj-agent').innerHTML =
        `<span class="badge badge-${msg.agent}">${msg.agent}</span>`;
    }

    if (!this.started) {
      log('DJ', 'buffering (not started yet)');
      return;
    }

    const audioActive = this.isPlaying || this.ttsPlaying || (this.audio.src && !this.audio.ended && !this.audio.error);
    const userAsked   = msg.trigger === 'user-chat';

    const intent = msg.playIntent ?? (userAsked ? 'now' : 'end');

    if (audioActive && !userAsked) {
      // Auto-scheduled / transition — hold TTS until near end of current track
      if (msg.ttsUrl) {
        log('DJ', `holding intro TTS until track near end (trigger=${msg.trigger})`);
        this.pendingIntroTTS = msg.ttsUrl;
        this.transitionRequested = true; // don't fire another transition request
      }
    } else if (audioActive && userAsked) {
      // User request while music is playing
      if (intent === 'now') {
        // Jump in: DJ speaks immediately over ducked music, then skips to the requested track
        log('DJ', 'user request now: jumping in');
        if (msg.firstTrack) {
          this._coldStartTrack = msg.firstTrack;
        } else {
          this._skipAfterTTS = true;
        }
        if (msg.ttsUrl) this.enqueueTTS(msg.ttsUrl);
        else this.skipNext();
      } else if (intent === 'next') {
        // Don't jump in: hold the DJ intro until near end of current track, update up-next
        log('DJ', 'user request next: queuing intro for end of current track');
        if (msg.ttsUrl) {
          this.pendingIntroTTS = msg.ttsUrl;
          this.transitionRequested = true; // prevent a separate /api/transition call
        }
        // Immediately update the up-next display with the requested track
        const nextTrack = msg.firstTrack ?? msg.play?.[0];
        if (nextTrack) {
          this.$('up-next-text').textContent =
            `${nextTrack.resolvedTitle ?? nextTrack.title} — ${nextTrack.resolvedArtist ?? nextTrack.artist ?? ''}`;
        }
      } else {
        // 'end' intent — track added to end of playlist, no interruption
        log('DJ', 'user request end: added to playlist');
        // Just show the DJ text (already updated above) — no TTS interruption
      }
    } else {
      // Nothing playing — DJ speaks first, then music starts
      if (msg.ttsUrl && msg.firstTrack) {
        log('DJ', 'cold start: TTS first, then track');
        this._coldStartTrack = msg.firstTrack;
        this.enqueueTTS(msg.ttsUrl);
      } else if (msg.ttsUrl) {
        this.enqueueTTS(msg.ttsUrl);
      } else if (msg.firstTrack) {
        this.playTrack(msg.firstTrack);
      }
    }

    // Update up-next display (for session starts and 'now' requests, show play[1]; 'next' was already set above)
    if (intent !== 'next' && msg.play?.length > 1) {
      const next = msg.play[1];
      this.$('up-next-text').textContent =
        `${next.resolvedTitle ?? next.title} — ${next.resolvedArtist ?? next.artist ?? ''}`;
    } else if (intent !== 'next' && msg.firstTrack && !audioActive) {
      // Cold start: show play[0] as "now playing soon"
      this.$('up-next-text').textContent =
        `${msg.firstTrack.resolvedTitle ?? msg.firstTrack.title} — ${msg.firstTrack.resolvedArtist ?? msg.firstTrack.artist ?? ''}`;
    }

    setTimeout(() => this.$('dj-dot').classList.remove('pulsing'), 3000);
  }

  // Show a tap-to-play prompt if browser blocks autoplay
  showPlayPrompt(track) {
    let prompt = this.$('play-prompt');
    if (!prompt) {
      prompt = document.createElement('div');
      prompt.id = 'play-prompt';
      prompt.style.cssText = 'text-align:center;margin:8px 0;font-size:12px;color:var(--accent);cursor:pointer;padding:8px;border:1px dashed var(--accent);border-radius:8px';
      this.container.insertBefore(prompt, this.$('dj-wrap'));
    }
    prompt.textContent = `▶ Tap to play: ${track.resolvedTitle ?? track.title}`;
    prompt.onclick = () => {
      prompt.style.display = 'none';
      this.waitingForInteraction = false;
      this.playTrack(track);
    };
  }

  // WebSocket: explicit now-playing command from server
  onNowPlaying(track) {
    this.playTrack(track);
  }

  onCommand(action) {
    if (action === 'pause') this.pause();
    else if (action === 'resume') this.play();
    else if (action === 'next') this.skipNext();
  }

  enqueueTTS(url) {
    this.ttsQueue.push(url);
    if (!this.ttsPlaying) this.playNextTTS();
  }

  playNextTTS() {
    if (!this.ttsQueue.length) { this.ttsPlaying = false; return; }
    this.ttsPlaying = true;
    const url = this.ttsQueue.shift();
    const log = window.dbg ?? console.log;
    log('TTS', `playing ${url}`);
    this.audio.volume = 0.05;  // duck music under DJ voice
    this.ttsAudio.src = url;
    this.ttsAudio.volume = 1;
    this.ttsAudio.play().catch(e => {
      log('TTS ERR', e.message);
      this.ttsPlaying = false;
      this.audio.volume = parseInt(this.$('volume-slider').value) / 100;
    });
  }

  togglePlay() { this.isPlaying ? this.pause() : this.play(); }
  play() {
    if (this.audio.src) {
      this.audio.play().catch(() => {});
    } else {
      // Nothing loaded yet — pull the next track from the server queue
      this.skipNext();
    }
  }
  pause() { this.audio.pause(); }

  setPlaying(playing) {
    this.isPlaying = playing;
    this.$('ico-play').style.display  = playing ? 'none'  : 'block';
    this.$('ico-pause').style.display = playing ? 'block' : 'none';
    if (playing) this.startProgressPoll();
    else         this.stopProgressPoll();
  }

  startProgressPoll() {
    this.stopProgressPoll();
    this.progressTimer = setInterval(() => this.updateProgress(), 500);
  }

  stopProgressPoll() {
    if (this.progressTimer) { clearInterval(this.progressTimer); this.progressTimer = null; }
  }

  updateProgress() {
    const cur = this.audio.currentTime;
    const dur = this.audio.duration;
    if (!dur) return;
    this.$('progress-fill').style.width = `${(cur / dur) * 100}%`;
    this.$('time-current').textContent = fmt(cur);
    this.$('time-total').textContent   = fmt(dur);

    const remaining = dur - cur;

    // Request a DJ transition intro at ~30s remaining (gives AI + TTS time to generate)
    if (!this.transitionRequested && !this.pendingIntroTTS && remaining <= 30 && dur > 40) {
      this.transitionRequested = true;
      const log = window.dbg ?? console.log;
      log('DJ', `requesting transition at ${remaining.toFixed(0)}s remaining`);
      fetch('/api/transition', { method: 'POST' }).catch(() => {});
    }

    // Fire pending DJ intro when 8 seconds remain in the current track
    if (!this.introFired && this.pendingIntroTTS && remaining <= 8 && dur > 15) {
      this.introFired = true;
      const log = window.dbg ?? console.log;
      log('DJ', 'firing intro at 8s remaining');
      this.enqueueTTS(this.pendingIntroTTS);
      this.pendingIntroTTS = null;
    }
  }

  async skipNext() {
    this.audio.pause();
    this.stopProgressPoll();
    this.introFired = false;
    this.transitionRequested = false;
    this.pendingIntroTTS = null;
    this._coldStartTrack = null;
    this._skipAfterTTS = false;
    try {
      const res = await fetch('/api/next', { method: 'POST' });
      const { track, upNext } = await res.json();
      this.updateUpNext(upNext);
      if (track) this.playTrack(track);
      else this.setPlaying(false);
    } catch (err) { console.error(err); }
  }

  updateUpNext(upNext) {
    this.$('up-next-text').textContent = upNext
      ? `${upNext.resolvedTitle ?? upNext.title} — ${upNext.resolvedArtist ?? upNext.artist ?? ''}`
      : '—';
  }

  async onTrackEnded() {
    this.setPlaying(false);
    this.stopProgressPoll();
    await this.skipNext();
  }

  async sendChat() {
    const input = this.$('chat-input');
    const message = input.value.trim();
    if (!message) return;
    input.value = '';
    this.$('dj-text').textContent = '...';
    this.$('dj-dot').classList.add('pulsing');
    try {
      await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
    } catch {
      this.$('dj-text').textContent = 'Connection error — is the server running?';
    }
  }

  setConnected(connected) {
    this.$('dj-label').textContent = connected ? 'DJ Commentary' : 'Reconnecting...';
  }
}

function fmt(s) {
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}
