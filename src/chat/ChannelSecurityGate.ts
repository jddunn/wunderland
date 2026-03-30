/**
 * @fileoverview Security gate — enforces user whitelists on incoming channel messages.
 *
 * Checks whether an incoming message sender is authorized based on the
 * configured allowedUsers list. An empty list means all users are allowed.
 *
 * @module wunderland/chat/ChannelSecurityGate
 */

/** Result of a security check. */
export interface SecurityCheckResult {
  /** Whether the user is allowed to proceed. */
  allowed: boolean;
  /** Reason for denial (only set when allowed is false). */
  reason?: string;
}

/**
 * Check whether a user is authorized to interact with the bot.
 *
 * @param userId - The sender's platform user ID.
 * @param allowedUsers - List of allowed user IDs. Empty = all allowed.
 * @returns Security check result with allowed flag and optional denial reason.
 */
export function checkSecurity(
  userId: string,
  allowedUsers: string[],
): SecurityCheckResult {
  if (allowedUsers.length === 0) return { allowed: true };
  if (allowedUsers.includes(userId)) return { allowed: true };
  return { allowed: false, reason: 'I can only help authorized users. Contact the admin.' };
}
