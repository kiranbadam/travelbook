import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const cognito = new CognitoIdentityProviderClient({ maxAttempts: 2 });
const USER_POOL_ID = process.env.USER_POOL_ID ?? "";

/**
 * Resolve a TravelBook user sub by email via Cognito ListUsers.
 * Returns null when the pool is unconfigured or no user matches.
 * Requires cognito-idp:ListUsers on the user pool (API role).
 */
export async function resolveUserSubByEmail(email: string): Promise<string | null> {
  if (!USER_POOL_ID) return null;
  const res = await cognito.send(
    new ListUsersCommand({
      UserPoolId: USER_POOL_ID,
      Filter: `email = "${email.replace(/"/g, "")}"`,
      Limit: 1,
      AttributesToGet: ["sub"],
    }),
  );
  const user = res.Users?.[0];
  const sub = user?.Attributes?.find((a) => a.Name === "sub")?.Value;
  return sub ?? null;
}
