'use strict';

/**
 * ChatApp — Storybased Game Maker
 *
 * Chat IS the app: there's no landing screen. On page load the bot greets the
 * user with "Hi! I'm GameMaker. What's your name?", the user types their name,
 * the server treats that as the answer to the first question, and the
 * conversation proceeds normally.
 *
 * Visual style: arcade-retro pixel panels (see style.css).
 */
class ChatApp {
  constructor() {
    this._dom = {
      chatMessages: document.getElementById('chat-messages'),
      messageInput: document.getElementById('messageInput'),
      messageForm:  document.getElementById('messageForm'),
      sendBtn:      document.getElementById('sendBtn'),

      // Sidebar icon buttons
      clearBtn:     document.getElementById('clearBtn'),    // 🔄 restart
      aboutBtn:     document.getElementById('aboutBtn'),    // ℹ️ about
      playBtn:      document.getElementById('playBtn'),     // 🎮 (placeholder)
      exportBtn:    document.getElementById('exportBtn'),   // 📤 (placeholder)

      srAnnouncer:  document.getElementById('sr-announcer'),

      // Dialogs
      aboutDialog:  document.getElementById('about-dialog'),
      clearDialog:  document.getElementById('clear-dialog'),
      clearConfirm: document.getElementById('clear-confirm'),
      clearCancel:  document.getElementById('clear-cancel'),
      aboutClose:   document.getElementById('about-close'),
    };

    this._messageHistory   = [];
    this._isLoading        = false;
    this._lastQuestionText = '';
    this._lastQuestionType = 'text';
    this._statusTimer      = null;
    this._sessionId        = this._generateSessionId();

    this._initChat();
    this._greet();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════════════════════════

  _initChat() {
    // Send on form submit
    this._dom.messageForm.addEventListener('submit', (e) => {
      e.preventDefault();
      this._sendMessage();
    });

    // Enter to send (Shift+Enter for newline)
    this._dom.messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._sendMessage();
      }
    });

    // Auto-resize textarea
    this._dom.messageInput.addEventListener('input', () => {
      this._dom.messageInput.style.height = 'auto';
      this._dom.messageInput.style.height =
        Math.min(this._dom.messageInput.scrollHeight, 120) + 'px';
    });

    // Sidebar buttons
    this._dom.clearBtn.addEventListener('click', () => this._dom.clearDialog.showModal());
    this._dom.aboutBtn.addEventListener('click', () => this._dom.aboutDialog.showModal());
    this._dom.playBtn .addEventListener('click', () => this._announce('Play your latest game from the chat button when it appears.'));
    this._dom.exportBtn.addEventListener('click', () => this._announce('Export Game feature coming soon.'));

    // Dialog buttons
    this._dom.aboutClose .addEventListener('click', () => this._dom.aboutDialog.close());
    this._dom.clearConfirm.addEventListener('click', () => {
      this._dom.clearDialog.close();
      this._clearChat();
    });
    this._dom.clearCancel .addEventListener('click', () => this._dom.clearDialog.close());

    // Return focus on dialog close
    this._dom.aboutDialog.addEventListener('close', () => this._dom.aboutBtn.focus());
    this._dom.clearDialog.addEventListener('close', () => this._dom.clearBtn.focus());
  }

  /** Show the bot's opening message immediately on page load. */
  _greet() {
    const greeting = "Hi! I'm GameMaker. What's your name?";
    this._addMessage(greeting, 'assistant');
    this._messageHistory.push({ role: 'assistant', content: greeting });
    this._lastQuestionText = greeting;
    this._lastQuestionType = 'text';
    this._dom.messageInput.focus();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SEND / RECEIVE
  // ═══════════════════════════════════════════════════════════════════════

  async _sendMessage() {
    const message = this._dom.messageInput.value.trim();
    if (!message || this._isLoading) return;

    this._isLoading = true;
    this._dom.sendBtn.disabled = true;

    this._addMessage(message, 'user');
    this._messageHistory.push({ role: 'user', content: message });

    this._dom.messageInput.value = '';
    this._dom.messageInput.style.height = 'auto';
    this._addTypingIndicator();

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-ID': this._sessionId,
        },
        body: JSON.stringify({
          message,
          history: this._messageHistory,
        }),
      });

      const data = await response.json();

      if (!data.success) {
        this._removeTypingIndicator();
        this._addMessage(`Error: ${data.error ?? 'Unknown error'}`, 'assistant');
        return;
      }

      const text = data.response ?? '';

      // Async generation path. The server kicks off a background thread
      // and gives us a job_id; we poll /api/job/<id> until done.
      //
      // We keep the typing indicator visible the whole time and embed the
      // server's "Generating your game…" message INSIDE it (instead of as
      // a separate bubble above) so the user sees a single, calm "we're
      // working on it" UI element rather than two stacked bubbles.
      if (data.type === 'job_started' && data.job_id) {
        this._removeTypingIndicator();
        this._messageHistory.push({ role: 'assistant', content: text });
        this._addTypingIndicator(text);
        await this._pollJob(data.job_id);
        return;
      }

      this._removeTypingIndicator();

      if (data.type === 'game_ready' && data.game_url) {
        // Legacy synchronous path — kept for backwards compat if the
        // server ever returns a game_ready directly.
        this._addMessage(text, 'assistant');
        this._messageHistory.push({ role: 'assistant', content: text });
        this._renderPlayButton(data.game_url);
      } else {
        this._addMessage(text, 'assistant');
        this._messageHistory.push({ role: 'assistant', content: text });
      }

      this._lastQuestionText = text;
      this._lastQuestionType = data.type ?? 'text';

      if (Array.isArray(data.options) && data.options.length) {
        this._renderOptions(data.options);
      }
      // Image upload UI is intentionally disabled — text-only descriptions
      // produce more consistent in-game art. (The vision pipeline + the
      // _renderUploadUI helper are still in the codebase for future re-use.)
    } catch (err) {
      this._removeTypingIndicator();
      this._addMessage(`Error: ${err.message}`, 'assistant');
      console.error('Request error:', err);
    } finally {
      this._isLoading = false;
      this._dom.sendBtn.disabled = false;
      this._dom.messageInput.focus();
    }
  }

  /**
   * Poll /api/job/<id> until the job finishes (or we hit the safety cap).
   *
   * The server runs game generation in a background thread; this is how
   * we get the result without holding open a 3-minute HTTP request, which
   * Render's proxy would cut at ~100s.
   *
   * Resilience strategy:
   *   - Patient: tolerates 40 consecutive failures (~2.5 min @ 3-10s) before
   *     giving up. Render's free tier 502s briefly while waking up workers
   *     or under load.
   *   - Exponential-ish backoff: after 5 consecutive errors we slow polls
   *     from 3s → 10s so we're not hammering a struggling server.
   *   - 404 (server forgot the job) is treated as a hard error — usually
   *     means the server restarted, so polling forever won't help.
   *   - Total time cap: ~15 minutes (enough headroom for a 6-min job + recovery).
   */
  async _pollJob(jobId) {
    const FAST_INTERVAL_MS    = 3000;   // healthy polling
    const SLOW_INTERVAL_MS    = 10000;  // after errors start happening
    const MAX_TOTAL_MS        = 15 * 60 * 1000;  // 15 minutes
    const MAX_CONSEC_ERRORS   = 40;     // ≈ 2-7 minutes of failures before quitting

    const startedAt = Date.now();
    let consecutiveErrors = 0;

    while (Date.now() - startedAt < MAX_TOTAL_MS) {
      // Back off to longer interval if we've been seeing errors
      const interval = consecutiveErrors > 5 ? SLOW_INTERVAL_MS : FAST_INTERVAL_MS;
      await new Promise((r) => setTimeout(r, interval));

      try {
        const resp = await fetch(`/api/job/${jobId}`);

        if (resp.status === 404) {
          // Server doesn't know this job — restarted between submit and poll.
          // No amount of waiting will recover it.
          this._removeTypingIndicator();
          this._addMessage(
            'The server restarted before your game finished. Please try again.',
            'assistant'
          );
          return;
        }

        if (!resp.ok) {
          // 5xx / proxy errors — count as a transient error
          throw new Error(`HTTP ${resp.status}`);
        }

        const data = await resp.json();
        consecutiveErrors = 0;

        if (!data.success) continue;

        if (data.status === 'done') {
          this._removeTypingIndicator();
          const msg = data.message ?? 'Your game is ready!';
          this._addMessage(msg, 'assistant');
          this._messageHistory.push({ role: 'assistant', content: msg });
          if (data.game_url) this._renderPlayButton(data.game_url);
          return;
        }

        if (data.status === 'error') {
          this._removeTypingIndicator();
          const msg = data.message ?? 'Game generation failed. Please try again.';
          this._addMessage(msg, 'assistant');
          this._messageHistory.push({ role: 'assistant', content: msg });
          return;
        }
        // status === 'working' → keep polling
      } catch (err) {
        // Transient errors: Render free-tier proxies hiccup, server wakes,
        // network blips. Don't give up easily — the job is almost certainly
        // still running on the server.
        console.warn(`Job poll failed (consecutive: ${consecutiveErrors + 1}):`, err);
        consecutiveErrors += 1;
        if (consecutiveErrors >= MAX_CONSEC_ERRORS) {
          this._removeTypingIndicator();
          this._addMessage(
            'Lost connection to the server for too long. The game may still be ready — please reload the page and try again.',
            'assistant'
          );
          return;
        }
      }
    }

    // Hit the 15-minute total time cap
    this._removeTypingIndicator();
    this._addMessage(
      'Game generation is taking longer than expected. Please try again in a minute.',
      'assistant'
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MESSAGE RENDERING
  // ═══════════════════════════════════════════════════════════════════════

  /** Add a message to the chat. role = 'assistant' (bot) or 'user'. */
  _addMessage(content, role) {
    const isBot = role === 'assistant';

    const row = document.createElement('div');
    row.className = isBot ? 'msg-row' : 'msg-row msg-row--user';

    const avatar = document.createElement('div');
    avatar.className = isBot ? 'avatar avatar--bot' : 'avatar avatar--user';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = isBot ? '🤖' : '🎮';

    const panel = document.createElement('div');
    panel.className = isBot ? 'panel panel--bot' : 'panel panel--user';

    if (this._isImageUrl(content)) {
      const img = document.createElement('img');
      img.src = content;
      img.alt = 'Uploaded image';
      img.loading = 'lazy';
      panel.appendChild(img);
    } else {
      const p = document.createElement('p');
      this._appendText(p, String(content));
      panel.appendChild(p);
    }

    // Bot: avatar then panel; user: panel then avatar
    if (isBot) {
      row.appendChild(avatar);
      row.appendChild(panel);
    } else {
      row.appendChild(panel);
      row.appendChild(avatar);
    }

    this._dom.chatMessages.appendChild(row);
    this._scrollToBottom();

    if (isBot) this._announce(String(content));
    return row;
  }

  /** Safe text rendering (newlines → <br>, no innerHTML, no XSS). */
  _appendText(element, text) {
    text.split('\n').forEach((line, i, arr) => {
      element.appendChild(document.createTextNode(line));
      if (i < arr.length - 1) element.appendChild(document.createElement('br'));
    });
  }

  _isImageUrl(value) {
    const s = String(value ?? '').toLowerCase();
    return (s.startsWith('http') || s.startsWith('/static/')) &&
      /\.(png|jpe?g|gif|webp|svg)(\?|$)/.test(s);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TYPING INDICATOR (with rotating status text after 5s)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Show the typing indicator (3 animated dots) at the bottom of the chat.
   *
   * @param {string} [initialMessage=''] — if provided, this text appears
   *   inside the indicator immediately (no separate bubble needed). Used
   *   on job_started to show "Generating your game, Inbal…" while the
   *   background job runs. Rotating fun messages take over after 7s.
   */
  _addTypingIndicator(initialMessage = '') {
    const row = document.createElement('div');
    row.className = 'msg-row';
    row.id = 'typing-indicator';

    const avatar = document.createElement('div');
    avatar.className = 'avatar avatar--bot';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = '🤖';

    const panel = document.createElement('div');
    panel.className = 'panel panel--bot typing-indicator';
    panel.setAttribute('aria-label', 'Assistant is typing');

    for (let i = 0; i < 3; i++) {
      const dot = document.createElement('div');
      dot.className = 'typing-dot';
      dot.setAttribute('aria-hidden', 'true');
      panel.appendChild(dot);
    }

    const status = document.createElement('p');
    status.className = 'typing-status';
    status.setAttribute('aria-live', 'polite');
    if (initialMessage) {
      status.style.display = 'block';
      status.textContent = initialMessage;
    }
    panel.appendChild(status);

    row.appendChild(avatar);
    row.appendChild(panel);
    this._dom.chatMessages.appendChild(row);
    this._scrollToBottom();

    // If we already have an initial message, delay the first rotation by
    // 7s (instead of 5s) so the user reads the server's message first.
    this._startStatusRotation(status, !!initialMessage);
  }

  _removeTypingIndicator() {
    this._stopStatusRotation();
    document.getElementById('typing-indicator')?.remove();
  }

  _startStatusRotation(statusEl, hasInitialMessage = false) {
    // When we already showed the server's "Generating your game…" message,
    // we drop the first rotation entry (it was redundant) and start with
    // the more interesting "Designing your hero…".
    const messages = hasInitialMessage
      ? [
          'Designing your hero and world…',
          'Drawing scene art (this is the slow part)…',
          'Placing platforms and obstacles…',
          'Almost there — assembling the game…',
        ]
      : [
          'Generating your game — this takes up to a minute…',
          'Designing your hero and world…',
          'Drawing scene art (this is the slow part)…',
          'Placing platforms and obstacles…',
          'Almost there — assembling the game…',
        ];
    let i = 0;
    const showNext = () => {
      statusEl.style.display = 'block';
      statusEl.textContent = messages[i % messages.length];
      i += 1;
      this._statusTimer = setTimeout(showNext, 7000);
    };
    // If we already have an initial message, give the user 7s to read it
    // before rotating. Otherwise rotate after 5s.
    const firstDelay = hasInitialMessage ? 7000 : 5000;
    this._statusTimer = setTimeout(showNext, firstDelay);
  }

  _stopStatusRotation() {
    if (this._statusTimer) {
      clearTimeout(this._statusTimer);
      this._statusTimer = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // OPTIONS / PLAY / UPLOAD UI (attached after a bot message)
  // ═══════════════════════════════════════════════════════════════════════

  _renderOptions(options) {
    const lastBotPanel = this._lastBotPanel();
    if (!lastBotPanel) return;

    const container = document.createElement('div');
    container.className = 'options-container';
    container.setAttribute('role', 'group');
    container.setAttribute('aria-label', 'Quick replies');

    options.forEach((opt) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'choice-btn';
      btn.textContent = opt.toUpperCase();
      btn.addEventListener('click', () => {
        container.remove();
        this._dom.messageInput.value = opt;
        this._sendMessage();
      });
      container.appendChild(btn);
    });

    // Append the option chips as a sibling to the message row (so they sit
    // on a new line, indented to line up with the panel)
    this._dom.chatMessages.appendChild(container);
    this._scrollToBottom();
  }

  _renderPlayButton(gameUrl) {
    const container = document.createElement('div');
    container.className = 'play-container';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'play-game-btn';
    btn.textContent = '▶  PLAY GAME';
    btn.addEventListener('click', () => window.open(gameUrl, '_blank', 'noopener,noreferrer'));

    container.appendChild(btn);
    this._dom.chatMessages.appendChild(container);
    this._scrollToBottom();
  }

  _renderUploadUI() {
    const container = document.createElement('div');
    container.className = 'upload-container';

    const fileId = `file-${Date.now()}`;
    const fileLabel = document.createElement('label');
    fileLabel.htmlFor = fileId;
    fileLabel.className = 'sr-only';
    fileLabel.textContent = 'Upload an image file';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.id = fileId;
    fileInput.className = 'upload-input';

    const uploadBtn = document.createElement('button');
    uploadBtn.type = 'button';
    uploadBtn.className = 'upload-btn';
    uploadBtn.textContent = 'UPLOAD IMAGE';

    const urlId = `url-${Date.now()}`;
    const urlLabel = document.createElement('label');
    urlLabel.htmlFor = urlId;
    urlLabel.className = 'sr-only';
    urlLabel.textContent = 'Or paste an image URL';

    const urlInput = document.createElement('input');
    urlInput.type = 'url';
    urlInput.id = urlId;
    urlInput.placeholder = 'Or paste an image URL here';
    urlInput.className = 'url-input';

    const urlSend = document.createElement('button');
    urlSend.type = 'button';
    urlSend.className = 'url-send-btn';
    urlSend.textContent = 'SEND URL';

    const urlRow = document.createElement('div');
    urlRow.className = 'url-input-row';
    urlRow.appendChild(urlLabel);
    urlRow.appendChild(urlInput);
    urlRow.appendChild(urlSend);

    container.appendChild(fileLabel);
    container.appendChild(fileInput);
    container.appendChild(uploadBtn);
    container.appendChild(urlRow);

    uploadBtn.addEventListener('click', async () => {
      if (!fileInput.files?.length) { this._announce('Please select a file first.'); return; }
      const form = new FormData();
      form.append('file', fileInput.files[0]);
      try {
        const resp = await fetch('/api/upload', {
          method: 'POST',
          headers: { 'X-Session-ID': this._sessionId },
          body: form,
        });
        const j = await resp.json();
        if (j.url) {
          this._dom.messageInput.value = j.url;
          container.remove();
          this._sendMessage();
        } else {
          this._announce(`Upload failed: ${j.error ?? 'Unknown error'}`);
        }
      } catch (err) {
        console.error('Upload error:', err);
        this._announce('Upload failed. Please try again.');
      }
    });

    urlSend.addEventListener('click', () => {
      const val = urlInput.value.trim();
      if (!val) { this._announce('Please enter an image URL first.'); return; }
      this._dom.messageInput.value = val;
      container.remove();
      this._sendMessage();
    });

    this._dom.chatMessages.appendChild(container);
    this._scrollToBottom();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════════════════════════

  _scrollToBottom() {
    // The scroll container is .chat-wrap (the parent of #chat-messages —
    // it has overflow-y: auto in style.css). #chat-messages itself is just
    // the content list inside it.
    //
    // Why three attempts: appendChild makes the new node visible to JS
    // immediately, but the browser's layout/paint cycle is async. One
    // requestAnimationFrame is normally enough, but on real Render
    // deployments (where pixel-font webfonts and slow image decodes shift
    // heights for several frames after insertion) the chat would scroll
    // to "almost bottom" and the last message stayed cut off below the
    // input bar. Scrolling repeatedly across frame boundaries makes the
    // behavior robust to those late layout shifts.
    const wrap = this._dom.chatMessages.parentElement;
    if (!wrap) return;
    const doScroll = () => { wrap.scrollTop = wrap.scrollHeight; };
    requestAnimationFrame(doScroll);
    setTimeout(doScroll, 60);
    setTimeout(doScroll, 250);
  }

  _announce(text) {
    this._dom.srAnnouncer.textContent = '';
    requestAnimationFrame(() => { this._dom.srAnnouncer.textContent = text; });
  }

  _lastBotPanel() {
    const panels = this._dom.chatMessages.querySelectorAll('.panel--bot');
    return panels[panels.length - 1] || null;
  }

  _clearChat() {
    // Wipe everything + restart with a fresh session and greeting
    this._dom.chatMessages.replaceChildren();
    this._messageHistory = [];
    this._sessionId = this._generateSessionId();
    this._lastQuestionText = '';
    this._lastQuestionType = 'text';
    this._greet();
    this._announce('Conversation restarted.');
  }

  _generateSessionId() {
    return 'session-' +
      Math.random().toString(36).substring(2, 15) +
      Math.random().toString(36).substring(2, 15);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.chatApp = new ChatApp();
});
