/* WorkPulse browser client. Include with <script src="/wp-api.js"></script> and call api.get / api.post / ...
   Cookies carry the login, so every call sends credentials. Errors come back as thrown objects: { status, code, message }.
   If the API runs on another port than the pages, either set up the Vite proxy (see BACKEND.md) or set window.WP_API_BASE. */
(function () {
  var BASE = window.WP_API_BASE || '';

  async function call(method, path, body) {
    var res = await fetch(BASE + path, {
      method: method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'workpulse' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    var data = null;
    try { data = await res.json(); } catch (e) { /* empty body */ }
    if (!res.ok) {
      var err = { status: res.status, code: data && data.code, message: (data && data.error) || 'Something went wrong. Try again.' };
      if (res.status === 401 && !/\/auth\//.test(path)) window.dispatchEvent(new CustomEvent('wp:signed-out'));   // pages can send people to the sign-in page
      throw err;
    }
    return data;
  }

  window.api = {
    get: function (p) { return call('GET', p); },
    post: function (p, b) { return call('POST', p, b === undefined ? {} : b); },
    put: function (p, b) { return call('PUT', p, b); },
    patch: function (p, b) { return call('PATCH', p, b); },
    del: function (p) { return call('DELETE', p); }
  };
})();
