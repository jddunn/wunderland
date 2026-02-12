/**
 * @file QualityChecker.ts
 * @description Validates deliverable quality before submission.
 *
 * Checks:
 * - Completeness (minimum content length by type)
 * - Relevance (keyword matching against job description)
 * - Format (category-specific structure validation)
 *
 * All checks are deterministic (no LLM calls). Configurable pass threshold.
 */

export interface Deliverable {
  type: 'code' | 'report' | 'data' | 'url' | 'ipfs';
  content: string;
  mimeType?: string;
}

export interface QualityCheckResult {
  passed: boolean;
  score: number; // 0-1
  issues: string[];
  suggestions: string[];
}

export interface QualityCheckJob {
  id: string;
  title: string;
  description: string;
  category: string;
}

export interface QualityCheckerConfig {
  /**
   * Minimum overall score to pass (default: 0.7)
   */
  threshold?: number;

  /**
   * Minimum keyword overlap ratio for relevance check (default: 0.3)
   */
  minRelevanceRatio?: number;

  /**
   * Override minimum content lengths per deliverable type
   */
  minLengths?: Partial<Record<Deliverable['type'], number>>;
}

/**
 * Minimum content lengths by deliverable type.
 */
const DEFAULT_MIN_LENGTHS: Record<Deliverable['type'], number> = {
  code: 50,
  report: 200,
  data: 10,
  url: 10,
  ipfs: 10,
};

/**
 * Common stop words to exclude from keyword extraction.
 */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'can', 'may', 'might', 'must', 'i', 'you', 'he',
  'she', 'it', 'we', 'they', 'this', 'that', 'these', 'those',
]);

/**
 * Validates deliverable quality before Solana submission.
 */
export class QualityChecker {
  private readonly threshold: number;
  private readonly minRelevanceRatio: number;
  private readonly minLengths: Record<Deliverable['type'], number>;

  constructor(config?: QualityCheckerConfig) {
    this.threshold = config?.threshold ?? 0.7;
    this.minRelevanceRatio = config?.minRelevanceRatio ?? 0.3;
    this.minLengths = {
      ...DEFAULT_MIN_LENGTHS,
      ...config?.minLengths,
    };
  }

  /**
   * Check deliverable quality across multiple dimensions.
   */
  async checkDeliverable(
    deliverable: Deliverable,
    job: QualityCheckJob,
  ): Promise<QualityCheckResult> {
    const checks = [
      this.checkCompleteness(deliverable, job),
      this.checkRelevance(deliverable, job),
      this.checkFormat(deliverable, job),
    ];

    const results = await Promise.all(checks);
    const avgScore = results.reduce((sum, r) => sum + r.score, 0) / results.length;

    return {
      passed: avgScore >= this.threshold,
      score: avgScore,
      issues: results.flatMap((r) => r.issues),
      suggestions: results.flatMap((r) => r.suggestions),
    };
  }

  /**
   * Check if deliverable has sufficient content.
   */
  private async checkCompleteness(
    deliverable: Deliverable,
    _job: QualityCheckJob,
  ): Promise<QualityCheckResult> {
    const minLength = this.minLengths[deliverable.type] ?? 100;
    const hasContent = deliverable.content.length >= minLength;

    if (!hasContent) {
      return {
        passed: false,
        score: 0.3,
        issues: [
          `Deliverable is too short (${deliverable.content.length} chars, minimum: ${minLength})`,
        ],
        suggestions: [
          'Provide more detailed output',
          'Include complete implementation/analysis',
        ],
      };
    }

    return {
      passed: true,
      score: 1.0,
      issues: [],
      suggestions: [],
    };
  }

  /**
   * Check if deliverable addresses job requirements using keyword matching.
   */
  private async checkRelevance(
    deliverable: Deliverable,
    job: QualityCheckJob,
  ): Promise<QualityCheckResult> {
    const jobKeywords = this.extractKeywords(job.description + ' ' + job.title);
    const deliverableText = deliverable.content.toLowerCase();

    const matchedKeywords = jobKeywords.filter((keyword) =>
      deliverableText.includes(keyword.toLowerCase()),
    );

    const relevanceScore =
      jobKeywords.length > 0
        ? matchedKeywords.length / jobKeywords.length
        : 0.5;

    const passed = relevanceScore >= this.minRelevanceRatio;

    if (!passed) {
      return {
        passed: false,
        score: relevanceScore,
        issues: [
          `Deliverable may not address job requirements (${Math.round(relevanceScore * 100)}% keyword match)`,
        ],
        suggestions: [
          `Expected to see references to: ${jobKeywords.slice(0, 5).join(', ')}`,
          'Ensure deliverable directly addresses the job description',
        ],
      };
    }

    return {
      passed: true,
      score: Math.min(relevanceScore + 0.3, 1.0),
      issues: [],
      suggestions: [],
    };
  }

  /**
   * Check deliverable format (category-specific).
   */
  private async checkFormat(
    deliverable: Deliverable,
    job: QualityCheckJob,
  ): Promise<QualityCheckResult> {
    if (job.category === 'development' && deliverable.type === 'code') {
      const hasCodeStructure =
        deliverable.content.includes('function') ||
        deliverable.content.includes('class') ||
        deliverable.content.includes('def') ||
        deliverable.content.includes('const') ||
        deliverable.content.includes('let') ||
        deliverable.content.includes('var') ||
        deliverable.content.includes('export') ||
        deliverable.content.includes('import');

      if (!hasCodeStructure) {
        return {
          passed: false,
          score: 0.5,
          issues: ['Code deliverable lacks recognizable programming constructs'],
          suggestions: ['Ensure deliverable contains actual code (functions, classes, etc.)'],
        };
      }
    }

    if (job.category === 'research' && deliverable.type === 'report') {
      const lowerContent = deliverable.content.toLowerCase();
      const hasReportStructure =
        lowerContent.includes('summary') ||
        lowerContent.includes('introduction') ||
        lowerContent.includes('conclusion') ||
        lowerContent.includes('findings') ||
        lowerContent.includes('analysis');

      if (!hasReportStructure) {
        return {
          passed: false,
          score: 0.6,
          issues: ['Report lacks standard structure (summary, findings, conclusion)'],
          suggestions: ['Include standard report sections'],
        };
      }
    }

    return {
      passed: true,
      score: 1.0,
      issues: [],
      suggestions: [],
    };
  }

  /**
   * Extract important keywords from text (simple stop-word filtering).
   */
  private extractKeywords(text: string): string[] {
    const words = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 3 && !STOP_WORDS.has(word));

    return [...new Set(words)];
  }
}
