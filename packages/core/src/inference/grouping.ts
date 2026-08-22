/**
 * Logical Route Grouping and Sub-Collection Discovery Engine
 */

import {
  CandidateCollection,
  CapturedRequest,
  JSONPointer,
  ULID,
} from '../types/index.js';
import { detectCandidateCollections } from './candidate.js';

export interface GroupedRouteCandidate {
  route_id: string;
  route_template: string;
  method: string;
  graphql_operation?: string;
  capture_ids: ULID[];
  captures: CapturedRequest[];
  total_captures: number;
  collections: Array<{
    pointer: JSONPointer;
    suggested_name: string;
    total_rows: number;
    sample_rows_per_capture: number;
    field_count: number;
    sample_keys: string[];
    confidence: 'high' | 'medium' | 'low';
    is_sub_collection: boolean;
  }>;
}

/**
 * Groups raw captures and candidate collections by logical route/endpoint pattern
 */
export function groupCandidatesByRoute(
  captures: CapturedRequest[],
  responseBodies: Map<string, unknown>
): GroupedRouteCandidate[] {
  const routeMap = new Map<string, {
    route_template: string;
    method: string;
    graphql_operation?: string;
    captures: CapturedRequest[];
    collectionsMap: Map<string, {
      collection: CandidateCollection;
      total_rows: number;
      matching_captures: number;
    }>;
  }>();

  for (const capture of captures) {
    const routeKey = capture.request.route_template || capture.request.sanitized_url;
    let group = routeMap.get(routeKey);

    if (!group) {
      group = {
        route_template: routeKey,
        method: capture.request.method,
        graphql_operation: capture.request.graphql_operation_name,
        captures: [],
        collectionsMap: new Map(),
      };
      routeMap.set(routeKey, group);
    }

    group.captures.push(capture);

    const bodyObj = responseBodies.get(capture.response.body_hash);
    if (bodyObj) {
      const candidates = detectCandidateCollections(bodyObj);
      for (const cand of candidates) {
        const existing = group.collectionsMap.get(cand.pointer);
        if (existing) {
          existing.total_rows += cand.row_count;
          existing.matching_captures += 1;
        } else {
          group.collectionsMap.set(cand.pointer, {
            collection: cand,
            total_rows: cand.row_count,
            matching_captures: 1,
          });
        }
      }
    }
  }

  const result: GroupedRouteCandidate[] = [];

  for (const [routeKey, group] of routeMap.entries()) {
    const collections = Array.from(group.collectionsMap.values()).map(({ collection, total_rows }) => ({
      pointer: collection.pointer,
      suggested_name: collection.suggested_name,
      total_rows,
      sample_rows_per_capture: collection.row_count,
      field_count: collection.field_count,
      sample_keys: collection.sample_keys,
      confidence: collection.confidence,
      is_sub_collection: collection.pointer.split('/').length > 2,
    }));

    // Sort collections by total rows and confidence
    collections.sort((a, b) => b.total_rows - a.total_rows);

    result.push({
      route_id: `route_${routeKey.replace(/[^a-zA-Z0-9_]/g, '_')}`,
      route_template: group.route_template,
      method: group.method,
      graphql_operation: group.graphql_operation,
      capture_ids: group.captures.map(c => c.capture_id),
      captures: group.captures,
      total_captures: group.captures.length,
      collections,
    });
  }

  // Sort routes with most captures / records first
  result.sort((a, b) => b.total_captures - a.total_captures);
  return result;
}
