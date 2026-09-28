import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { isConfigured, loadConfig } from '../config';
import { isPreviewMode } from '../preview-data';
import type { AppConfig } from '../types';
import {
  confirmSignUp as cognitoConfirm,
  getCurrentSession,
  signIn as cognitoSignIn,
  signOut as cognitoSignOut,
  signUp as cognitoSignUp,
} from './cognito';
import type { AuthTokens } from './cognito';

interface AuthContextValue {
  /** Runtime config from /config.json (null while loading). */
  config: AppConfig | null;
  configured: boolean;
  tokens: AuthTokens | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<{ userConfirmed: boolean }>;
  confirmSignUp: (email: string, code: string) => Promise<void>;
  signOut: () => void;
  /** Re-read the session (e.g. after a token refresh elsewhere). */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [tokens, setTokens] = useState<AuthTokens | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cfg = await loadConfig();
      if (cancelled) return;
      setConfig(cfg);
      if (isConfigured(cfg)) {
        const session = await getCurrentSession(cfg);
        if (!cancelled) setTokens(session);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const requireConfig = useCallback(() => {
    if (!config || !isConfigured(config)) {
      throw new Error('Cognito is not configured for this deployment.');
    }
    return config;
  }, [config]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const t = await cognitoSignIn(requireConfig(), email, password);
      setTokens(t);
    },
    [requireConfig],
  );

  const signUp = useCallback(
    (email: string, password: string) => cognitoSignUp(requireConfig(), email, password),
    [requireConfig],
  );

  const confirmSignUp = useCallback(
    (email: string, code: string) => cognitoConfirm(requireConfig(), email, code),
    [requireConfig],
  );

  const signOut = useCallback(() => {
    if (config) cognitoSignOut(config);
    setTokens(null);
  }, [config]);

  const refresh = useCallback(async () => {
    const cfg = requireConfig();
    setTokens(await getCurrentSession(cfg));
  }, [requireConfig]);

  const value = useMemo<AuthContextValue>(
    () => ({
      config,
      configured: config ? isConfigured(config) : false,
      tokens,
      loading,
      signIn,
      signUp,
      confirmSignUp,
      signOut,
      refresh,
    }),
    [config, tokens, loading, signIn, signUp, confirmSignUp, signOut, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>.');
  return ctx;
}

/** Route guard: unauthenticated users (once loading settles) go to /login. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { tokens, loading } = useAuth();
  const location = useLocation();
  if (loading) return null;
  // PREVIEW-ONLY: ?preview skips Cognito so design reviews need no credentials.
  if (!tokens && !isPreviewMode()) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}
