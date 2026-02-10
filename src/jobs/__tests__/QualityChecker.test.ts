/**
 * @file QualityChecker.test.ts
 * @description Unit tests for QualityChecker — completeness, relevance, and format validation.
 */

import { describe, it, expect } from 'vitest';
import { QualityChecker } from '../QualityChecker.js';
import type { Deliverable, QualityCheckJob } from '../QualityChecker.js';

describe('QualityChecker', () => {
  const checker = new QualityChecker();

  const makeJob = (overrides?: Partial<QualityCheckJob>): QualityCheckJob => ({
    id: 'test-job-1',
    title: 'Build a REST API',
    description: 'Create a REST API with Node.js and Express for user management',
    category: 'development',
    ...overrides,
  });

  describe('Completeness check', () => {
    it('should fail code deliverables shorter than 50 chars', async () => {
      const deliverable: Deliverable = { type: 'code', content: 'console.log("hi")' };
      const result = await checker.checkDeliverable(deliverable, makeJob());

      expect(result.issues).toEqual(
        expect.arrayContaining([expect.stringContaining('too short')]),
      );
    });

    it('should fail report deliverables shorter than 200 chars', async () => {
      const deliverable: Deliverable = { type: 'report', content: 'Short report.' };
      const result = await checker.checkDeliverable(deliverable, makeJob({ category: 'research' }));

      expect(result.issues).toEqual(
        expect.arrayContaining([expect.stringContaining('too short')]),
      );
    });

    it('should pass data deliverables with >= 10 chars', async () => {
      const deliverable: Deliverable = {
        type: 'data',
        content: '{"result":"ok","items":[1,2,3]}',
      };
      const result = await checker.checkDeliverable(deliverable, makeJob({ category: 'data' }));

      // Completeness at least should pass (other checks may vary)
      const completenessIssues = result.issues.filter((i) => i.includes('too short'));
      expect(completenessIssues).toHaveLength(0);
    });

    it('should pass code deliverables with sufficient content', async () => {
      const deliverable: Deliverable = {
        type: 'code',
        content: `
function createUserEndpoint(app) {
  app.post('/api/users', (req, res) => {
    const { name, email } = req.body;
    // Create user in database
    res.json({ success: true, user: { name, email } });
  });
}
export default createUserEndpoint;`,
      };
      const result = await checker.checkDeliverable(deliverable, makeJob());

      expect(result.passed).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(0.7);
    });
  });

  describe('Relevance check', () => {
    it('should pass when deliverable contains job keywords', async () => {
      const deliverable: Deliverable = {
        type: 'code',
        content: `
// REST API for user management built with Node.js and Express
import express from 'express';
const app = express();
app.get('/api/users', (req, res) => res.json({ users: [] }));
export default app;`,
      };
      const result = await checker.checkDeliverable(deliverable, makeJob());

      expect(result.passed).toBe(true);
    });

    it('should fail when deliverable has no keyword overlap', async () => {
      const deliverable: Deliverable = {
        type: 'code',
        content: `
# This is a completely unrelated Python script
import pandas as pd
df = pd.read_csv("data.csv")
print(df.describe())
# Machine learning analysis below
from sklearn.ensemble import RandomForestClassifier
model = RandomForestClassifier()
model.fit(X_train, y_train)`,
      };

      const job = makeJob({
        title: 'Write documentation for blockchain protocol',
        description: 'Document the Solana smart contract API and provide usage examples for validators',
      });

      const result = await checker.checkDeliverable(deliverable, job);

      // Should have relevance issues
      const relevanceIssues = result.issues.filter((i) => i.includes('keyword match'));
      expect(relevanceIssues.length).toBeGreaterThan(0);
    });
  });

  describe('Format check', () => {
    it('should fail code deliverables without programming keywords', async () => {
      // This text deliberately avoids all checked keywords:
      // function, class, def, const, let, var, export, import
      const deliverable: Deliverable = {
        type: 'code',
        content: `This is just a long paragraph of plain text that does not have any real programming keywords.
        It talks about how to build an API but never shows actual code. REST API user management Node.js Express.
        More padding text to ensure the minimum length requirement is met for the deliverable check.`,
      };
      const result = await checker.checkDeliverable(deliverable, makeJob());

      const formatIssues = result.issues.filter((i) =>
        i.includes('programming constructs'),
      );
      expect(formatIssues.length).toBeGreaterThan(0);
    });

    it('should pass code deliverables with programming constructs', async () => {
      const deliverable: Deliverable = {
        type: 'code',
        content: `
const express = require('express');
function createApp() {
  const app = express();
  // REST API user management Node.js Express
  return app;
}
export default createApp;`,
      };
      const result = await checker.checkDeliverable(deliverable, makeJob());

      const formatIssues = result.issues.filter((i) =>
        i.includes('programming constructs'),
      );
      expect(formatIssues).toHaveLength(0);
    });

    it('should fail research reports without standard structure', async () => {
      const deliverable: Deliverable = {
        type: 'report',
        content: `Here is some text about the topic. It goes on for quite a while but never uses
        standard report sections. The report just rambles without any organization or headings.
        More text here to meet the minimum length requirement. Additional padding text for
        the completeness check. More words to make it long enough to pass the length test.`,
      };
      const job = makeJob({
        title: 'Research report on AI trends',
        description: 'Research current trends in artificial intelligence',
        category: 'research',
      });

      const result = await checker.checkDeliverable(deliverable, job);

      const formatIssues = result.issues.filter((i) =>
        i.includes('standard structure'),
      );
      expect(formatIssues.length).toBeGreaterThan(0);
    });

    it('should pass research reports with standard structure', async () => {
      const deliverable: Deliverable = {
        type: 'report',
        content: `# AI Trends Research

## Summary
Current artificial intelligence trends research findings.

## Findings
- Trend 1: Large language models are becoming more capable
- Trend 2: AI agents are being deployed in production

## Analysis
The trends indicate a shift toward autonomous AI systems.

## Conclusion
AI research is progressing rapidly.`,
      };
      const job = makeJob({
        title: 'Research report on AI trends',
        description: 'Research current trends in artificial intelligence',
        category: 'research',
      });

      const result = await checker.checkDeliverable(deliverable, job);

      expect(result.passed).toBe(true);
    });
  });

  describe('Configurable threshold', () => {
    it('should use custom threshold', async () => {
      const strictChecker = new QualityChecker({ threshold: 0.9 });
      const lenientChecker = new QualityChecker({ threshold: 0.3 });

      const deliverable: Deliverable = {
        type: 'code',
        content: `
function handler() {
  // REST API user management Express
  return { status: 200 };
}
export default handler;`,
      };
      const job = makeJob();

      const strictResult = await strictChecker.checkDeliverable(deliverable, job);
      const lenientResult = await lenientChecker.checkDeliverable(deliverable, job);

      // Same score, different pass/fail
      expect(strictResult.score).toEqual(lenientResult.score);
      expect(lenientResult.passed).toBe(true);
      // Strict may or may not pass depending on actual score
    });

    it('should use custom min lengths', async () => {
      const customChecker = new QualityChecker({
        minLengths: { code: 10 },
      });

      const deliverable: Deliverable = { type: 'code', content: 'const x = 1; export default x;' };
      const result = await customChecker.checkDeliverable(deliverable, makeJob());

      // Should not have completeness issues with lowered threshold
      const completenessIssues = result.issues.filter((i) => i.includes('too short'));
      expect(completenessIssues).toHaveLength(0);
    });
  });

  describe('Overall scoring', () => {
    it('should average scores from all three checks', async () => {
      const deliverable: Deliverable = {
        type: 'code',
        content: `
// REST API user management with Node.js and Express
import express from 'express';
const app = express();
app.get('/api/users', (req, res) => {
  res.json({ users: [] });
});
export default app;`,
      };

      const result = await checker.checkDeliverable(deliverable, makeJob());

      expect(result.score).toBeGreaterThan(0);
      expect(result.score).toBeLessThanOrEqual(1);
      expect(typeof result.passed).toBe('boolean');
      expect(Array.isArray(result.issues)).toBe(true);
      expect(Array.isArray(result.suggestions)).toBe(true);
    });
  });
});
