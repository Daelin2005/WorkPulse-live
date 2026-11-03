(function () {
  'use strict';

  if (!window.api) throw new Error('The WorkPulse API client must load before notifications.');

  var bell = document.getElementById('bell');
  var panel = document.getElementById('pop');
  var list = document.getElementById('pl');
  var badge = document.getElementById('nc');
  var timezone = 'UTC';
  var isOpen = false;
  var knownIds = null;
  var audioContext = null;
  var soundReady = false;

  function primeSound() {
    var AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    try {
      if (!audioContext) audioContext = new AudioContext();
      if (audioContext.state === 'running') {
        soundReady = true;
        return;
      }
      audioContext.resume().then(function () {
        soundReady = true;
      }).catch(function (error) {
        console.warn('Could not enable WorkPulse notification sounds.', error);
      });
    } catch (error) {
      console.warn('Could not enable WorkPulse notification sounds.', error);
    }
  }

  function playSound() {
    if (!soundReady || !audioContext || audioContext.state !== 'running') return;
    var now = audioContext.currentTime;
    var oscillator = audioContext.createOscillator();
    var gain = audioContext.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, now);
    oscillator.frequency.setValueAtTime(1174.66, now + 0.12);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.29);
  }

  document.addEventListener('pointerdown', primeSound, { once: true });
  document.addEventListener('keydown', primeSound, { once: true });

  if (!bell) {
    var signOut = document.getElementById('signout');
    if (!signOut || !signOut.parentNode) return;
    bell = document.createElement('button');
    bell.className = 'ib';
    bell.id = 'bell';
    bell.type = 'button';
    bell.setAttribute('aria-label', 'Notifications');
    bell.setAttribute('aria-expanded', 'false');
    bell.innerHTML = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7M10 20a2 2 0 0 0 4 0"/></svg>';
    signOut.parentNode.insertBefore(bell, signOut);
  }

  if (!badge) {
    badge = document.createElement('b');
    badge.id = 'nc';
    badge.hidden = true;
    bell.appendChild(badge);
  }
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'pop';
    panel.hidden = true;
    document.body.appendChild(panel);
  }
  panel.classList.add('wp-notification-pop');
  if (!list) {
    list = document.createElement('div');
    list.id = 'pl';
    panel.appendChild(list);
  }

  var styles = document.createElement('style');
  styles.textContent = [
    '.wp-notification-pop{position:fixed;top:calc(env(safe-area-inset-top,0px) + 64px);right:16px;width:min(360px,calc(100vw - 24px));max-height:min(70vh,520px);overflow:auto;padding:8px;background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:14px;box-shadow:0 18px 40px #0009;z-index:40}',
    '.wp-notification-pop[hidden]{display:none!important}.wp-notification-pop .wp-notification{display:block;padding:10px;border-radius:8px;color:inherit;text-decoration:none;overflow-wrap:anywhere}',
    '.wp-notification-pop .wp-notification:hover,.wp-notification-pop .wp-notification.unread{background:var(--card2)}',
    '.wp-notification-pop .wp-notification.unread{font-weight:700}.wp-notification-pop .wp-notification small{display:block;margin-top:3px;color:var(--muted);font-weight:400}',
    '#bell{position:relative}#nc{position:absolute;top:3px;right:3px;min-width:17px;height:17px;padding:0 4px;border-radius:9px;background:var(--bad);color:#fff;font-size:10px;display:grid;place-items:center}#nc[hidden]{display:none!important}'
  ].join('');
  document.head.appendChild(styles);

  function time(value) {
    return new Date(value).toLocaleString('en-GB', {
      timeZone: timezone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
    });
  }

  function href(link) {
    if (typeof link !== 'string' || link.charAt(0) !== '/' || link.charAt(1) === '/') return '/home.html';
    var ticket = link.match(/^\/tickets\/([0-9a-f-]+)$/i);
    if (ticket) return '/tickets.html?ticket=' + encodeURIComponent(ticket[1]);
    if (link === '/leave') return '/leave.html';
    if (link === '/attendance') return '/attendance.html';
    return link;
  }

  function escape(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  function render(data) {
    badge.textContent = data.unread > 99 ? '99+' : String(data.unread);
    badge.hidden = data.unread === 0;
    list.innerHTML = data.items.length ? data.items.map(function (item) {
      return '<a class="wp-notification' + (item.readAt ? '' : ' unread') + '" href="' + escape(href(item.link)) + '"' +
        ' data-notification="' + escape(item.id) + '">' + escape(item.body) +
        '<small>' + escape(time(item.createdAt)) + '</small></a>';
    }).join('') : '<div class="wp-notification">You are all caught up.</div>';
    if (knownIds !== null) {
      var incoming = data.items.find(function (item) { return !item.readAt && !knownIds.has(item.id); });
      if (incoming) {
        if (typeof window.wpToast === 'function') window.wpToast(incoming.body);
        playSound();
      }
    }
    knownIds = new Set(data.items.map(function (item) { return item.id; }));
  }

  async function refresh() {
    try {
      var data = await window.api.get('/api/notifications');
      render(data);
    } catch (error) {
      if (isOpen) list.textContent = error && error.message ? error.message : 'Notifications could not be loaded.';
      else console.error('Could not refresh WorkPulse notifications.', error);
    }
  }

  bell.addEventListener('click', async function () {
    primeSound();
    isOpen = panel.hidden;
    panel.hidden = !isOpen;
    bell.setAttribute('aria-expanded', String(isOpen));
    if (!isOpen) return;
    await refresh();
    if (!badge.hidden) {
      try {
        await window.api.post('/api/notifications/read-all');
        badge.hidden = true;
        panel.querySelectorAll('.wp-notification.unread').forEach(function (item) {
          item.classList.remove('unread');
        });
      } catch (error) {
        list.textContent = error && error.message ? error.message : 'Notifications could not be marked as read.';
      }
    }
  });

  panel.addEventListener('click', function (event) {
    var item = event.target.closest('[data-notification]');
    if (!item) return;
    window.api.post('/api/notifications/' + encodeURIComponent(item.dataset.notification) + '/read')
      .catch(function (error) { console.error('Could not mark notification as read.', error); });
  });

  document.addEventListener('click', function (event) {
    if (isOpen && !panel.contains(event.target) && !bell.contains(event.target)) {
      isOpen = false;
      panel.hidden = true;
      bell.setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && isOpen) {
      isOpen = false;
      panel.hidden = true;
      bell.setAttribute('aria-expanded', 'false');
      bell.focus();
    }
  });

  window.WPNotifications = { refresh: refresh };
  window.addEventListener('wp:notification-refresh', refresh);
  window.api.get('/api/bootstrap').then(function (context) {
    timezone = context.company.timezone || 'UTC';
  }).catch(function (error) {
    console.error('Could not load the company time zone for notifications.', error);
  });
  refresh();
  window.setInterval(refresh, 15000);
}());
