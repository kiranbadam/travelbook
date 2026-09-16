import { Badge, Banner, Button, Card, Heading, TextInput } from '@astryxdesign/core';
import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../useApi';
import type { Friend, FriendFeed, FriendRequest } from '../types';
import { timeAgo } from '../components/bits';
import { FeedCard } from './FeedCard';

/**
 * Social, slice 3. Privacy defaults (per the architecture plan):
 * feeds are private until explicitly shared, and friend requests require
 * mutual acceptance — nothing here can see or share on someone's behalf.
 */
export function FriendsScreen() {
  const api = useApi();

  const [friends, setFriends] = useState<Friend[]>([]);
  const [incoming, setIncoming] = useState<FriendRequest[]>([]);
  const [email, setEmail] = useState('');
  const [userId, setUserId] = useState('');
  const [sending, setSending] = useState(false);
  const [sentNote, setSentNote] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewing, setViewing] = useState<FriendFeed | null>(null);
  const [viewingLoading, setViewingLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const [f, r] = await Promise.all([api.listFriends(), api.listIncomingRequests()]);
      setFriends(f.friends);
      setIncoming(r.requests);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function sendRequest() {
    setSending(true);
    setError(null);
    setSentNote(false);
    try {
      // Prefer email; the backend resolves it. If the backend expects a user
      // ID instead, the paste-their-user-ID field below is the fallback.
      await api.requestFriend(
        email.trim() !== '' ? { email: email.trim() } : { userId: userId.trim() },
      );
      setSentNote(true);
      setEmail('');
      setUserId('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  async function accept(requestId: string) {
    setError(null);
    try {
      await api.acceptFriend(requestId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function viewFeed(friend: Friend) {
    setViewingLoading(true);
    setError(null);
    try {
      setViewing(await api.getFriendFeed(friend.userSub));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setViewingLoading(false);
    }
  }

  return (
    <div className="tb-page">
      <Heading level={1}>Friends</Heading>
      <p className="tb-muted">
        🔒 Your feed stays private until you share it, and requests need mutual
        acceptance — both sides must agree before anything is visible.
      </p>

      {error && (
        <div className="tb-section">
          <Banner status="error" title="Something went wrong" description={error} isDismissable onDismiss={() => setError(null)} />
        </div>
      )}

      <div className="tb-grid-2">
        <div className="tb-section">
          <Card>
            <Heading level={2}>Send a friend request</Heading>
            <div className="tb-section">
              <TextInput
                label="Their email"
                type="email"
                value={email}
                onChange={setEmail}
                placeholder="friend@example.com"
                description="Preferred — the backend resolves the account."
              />
            </div>
            <div className="tb-section">
              <TextInput
                label="Or paste their user ID"
                value={userId}
                onChange={setUserId}
                placeholder="Cognito user sub"
                description="Fallback, in case the backend expects a user ID instead of an email."
              />
            </div>
            <div className="tb-row">
              <Button
                label="Send request"
                variant="primary"
                isLoading={sending}
                isDisabled={email.trim() === '' && userId.trim() === ''}
                clickAction={sendRequest}
              />
              {sentNote && <Badge variant="success" label="Request sent" />}
            </div>
          </Card>

          <div className="tb-section" style={{ marginTop: 16 }}>
            <Card>
              <Heading level={2}>Incoming requests</Heading>
              {loading ? (
                <p className="tb-muted">Loading…</p>
              ) : incoming.length === 0 ? (
                <p className="tb-muted">No pending requests.</p>
              ) : (
                incoming.map((r) => (
                  <div key={r.requestId} className="tb-spread" style={{ marginBottom: 8 }}>
                    <span>
                      <strong>{r.fromEmail ?? r.fromSub.slice(0, 8)}</strong>
                      <span className="tb-muted" style={{ fontSize: 13 }}>
                        {' '}
                        · {timeAgo(r.createdAt)}
                      </span>
                    </span>
                    <Button label="Accept" variant="primary" size="sm" clickAction={() => accept(r.requestId)} />
                  </div>
                ))
              )}
            </Card>
          </div>
        </div>

        <div className="tb-section">
          <Card>
            <Heading level={2}>Your friends</Heading>
            {loading ? (
              <p className="tb-muted">Loading…</p>
            ) : friends.length === 0 ? (
              <p className="tb-muted">No friends yet — send a request to get started.</p>
            ) : (
              friends.map((f) => (
                <div key={f.userSub} className="tb-spread" style={{ marginBottom: 8 }}>
                  <span>
                    <strong>{f.displayName ?? f.email ?? f.userSub.slice(0, 8)}</strong>
                    <span className="tb-muted" style={{ fontSize: 13 }}>
                      {' '}
                      · friends since {new Date(f.friendsSince).toLocaleDateString()}
                    </span>
                  </span>
                  <Button
                    label="View shared feed"
                    variant="secondary"
                    size="sm"
                    isLoading={viewingLoading}
                    clickAction={() => viewFeed(f)}
                  />
                </div>
              ))
            )}
          </Card>
        </div>
      </div>

      {viewing && (
        <div className="tb-section">
          <Card>
            <div className="tb-spread">
              <Heading level={2}>
                {viewing.friend.displayName ?? viewing.friend.email ?? 'Friend'}&apos;s shared feed
              </Heading>
              <Button label="Close" variant="ghost" clickAction={() => setViewing(null)} />
            </div>
            <p className="tb-muted" style={{ fontSize: 13 }}>
              Shared {timeAgo(viewing.sharedAt)} · read-only — reactions are disabled on
              someone else&apos;s feed.
            </p>
            {viewing.cards.length === 0 ? (
              <p className="tb-muted">They haven&apos;t shared any destinations yet.</p>
            ) : (
              <div style={{ display: 'grid', gap: 16, marginTop: 12 }}>
                {viewing.cards.map((card) => (
                  <FeedCard key={card.destinationId} card={card} onHidden={() => {}} hideReactions />
                ))}
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
