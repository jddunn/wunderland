/**
 * Type declarations for @framers/agentos/auth subpath export.
 * Resolved at runtime via dynamic import().
 */
declare module '@framers/agentos/auth' {
  export type AuthMethod = 'api-key' | 'oauth';

  export interface OAuthTokenSet {
    accessToken: string;
    refreshToken?: string;
    expiresAt: number;
  }

  export interface IOAuthTokenStore {
    load(providerId: string): Promise<OAuthTokenSet | null>;
    save(providerId: string, tokens: OAuthTokenSet): Promise<void>;
    clear(providerId: string): Promise<void>;
  }

  export interface IOAuthFlow {
    readonly providerId: string;
    authenticate(): Promise<OAuthTokenSet>;
    refresh(tokens: OAuthTokenSet): Promise<OAuthTokenSet>;
    isValid(tokens: OAuthTokenSet): boolean;
    getAccessToken(): Promise<string>;
  }

  export class FileTokenStore implements IOAuthTokenStore {
    constructor(baseDir?: string);
    load(providerId: string): Promise<OAuthTokenSet | null>;
    save(providerId: string, tokens: OAuthTokenSet): Promise<void>;
    clear(providerId: string): Promise<void>;
  }

  export interface OpenAIOAuthFlowOptions {
    tokenStore?: IOAuthTokenStore;
    clientId?: string;
    onUserCode?: (userCode: string, verificationUrl: string) => void;
  }

  export class OpenAIOAuthFlow implements IOAuthFlow {
    readonly providerId: string;
    constructor(opts?: OpenAIOAuthFlowOptions);
    authenticate(): Promise<OAuthTokenSet>;
    refresh(tokens: OAuthTokenSet): Promise<OAuthTokenSet>;
    isValid(tokens: OAuthTokenSet): boolean;
    getAccessToken(): Promise<string>;
  }
}
