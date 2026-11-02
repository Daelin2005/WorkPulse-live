(function () {
  'use strict';

  var themes = [
    ['midnight', 'Midnight', '#0d1a42', '#3d6bff'],
    ['light', 'Daylight', '#eef2fb', '#2f5bea'],
    ['ocean', 'Ocean', '#0b2d3b', '#1fc2cf'],
    ['forest', 'Forest', '#11261b', '#2fb36a'],
    ['sunset', 'Sunset', '#2c1424', '#e8553f'],
    ['violet', 'Violet', '#1d1442', '#7c4dff'],
    ['graphite', 'Graphite', '#1b1d21', '#e0a030'],
    ['sand', 'Sand', '#efe6d8', '#b5521f']
  ];
  var storageKey = 'wp-theme';
  var root = document.documentElement;
  var currentTheme = 'midnight';

  function savedTheme() {
    try {
      var value = localStorage.getItem(storageKey);
      return themes.some(function (theme) { return theme[0] === value; }) ? value : 'midnight';
    } catch (error) {
      return 'midnight';
    }
  }

  function setTheme(id, persist) {
    if (!themes.some(function (theme) { return theme[0] === id; })) return;
    currentTheme = id;
    if (id === 'midnight') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', id);

    if (persist) {
      try {
        localStorage.setItem(storageKey, id);
      } catch (error) {
        if (typeof window.wpToast === 'function') window.wpToast('Your browser could not save this theme.');
      }
    }

    document.querySelectorAll('.tho').forEach(function (button) {
      button.setAttribute('aria-pressed', String(button.dataset.t === id));
    });
  }

  function init() {
    if (document.getElementById('thBtn')) return;
    var signOut = document.getElementById('signout');
    if (!signOut || !signOut.parentNode) return;

    var button = document.createElement('button');
    button.className = 'ib';
    button.id = 'thBtn';
    button.type = 'button';
    button.setAttribute('aria-label', 'Change theme');
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18c1.2 0 2-.8 2-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4c0-4-4-8-9-8z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7" r="1"/></svg>';

    var panel = document.createElement('div');
    panel.className = 'thp';
    panel.hidden = true;
    panel.innerHTML = '<h3>Theme</h3><div class="thg"></div>';
    var grid = panel.querySelector('.thg');
    themes.forEach(function (theme) {
      var option = document.createElement('button');
      option.className = 'tho';
      option.type = 'button';
      option.dataset.t = theme[0];
      option.innerHTML = '<i style="background:linear-gradient(135deg,' + theme[2] + ' 50%,' + theme[3] + ' 50%)"></i>' + theme[1];
      option.addEventListener('click', function () {
        setTheme(theme[0], true);
        if (typeof window.wpToast === 'function') window.wpToast(theme[1] + ' theme on');
      });
      grid.appendChild(option);
    });

    button.addEventListener('click', function () {
      panel.hidden = !panel.hidden;
      button.setAttribute('aria-expanded', String(!panel.hidden));
    });
    document.addEventListener('click', function (event) {
      if (!panel.hidden && !panel.contains(event.target) && !button.contains(event.target)) {
        panel.hidden = true;
        button.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !panel.hidden) {
        panel.hidden = true;
        button.setAttribute('aria-expanded', 'false');
        button.focus();
      }
    });

    signOut.parentNode.insertBefore(button, signOut);
    document.body.appendChild(panel);
    setTheme(savedTheme(), false);
  }

  window.addEventListener('storage', function (event) {
    if (event.key === storageKey && event.newValue) setTheme(event.newValue, false);
  });

  window.WPTheme = {
    init: init,
    set: function (id) { setTheme(id, true); },
    get: function () { return currentTheme; }
  };
}());
