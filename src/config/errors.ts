export type WunderlandConfigIssue = {
  path: string;
  message: string;
  hint?: string;
};

export class WunderlandConfigError extends Error {
  public readonly issues: WunderlandConfigIssue[];

  constructor(message: string, issues: WunderlandConfigIssue[]) {
    super(message);
    this.name = 'WunderlandConfigError';
    this.issues = issues;
  }
}

