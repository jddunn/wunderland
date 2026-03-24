declare module '@framers/agentos/voice-pipeline' {
  export const VoicePipelineOrchestrator: new (config?: unknown) => any;
  export const WebSocketStreamTransport: new (socket: unknown, options?: unknown) => any;
}
