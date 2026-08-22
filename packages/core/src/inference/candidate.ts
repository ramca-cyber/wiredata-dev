/**
 * JSON Candidate Collection Detection and Scoring Engine
 */

import { CandidateCollection, JSONPointer } from '../types/index.js';
import { compilePointer, pointerToDisplayPath } from '../json/pointer.js';

export interface DetectionOptions {
  maxDepth?: number;
  minRows?: number;
}

/**
 * Calculates Jaccard similarity index between key sets across objects
 */
function calculateKeyOverlap(objects: Array<Record<string, unknown>>): number {
  if (objects.length <= 1) return 1.0;
  const sample = objects.slice(0, 20); // sample up to 20 objects
  const allKeys = new Set<string>();
  const keySets: Array<Set<string>> = [];

  for (const obj of sample) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    const keys = new Set(Object.keys(obj));
    keySets.push(keys);
    for (const k of keys) allKeys.add(k);
  }

  if (allKeys.size === 0 || keySets.length === 0) return 0.0;

  // Average pairwise intersection / union
  let totalIntersection = 0;
  for (const k of allKeys) {
    let count = 0;
    for (const ks of keySets) {
      if (ks.has(k)) count++;
    }
    totalIntersection += count / keySets.length;
  }

  return totalIntersection / allKeys.size;
}

/**
 * Scores an array candidate to evaluate if it represents a structured dataset
 */
export function scoreCandidateArray(
  arr: unknown[],
  pointerTokens: string[]
): {
  score: number;
  confidence: 'high' | 'medium' | 'low';
  sampleKeys: string[];
  fieldCount: number;
} {
  if (!Array.isArray(arr) || arr.length === 0) {
    return { score: 0, confidence: 'low', sampleKeys: [], fieldCount: 0 };
  }

  // Count how many elements are objects
  let objectCount = 0;
  const sampleObjects: Array<Record<string, unknown>> = [];
  const allKeys = new Set<string>();

  for (const item of arr) {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      objectCount++;
      if (sampleObjects.length < 20) {
        sampleObjects.push(item as Record<string, unknown>);
      }
      for (const k of Object.keys(item as object)) {
        allKeys.add(k);
      }
    }
  }

  const objectFraction = objectCount / arr.length;
  if (objectFraction < 0.5) {
    // Array of primitives or mixed non-objects
    return {
      score: 0.1,
      confidence: 'low',
      sampleKeys: [],
      fieldCount: 1,
    };
  }

  const keyOverlap = calculateKeyOverlap(sampleObjects);
  const rowCountFactor = Math.min(1.0, arr.length / 5); // scales up to 5+ rows
  const fieldCount = allKeys.size;
  const fieldCountFactor = Math.min(1.0, fieldCount / 3); // scales up to 3+ fields

  // Combined weighted score (0.0 to 1.0)
  const score =
    objectFraction * 0.4 +
    keyOverlap * 0.35 +
    rowCountFactor * 0.15 +
    fieldCountFactor * 0.1;

  let confidence: 'high' | 'medium' | 'low' = 'low';
  if (score >= 0.7 && arr.length >= 1 && objectFraction >= 0.8) {
    confidence = 'high';
  } else if (score >= 0.45) {
    confidence = 'medium';
  }

  return {
    score: Math.round(score * 100) / 100,
    confidence,
    sampleKeys: Array.from(allKeys).slice(0, 10),
    fieldCount,
  };
}

/**
 * Derives a readable dataset name from pointer tokens
 */
function deriveSuggestedName(pointerTokens: string[]): string {
  if (pointerTokens.length === 0) return 'root_dataset';
  const lastToken = pointerTokens[pointerTokens.length - 1];
  // Convert camelCase or kebab-case to snake_case
  return lastToken
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

/**
 * Recursively inspects a JSON document and detects dataset collection candidates
 */
export function detectCandidateCollections(
  document: unknown,
  options: DetectionOptions = {}
): CandidateCollection[] {
  const maxDepth = options.maxDepth ?? 6;
  const minRows = options.minRows ?? 1;
  const candidates: CandidateCollection[] = [];

  function traverse(node: unknown, tokens: string[], depth: number) {
    if (depth > maxDepth || node === null || node === undefined) return;

    if (Array.isArray(node)) {
      if (node.length >= minRows) {
        const { score, confidence, sampleKeys, fieldCount } = scoreCandidateArray(node, tokens);
        const pointer = compilePointer(tokens);
        candidates.push({
          pointer: pointer === '' ? '/' : pointer,
          display_path: pointerToDisplayPath(pointer),
          row_count: node.length,
          field_count: fieldCount,
          confidence,
          confidence_score: score,
          sample_keys: sampleKeys,
          suggested_name: deriveSuggestedName(tokens),
        });
      }

      // Check nested objects within array if depth permits (limited inspection)
      if (node.length > 0 && typeof node[0] === 'object' && node[0] !== null && depth + 1 <= maxDepth) {
        for (const [key, value] of Object.entries(node[0] as Record<string, unknown>)) {
          if (Array.isArray(value)) {
            traverse(value, [...tokens, '0', key], depth + 2);
          }
        }
      }
      return;
    }

    if (typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        traverse(value, [...tokens, key], depth + 1);
      }
    }
  }

  traverse(document, [], 0);

  // Sort candidates by confidence score descending, then row count descending
  candidates.sort((a, b) => {
    if (b.confidence_score !== a.confidence_score) {
      return b.confidence_score - a.confidence_score;
    }
    return b.row_count - a.row_count;
  });

  return candidates;
}
