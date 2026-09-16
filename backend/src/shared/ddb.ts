import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

/** Shared DynamoDB DocumentClient. Region comes from the Lambda environment. */
const client = new DynamoDBClient({ maxAttempts: 3 });
export const ddb = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

export const TABLE_NAME = process.env.TABLE_NAME ?? "travelbook-dev";
export const GSI1 = "GSI1";
export const GSI2 = "GSI2";

/* ------------------------------------------------------------------ */
/* Key builders (single-table design, per architecture plan)           */
/* ------------------------------------------------------------------ */

export const pkUser = (uid: string): string => `USER#${uid}`;
export const skProfile = (): string => "PROFILE";
export const skPref = (): string => "PREF#ACTIVE";
export const skFeed = (createdAt: string): string => `FEED#${createdAt}`;
export const skFeedId = (snapshotId: string): string => `FEEDID#${snapshotId}`;
export const skReaction = (targetType: string, targetId: string): string =>
  `REACTION#${targetType}#${targetId}`;
export const skIdempotency = (hash: string): string => `IDEMPOTENCY#${hash}`;
export const skFriend = (friendUid: string): string => `FRIEND#${friendUid}`;

export const pkJob = (jobId: string): string => `JOB#${jobId}`;
export const skJobMeta = (): string => "META";
export const skEvidence = (dest: string, source: string): string =>
  `EVIDENCE#${dest}#${source}`;

export const pkCache = (queryHash: string): string => `CACHE#${queryHash}`;
export const skCacheResult = (provider: string): string => `RESULT#${provider}`;

export const pkTrip = (tripId: string): string => `TRIP#${tripId}`;
export const skTripMeta = (): string => "META";
export const skTripMember = (uid: string): string => `MEMBER#${uid}`;
export const skTripPointer = (tripId: string): string => `TRIPMEMBER#${tripId}`;
export const skTripVote = (dest: string, uid: string): string => `VOTE#${dest}#${uid}`;

export const pkFriendReq = (toUid: string): string => `FRIENDREQ#${toUid}`;
export const skFriendReqFrom = (fromUid: string): string => `FROM#${fromUid}`;

/* ------------------------------------------------------------------ */
/* GSI key helpers                                                     */
/* ------------------------------------------------------------------ */

/** GSI1: user timeline + visible friend feed. */
export const gsi1pkUser = (uid: string): string => `USER#${uid}`;
export const gsi1skFeed = (createdAt: string): string => `FEED#${createdAt}`;
/** Items shared with a user carry gsi1pk=SHAREDWITH#<uid>. */
export const gsi1pkSharedWith = (uid: string): string => `SHAREDWITH#${uid}`;
export const gsi1skFriendShare = (ownerUid: string, createdAt: string): string =>
  `FRIENDSHARE#${ownerUid}#${createdAt}`;

/** GSI2: pending jobs by state + next-attempt time. */
export const gsi2pkJobState = (state: string): string => `JOBSTATE#${state}`;

/* ------------------------------------------------------------------ */
/* TTL helper (epoch seconds, as DynamoDB expects)                     */
/* ------------------------------------------------------------------ */

export function ttlEpochSeconds(ttlDays: number, fromMs: number = Date.now()): number {
  return Math.floor(fromMs / 1000) + Math.round(ttlDays * 86400);
}

/** TTL in epoch seconds from a millisecond duration. */
export function ttlFromMs(ttlMs: number, fromMs: number = Date.now()): number {
  return Math.floor(fromMs / 1000) + Math.round(ttlMs / 1000);
}

export function nowIso(fromMs: number = Date.now()): string {
  return new Date(fromMs).toISOString();
}
