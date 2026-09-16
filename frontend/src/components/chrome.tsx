import { AppShell, Button, SegmentedControl, SegmentedControlItem, TopNav } from '@astryxdesign/core';
import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

export type ThemeMode = 'light' | 'dark' | 'system';

const NAV = [
  { path: '/feed', label: 'Feed' },
  { path: '/preferences', label: 'Preferences' },
  { path: '/trips', label: 'Trips' },
  { path: '/friends', label: 'Friends' },
];

/**
 * App chrome: TopNav with brand, route tabs, dark-mode toggle, and sign-out.
 * Theme mode is lifted to App so the <Theme> provider can consume it.
 */
export function Chrome({
  children,
  mode,
  onModeChange,
}: {
  children: ReactNode;
  mode: ThemeMode;
  onModeChange: (mode: ThemeMode) => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { tokens, signOut } = useAuth();

  const active = NAV.find((n) => location.pathname.startsWith(n.path))?.path;

  return (
    <AppShell
      topNav={
        <TopNav
          heading={
            <span style={{ fontWeight: 700, fontSize: 17, cursor: 'pointer' }} onClick={() => navigate('/feed')}>
              ✈️ TravelBook
            </span>
          }
          endContent={
            <div className="tb-row">
              <SegmentedControl value={mode} onChange={(v) => onModeChange(v as ThemeMode)} label="Color mode" size="sm">
                <SegmentedControlItem value="light" label="Light" />
                <SegmentedControlItem value="dark" label="Dark" />
                <SegmentedControlItem value="system" label="Auto" />
              </SegmentedControl>
              {tokens && (
                <Button
                  label="Sign out"
                  variant="ghost"
                  size="sm"
                  clickAction={() => {
                    signOut();
                    navigate('/login');
                  }}
                />
              )}
            </div>
          }
        >
          <div className="tb-row">
            {NAV.map((n) => (
              <Button
                key={n.path}
                label={n.label}
                variant="ghost"
                size="sm"
                className={active === n.path ? 'tb-nav-active' : undefined}
                clickAction={() => navigate(n.path)}
              />
            ))}
          </div>
        </TopNav>
      }
    >
      {children}
    </AppShell>
  );
}
