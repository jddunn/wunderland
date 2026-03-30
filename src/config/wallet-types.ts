/**
 * @fileoverview Wallet config type for agent.config.json schema.
 *
 * The full wallet implementation lives in @framers/agentos-ext-wallet.
 * This file defines only the config shape that WunderlandAgentConfig references.
 *
 * @module wunderland/config/wallet-types
 */

export type ChainId = 'solana' | 'ethereum' | 'base' | 'polygon';
export type TokenSymbol = 'SOL' | 'ETH' | 'USDC' | 'USDT';

export type SpendCategory =
  | 'api_costs'
  | 'web_services'
  | 'shopping'
  | 'subscriptions'
  | 'transfers'
  | 'defi'
  | 'dining'
  | 'travel'
  | 'entertainment'
  | 'utilities'
  | 'other';

export interface CategoryBudget {
  category: SpendCategory;
  dailyLimitUsd: number;
  monthlyLimitUsd: number;
}

export interface SpendingPolicyConfig {
  dailyLimitUsd: number;
  perTransactionLimitUsd: number;
  monthlyLimitUsd: number;
  categoryBudgets: CategoryBudget[];
  requireApprovalAboveUsd: number;
  blockedCategories: SpendCategory[];
  allowedAddresses?: string[];
  blockedAddresses?: string[];
}

export interface CardConfig {
  enabled: boolean;
  provider: 'lithic';
  defaultSpendLimitUsd: number;
  allowPhysical: boolean;
}

export interface WalletConfig {
  enabled: boolean;
  chains: ChainId[];
  custodyMode: 'hot' | 'encrypted-hot';
  allowedTokens: TokenSymbol[];
  spendingPolicy: SpendingPolicyConfig;
  card?: CardConfig;
}
