import { TopNav } from '../components/TopNav';
import LoginClient from './LoginClient';

export default function LoginPage() {
  return (
    <main className="page-shell">
      <TopNav />
      <section className="auth-card" aria-labelledby="login-title">
        <p className="eyebrow">Creator access</p>
        <h1 id="login-title">Sign in to manage your stream.</h1>
        <p className="lede">Use your Google account to open your BharatStudio dashboard. We use sign-in to identify your BharatStudio account; YouTube access is not requested for Alerts v1.</p>
        <LoginClient />
        <p className="helper-text">You will be asked to accept the Terms of Service and Privacy Notice on first sign-in.</p>
      </section>
    </main>
  );
}
