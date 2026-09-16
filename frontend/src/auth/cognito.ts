import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserAttribute,
  CognitoUserPool,
} from 'amazon-cognito-identity-js';
import type { AppConfig } from '../types';

/**
 * Thin promise wrappers over amazon-cognito-identity-js (no Amplify).
 * The pool is built lazily from /config.json so an unconfigured deploy
 * never throws at import time — it fails loudly only when auth is used.
 */

export interface AuthTokens {
  idToken: string;
  email: string;
  sub: string;
}

interface IdTokenLike {
  getJwtToken(): string;
  payload: Record<string, unknown>;
}

interface SessionLike {
  getIdToken(): IdTokenLike | null;
}

function getPool(cfg: AppConfig): CognitoUserPool {
  if (!cfg.userPoolId || !cfg.userPoolClientId) {
    throw new Error(
      'Cognito is not configured: /config.json is missing userPoolId / userPoolClientId.',
    );
  }
  return new CognitoUserPool({ UserPoolId: cfg.userPoolId, ClientId: cfg.userPoolClientId });
}

function toTokens(session: SessionLike): AuthTokens {
  const idToken = session.getIdToken();
  if (!idToken) throw new Error('Session has no ID token.');
  const payload = idToken.payload;
  return {
    idToken: idToken.getJwtToken(),
    email: String(payload['email'] ?? ''),
    sub: String(payload['sub'] ?? ''),
  };
}

export function signUp(cfg: AppConfig, email: string, password: string): Promise<{ userConfirmed: boolean }> {
  const pool = getPool(cfg);
  const attrs = [new CognitoUserAttribute({ Name: 'email', Value: email })];
  return new Promise((resolve, reject) => {
    pool.signUp(email, password, attrs, [], (err, result) => {
      if (err || !result) {
        reject(err ?? new Error('Sign-up failed with no error detail.'));
        return;
      }
      resolve({ userConfirmed: result.userConfirmed });
    });
  });
}

export function confirmSignUp(cfg: AppConfig, email: string, code: string): Promise<void> {
  const pool = getPool(cfg);
  const user = new CognitoUser({ Username: email, Pool: pool });
  return new Promise((resolve, reject) => {
    user.confirmRegistration(code.trim(), true, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export function signIn(cfg: AppConfig, email: string, password: string): Promise<AuthTokens> {
  const pool = getPool(cfg);
  const user = new CognitoUser({ Username: email, Pool: pool });
  const details = new AuthenticationDetails({ Username: email, Password: password });
  return new Promise((resolve, reject) => {
    user.authenticateUser(details, {
      onSuccess: (session) => resolve(toTokens(session)),
      onFailure: (err) => reject(err instanceof Error ? err : new Error(String(err))),
      newPasswordRequired: () =>
        reject(new Error('A password reset is required. Complete it in the Cognito hosted UI, then sign in.')),
    });
  });
}

/** Returns the current session's tokens, or null when signed out / expired. */
export function getCurrentSession(cfg: AppConfig): Promise<AuthTokens | null> {
  let pool: CognitoUserPool;
  try {
    pool = getPool(cfg);
  } catch {
    return Promise.resolve(null);
  }
  const user = pool.getCurrentUser();
  if (!user) return Promise.resolve(null);
  return new Promise((resolve) => {
    user.getSession((err: unknown, session: SessionLike | null) => {
      if (err || !session || !session.getIdToken()) {
        resolve(null);
        return;
      }
      try {
        resolve(toTokens(session));
      } catch {
        resolve(null);
      }
    });
  });
}

export function signOut(cfg: AppConfig): void {
  try {
    getPool(cfg).getCurrentUser()?.signOut();
  } catch {
    // Unconfigured or already signed out — nothing to do.
  }
}
