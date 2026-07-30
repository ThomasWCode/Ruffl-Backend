function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export const accountPageCss = `
:root { color-scheme: light; font-family: system-ui, sans-serif; }
body { background: #f6f0e7; color: #1d2a24; margin: 0; padding: 24px; }
main { background: #fffdf9; border: 1px solid #ded8cd; border-radius: 20px; box-shadow: 0 12px 35px rgba(29,42,36,.1); margin: 8vh auto; max-width: 480px; padding: 28px; }
h1 { font-size: 30px; letter-spacing: -.6px; margin: 0 0 12px; }
p { line-height: 1.55; }
form { display: grid; gap: 14px; margin-top: 24px; }
label { display: grid; font-size: 14px; font-weight: 700; gap: 7px; }
input { border: 1px solid #cfc7ba; border-radius: 12px; font: inherit; min-height: 48px; padding: 0 13px; }
button { background: #385f4d; border: 0; border-radius: 12px; color: white; cursor: pointer; font: inherit; font-weight: 800; min-height: 50px; padding: 0 18px; }
button:disabled { cursor: not-allowed; opacity: .5; }
.error { color: #a43f36; font-weight: 700; }
.muted { color: #647169; font-size: 14px; }
`;

export const accountPageScript = `
(() => {
  const form = document.querySelector('[data-token-form]');
  const tokenInput = document.querySelector('input[name="token"]');
  const message = document.querySelector('[data-token-message]');
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
  if (!form || !tokenInput || !message) return;
  if (!token) {
    message.textContent = 'This link is incomplete. Request a new email from the Ruffl app.';
    message.className = 'error';
    form.querySelectorAll('input, button').forEach((control) => {
      control.disabled = true;
    });
    return;
  }
  tokenInput.value = token;
  history.replaceState(null, '', window.location.pathname);
})();
`;

export function accountPage(input: {
  title: string;
  body: string;
  form?: 'verify' | 'reset';
  error?: string;
}): string {
  const form =
    input.form === 'verify'
      ? `<form action="/auth/verify-email" data-token-form method="post">
          <input name="token" type="hidden">
          <button type="submit">Verify email</button>
        </form>`
      : input.form === 'reset'
        ? `<form action="/auth/reset-password" data-token-form method="post">
            <input name="token" type="hidden">
            <label>New password
              <input autocomplete="new-password" maxlength="128" minlength="8" name="password" required type="password">
            </label>
            <label>Confirm new password
              <input autocomplete="new-password" maxlength="128" minlength="8" name="confirmPassword" required type="password">
            </label>
            <button type="submit">Reset password</button>
          </form>`
        : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex,nofollow">
    <title>${escapeHtml(input.title)} · Ruffl</title>
    <link href="/auth/account.css" rel="stylesheet">
    ${input.form ? '<script defer src="/auth/account.js"></script>' : ''}
  </head>
  <body>
    <main>
      <p class="muted">Ruffl account security</p>
      <h1>${escapeHtml(input.title)}</h1>
      <p>${escapeHtml(input.body)}</p>
      ${input.error ? `<p class="error">${escapeHtml(input.error)}</p>` : ''}
      ${input.form ? '<p class="muted" data-token-message>This secure link will be removed from the address bar.</p>' : ''}
      ${form}
    </main>
  </body>
</html>`;
}
