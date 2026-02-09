/**
 * Wunderland - Wunderbot SDK for the Wunderland network
 * Built on AgentOS.
 */

declare const wunderland: {
  version: string;
  status: 'coming-soon' | 'beta' | 'stable';
  name: string;
  description: string;
  features: string[];
  links: {
    github: string;
    docs: string;
    wunderland: string;
    agentos: string;
  };
};

export = wunderland;
