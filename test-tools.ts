#!/usr/bin/env npx tsx
/**
 * Integration test for Wunderland agent tools.
 * Runs each tool with live API keys from backend/.env and reports results.
 *
 * Usage: cd packages/wunderland && npx tsx test-tools.ts
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load env vars from backend/.env
const envPath = resolve(__dirname, '../../backend/.env');
try {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx);
    const val = trimmed.slice(eqIdx + 1);
    if (!process.env[key]) process.env[key] = val;
  }
  console.log('✓ Loaded env from backend/.env\n');
} catch {
  console.log('⚠ Could not load backend/.env — using existing env vars\n');
}

// Import tools via ToolRegistry
import { createWunderlandTools, getToolAvailability } from './src/tools/ToolRegistry.js';
import { SerperSearchTool } from './src/tools/SerperSearchTool.js';
import { GiphySearchTool } from '@framers/agentos-ext-giphy';
import { ImageSearchTool } from '@framers/agentos-ext-image-search';
import { TextToSpeechTool } from '@framers/agentos-ext-voice-synthesis';
import { NewsSearchTool } from '@framers/agentos-ext-news-search';

// Minimal execution context for testing
const testContext = {
  gmiId: 'test-agent',
  personaId: 'test-persona',
  userContext: { userId: 'test-user' },
  correlationId: 'test-run-' + Date.now(),
};

// ─── Utility ───
function printResult(name: string, result: any) {
  if (result.success) {
    console.log(`  ✅ ${name}: SUCCESS`);
    const out = result.output;
    // Print a brief summary depending on tool type
    if (out.results) {
      console.log(`     → ${out.results.length} results for "${out.query}"`);
      if (out.results[0]) console.log(`     → First: ${out.results[0].title || out.results[0].link || out.results[0].url || JSON.stringify(out.results[0]).slice(0, 100)}`);
    } else if (out.articles) {
      console.log(`     → ${out.articles.length} articles for "${out.query}"`);
      if (out.articles[0]) console.log(`     → First: "${out.articles[0].title}" (${out.articles[0].source})`);
    } else if (out.images) {
      console.log(`     → ${out.images.length} images from ${out.provider} for "${out.query}"`);
      if (out.images[0]) console.log(`     → First: ${out.images[0].url?.slice(0, 80)}...`);
    } else if (out.audioBase64) {
      console.log(`     → Audio: ${(out.audioBase64.length / 1024).toFixed(1)} KB base64, voice="${out.voice}", est ${out.durationEstimateMs}ms`);
    } else {
      console.log(`     → ${JSON.stringify(out).slice(0, 150)}`);
    }
  } else {
    console.log(`  ❌ ${name}: FAILED — ${result.error}`);
  }
}

async function runTest(name: string, fn: () => Promise<any>) {
  try {
    const start = Date.now();
    const result = await fn();
    const elapsed = Date.now() - start;
    printResult(`${name} (${elapsed}ms)`, result);
    return result.success;
  } catch (err: any) {
    console.log(`  ❌ ${name}: EXCEPTION — ${err.message}`);
    return false;
  }
}

// ─── Main ───
async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Wunderland Agent Tool Integration Tests');
  console.log('═══════════════════════════════════════════════════════\n');

  // Show availability
  const availability = getToolAvailability();
  console.log('Tool Availability:');
  for (const [id, info] of Object.entries(availability)) {
    console.log(`  ${info.available ? '🟢' : '🔴'} ${id}${info.reason ? ` — ${info.reason}` : ''}`);
  }
  console.log();

  // Create all tools via registry
  const allTools = createWunderlandTools();
  console.log(`Registry created ${allTools.length} tools: ${allTools.map(t => t.name).join(', ')}\n`);

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  // ─── 1. Serper Web Search ───
  console.log('── 1. Serper Web Search ──');
  if (process.env.SERPER_API_KEY) {
    const serper = new SerperSearchTool(process.env.SERPER_API_KEY);
    const ok = await runTest('Web search "AI agents 2025"', () =>
      serper.execute({ query: 'AI agents 2025', num: 3 }, testContext)
    );
    const ok2 = await runTest('News search "artificial intelligence"', () =>
      serper.execute({ query: 'artificial intelligence', type: 'news', num: 3 }, testContext)
    );
    passed += (ok ? 1 : 0) + (ok2 ? 1 : 0);
    failed += (!ok ? 1 : 0) + (!ok2 ? 1 : 0);
  } else {
    console.log('  ⏭ Skipped — SERPER_API_KEY not set');
    skipped += 2;
  }
  console.log();

  // ─── 2. News Search (NewsAPI) ───
  console.log('── 2. NewsAPI Search ──');
  if (process.env.NEWSAPI_API_KEY) {
    const news = new NewsSearchTool(process.env.NEWSAPI_API_KEY);
    const ok = await runTest('News search "technology"', () =>
      news.execute({ query: 'technology', pageSize: 3 }, testContext)
    );
    passed += ok ? 1 : 0;
    failed += ok ? 0 : 1;
  } else {
    console.log('  ⏭ Skipped — NEWSAPI_API_KEY not set');
    skipped++;
  }
  console.log();

  // ─── 3. Giphy GIF Search ───
  console.log('── 3. Giphy GIF Search ──');
  if (process.env.GIPHY_API_KEY) {
    const giphy = new GiphySearchTool(process.env.GIPHY_API_KEY);
    const ok = await runTest('GIF search "celebration"', () =>
      giphy.execute({ query: 'celebration', limit: 2 }, testContext)
    );
    passed += ok ? 1 : 0;
    failed += ok ? 0 : 1;
  } else {
    console.log('  ⏭ Skipped — GIPHY_API_KEY not set');
    skipped++;
  }
  console.log();

  // ─── 4. Image Search (Pexels) ───
  console.log('── 4. Image Search (Pexels) ──');
  if (process.env.PEXELS_API_KEY) {
    const img = new ImageSearchTool({ pexels: process.env.PEXELS_API_KEY });
    const ok = await runTest('Pexels search "sunset mountains"', () =>
      img.execute({ query: 'sunset mountains', provider: 'pexels', limit: 2 }, testContext)
    );
    passed += ok ? 1 : 0;
    failed += ok ? 0 : 1;
  } else {
    console.log('  ⏭ Skipped — PEXELS_API_KEY not set');
    skipped++;
  }
  console.log();

  // ─── 5. Image Search (Unsplash) ───
  console.log('── 5. Image Search (Unsplash) ──');
  if (process.env.UNSPLASH_ACCESS_KEY) {
    const img = new ImageSearchTool({ unsplash: process.env.UNSPLASH_ACCESS_KEY });
    const ok = await runTest('Unsplash search "cyberpunk city"', () =>
      img.execute({ query: 'cyberpunk city', provider: 'unsplash', limit: 2 }, testContext)
    );
    passed += ok ? 1 : 0;
    failed += ok ? 0 : 1;
  } else {
    console.log('  ⏭ Skipped — UNSPLASH_ACCESS_KEY not set');
    skipped++;
  }
  console.log();

  // ─── 6. Image Search (Pixabay) ───
  console.log('── 6. Image Search (Pixabay) ──');
  if (process.env.PIXABAY_API_KEY) {
    const img = new ImageSearchTool({ pixabay: process.env.PIXABAY_API_KEY });
    const ok = await runTest('Pixabay search "robot AI"', () =>
      img.execute({ query: 'robot AI', provider: 'pixabay', limit: 2 }, testContext)
    );
    passed += ok ? 1 : 0;
    failed += ok ? 0 : 1;
  } else {
    console.log('  ⏭ Skipped — PIXABAY_API_KEY not set');
    skipped++;
  }
  console.log();

  // ─── 7. ElevenLabs TTS ───
  console.log('── 7. ElevenLabs Text-to-Speech ──');
  if (process.env.ELEVENLABS_API_KEY) {
    const tts = new TextToSpeechTool(process.env.ELEVENLABS_API_KEY);
    const ok = await runTest('TTS "Hello from Wunderland"', () =>
      tts.execute({ text: 'Hello from Wunderland! I am an autonomous AI agent.', voice: 'rachel' }, testContext)
    );
    passed += ok ? 1 : 0;
    failed += ok ? 0 : 1;
  } else {
    console.log('  ⏭ Skipped — ELEVENLABS_API_KEY not set');
    skipped++;
  }
  console.log();

  // ─── Summary ───
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log('═══════════════════════════════════════════════════════');

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
