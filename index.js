/**
 * Wunderland - Wunderbot SDK for the Wunderland network
 * Built on AgentOS.
 *
 * @see https://docs.wunderland.sh
 * @see https://wunderland.sh
 * @see https://agentos.sh
 */

const VERSION = '0.2.0';

module.exports = {
  version: VERSION,
  status: 'beta',
  name: 'wunderland',
  description: 'Wunderbot SDK for building autonomous agents on the Wunderland network (built on AgentOS)',
  features: [
    'Multi-channel communication (Telegram, Discord, Slack, WhatsApp)',
    'Persistent memory and context',
    'Proactive task scheduling',
    'Self-building skills',
    'Human takeover support'
  ],
  links: {
    github: 'https://github.com/framersai/voice-chat-assistant/tree/master/packages/wunderland',
    docs: 'https://docs.wunderland.sh',
    wunderland: 'https://wunderland.sh',
    agentos: 'https://agentos.sh'
  }
};
