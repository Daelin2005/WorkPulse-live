(function () {
  'use strict';

  var page = location.pathname.split('/').pop().toLowerCase();
  if (page === 'dashboard.html') {
    location.replace('home.html');
    return;
  }
  var titles = {
    'assets.html': 'Equipment',
    'leave.html': 'Leave',
    'company.html': 'Company management',
    'profile.html': 'My profile'
  };
  if (!titles[page]) return;
  if (!document.querySelector('link[rel="icon"]')) {
    var favicon = document.createElement('link');
    favicon.rel = 'icon';
    favicon.type = 'image/svg+xml';
    favicon.href = '/workpulse-icon.svg';
    document.head.appendChild(favicon);
  }

  var $ = function (selector, root) { return (root || document).querySelector(selector); };
  var esc = function (value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  };
  var date = function (value) {
    if (!value) return '—';
    var dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(value));
    var d = new Date(dateOnly ? value + 'T12:00:00' : value);
    return isNaN(d.getTime()) ? String(value) : d.toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      ...(context && context.company.timezone && !dateOnly ? { timeZone: context.company.timezone } : {})
    });
  };
  var isoDate = function (d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  var companyToday = function () {
    var parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: context.company.timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date());
    var values = {};
    parts.forEach(function (part) { values[part.type] = part.value; });
    return values.year + '-' + values.month + '-' + values.day;
  };
  var toast = function (message, bad) {
    var n = $('#notice');
    if (!n) return;
    n.textContent = message;
    n.className = 'notice' + (bad ? ' bad' : '');
    n.hidden = false;
  };
  var problem = function (error) {
    return error && error.message ? error.message : 'The request could not be completed.';
  };
  var readImage = function (file, maxBytes) {
    if (!file || !/^image\/(png|jpeg|gif|webp)$/.test(file.type) || file.size > maxBytes) {
      return Promise.reject(new Error('Choose a PNG, JPEG, GIF or WebP image smaller than ' + Math.round(maxBytes / 1024 / 1024) + ' MB.'));
    }
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error('The image could not be read.')); };
      reader.readAsDataURL(file);
    });
  };
  var field = function (label, name, options) {
    options = options || {};
    var type = options.type || 'text';
    return '<label>' + esc(label) + '<input name="' + esc(name) + '" type="' + esc(type) + '"' +
      (options.required ? ' required' : '') + (options.min !== undefined ? ' min="' + esc(options.min) + '"' : '') +
      (options.minlength ? ' minlength="' + esc(options.minlength) + '"' : '') +
      (options.maxlength ? ' maxlength="' + esc(options.maxlength) + '"' : '') +
      (options.value !== undefined ? ' value="' + esc(options.value) + '"' : '') +
      (options.readonly ? ' readonly' : '') + '></label>';
  };
  var select = function (label, name, values, selected, labels) {
    return '<label>' + esc(label) + '<select name="' + esc(name) + '">' + values.map(function (value) {
      var text = labels && labels[value] !== undefined ? labels[value] : value;
      return '<option value="' + esc(value) + '"' + (String(value) === String(selected) ? ' selected' : '') + '>' + esc(text) + '</option>';
    }).join('') + '</select></label>';
  };
  var timezoneOptions = function (current) {
    var zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [
      'Africa/Johannesburg', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/New_York',
      'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Melbourne', 'Australia/Sydney',
      'Europe/Berlin', 'Europe/London', 'Europe/Paris', 'Pacific/Auckland', 'UTC'
    ];
    if (zones.indexOf(current) < 0) zones.push(current);
    return zones.sort(function (a, b) { return a.localeCompare(b); }).map(function (zone) {
      var offset = '';
      try { offset = new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'shortOffset' }).format(new Date()).split(' ').pop(); }
      catch (error) { offset = ''; }
      return '<option value="' + esc(zone) + '"' + (zone === current ? ' selected' : '') + '>' +
        esc(zone) + (offset ? ' (' + esc(offset) + ')' : '') + '</option>';
    }).join('');
  };
  var button = function (label, kind, attrs) {
    return '<button class="btn' + (kind ? ' ' + kind : '') + '"' + (attrs || '') + '>' + esc(label) + '</button>';
  };
  var table = function (headers, rows) {
    return '<div class="table-wrap"><table><thead><tr>' + headers.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  };
  var rowsOrEmpty = function (rows, message, span) {
    return rows || '<tr><td colspan="' + span + '" class="empty">' + esc(message) + '</td></tr>';
  };
  var nav = [
    ['home.html', 'Dashboard'], ['attendance.html', 'Attendance'], ['leave.html', 'Leave Requests'],
    ['tickets.html', 'Tickets'],
    ['assets.html', 'Log Asset Equipment'], ['company.html', 'Company Management']
  ];

  document.title = titles[page] + ' | WorkPulse';
  document.body.innerHTML = '<div class="app" id="app"><aside class="side" id="side">' +
    '<div class="brand"><button class="logo" id="collapse" type="button" aria-label="Collapse or expand menu"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12h4l3-7 4 14 3-7h6"/></svg></button><span class="lbl">WorkPulse</span></div>' +
    '<div class="co"><span class="ic"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="1"/><path d="M9 7h2m2 0h2m-6 4h2m2 0h2m-5 10v-4h4v4"/></svg></span><span class="ct"><b id="company-label">Loading company…</b><small id="company-domain"></small></span></div>' +
    '<div class="grp">WORKSPACE</div><nav id="main-nav"></nav><div class="sp"></div>' +
    '<a class="me" href="profile.html"><span class="av" id="user-avatar">?</span><span class="lbl"><b id="signed-user"></b><small id="user-role"></small></span></a>' +
    '</aside><main class="main"><header class="top">' +
    '<div class="crumb"><span id="company-crumb"></span><span>›</span><b>' + esc(titles[page]) + '</b></div><div class="sp"></div>' +
    '<button class="ib" id="signout" type="button" aria-label="Sign out" title="Sign out"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 17l5-5-5-5m5 5H3m9-9h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1h-8"/></svg></button></header>' +
    '<div id="notice" class="notice" role="status" hidden></div><section class="page" id="content"><p>Loading your workspace…</p></section></main></div>';

  var styles = document.createElement('style');
  styles.textContent = [
    ':root{box-sizing:border-box;color-scheme:dark;--bg:#080f26;--bg2:#0d1a42;--side:#0b1431;--card:#0e1a3e;--card2:#0a1330;--line:#1e2e5e;--ink:#eaf0ff;--muted:#8e9cc7;--accent:#3d6bff;--accent2:#5b86ff;--brand:#3d6bff;--on:#fff;--soft:#172863;--ok:#35d6a0;--warn:#f0b43c;--off:#7683a8;--bad:#ff6b6b;--hi:#ff9a52;--pr:#b48cff}',
    ':root[data-theme="light"]{color-scheme:light;--bg:#eef2fb;--bg2:#e3eafa;--side:#fff;--card:#fff;--card2:#f3f6fd;--line:#d5deef;--ink:#14203d;--muted:#5a6a8f;--accent:#2f5bea;--accent2:#2f5bea;--brand:#2f5bea;--on:#fff;--soft:#e4ebff;--ok:#14a374;--warn:#b57a00;--off:#7683a8;--bad:#d13d3d;--hi:#c25a10;--pr:#7a4fd6}',
    ':root[data-theme="ocean"]{--bg:#06161f;--bg2:#0b2d3b;--side:#07202b;--card:#0b2733;--card2:#08202a;--line:#17414f;--ink:#e4f6fb;--muted:#84aab8;--accent:#1fc2cf;--accent2:#4fe0ea;--brand:#1fc2cf;--on:#02242b;--soft:#0f3a47}',
    ':root[data-theme="forest"]{--bg:#0a1510;--bg2:#11261b;--side:#0c1b14;--card:#12261c;--card2:#0d1c15;--line:#25402f;--ink:#e8f5ec;--muted:#8fae9a;--accent:#2fb36a;--accent2:#5fd48f;--brand:#2fb36a;--on:#03210f;--soft:#173826}',
    ':root[data-theme="sunset"]{--bg:#1a0e17;--bg2:#2c1424;--side:#1a0c15;--card:#2a1522;--card2:#20101b;--line:#4a2a3d;--ink:#fdeef0;--muted:#c39aa9;--accent:#e8553f;--accent2:#ff8f7a;--brand:#e8553f;--on:#fff;--soft:#44202f}',
    ':root[data-theme="violet"]{--bg:#100b24;--bg2:#1d1442;--side:#0f0a22;--card:#1b1440;--card2:#140f33;--line:#34296a;--ink:#efeaff;--muted:#a99ed6;--accent:#7c4dff;--accent2:#a78bfa;--brand:#7c4dff;--on:#fff;--soft:#2a1f5e}',
    ':root[data-theme="graphite"]{--bg:#0f1012;--bg2:#1b1d21;--side:#131417;--card:#1c1e22;--card2:#16181b;--line:#2d3036;--ink:#ececef;--muted:#9a9ea8;--accent:#e0a030;--accent2:#f2bf5e;--brand:#e0a030;--on:#1a1200;--soft:#2d2a20}',
    ':root[data-theme="sand"]{color-scheme:light;--bg:#f6f1e9;--bg2:#efe6d8;--side:#fffaf2;--card:#fffdf8;--card2:#f7f0e4;--line:#e2d6c2;--ink:#2a2118;--muted:#7a6a55;--accent:#b5521f;--accent2:#b5521f;--brand:#b5521f;--on:#fff;--soft:#f3e2d0;--ok:#2f8f5b;--warn:#a8690a;--bad:#c23b3b}',
    '*,*::before,*::after{box-sizing:inherit}body{margin:0;min-height:100vh;background:linear-gradient(160deg,var(--bg2),var(--bg) 60%);color:var(--ink);font:14px/1.5 "Plus Jakarta Sans",system-ui,-apple-system,"Segoe UI",sans-serif}',
    'button,select,input,textarea{font:inherit;color:inherit}button{cursor:pointer}:focus-visible{outline:2px solid var(--accent2);outline-offset:2px}svg.i{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;flex:none}',
    '.app{display:flex;min-height:100vh}.side{width:244px;min-height:100vh;background:var(--side);border-right:1px solid var(--line);display:flex;flex-direction:column;padding:18px 12px;flex:none;transition:width .2s;overflow:auto}.side.c{width:70px}',
    '.brand{display:flex;align-items:center;gap:12px;padding:0 6px 16px;font-size:20px;font-weight:800;white-space:nowrap}.logo{width:40px;height:40px;border:0;border-radius:12px;background:linear-gradient(135deg,var(--brand),color-mix(in srgb,var(--brand) 62%,#000));display:grid;place-items:center;box-shadow:0 0 18px color-mix(in srgb,var(--brand) 40%,transparent);flex:none;color:var(--on);padding:0}.logo svg{width:24px;height:24px;stroke:var(--on);fill:none;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}',
    '.co{display:flex;gap:12px;align-items:center;padding:14px;border:1px solid var(--line);border-radius:14px;background:var(--card2);margin-bottom:18px;white-space:nowrap;min-height:74px}.co .ic{width:46px;height:46px;padding:3px;border:2px solid var(--line);border-radius:13px;background:var(--card);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent2) 12%,transparent);display:grid;place-items:center;color:var(--accent2);flex:none;overflow:hidden}.co b{display:block;font-size:13px}.co small{color:var(--muted)}',
    '.grp{font-size:11px;font-weight:700;letter-spacing:.08em;color:var(--muted);padding:0 10px;margin:4px 0 8px;white-space:nowrap}.side nav{display:grid;gap:4px}.side nav a{display:flex;align-items:center;gap:12px;padding:11px 12px;border-radius:10px;color:var(--muted);text-decoration:none;white-space:nowrap}.side nav a:hover{background:var(--card2);color:var(--ink)}.side nav a[aria-current]{background:var(--soft);color:var(--ink);font-weight:600;box-shadow:inset 3px 0 0 var(--accent2)}.side.c .lbl,.side.c .grp,.side.c .co .ct{display:none}.side.c .co{padding:8px;justify-content:center}.sp{flex:1}.side a.me{display:flex;gap:10px;align-items:center;padding:14px 8px 0;border-top:1px solid var(--line);color:var(--ink);text-decoration:none;white-space:nowrap}.av{width:36px;height:36px;border-radius:50%;background:var(--soft);display:grid;place-items:center;font-weight:700;font-size:12px;flex:none}.me b{display:block;font-size:13px}.me small{color:var(--muted)}',
    '.main{flex:1;min-width:0;display:flex;flex-direction:column;position:relative}.top{display:flex;align-items:center;gap:12px;padding:14px 32px;border-bottom:1px solid var(--line)}.crumb{display:flex;gap:10px;align-items:center;color:var(--muted)}.crumb b{color:var(--ink)}.top .sp{flex:1}.ib{width:40px;height:40px;border-radius:10px;border:0;background:none;color:var(--muted);display:grid;place-items:center}.ib:hover{background:var(--card);color:var(--ink)}',
    '.page{flex:1;overflow:auto;padding:clamp(18px,3vw,40px)}.page>section,.page>.grid,.page>#content>*{width:100%;max-width:none}.page .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:clamp(16px,2vw,24px);margin:0 0 18px;box-shadow:0 8px 24px #0000000a}.page h1,.page h2,.page h3{color:var(--ink)}.page h2{margin:0 0 14px}.page h3{margin:12px 0 8px}.muted,.metric-label{color:var(--muted)}',
    '.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:18px}.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:16px;align-items:end}.page form.stack{display:grid;gap:16px}.page label{display:grid;min-width:0;gap:6px;font-size:13px;font-weight:600;color:var(--muted)}',
    '.page input,.page select,.page textarea{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card2);color:var(--ink);font:inherit}.page textarea{min-height:90px;resize:vertical}.page input[type=checkbox]{width:auto;accent-color:var(--accent)}',
    '.btn{border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:10px;padding:10px 16px;font-weight:650;line-height:1.25;display:inline-flex;justify-content:center;gap:8px;align-items:center;transition:background .16s,border-color .16s,transform .16s,box-shadow .16s}.btn:hover{border-color:var(--accent2);background:var(--soft);transform:translateY(-1px)}.btn:active{transform:translateY(0)}.btn.primary{background:linear-gradient(135deg,var(--accent),var(--accent2));border-color:var(--accent2);color:#fff;box-shadow:0 5px 16px color-mix(in srgb,var(--accent) 25%,transparent)}.btn.primary:hover{filter:brightness(1.08);box-shadow:0 7px 20px color-mix(in srgb,var(--accent) 32%,transparent)}.btn.danger{border-color:var(--bad);color:var(--bad)}.btn:disabled{opacity:.55;cursor:wait;transform:none}.actions{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap;margin-top:12px}.actions.asset-actions{margin-top:16px}',
    '.asset-filters{grid-template-columns:repeat(auto-fit,minmax(min(100%,210px),1fr))}.table-wrap{width:100%}.company-mark,.avatar-photo{width:100%;height:100%;object-fit:cover;border-radius:inherit}.password-field{display:flex;align-items:stretch}.password-field input{min-width:0}.password-field button{flex:none}',
    '.brand-settings{display:flex;justify-content:space-between;align-items:center;gap:20px;padding:16px;border:1px solid var(--line);border-radius:12px;background:var(--card2)}.brand-settings>div:first-child{display:grid;gap:8px}.brand-settings p{margin:0}.brand-preview{width:72px;height:72px;display:grid;place-items:center;flex:none;border:1px dashed var(--line);border-radius:16px;overflow:hidden;color:var(--muted)}.brand-preview img{width:100%;height:100%;object-fit:cover}.avatar-editor{display:flex;align-items:center;gap:16px}.avatar-editor .av{width:72px;height:72px;font-size:20px;overflow:hidden}.avatar-editor>div{display:grid;gap:8px}.field-hint{font-weight:400}',
    '.photo-editor-backdrop{position:fixed;inset:0;z-index:60;display:grid;place-items:center;padding:18px;background:#0009}.photo-editor-backdrop[hidden]{display:none!important}.photo-editor-dialog{width:min(440px,100%);max-height:calc(100vh - 36px);overflow:auto;padding:22px;border:1px solid var(--line);border-radius:16px;background:var(--card);box-shadow:0 20px 60px #0008}.photo-editor-dialog h2{margin:0 0 4px}.photo-editor-dialog p{margin:0 0 14px;color:var(--muted)}.photo-editor-canvas{display:block;width:min(280px,100%);height:auto;margin:0 auto 16px;border:2px solid var(--line);border-radius:50%;background:var(--card2);touch-action:none;cursor:grab}.photo-editor-canvas:active{cursor:grabbing}.photo-editor-zoom{display:grid;grid-template-columns:1fr auto;align-items:center;gap:4px 12px}.photo-editor-zoom label{grid-column:1/-1}.photo-editor-zoom input{padding:0!important}.photo-editor-actions{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-top:18px}.photo-editor-actions>div{display:flex;gap:8px;flex-wrap:wrap}.avatar-editor .btn[hidden]{display:none!important}',
    '.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:10px 9px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12px;color:var(--muted);font-weight:700;white-space:nowrap}.empty{text-align:center;color:var(--muted);padding:22px}.pill{display:inline-block;border-radius:99px;background:var(--soft);color:var(--ink);padding:3px 8px;font-size:12px}',
    '.tab-row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}.tab-row button[aria-pressed=true]{border-color:var(--accent2);background:var(--soft)}.metric{font-size:24px;font-weight:700}.invite{overflow-wrap:anywhere}.notice{margin:12px 32px 0;padding:12px 14px;border-radius:8px;background:var(--soft);color:var(--ink)}.notice.bad{background:color-mix(in srgb,var(--bad) 18%,var(--card));color:var(--bad)}.notice[hidden]{display:none}',
    '.thp{position:fixed;top:calc(env(safe-area-inset-top,0px) + 60px);right:16px;width:min(300px,calc(100% - 24px));background:var(--card);border:1px solid var(--line);border-radius:14px;padding:10px;box-shadow:0 18px 40px #0009;z-index:30}.thp[hidden]{display:none}.thp h3{margin:2px 6px 8px;font-size:13px}.thg{display:grid;grid-template-columns:1fr 1fr;gap:8px}.tho{display:flex;gap:8px;align-items:center;border:1px solid var(--line);border-radius:10px;padding:8px;background:var(--card2);color:var(--ink);text-align:left;font-weight:600}.tho[aria-pressed=true]{border-color:var(--accent2);background:var(--soft)}.tho i{width:22px;height:22px;border-radius:50%;flex:none;border:2px solid var(--line)}',
    '@media(max-width:800px){.side{width:70px;padding:12px 8px}.side .lbl,.side .grp,.side .co .ct{display:none}.side .co{padding:8px;justify-content:center}.top{padding:12px 16px}.page{padding:20px 16px}.notice{margin:12px 16px 0}}'
  ].join('');
  document.head.appendChild(styles);

  var context;
  function setAvatar(element, src, name) {
    if (src) {
      var image = document.createElement('img');
      image.className = 'avatar-photo';
      image.alt = '';
      image.src = src;
      element.replaceChildren(image);
    } else {
      element.textContent = String(name || '?').split(/\s+/).map(function (part) { return part[0] || ''; }).join('').slice(0, 2).toUpperCase();
    }
  }
  function setCompanyMark(src) {
    var mark = $('.co .ic');
    if (!mark) return;
    if (src) {
      var image = document.createElement('img');
      image.className = 'company-mark';
      image.alt = 'Company icon';
      image.src = src;
      mark.replaceChildren(image);
    } else {
      mark.innerHTML = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="1"/><path d="M9 7h2m2 0h2m-6 4h2m2 0h2m-5 10v-4h4v4"/></svg>';
    }
  }
  function showNav() {
    var icons = {
      'home.html': '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
      'attendance.html': '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
      'leave.html': '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4m8-4v4M3 11h18"/>',
      'tickets.html': '<path d="M3 9a2 2 0 0 0 0 6v3h18v-3a2 2 0 0 1 0-6V6H3z"/>',
      'assets.html': '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
      'company.html': '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>'
    };
    $('#main-nav').innerHTML = nav.filter(function (item) {
      return item[0] !== 'company.html' || context.user.role !== 'employee';
    }).map(function (item) {
      return '<a href="' + item[0] + '"' + (page === item[0] ? ' aria-current="page"' : '') + '><svg class="i" viewBox="0 0 24 24" aria-hidden="true">' + icons[item[0]] + '</svg><span class="lbl">' + esc(item[1]) + '</span></a>';
    }).join('');
    $('#company-label').textContent = context.company.name;
    $('#company-domain').textContent = context.company.domain;
    $('#company-crumb').textContent = context.company.name;
    setCompanyMark(context.company.logo);
    $('#signed-user').textContent = context.user.name;
    setAvatar($('#user-avatar'), context.user.avatar, context.user.name);
    $('#user-role').textContent = context.user.role.charAt(0).toUpperCase() + context.user.role.slice(1);
    if (page === 'profile.html') $('.me').setAttribute('aria-current', 'page');
    if (window.innerWidth < 800) $('#side').classList.add('c');
  }
  $('#signout').addEventListener('click', async function () {
    this.disabled = true;
    try { await api.post('/api/auth/logout'); } catch (error) { toast(problem(error), true); }
    location.replace('Login.html');
  });
  $('#collapse').addEventListener('click', function () { $('#side').classList.toggle('c'); });
  window.addEventListener('wp:signed-out', function () { location.replace('Login.html'); });
  window.wpToast = toast;
  if (window.WPTheme) window.WPTheme.init();

  var assetQuery = {};
  function loadAssets() {
    var content = $('#content'), assets, types, locations, directory;
    var query = new URLSearchParams(assetQuery);
    return Promise.all([
      api.get('/api/assets' + (query.toString() ? '?' + query.toString() : '')),
      api.get('/api/asset-types'), api.get('/api/locations'), api.get('/api/employees')
    ]).then(function (data) {
      assets = data[0]; types = data[1]; locations = data[2]; directory = data[3];
      var canWrite = context.permissions.writeEquipment;
      content.innerHTML = '<section class="card"><h2>Equipment register</h2><p class="muted">Search and manage company equipment and incident history.</p>' +
        '<form id="asset-search"><div class="form-grid asset-filters">' + field('Search', 'q') +
        select('Type', 'typeId', [''].concat(types.map(function (x) { return x.id; })), '', types.reduce(function (o, x) { o[x.id] = x.name; return o; }, { '': 'All types' })) +
        select('Location', 'locationId', [''].concat(locations.map(function (x) { return x.id; })), '', locations.reduce(function (o, x) { o[x.id] = x.name; return o; }, { '': 'All locations' })) +
        select('Status', 'status', ['', 'In use', 'In storage', 'In repair', 'Retired', 'Lost'], '') + '</div>' +
        '<div class="actions asset-actions"><button class="btn" type="submit">Search</button>' +
        (canWrite ? '<button class="btn primary" type="button" id="new-asset">Add equipment</button><button class="btn" type="button" id="new-type">Add type</button><button class="btn" type="button" id="new-location">Add location</button>' : '') +
        '</div></form>' + table(['Asset ID', 'Equipment', 'Type', 'Holder', 'Location', 'Status', 'Incidents', ''], rowsOrEmpty(assets.map(function (asset) {
          return '<tr><td>' + esc(asset.assetTag) + '</td><td>' + esc(asset.model) + '<br><span class="muted">' + esc(asset.serialNumber || '') + '</span></td><td>' +
            esc(asset.type) + '</td><td>' + esc(asset.holder || 'Unassigned') + '</td><td>' + esc(asset.location) + '</td><td>' + esc(asset.status) +
            '</td><td>' + esc(asset.openIncidents) + ' open / ' + esc(asset.incidentCount) + '</td><td><button class="btn" type="button" data-asset="' + esc(asset.id) + '">Details</button></td></tr>';
        }).join(''), 'No equipment is registered yet.', 8)) + '</section><section id="asset-editor"></section><section id="asset-detail"></section>';

      $('#asset-search').addEventListener('submit', function (event) {
        event.preventDefault();
        assetQuery = Object.fromEntries(new FormData(this));
        loadAssets().catch(function (error) { toast(problem(error), true); });
      });
      $('#content').querySelectorAll('[data-asset]').forEach(function (b) {
        b.addEventListener('click', function () { showAsset(b.getAttribute('data-asset'), canWrite); });
      });
      if (canWrite) {
        $('#new-asset').addEventListener('click', function () { assetForm(types, locations, directory); });
        $('#new-type').addEventListener('click', function () {
          namedItemForm('type', 'Equipment type', '/api/asset-types', 60);
        });
        $('#new-location').addEventListener('click', function () {
          namedItemForm('location', 'Location', '/api/locations', 80);
        });
      }

      function namedItemForm(kind, label, endpoint, maxLength) {
        var target = $('#asset-editor'), formId = 'new-' + kind + '-form';
        target.innerHTML = '<section class="card"><h2>Add ' + esc(label.toLowerCase()) + '</h2><form id="' + formId + '" class="stack">' +
          '<div class="form-grid">' + field(label + ' name', 'name', { required: true, maxlength: maxLength }) + '</div>' +
          '<div class="actions"><button class="btn primary" type="submit">Save ' + esc(label.toLowerCase()) +
          '</button><button class="btn" type="button" id="cancel-named-item">Cancel</button></div></form></section>';
        $('#cancel-named-item').addEventListener('click', function () { target.innerHTML = ''; });
        $('#' + formId).addEventListener('submit', async function (event) {
          event.preventDefault();
          var input = this.elements.name, name = input.value.trim(), save = this.querySelector('[type=submit]');
          if (!name) { input.focus(); return; }
          save.disabled = true;
          try {
            await api.post(endpoint, { name: name });
            toast(label + ' added.');
            await loadAssets();
          } catch (error) {
            toast(problem(error), true);
            save.disabled = false;
          }
        });
      }

      function assetForm(typeRows, locationRows, people, existing) {
        var target = $('#asset-editor');
        var a = existing || {};
        target.innerHTML = '<section class="card"><h2>' + (a.id ? 'Edit equipment' : 'Add equipment') + '</h2><form id="asset-form" class="stack">' +
          '<div class="form-grid">' + select('Type', 'typeId', typeRows.map(function (x) { return x.id; }), a.typeId || typeRows[0].id,
            typeRows.reduce(function (o, x) { o[x.id] = x.name; return o; }, {})) +
          field('Asset ID (leave blank to generate)', 'assetTag', { value: a.assetTag || '' }) +
          field('Model', 'model', { required: true, value: a.model || '' }) + field('Serial number', 'serialNumber', { value: a.serialNumber || '' }) +
          select('Status', 'status', ['In use', 'In storage', 'In repair', 'Retired', 'Lost'], a.status || 'In storage') +
          select('Holder', 'holderId', [''].concat(people.map(function (x) { return x.id; })), a.holderId || '',
            people.reduce(function (o, x) { o[x.id] = x.name; return o; }, { '': 'Unassigned' })) +
          select('Location', 'locationId', locationRows.map(function (x) { return x.id; }), a.locationId || locationRows[0].id,
            locationRows.reduce(function (o, x) { o[x.id] = x.name; return o; }, {})) +
          field('Purchased on', 'purchasedOn', { type: 'date', value: a.purchasedOn || '' }) +
          field('Warranty ends', 'warrantyEndsOn', { type: 'date', value: a.warrantyEndsOn || '' }) + '</div>' +
          '<label>Notes<textarea name="notes">' + esc(a.notes || '') + '</textarea></label>' +
          '<div class="actions"><button class="btn primary" type="submit">Save equipment</button><button class="btn" type="button" id="cancel-asset">Cancel</button></div></form></section>';
        $('#cancel-asset').addEventListener('click', function () { target.innerHTML = ''; });
        $('#asset-form').addEventListener('submit', async function (event) {
          event.preventDefault();
          var values = Object.fromEntries(new FormData(this));
          if (!values.holderId) values.holderId = null;
          for (var key of ['purchasedOn', 'warrantyEndsOn']) if (!values[key]) values[key] = null;
          var save = this.querySelector('[type=submit]'); save.disabled = true;
          try {
            if (a.id) await api.patch('/api/assets/' + a.id, values);
            else await api.post('/api/assets', values);
            toast('Equipment saved.'); loadAssets();
          } catch (error) { toast(problem(error), true); save.disabled = false; }
        });
      }
      async function showAsset(id, editable) {
        var target = $('#asset-detail');
        try {
          var asset = await api.get('/api/assets/' + id);
          target.innerHTML = '<section class="card"><h2>' + esc(asset.assetTag) + ' · ' + esc(asset.model) + '</h2><p>' +
            esc(asset.type) + ' · ' + esc(asset.status) + ' · ' + esc(asset.location) + ' · ' + esc(asset.holder || 'Unassigned') + '</p>' +
            (editable ? '<div class="actions"><button class="btn" id="edit-asset" type="button">Edit details</button></div>' +
              '<h3>Log an incident</h3><form id="incident-form" class="stack"><div class="form-grid">' +
              select('Kind', 'kind', ['Fault', 'Damage', 'Loss or theft', 'Maintenance', 'Other'], 'Fault') +
              select('Severity', 'severity', ['Minor', 'Major', 'Critical'], 'Minor') + field('Title', 'title', { required: true }) +
              field('Occurred on', 'occurredOn', { type: 'date' }) + '</div><label>Description<textarea name="description" required></textarea></label>' +
              '<button class="btn primary" type="submit">Log incident</button></form>' : '') +
            '<h3>Incidents</h3>' + table(['Date', 'Incident', 'Severity', 'Status', 'Resolution', ''], rowsOrEmpty((asset.incidents || []).map(function (i) {
              return '<tr><td>' + esc(date(i.occurredOn)) + '</td><td>' + esc(i.title) + '<br>' + esc(i.description) + '</td><td>' +
                esc(i.severity) + '</td><td>' + esc(i.status) + '</td><td>' + esc(i.resolution || '—') + '</td><td>' +
                (editable && i.status === 'Open' ? '<button class="btn" type="button" data-resolve="' + esc(i.id) + '">Resolve</button>' : '') + '</td></tr>';
            }).join(''), 'No incidents have been logged.', 6)) +
            '<h3>History</h3><ul>' + (asset.history || []).map(function (h) { return '<li>' + esc(date(h.createdAt)) + ' · ' + esc(h.actor || 'System') + ': ' + esc(h.event) + '</li>'; }).join('') + '</ul></section>';
          if (editable) {
            $('#edit-asset').addEventListener('click', function () { assetForm(types, locations, directory, asset); });
            target.querySelectorAll('[data-resolve]').forEach(function (b) {
              b.onclick = async function () {
                var resolution = prompt('How was this incident resolved?');
                if (resolution === null) return;
                try {
                  var result = await api.patch('/api/assets/' + id + '/incidents/' + b.dataset.resolve, { resolution: resolution });
                  toast(result.reminder || 'Incident resolved.');
                  showAsset(id, editable); loadAssets();
                } catch (error) { toast(problem(error), true); }
              };
            });
            $('#incident-form').addEventListener('submit', async function (event) {
              event.preventDefault();
              var values = Object.fromEntries(new FormData(this));
              try { await api.post('/api/assets/' + id + '/incidents', values); toast('Incident recorded.'); showAsset(id, editable); loadAssets(); }
              catch (error) { toast(problem(error), true); }
            });
          }
        } catch (error) { toast(problem(error), true); }
      }
    });
  }

  function loadLeave() {
    var content = $('#content'), activeTab = 'mine', today = companyToday();
    var month = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, 1);
    function render() {
      return Promise.all([
        api.get('/api/leave/balances'), api.get('/api/leave'), api.get('/api/leave-types')
      ]).then(function (data) {
        var balances = data[0], requests = data[1], types = data[2];
        content.innerHTML = '<div class="tab-row"><button class="btn" data-tab="mine" aria-pressed="' + (activeTab === 'mine') + '">My leave</button>' +
          '<button class="btn" data-tab="calendar" aria-pressed="' + (activeTab === 'calendar') + '">Company calendar</button>' +
          (context.permissions.viewReports ? '<button class="btn" data-tab="approvals" aria-pressed="' + (activeTab === 'approvals') + '">Approvals</button>' : '') + '</div>' +
          (activeTab === 'mine' ? '<div class="grid">' + balances.types.map(function (b) {
            return '<section class="card"><div class="metric">' + (b.remaining === null ? 'Unlimited' : esc(b.remaining) + ' days') +
              '</div><div class="metric-label">' + esc(b.name) + ' remaining · ' + esc(b.used) + ' used · ' + esc(b.pending) + ' pending</div></section>';
          }).join('') + '</div><section class="card"><h2>Request leave</h2><form id="leave-form" class="stack"><div class="form-grid">' +
          select('Leave type', 'leaveTypeId', types.filter(function (t) { return t.enabled; }).map(function (t) { return t.id; }),
            types.filter(function (t) { return t.enabled; })[0] && types.filter(function (t) { return t.enabled; })[0].id,
            types.reduce(function (o, t) { o[t.id] = t.name; return o; }, {})) +
          select('Duration', 'dayPart', ['full', 'am', 'pm'], 'full', { full: 'Full day', am: 'Half day · morning', pm: 'Half day · afternoon' }) +
          field('First day', 'startDate', { type: 'date', required: true }) + field('Last day', 'endDate', { type: 'date', required: true }) +
          '</div><label>Reason<textarea name="reason" maxlength="1000" required></textarea></label><button class="btn primary" type="submit">Send request</button></form></section>' +
          '<section class="card"><h2>My leave history</h2>' + table(['Type', 'Dates', 'Days', 'Status', 'Decision', ''], rowsOrEmpty(requests.map(function (r) {
            return '<tr><td>' + esc(r.leaveType) + '</td><td>' + esc(date(r.startDate)) + ' – ' + esc(date(r.endDate)) + '</td><td>' + esc(r.days) +
              '</td><td><span class="pill">' + esc(r.status) + '</span></td><td>' + esc(r.decisionNote || '—') + '</td><td>' +
              (r.status === 'pending' || (r.status === 'approved' && r.startDate > today) ? '<button class="btn danger" data-cancel="' + esc(r.id) + '">Cancel</button>' : '') +
              '</td></tr>';
          }).join(''), 'No leave requests yet.', 6)) + '</section>' :
          activeTab === 'calendar' ? '<section class="card"><div class="actions"><button class="btn" id="prev-month" type="button">Previous</button><h2>' +
            esc(month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })) + '</h2><button class="btn" id="next-month" type="button">Next</button></div><div id="leave-calendar">Loading…</div></section>' :
          '<section class="card"><h2>Pending leave approvals</h2><div id="approval-list">Loading…</div></section>');

        content.querySelectorAll('[data-tab]').forEach(function (b) { b.addEventListener('click', function () { activeTab = b.dataset.tab; render(); }); });
        if (activeTab === 'mine') {
          $('#leave-form').addEventListener('submit', async function (event) {
            event.preventDefault();
            var values = Object.fromEntries(new FormData(this));
            try { await api.post('/api/leave', values); toast('Leave request submitted.'); render(); }
            catch (error) { toast(problem(error), true); }
          });
          content.querySelectorAll('[data-cancel]').forEach(function (b) {
            b.addEventListener('click', async function () {
              if (!confirm('Cancel this leave request?')) return;
              try { await api.post('/api/leave/' + b.dataset.cancel + '/cancel'); toast('Request cancelled.'); render(); }
              catch (error) { toast(problem(error), true); }
            });
          });
        } else if (activeTab === 'calendar') {
          var first = new Date(month.getFullYear(), month.getMonth(), 1), last = new Date(month.getFullYear(), month.getMonth() + 1, 0);
          api.get('/api/leave/calendar?from=' + isoDate(first) + '&to=' + isoDate(last)).then(function (items) {
            $('#leave-calendar').innerHTML = items.length ? table(['Dates', 'Employee', 'Department', 'Leave type', 'Days'], items.map(function (r) {
              return '<tr><td>' + esc(date(r.startDate)) + ' – ' + esc(date(r.endDate)) + '</td><td>' + esc(r.employee) + '</td><td>' + esc(r.department) + '</td><td>' + esc(r.leaveType) + '</td><td>' + esc(r.days) + '</td></tr>';
            }).join('')) : '<p class="empty">No approved leave for this month.</p>';
          }).catch(function (error) { toast(problem(error), true); });
          $('#prev-month').onclick = function () { month.setMonth(month.getMonth() - 1); render(); };
          $('#next-month').onclick = function () { month.setMonth(month.getMonth() + 1); render(); };
        } else {
          api.get('/api/leave?scope=all&status=pending').then(function (items) {
            $('#approval-list').innerHTML = items.length ? items.map(function (r) {
              return '<article class="card"><h3>' + esc(r.employee) + ' · ' + esc(r.leaveType) + '</h3><p>' +
                esc(date(r.startDate)) + ' – ' + esc(date(r.endDate)) + ' · ' + esc(r.days) + ' day(s) · ' + esc(r.department) + '</p><p>' +
                esc(r.reason) + '</p><div class="actions"><button class="btn primary" data-decision="approve" data-id="' + esc(r.id) + '">Approve</button>' +
                '<button class="btn danger" data-decision="reject" data-id="' + esc(r.id) + '">Reject</button></div></article>';
            }).join('') : '<p class="empty">There are no pending approvals.</p>';
            $('#approval-list').querySelectorAll('[data-decision]').forEach(function (b) {
              b.onclick = async function () {
                var decision = b.dataset.decision, note = decision === 'reject' ? prompt('Reason for rejection (optional):') : '';
                if (decision === 'reject' && note === null) return;
                try {
                  var result = await api.post('/api/leave/' + b.dataset.id + '/decision', { decision: decision, note: note || '' });
                  toast(result.warning ? result.warning.message : 'Request ' + (decision === 'approve' ? 'approved' : 'rejected') + '.');
                  render();
                } catch (error) { toast(problem(error), true); }
              };
            });
          }).catch(function (error) { toast(problem(error), true); });
        }
      });
    }
    return render();
  }

  function loadCompany() {
    var content = $('#content'), activeTab = 'company', state = {}, editingEmployee = null;
    function reload() {
      return Promise.all([
        api.get('/api/company'), api.get('/api/departments'), api.get('/api/employees'),
        api.get('/api/leave-types'), api.get('/api/sla-targets'), api.get('/api/announcements?all=1')
      ]).then(function (data) {
        state = { company: data[0], departments: data[1], employees: data[2], leaveTypes: data[3], targets: data[4], announcements: data[5] };
        context.company = Object.assign({}, context.company, state.company);
        $('#company-label').textContent = context.company.name;
        $('#company-domain').textContent = context.company.domain;
        $('#company-crumb').textContent = context.company.name;
        setCompanyMark(context.company.logo);
        render();
      });
    }
    function render() {
      var admin = context.permissions.manage;
      var tabs = [['company', 'Company'], ['people', 'Employees'], ['departments', 'Departments'], ['leave', 'Leave policy'], ['sla', 'Ticket SLAs'], ['announcements', 'Announcements']];
      if (context.permissions.viewReports) tabs.push(['audit', 'Audit log']);
      content.innerHTML = '<div class="tab-row">' + tabs.map(function (t) {
        return '<button class="btn" data-tab="' + t[0] + '" aria-pressed="' + (activeTab === t[0]) + '">' + t[1] + '</button>';
      }).join('') + '</div>' + renderTab(activeTab, admin);
      content.querySelectorAll('[data-tab]').forEach(function (b) { b.onclick = function () { activeTab = b.dataset.tab; render(); if (activeTab === 'audit') loadAudit(); }; });
      bindTab(admin);
    }
    function renderTab(tab, admin) {
      if (tab === 'company') {
        var c = state.company;
        return '<section class="card"><h2>Company profile</h2><form id="company-form" class="stack"><div class="form-grid">' +
          field('Company name', 'name', { required: true, value: c.name }) + '<label>Company time zone<select name="timezone">' +
          timezoneOptions(c.timezone) + '</select></label>' +
          field('Leave year starts in month (1–12)', 'leaveYearStart', { type: 'number', min: 1, value: c.leaveYearStart }) +
          field('Staffing warning threshold', 'staffingWarnAt', { type: 'number', min: 1, value: c.staffingWarnAt }) +
          '<label><span>Calculate ticket SLAs in business hours</span><select name="slaBusinessHours"><option value="true"' + (c.slaBusinessHours ? ' selected' : '') + '>Yes</option><option value="false"' + (!c.slaBusinessHours ? ' selected' : '') + '>No</option></select></label></div>' +
          (admin ? '<div class="brand-settings"><div><b>Company icon</b><p class="muted">Shown beside your company name across the workspace. PNG, JPEG, GIF or WebP, up to 1 MB.</p>' +
            '<input type="file" id="company-icon" accept="image/png,image/jpeg,image/gif,image/webp">' +
            (c.logo ? '<button class="btn danger" type="button" id="remove-company-icon">Remove icon</button>' : '') + '</div>' +
            '<div class="brand-preview">' + (c.logo ? '<img src="' + esc(c.logo) + '" alt="Current company icon">' : '<span>No icon set</span>') + '</div></div>' : '') +
          '<p class="muted">Plan: ' + esc(c.tier) + ' · ' + esc(c.seatsUsed) + ' of ' + esc(c.seats) + ' seats used · Company ID ' + esc(c.publicId) + '</p>' +
          (admin ? '<button class="btn primary" type="submit">Save company settings</button>' : '<p class="muted">Only a company admin can change settings.</p>') + '</form></section>';
      }
      if (tab === 'people') {
        var editing = editingEmployee;
        var employeeEditForm = editing ? '<section class="card"><h2>Edit employee</h2><form id="edit-employee-form" class="stack"><div class="form-grid">' +
          field('Full name', 'fullName', { required: true, value: editing.name }) +
          field('Username', 'username', { required: true, maxlength: 32, value: editing.username }) +
          field('Work email', 'email', { type: 'email', required: true, value: editing.email }) +
          field('Job title', 'jobTitle', { required: true, value: editing.jobTitle }) +
          select('Role', 'role', ['employee', 'manager', 'admin'], editing.role) +
          select('Department', 'departmentId', state.departments.map(function (d) { return d.id; }), editing.departmentId,
            state.departments.reduce(function (o, d) { o[d.id] = d.name; return o; }, {})) +
          field('Start date', 'startDate', { type: 'date', value: editing.startDate ? String(editing.startDate).slice(0, 10) : '' }) +
          '</div><div class="actions"><button class="btn primary" type="submit">Save employee</button><button class="btn" type="button" id="cancel-employee-edit">Cancel</button></div></form></section>' : '';
        return employeeEditForm + '<section class="card"><h2>Employees</h2>' + (admin ? '<form id="add-employee-form" class="stack"><div class="form-grid">' +
          field('Full name', 'fullName', { required: true }) + field('Username', 'username', { required: true, maxlength: 32 }) +
          field('Work email', 'email', { type: 'email', required: true }) +
          field('Job title', 'jobTitle', { required: true }) + select('Role', 'role', ['employee', 'manager', 'admin'], 'employee') +
          select('Department', 'departmentId', state.departments.map(function (d) { return d.id; }), state.departments[0] && state.departments[0].id,
            state.departments.reduce(function (o, d) { o[d.id] = d.name; return o; }, {})) +
          field('Start date', 'startDate', { type: 'date' }) +
          '<label>Initial password<input id="employee-initial-password" name="password" type="password" minlength="8" maxlength="200" autocomplete="new-password" required>' +
          '<button class="btn" type="button" id="toggle-employee-password" aria-controls="employee-initial-password" aria-pressed="false">Show password</button></label>' +
          '</div><p class="muted">Set the initial password and share the username, work email, and password with the employee. They can change their password in Profile after signing in.</p>' +
          '<button class="btn primary" type="submit">Add employee</button><div id="employee-result"></div></form>' : '') +
          table(['Employee ID', 'Name', 'Username', 'Email', 'Title', 'Department', 'Role', 'Status', ''], rowsOrEmpty(state.employees.map(function (e) {
            return '<tr><td>' + esc(e.employeeNo || '—') + '</td><td>' + esc(e.name) + '</td><td>' + esc(e.username || '—') + '</td><td>' + esc(e.email || 'Private') + '</td><td>' + esc(e.jobTitle) +
              '</td><td>' + esc(e.department) + '</td><td>' + esc(e.role) + '</td><td>' + esc(e.status) + '</td><td>' +
              (admin && e.id !== context.user.id ? '<div class="actions"><button class="btn" type="button" data-edit-employee="' + esc(e.id) + '">Edit</button><button class="btn" type="button" data-employee="' + esc(e.id) + '" data-state="' + esc(e.status) + '">' +
                (e.status === 'deactivated' ? 'Reactivate' : 'Deactivate') + '</button><button class="btn danger" type="button" data-delete-employee="' + esc(e.id) + '">Delete</button></div>' : '') + '</td></tr>';
          }).join(''), 'No employees found.', 9)) + '</section>';
      }
      if (tab === 'departments') {
        return '<section class="card"><h2>Departments</h2>' + (admin ? '<form id="department-form" class="stack"><div class="form-grid">' +
          field('Department name', 'name', { required: true }) + '<label><span>Handles support tickets</span><select name="handlesTickets"><option value="false">No</option><option value="true">Yes</option></select></label>' +
          '</div><button class="btn primary" type="submit">Add department</button></form>' : '') +
          table(['Name', 'Department head', 'People', 'Ticket handling'], rowsOrEmpty(state.departments.map(function (d) {
            return '<tr><td>' + esc(d.name) + '</td><td>' + esc(d.headName || '—') + '</td><td>' + esc(d.people) + '</td><td>' + (d.handlesTickets ? 'Yes' : 'No') + '</td></tr>';
          }).join(''), 'No departments found.', 4)) + '</section>';
      }
      if (tab === 'leave') return '<section class="card"><h2>Leave policy</h2>' + table(['Type', 'Days/year', 'Carry-over', 'Approval', 'Minimum notice', 'Enabled', ''], rowsOrEmpty(state.leaveTypes.map(function (t) {
        return '<tr><td>' + esc(t.name) + '</td><td><input type="number" min="0" data-lt="' + esc(t.id) + '" data-key="daysPerYear" value="' + esc(t.daysPerYear) + '"' + (!admin ? ' disabled' : '') + '></td>' +
          '<td><input type="number" min="0" data-lt="' + esc(t.id) + '" data-key="carryOverDays" value="' + esc(t.carryOverDays) + '"' + (!admin ? ' disabled' : '') + '></td>' +
          '<td><input type="checkbox" data-lt="' + esc(t.id) + '" data-key="requiresApproval"' + (t.requiresApproval ? ' checked' : '') + (!admin ? ' disabled' : '') + '></td>' +
          '<td><input type="number" min="0" data-lt="' + esc(t.id) + '" data-key="minNoticeDays" value="' + esc(t.minNoticeDays) + '"' + (!admin ? ' disabled' : '') + '></td>' +
          '<td><input type="checkbox" data-lt="' + esc(t.id) + '" data-key="enabled"' + (t.enabled ? ' checked' : '') + (!admin ? ' disabled' : '') + '></td>' +
          '<td>' + (admin ? '<button class="btn" data-save-lt="' + esc(t.id) + '">Save</button>' : '') + '</td></tr>';
      }).join(''), 'No leave types configured.', 7)) + '</section>';
      if (tab === 'sla') return '<section class="card"><h2>Ticket response targets</h2><form id="sla-form" class="stack">' +
        table(['Urgency', 'First response hours', 'Resolution hours'], state.targets.map(function (t) {
          return '<tr><td>' + esc(t.urgency) + '<input type="hidden" name="urgency" value="' + esc(t.urgency) + '"></td>' +
            '<td><input type="number" min="1" name="firstResponseHours" value="' + esc(t.firstResponseHours) + '"' + (!admin ? ' disabled' : '') + '></td>' +
            '<td><input type="number" min="1" name="resolutionHours" value="' + esc(t.resolutionHours) + '"' + (!admin ? ' disabled' : '') + '></td></tr>';
        }).join('')) + (admin ? '<button class="btn primary" type="submit">Save SLA targets</button>' : '') + '</form></section>';
      if (tab === 'announcements') return '<section class="card"><h2>Announcements</h2>' + (admin ? '<form id="announcement-form" class="stack"><div class="form-grid">' +
        field('Title', 'title', { required: true, maxlength: 120 }) + select('Audience', 'audienceDepartmentId', [''].concat(state.departments.map(function (d) { return d.id; })), '',
          state.departments.reduce(function (o, d) { o[d.id] = d.name; return o; }, { '': 'Everyone' })) +
        field('Expires on', 'expiresOn', { type: 'date' }) + '<label><span>Publish now</span><select name="status"><option value="published">Yes</option><option value="draft">No, keep as draft</option></select></label>' +
        '</div><label>Message<textarea name="body" required></textarea></label><label><span>Pin announcement</span><select name="pinned"><option value="false">No</option><option value="true">Yes</option></select></label><button class="btn primary" type="submit">Save announcement</button></form>' : '') +
        (state.announcements || []).map(function (a) {
          return '<article class="card"><h3>' + esc(a.title) + '</h3><p>' + esc(a.body) + '</p><p class="muted">' + esc(a.status) +
            (a.pinned ? ' · pinned' : '') + ' · ' + esc(a.audience || 'Everyone') + '</p></article>';
        }).join('') + '</section>';
      return '<section class="card"><h2>Audit log</h2><form id="audit-search" class="form-grid">' + field('Search', 'q') +
        field('Category', 'category') + '<button class="btn" type="submit">Search</button></form><div id="audit-rows">Loading…</div></section>';
    }
    function bindTab(admin) {
      if (activeTab === 'company' && admin) {
        $('#company-form').addEventListener('submit', async function (event) {
          event.preventDefault();
          var v = Object.fromEntries(new FormData(this)); v.leaveYearStart = Number(v.leaveYearStart); v.staffingWarnAt = Number(v.staffingWarnAt); v.slaBusinessHours = v.slaBusinessHours === 'true';
          try { await api.patch('/api/company', v); toast('Company settings saved.'); reload(); }
          catch (error) { toast(problem(error), true); }
        });
        $('#company-icon').addEventListener('change', async function () {
          if (!this.files || !this.files[0]) return;
          try {
            var logo = await readImage(this.files[0], 1024 * 1024);
            await api.patch('/api/company', { logo: logo });
            toast('Company icon saved.');
            await reload();
          } catch (error) { toast(problem(error), true); }
        });
        var removeIcon = $('#remove-company-icon');
        if (removeIcon) removeIcon.addEventListener('click', async function () {
          try { await api.patch('/api/company', { logo: null }); toast('Company icon removed.'); await reload(); }
          catch (error) { toast(problem(error), true); }
        });
      }
      if (activeTab === 'people' && admin) {
        var editForm = $('#edit-employee-form');
        if (editForm) {
          editForm.addEventListener('submit', async function (event) {
            event.preventDefault();
            var values = Object.fromEntries(new FormData(this));
            if (!values.startDate) values.startDate = null;
            try {
              await api.patch('/api/employees/' + editingEmployee.id, values);
              editingEmployee = null;
              toast('Employee updated.');
              await reload();
            } catch (error) { toast(problem(error), true); }
          });
          $('#cancel-employee-edit').addEventListener('click', function () { editingEmployee = null; render(); });
        }
        content.querySelectorAll('[data-edit-employee]').forEach(function (b) {
          b.onclick = function () {
            editingEmployee = state.employees.find(function (e) { return e.id === b.dataset.editEmployee; });
            render();
            var form = $('#edit-employee-form');
            if (form) form.scrollIntoView({ behavior: 'smooth', block: 'start' });
          };
        });
        var employeeForm = $('#add-employee-form');
        var employeeEmail = employeeForm.elements.email;
        var employeeUsername = employeeForm.elements.username;
        employeeEmail.addEventListener('input', function () {
          if (!employeeUsername.dataset.edited) employeeUsername.value = this.value.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 32);
        });
        employeeUsername.addEventListener('input', function () { this.dataset.edited = 'true'; });
        $('#toggle-employee-password').addEventListener('click', function () {
          var password = $('#employee-initial-password');
          var visible = password.type === 'password';
          password.type = visible ? 'text' : 'password';
          this.textContent = visible ? 'Hide password' : 'Show password';
          this.setAttribute('aria-pressed', visible ? 'true' : 'false');
        });
        employeeForm.addEventListener('submit', async function (event) {
          event.preventDefault();
          var v = Object.fromEntries(new FormData(this)); if (!v.startDate) delete v.startDate;
          try {
            var result = await api.post('/api/employees', v);
            var message = '<p>Added <b>' + esc(result.name) + '</b> as <b>' + esc(result.username) + '</b> (' + esc(result.email) + '). The account is ready to sign in.</p>';
            toast('Employee added.'); this.reset(); await reload();
            var resultBox = $('#employee-result');
            if (resultBox) resultBox.innerHTML = message;
          } catch (error) { toast(problem(error), true); }
        });
        content.querySelectorAll('[data-employee]').forEach(function (b) {
          b.onclick = async function () {
            var id = b.dataset.employee, action = b.dataset.state === 'deactivated' ? 'reactivate' : 'deactivate';
            if (!confirm((action === 'deactivate' ? 'Deactivate' : 'Reactivate') + ' this employee?')) return;
            try { await api.post('/api/employees/' + id + '/' + action); toast('Employee status updated.'); reload(); }
            catch (error) { toast(problem(error), true); }
          };
        });
        content.querySelectorAll('[data-delete-employee]').forEach(function (b) {
          b.onclick = async function () {
            var employee = state.employees.find(function (e) { return e.id === b.dataset.deleteEmployee; });
            if (!employee || !confirm('Permanently delete ' + employee.name + '? This also deletes their attendance, leave, sessions, preferences and chat records, including groups they created and messages they sent. This cannot be undone. Employees who submitted tickets cannot be deleted; deactivate them instead.')) return;
            try {
              await api.del('/api/employees/' + employee.id);
              if (editingEmployee && editingEmployee.id === employee.id) editingEmployee = null;
              toast('Employee deleted.');
              await reload();
            } catch (error) { toast(problem(error), true); }
          };
        });
      }
      if (activeTab === 'departments' && admin) $('#department-form').addEventListener('submit', async function (event) {
        event.preventDefault(); var v = Object.fromEntries(new FormData(this)); v.handlesTickets = v.handlesTickets === 'true';
        try { await api.post('/api/departments', v); toast('Department added.'); reload(); }
        catch (error) { toast(problem(error), true); }
      });
      if (activeTab === 'leave' && admin) content.querySelectorAll('[data-save-lt]').forEach(function (b) {
        b.onclick = async function () {
          var id = b.dataset.saveLt, payload = {};
          content.querySelectorAll('[data-lt="' + id + '"]').forEach(function (input) {
            payload[input.dataset.key] = input.type === 'checkbox' ? input.checked : Number(input.value);
          });
          try { await api.patch('/api/leave-types/' + id, payload); toast('Leave policy saved.'); reload(); }
          catch (error) { toast(problem(error), true); }
        };
      });
      if (activeTab === 'sla' && admin) $('#sla-form').addEventListener('submit', async function (event) {
        event.preventDefault();
        var forms = Array.from(this.querySelectorAll('tbody tr')).map(function (tr) {
          return { urgency: tr.querySelector('[name=urgency]').value, firstResponseHours: Number(tr.querySelector('[name=firstResponseHours]').value), resolutionHours: Number(tr.querySelector('[name=resolutionHours]').value) };
        });
        try { await api.put('/api/sla-targets', { targets: forms }); toast('SLA targets saved.'); reload(); }
        catch (error) { toast(problem(error), true); }
      });
      if (activeTab === 'announcements' && admin) $('#announcement-form').addEventListener('submit', async function (event) {
        event.preventDefault();
        var v = Object.fromEntries(new FormData(this));
        v.audienceDepartmentId = v.audienceDepartmentId || null; v.expiresOn = v.expiresOn || null;
        v.pinned = v.pinned === 'true';
        try { await api.post('/api/announcements', v); toast('Announcement saved.'); reload(); }
        catch (error) { toast(problem(error), true); }
      });
      if (activeTab === 'audit') $('#audit-search').addEventListener('submit', function (event) { event.preventDefault(); loadAudit(Object.fromEntries(new FormData(this))); });
    }
    function loadAudit(filters) {
      var params = new URLSearchParams(filters || {});
      api.get('/api/audit' + (params.toString() ? '?' + params.toString() : '')).then(function (items) {
        $('#audit-rows').innerHTML = table(['When', 'Actor', 'Category', 'Action', 'Details'], rowsOrEmpty(items.map(function (r) {
          return '<tr><td>' + esc(date(r.createdAt)) + '</td><td>' + esc(r.actorName) + '</td><td>' + esc(r.category) +
            '</td><td>' + esc(r.action) + '</td><td>' + esc(r.details) + '</td></tr>';
        }).join(''), 'No activity matches.', 5));
      }).catch(function (error) { toast(problem(error), true); });
    }
    return reload();
  }

  function loadProfile() {
    var content = $('#content'), profile, sessions, balances;
    return Promise.all([api.get('/api/me/profile'), api.get('/api/me/sessions'), api.get('/api/leave/balances')]).then(function (data) {
      profile = data[0]; sessions = data[1]; balances = data[2];
      var prefs = profile.preferences || {};
      content.innerHTML = '<div class="grid"><section class="card"><h2>Personal details</h2><form id="profile-form" class="stack">' +
        '<div class="avatar-editor"><span class="av" id="profile-avatar">?</span><div><b>Profile photo</b><label>Choose or edit a photo<input id="profile-avatar-file" type="file" accept="image/png,image/jpeg,image/gif,image/webp"></label>' +
        '<button class="btn" id="edit-profile-avatar" type="button"' + (profile.avatar ? '' : ' hidden') + '>Adjust current photo</button>' +
        '<button class="btn danger" id="remove-profile-avatar" type="button"' + (profile.avatar ? '' : ' hidden') + '>Remove photo</button></div></div>' +
        '<div class="form-grid">' +         field('Name', 'name', { value: profile.name || context.user.name, readonly: true }) +
        field('Work email', 'email', { type: 'email', value: profile.email || context.user.email, readonly: true }) +
        field('Job title', 'jobTitle', { value: profile.jobTitle || '', readonly: true }) +
        field('Department', 'department', { value: profile.department || '', readonly: true }) +
        field('Phone', 'phone', { value: profile.phone || '' }) + '</div>' +
        '<p class="muted">Name, email, title, and department are managed by your company admin.</p>' +
        '<button class="btn primary" type="submit">Save phone number</button></form></section>' +
        '<section class="card"><h2>Work preferences</h2><form id="prefs-form" class="stack">' +
        '<div class="form-grid">' + select('Work mode', 'workMode', ['Office', 'Remote', 'On site'], prefs.workMode || 'Office') +
        select('Default status', 'defaultStatus', ['Online', 'Away'], prefs.defaultStatus || 'Online') +
        select('Ticket notifications', 'ticketNotifications', ['assigned', 'all'], (prefs.prefs || {}).ticketNotifications || 'assigned',
          { assigned: 'Tickets assigned to me', all: 'All company tickets' }) +
        '</div><label>Status message<input name="statusMessage" maxlength="60" value="' + esc(prefs.statusMessage || '') + '"></label>' +
        '<p class="muted">Choose whether the notification bell shows only tickets assigned to you or every ticket created in your company.</p>' +
        '<button class="btn primary" type="submit">Save preferences</button></form></section></div>' +
        '<section class="card"><h2>Change password</h2><form id="password-form" class="form-grid">' +
        field('Current password', 'current', { type: 'password', required: true }) + field('New password', 'next', { type: 'password', required: true, minlength: 8 }) +
        '<div class="actions"><button class="btn primary" type="submit">Update password</button></div></form></section>' +
        '<section class="card"><h2>Active sessions</h2>' + table(['Device', 'IP address', 'Last active', ''], rowsOrEmpty(sessions.map(function (s) {
          return '<tr><td>' + esc(s.userAgent || 'Unknown device') + (s.current ? ' <span class="pill">This device</span>' : '') + '</td><td>' + esc(s.ip || '—') +
            '</td><td>' + esc(date(s.lastSeenAt)) + '</td><td><button class="btn danger" data-session="' + esc(s.id) + '">Sign out</button></td></tr>';
        }).join(''), 'No active sessions.', 4)) + '</section>' +
        '<section class="card"><h2>Leave balance</h2>' + table(['Leave type', 'Allowance', 'Used', 'Pending', 'Remaining'], balances.types.map(function (b) {
          return '<tr><td>' + esc(b.name) + '</td><td>' + esc(b.allowance) + '</td><td>' + esc(b.used) + '</td><td>' + esc(b.pending) + '</td><td>' +
            (b.remaining === null ? 'Unlimited' : esc(b.remaining)) + '</td></tr>';
        }).join('')) + '</section>' +
        '<div class="photo-editor-backdrop" id="photo-editor" hidden><section class="photo-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="photo-editor-title">' +
        '<h2 id="photo-editor-title">Adjust profile photo</h2><p>Drag to position the photo. Start with the full photo, or zoom in to crop.</p>' +
        '<canvas class="photo-editor-canvas" id="photo-editor-canvas" width="512" height="512" aria-label="Profile photo crop preview"></canvas>' +
        '<div class="photo-editor-zoom"><label for="photo-editor-zoom">Zoom</label><input id="photo-editor-zoom" type="range" min="1" max="3" step="0.01" value="1"><output id="photo-editor-zoom-value" for="photo-editor-zoom">1×</output></div>' +
        '<div class="photo-editor-actions"><button class="btn" id="photo-editor-fit" type="button">Show full photo</button><div><button class="btn" id="photo-editor-cancel" type="button">Cancel</button><button class="btn primary" id="photo-editor-save" type="button">Save photo</button></div></div></section></div>';
      $('#profile-form').addEventListener('submit', async function (event) {
        event.preventDefault(); var phone = new FormData(this).get('phone');
        try { await api.patch('/api/me/profile', { phone: phone || '' }); toast('Phone number saved.'); }
        catch (error) { toast(problem(error), true); }
      });
      setAvatar($('#profile-avatar'), profile.avatar, profile.name || context.user.name);
      var photoEditor = $('#photo-editor'), photoCanvas = $('#photo-editor-canvas');
      var photoContext = photoCanvas.getContext('2d'), photoImage = null, photoZoom = 1, photoX = 0, photoY = 0, dragPoint = null;
      var photoZoomControl = $('#photo-editor-zoom'), photoZoomValue = $('#photo-editor-zoom-value');
      function drawPhotoPreview() {
        var size = photoCanvas.width, scale = Math.min(size / photoImage.naturalWidth, size / photoImage.naturalHeight) * photoZoom;
        var width = photoImage.naturalWidth * scale, height = photoImage.naturalHeight * scale;
        photoX = Math.max(-Math.max(0, (width - size) / 2), Math.min(Math.max(0, (width - size) / 2), photoX));
        photoY = Math.max(-Math.max(0, (height - size) / 2), Math.min(Math.max(0, (height - size) / 2), photoY));
        photoContext.clearRect(0, 0, size, size);
        photoContext.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--card2').trim() || '#f3f6fd';
        photoContext.fillRect(0, 0, size, size);
        photoContext.drawImage(photoImage, (size - width) / 2 + photoX, (size - height) / 2 + photoY, width, height);
      }
      function resetPhotoFraming() {
        photoZoom = 1; photoX = 0; photoY = 0;
        photoZoomControl.value = '1'; photoZoomValue.value = '1×';
        drawPhotoPreview();
      }
      function openPhotoEditor(source) {
        return new Promise(function (resolve, reject) {
          var image = new Image();
          image.onload = function () {
            if (!photoContext) { reject(new Error('Photo editing is not supported by this browser.')); return; }
            photoImage = image;
            resetPhotoFraming();
            photoEditor.hidden = false;
            $('#photo-editor-save').focus();
            resolve();
          };
          image.onerror = function () { reject(new Error('The selected photo could not be opened.')); };
          image.src = source;
        });
      }
      function closePhotoEditor() {
        photoEditor.hidden = true;
        $('#profile-avatar-file').focus();
      }
      $('#edit-profile-avatar').addEventListener('click', async function () {
        try { await openPhotoEditor(profile.avatar); }
        catch (error) { toast(problem(error), true); }
      });
      $('#profile-avatar-file').addEventListener('change', async function () {
        if (!this.files || !this.files[0]) return;
        var file = this.files[0];
        this.value = '';
        try {
          await openPhotoEditor(await readImage(file, 2 * 1024 * 1024));
        } catch (error) { toast(problem(error), true); }
      });
      photoZoomControl.addEventListener('input', function () {
        photoZoom = Number(this.value);
        photoZoomValue.value = photoZoom.toFixed(1).replace(/\.0$/, '') + '×';
        drawPhotoPreview();
      });
      $('#photo-editor-fit').addEventListener('click', resetPhotoFraming);
      photoCanvas.addEventListener('pointerdown', function (event) {
        dragPoint = { x: event.clientX, y: event.clientY };
        photoCanvas.setPointerCapture(event.pointerId);
      });
      photoCanvas.addEventListener('pointermove', function (event) {
        if (!dragPoint) return;
        var rect = photoCanvas.getBoundingClientRect(), factor = photoCanvas.width / rect.width;
        photoX += (event.clientX - dragPoint.x) * factor;
        photoY += (event.clientY - dragPoint.y) * factor;
        dragPoint = { x: event.clientX, y: event.clientY };
        drawPhotoPreview();
      });
      photoCanvas.addEventListener('pointerup', function () { dragPoint = null; });
      photoCanvas.addEventListener('pointercancel', function () { dragPoint = null; });
      $('#photo-editor-cancel').addEventListener('click', closePhotoEditor);
      photoEditor.addEventListener('click', function (event) {
        if (event.target === photoEditor) closePhotoEditor();
      });
      document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && !photoEditor.hidden) closePhotoEditor();
      });
      $('#photo-editor-save').addEventListener('click', async function () {
        var saveButton = this;
        saveButton.disabled = true;
        try {
          var avatar = photoCanvas.toDataURL('image/jpeg', 0.9);
          await api.patch('/api/me/profile', { avatar: avatar });
          profile.avatar = avatar;
          setAvatar($('#profile-avatar'), avatar, profile.name || context.user.name);
          setAvatar($('.me .av'), avatar, context.user.name);
          $('#edit-profile-avatar').hidden = false;
          $('#remove-profile-avatar').hidden = false;
          closePhotoEditor();
          toast('Profile photo saved.');
        } catch (error) { toast(problem(error), true); }
        finally { saveButton.disabled = false; }
      });
      var removeAvatar = $('#remove-profile-avatar');
      if (removeAvatar) removeAvatar.addEventListener('click', async function () {
        try {
          await api.patch('/api/me/profile', { avatar: null });
          profile.avatar = null;
          setAvatar($('#profile-avatar'), null, profile.name || context.user.name);
          setAvatar($('.me .av'), null, context.user.name);
          $('#edit-profile-avatar').hidden = true;
          this.hidden = true;
          toast('Profile photo removed.');
          this.remove();
        } catch (error) { toast(problem(error), true); }
      });
      $('#prefs-form').addEventListener('submit', async function (event) {
        event.preventDefault();
        var v = Object.fromEntries(new FormData(this));
        v.prefs = Object.assign({}, prefs.prefs || {}, { ticketNotifications: v.ticketNotifications });
        delete v.ticketNotifications;
        try { await api.put('/api/me/preferences', v); toast('Preferences saved.'); }
        catch (error) { toast(problem(error), true); }
      });
      $('#password-form').addEventListener('submit', async function (event) {
        event.preventDefault(); var b = this.querySelector('[type=submit]'); b.disabled = true;
        try { await api.post('/api/me/password', Object.fromEntries(new FormData(this))); toast('Password updated. Other sessions were signed out.'); this.reset(); }
        catch (error) { toast(problem(error), true); }
        finally { b.disabled = false; }
      });
      content.querySelectorAll('[data-session]').forEach(function (b) {
        b.onclick = async function () {
          if (!confirm('Sign out this session?')) return;
          try {
            var result = await api.del('/api/me/sessions/' + b.dataset.session);
            if (result.signedOut) location.replace('Login.html'); else { toast('Session signed out.'); loadProfile(); }
          } catch (error) { toast(problem(error), true); }
        };
      });
    });
  }

  async function start() {
    try {
      context = await api.get('/api/bootstrap');
      showNav();
      if (page === 'assets.html') await loadAssets();
      else if (page === 'leave.html') await loadLeave();
      else if (page === 'company.html') await loadCompany();
      else await loadProfile();
    } catch (error) {
      if (error.status === 401) return location.replace('Login.html');
      $('#content').innerHTML = '<section class="card"><h2>Could not load this page</h2><p>' + esc(problem(error)) +
        '</p><button class="btn" id="retry" type="button">Try again</button></section>';
      $('#retry').onclick = start;
    }
  }
  start();
}());
