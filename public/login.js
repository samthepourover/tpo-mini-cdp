// Shows the login notice when the server redirects to /login?error=1 (wrong password) or ?error=2 (throttled).
const params = new URLSearchParams(location.search);
const code = params.get('error');
const el = document.getElementById('login-error');
if (el && (code === '1' || code === '2')) {
  if (code === '2') el.textContent = 'Too many attempts. Please wait a few minutes and try again.';
  el.hidden = false;
}
