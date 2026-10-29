import { h, toast } from '../ui.js';
import { post } from '../api.js';
import { refresh } from '../store.js';

export function signIn(navigate) {
  const form = (mode) => {
    const email = h('input', { type: 'email', required: true, placeholder: 'you@example.com' });
    const pass = h('input', { type: 'password', required: true, placeholder: '••••••••' });
    const name = h('input', { type: 'text', placeholder: 'Your name' });
    const otp = h('input', { type: 'text', placeholder: '6-digit code' });
    const otpWrap = h('label', { class: 'field', style: { display: 'none' } },
      h('span', {}, 'Verification code'), otp);
    let pendingUserId = null;

    const submit = async (e) => {
      e.preventDefault();
      try {
        if (pendingUserId) {
          await post('/api/v1/users/otp/check-password', { user_id: pendingUserId, code: otp.value });
        } else if (mode === 'up') {
          await post('/api/v1/users/registrations/sign_up.json',
            { email: email.value, password: pass.value, name: name.value });
        } else {
          const res = await post('/api/v1/users/sessions/sign-in', { email: email.value, password: pass.value });
          if (res.otp_required) {
            pendingUserId = res.user_id;
            otpWrap.style.display = 'block';
            toast('We emailed you a code — check Settings → Email log');
            return;
          }
        }
        await refresh();
        navigate('#/documents');
      } catch { /* toast already shown */ }
    };

    return h('form', { class: 'card pad', onsubmit: submit },
      h('h1', { style: { margin: '0 0 4px', fontSize: '20px' } },
        mode === 'up' ? 'Create your DocHub account' : 'Sign in to DocHub'),
      h('p', { class: 'sub', style: { marginBottom: '18px' } },
        mode === 'up' ? 'Free plan: 3 documents, 5 signatures a month.' : 'Welcome back.'),
      mode === 'up' ? h('label', { class: 'field' }, h('span', {}, 'Name'), name) : null,
      h('label', { class: 'field' }, h('span', {}, 'Email'), email),
      h('label', { class: 'field' }, h('span', {}, 'Password',
        mode === 'up' ? h('span', { class: 'hint' }, ' — at least 8 characters') : null), pass),
      otpWrap,
      h('button', { class: 'btn primary', style: { width: '100%', justifyContent: 'center' }, type: 'submit' },
        mode === 'up' ? 'Create account' : 'Sign in'),
      h('p', { class: 'sub', style: { marginTop: '14px', textAlign: 'center' } },
        mode === 'up' ? 'Already have an account? ' : 'New here? ',
        h('a', { href: mode === 'up' ? '#/login' : '#/signup' }, mode === 'up' ? 'Sign in' : 'Create one')),
      mode === 'in' ? h('p', { class: 'sub', style: { textAlign: 'center' } },
        h('a', { href: '#', onclick: async (e) => {
          e.preventDefault();
          if (!email.value) return toast('Enter your email first', 'bad');
          await post('/api/v1/users/send-reset-password-instructions', { email: email.value });
          toast('If that account exists, a reset code was sent');
        } }, 'Forgot your password?')) : null);
  };

  const mode = location.hash.includes('signup') ? 'up' : 'in';
  return h('div', { class: 'auth-wrap' }, form(mode));
}
