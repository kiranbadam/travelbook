import { useMemo, useRef } from 'react';
import { ApiClient } from './api';
import { useAuth } from './auth/AuthContext';

/** Memoized API client whose token provider always reads the latest session. */
export function useApi(): ApiClient {
  const { tokens } = useAuth();
  const ref = useRef(tokens);
  ref.current = tokens;
  return useMemo(() => new ApiClient(() => ref.current?.idToken ?? null), []);
}
