/**
 * @file JobMemoryService.ts
 * @description Manages job outcome memory using AgentOS RAG system.
 *
 * Stores completed jobs as vector embeddings for similarity search.
 * Agents query their own job history to inform bidding decisions.
 *
 * Uses AgentOS RetrievalAugmentor with:
 * - Qdrant vector store (self-hosted on Wunderland instance)
 * - OpenAI ada-002 embeddings (or local model)
 * - Per-agent memory category (GOAL_ORIENTED_MEMORY)
 */

import type { IRetrievalAugmentor, RagDocumentInput, RagRetrievalOptions } from '@framers/agentos/rag';
import type { JobOutcome } from './AgentJobState.js';

export interface JobMemoryEntry {
  jobId: string;
  agentId: string;
  title: string;
  description: string;
  category: string;
  budgetLamports: number;
  success: boolean;
  completedAt: number;
  actualHours?: number;
  rating?: number;
}

/**
 * Manages job outcome memory using AgentOS RAG.
 */
export class JobMemoryService {
  constructor(private ragAugmentor: IRetrievalAugmentor) {}

  /**
   * Store completed job outcome in vector memory.
   */
  async storeJobOutcome(entry: JobMemoryEntry): Promise<void> {
    const document: RagDocumentInput = {
      id: `job-${entry.agentId}-${entry.jobId}`,
      content: `${entry.title}\n\n${entry.description}`,
      metadata: {
        agent_id: entry.agentId,
        job_id: entry.jobId,
        category: entry.category,
        budget_lamports: entry.budgetLamports,
        success: entry.success,
        completed_at: entry.completedAt,
        actual_hours: entry.actualHours || 0,
        rating: entry.rating || 0,
      },
      source: `wunderland-jobs/${entry.jobId}`,
      timestamp: new Date(entry.completedAt).toISOString(),
    };

    await this.ragAugmentor.ingestDocuments([document], {
      targetDataSourceId: `agent-jobs-${entry.agentId}`,
      duplicateHandling: 'overwrite',
      chunkingStrategy: {
        type: 'none', // Job descriptions are already atomic
      },
    });
  }

  /**
   * Find past jobs similar to the given description.
   */
  async findSimilarJobs(
    agentId: string,
    jobDescription: string,
    options?: {
      topK?: number;
      category?: string;
      successOnly?: boolean;
    },
  ): Promise<Array<JobMemoryEntry & { similarity: number }>> {
    const retrievalOptions: RagRetrievalOptions = {
      targetDataSourceIds: [`agent-jobs-${agentId}`],
      topK: options?.topK || 5,
      metadataFilter: {
        agent_id: agentId,
        ...(options?.category && { category: options.category }),
        ...(options?.successOnly && { success: true }),
      },
    };

    const result = await this.ragAugmentor.retrieveContext(jobDescription, retrievalOptions);

    return result.retrievedChunks.map((chunk) => ({
      jobId: (chunk.metadata?.job_id as string) || '',
      agentId: (chunk.metadata?.agent_id as string) || agentId,
      title: chunk.content.split('\n\n')[0] || '',
      description: chunk.content.split('\n\n')[1] || chunk.content,
      category: (chunk.metadata?.category as string) || '',
      budgetLamports: (chunk.metadata?.budget_lamports as number) || 0,
      success: (chunk.metadata?.success as boolean) || false,
      completedAt: (chunk.metadata?.completed_at as number) || 0,
      actualHours: chunk.metadata?.actual_hours as number | undefined,
      rating: chunk.metadata?.rating as number | undefined,
      similarity: chunk.relevanceScore || 0,
    }));
  }

  /**
   * Get statistics about agent's job history in a category.
   */
  async getCategoryStats(
    agentId: string,
    category: string,
  ): Promise<{
    totalJobs: number;
    successRate: number;
    avgBudget: number;
    avgHours: number;
  }> {
    // Query all jobs in this category (using high topK to get all)
    const jobs = await this.findSimilarJobs(agentId, category, {
      topK: 100,
      category,
    });

    if (jobs.length === 0) {
      return { totalJobs: 0, successRate: 0, avgBudget: 0, avgHours: 0 };
    }

    const successCount = jobs.filter((j) => j.success).length;
    const avgBudget =
      jobs.reduce((sum, j) => sum + j.budgetLamports, 0) / jobs.length;
    const avgHours =
      jobs.reduce((sum, j) => sum + (j.actualHours || 0), 0) / jobs.length;

    return {
      totalJobs: jobs.length,
      successRate: successCount / jobs.length,
      avgBudget,
      avgHours,
    };
  }

  /**
   * Clear all job memory for an agent (useful for testing).
   */
  async clearAgentMemory(agentId: string): Promise<void> {
    // Note: RetrievalAugmentor doesn't expose delete by filter
    // Would need direct vector store access for bulk deletion
    console.warn(`[JobMemoryService] clearAgentMemory not fully implemented for ${agentId}`);
  }
}

/**
 * Helper to convert JobOutcome to JobMemoryEntry.
 */
export function jobOutcomeToMemoryEntry(
  outcome: JobOutcome,
  agentId: string,
  title: string,
): JobMemoryEntry {
  return {
    jobId: outcome.jobId,
    agentId,
    title,
    description: `Category: ${outcome.category}, Budget: ${outcome.budgetLamports} lamports`,
    category: outcome.category,
    budgetLamports: outcome.budgetLamports,
    success: outcome.success,
    completedAt: outcome.timestamp,
    actualHours: outcome.completionTimeMs / (1000 * 60 * 60), // Convert ms to hours
  };
}
