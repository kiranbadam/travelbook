import { Banner, Button, Card, Heading, TextInput } from '@astryxdesign/core';
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

type Mode = 'signin' | 'signup' | 'confirm';

function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/UserNotFoundException|Incorrect username or password/i.test(msg)) {
    return 'Incorrect email or password.';
  }
  if (/UserNotConfirmedException/i.test(msg)) {
    return 'This account is not confirmed yet — enter the code from your email.';
  }
  if (/UsernameExistsException/i.test(msg)) {
    return 'An account with this email already exists. Try signing in.';
  }
  if (/CodeMismatchException|ExpiredCodeException/i.test(msg)) {
    return 'That code is wrong or expired. Request a new one and try again.';
  }
  return msg;
}

export function AuthScreen() {
  const { signIn, signUp, confirmSignUp, configured } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/feed';

  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = (path: string) => navigate(path, { replace: true });

  async function handleSignIn() {
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      go(from);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/UserNotConfirmedException/i.test(msg)) setMode('confirm');
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleSignUp() {
    setBusy(true);
    setError(null);
    try {
      const { userConfirmed } = await signUp(email.trim(), password);
      if (userConfirmed) go(from);
      else setMode('confirm');
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm() {
    setBusy(true);
    setError(null);
    try {
      await confirmSignUp(email.trim(), code);
      setMode('signin');
      setError(null);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tb-page" style={{ maxWidth: 460 }}>
      <Heading level={1}>Welcome to TravelBook</Heading>
      <p className="tb-muted">Sign in to get destination ideas grounded in evidence.</p>

      {!configured && (
        <div className="tb-section">
          <Banner
            status="warning"
            title="Sign-in is not configured"
            description="This deployment is missing /config.json (userPoolId / userPoolClientId). The deploy workflow writes the real file; the placeholder in public/ is not valid."
          />
        </div>
      )}

      <Card>
        {error && (
          <div className="tb-section">
            <Banner status="error" title="Something went wrong" description={error} isDismissable onDismiss={() => setError(null)} />
          </div>
        )}

        {mode === 'confirm' ? (
          <>
            <div className="tb-section">
              <TextInput
                label="Email"
                type="email"
                value={email}
                onChange={setEmail}
                placeholder="you@example.com"
              />
            </div>
            <div className="tb-section">
              <TextInput
                label="Confirmation code"
                value={code}
                onChange={setCode}
                placeholder="6-digit code from your email"
              />
            </div>
            <div className="tb-row">
              <Button label="Confirm account" variant="primary" isLoading={busy} isDisabled={!configured} clickAction={handleConfirm} />
              <Button label="Back to sign in" variant="ghost" clickAction={() => setMode('signin')} />
            </div>
          </>
        ) : (
          <>
            <div className="tb-section">
              <TextInput
                label="Email"
                type="email"
                value={email}
                onChange={setEmail}
                placeholder="you@example.com"
              />
            </div>
            <div className="tb-section">
              <TextInput
                label="Password"
                type="password"
                value={password}
                onChange={setPassword}
                placeholder={mode === 'signup' ? 'At least 8 characters' : 'Your password'}
              />
            </div>
            {mode === 'signin' ? (
              <div className="tb-row">
                <Button
                  label="Sign in"
                  variant="primary"
                  isLoading={busy}
                  isDisabled={!configured || email.trim() === '' || password === ''}
                  clickAction={handleSignIn}
                />
                <Button label="Create account" variant="ghost" clickAction={() => setMode('signup')} />
                <Button label="I have a code" variant="ghost" clickAction={() => setMode('confirm')} />
              </div>
            ) : (
              <div className="tb-row">
                <Button
                  label="Create account"
                  variant="primary"
                  isLoading={busy}
                  isDisabled={!configured || email.trim() === '' || password.length < 8}
                  clickAction={handleSignUp}
                />
                <Button label="Back to sign in" variant="ghost" clickAction={() => setMode('signin')} />
              </div>
            )}
          </>
        )}
      </Card>

      <p className="tb-note">
        Private alpha. Your feed is private until you explicitly share it, and friend
        requests need mutual acceptance.
      </p>
    </div>
  );
}
