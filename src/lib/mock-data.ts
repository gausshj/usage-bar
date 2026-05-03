// ============================================================================
// src/lib/mock-data.ts
// Mock data for UI development — to be replaced with real connector data
// ============================================================================

import type { NormalizedRecord } from '../connectors/types.js';

// ---------------------------------------------------------------------------
// Mock normalized records — simulates connector output
// ---------------------------------------------------------------------------

export const MOCK_RECORDS: NormalizedRecord[] = [
  {
    provider: 'openai',
    date: '2026-04-28',
    model: 'gpt-4o',
    requests: 142,
    input_tokens: 89500,
    output_tokens: 67300,
    cost_usd: 3.24,
  },
  {
    provider: 'openai',
    date: '2026-04-27',
    model: 'gpt-4o',
    requests: 98,
    input_tokens: 61200,
    output_tokens: 44100,
    cost_usd: 2.18,
  },
  {
    provider: 'zhipu',
    date: '2026-04-28',
    model: 'glm-4-flash',
    requests: 256,
    input_tokens: 182000,
    output_tokens: 134000,
    cost_usd: 0.47,
  },
  {
    provider: 'zhipu',
    date: '2026-04-27',
    model: 'glm-4-flash',
    requests: 189,
    input_tokens: 128000,
    output_tokens: 96000,
    cost_usd: 0.35,
  },
  {
    provider: 'minimax',
    date: '2026-04-28',
    model: 'abab6-chat',
    requests: 74,
    input_tokens: 42100,
    output_tokens: 31800,
    cost_usd: 0.89,
  },
];

// ---------------------------------------------------------------------------
// Mock sync status
// ---------------------------------------------------------------------------

export interface SyncStatus {
  provider: string;
  lastSyncTime: number; // Unix ms
  nextSyncTime: number; // Unix ms
  status: 'synced' | 'syncing' | 'error' | 'pending';
  errorMessage?: string;
  recordCount: number;
}

export const MOCK_SYNC_STATUS: SyncStatus[] = [
  {
    provider: 'openai',
    lastSyncTime: Date.now() - 1000 * 60 * 5, // 5 min ago
    nextSyncTime: Date.now() + 1000 * 60 * 25, // 25 min from now
    status: 'synced',
    recordCount: 142,
  },
  {
    provider: 'zhipu',
    lastSyncTime: Date.now() - 1000 * 60 * 8, // 8 min ago
    nextSyncTime: Date.now() + 1000 * 60 * 22, // 22 min from now
    status: 'synced',
    recordCount: 256,
  },
  {
    provider: 'minimax',
    lastSyncTime: Date.now() - 1000 * 60 * 45, // 45 min ago
    nextSyncTime: Date.now() + 1000 * 60 * 15, // 15 min from now
    status: 'error',
    errorMessage: 'API rate limit exceeded (429)',
    recordCount: 74,
  },
];

// ---------------------------------------------------------------------------
// Mock provider metadata
// ---------------------------------------------------------------------------

export interface ProviderMeta {
  id: string;
  name: string;
  displayName: string;
  quotaLimit: number; // USD
  quotaUsed: number;  // USD
  modelCount: number;
}

export const MOCK_PROVIDER_META: ProviderMeta[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    displayName: 'OpenAI / ChatGPT',
    quotaLimit: 100,
    quotaUsed: 5.42,
    modelCount: 3,
  },
  {
    id: 'zhipu',
    name: 'Zhipu',
    displayName: '智谱 GLM',
    quotaLimit: 50,
    quotaUsed: 0.82,
    modelCount: 5,
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    displayName: 'MiniMax',
    quotaLimit: 30,
    quotaUsed: 0.89,
    modelCount: 2,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount);
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat('en-US').format(n);
}

export function formatTimeAgo(ms: number): string {
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export function getQuotaPercentage(used: number, limit: number): number {
  return Math.min(100, (used / limit) * 100);
}