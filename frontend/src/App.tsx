import { Theme } from '@astryxdesign/core';
import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, RequireAuth } from './auth/AuthContext';
import { Chrome } from './components/chrome';
import type { ThemeMode } from './components/chrome';
import { travelBookTheme } from './theme';
import { AuthScreen } from './screens/Auth';
import { FeedScreen } from './screens/Feed';
import { PreferencesScreen } from './screens/Preferences';
import { FriendsScreen } from './screens/Friends';
import { TripDetailScreen, TripsScreen } from './screens/Trips';

const MODES = ['light', 'dark', 'system'] as const;
const STORAGE_KEY = 'travelbook-theme-mode';

function initialMode(): ThemeMode {
  const saved = localStorage.getItem(STORAGE_KEY);
  return (MODES as readonly string[]).includes(saved ?? '') ? (saved as ThemeMode) : 'system';
}

export default function App() {
  const [mode, setMode] = useState<ThemeMode>(initialMode);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  return (
    <Theme theme={travelBookTheme} mode={mode}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<AuthScreen />} />
          <Route
            path="/*"
            element={
              <RequireAuth>
                <Chrome mode={mode} onModeChange={setMode}>
                  <Routes>
                    <Route path="/feed" element={<FeedScreen />} />
                    <Route path="/preferences" element={<PreferencesScreen />} />
                    <Route path="/trips" element={<TripsScreen />} />
                    <Route path="/trips/:id" element={<TripDetailScreen />} />
                    <Route path="/friends" element={<FriendsScreen />} />
                    <Route path="*" element={<Navigate to="/feed" replace />} />
                  </Routes>
                </Chrome>
              </RequireAuth>
            }
          />
        </Routes>
      </AuthProvider>
    </Theme>
  );
}
