import type { CatalogFieldRole } from "@/lib/catalog/shared";

export interface RetrievalPageCursor {
  kind: "catalog_page";
  planKind: "catalog_search";
  terms: CatalogSearchTerm[];
  scopeSourceIds?: string[];
  offset: number;
  limit: number;
  nextOffset: number;
  hasMore: boolean;
}

export interface RetrievalCatalogFocus {
  kind: "catalog_focus";
  planKind: "catalog_search" | "catalog_count";
  terms: CatalogSearchTerm[];
  scopeSourceIds?: string[];
  matchedProducts: number;
}

export interface RetrievalCatalogProductFocus {
  kind: "catalog_product_focus";
  terms: CatalogSearchTerm[];
  matchedProducts: number;
  products: CatalogProductFocusItem[];
}

export interface CatalogProductFocusItem {
  productId: string;
  title: string;
  recordKey: string;
}

export interface CatalogProductReference {
  productId?: string;
  title?: string;
  terms?: CatalogSearchTerm[];
}

export type CatalogSearchMode = "inventory" | "detail";

export type CatalogPageAction = "first" | "next" | "restart";

export interface CatalogProductResolutionDiagnostics {
  requested: CatalogProductReference;
  status:
    | "selected"
    | "ambiguous"
    | "no_match"
    | "product_id_rejected"
    | "product_id_unqualified";
  selectedProductIds: string[];
  rejectedProductIds: string[];
  candidates: CatalogProductFocusItem[];
}

export interface CatalogSearchTerm {
  value: string;
  fieldPath?: string;
  validationCandidates?: CatalogSearchTermCandidate[];
}

export interface CatalogSearchTermCandidate {
  value: string;
  fieldPath?: string;
}

export interface CatalogFieldCapability {
  fieldPath: string;
  role: CatalogFieldRole;
}

export interface CatalogFilterValueSummary {
  fieldPath: string;
  value: string;
  normalizedValue: string;
  productCount: number;
}

export interface CatalogScopeSummary {
  sourceId: string;
  name?: string | null;
  aliases: string[];
}

export interface SourceCapabilities {
  agentId: string;
  knowledgeSourceIds?: string[];
  catalog: {
    available: boolean;
    activeProductCount: number;
    fieldCapabilities: CatalogFieldCapability[];
    filterValueSummaries: CatalogFilterValueSummary[];
    scopes: CatalogScopeSummary[];
  };
  documents: {
    available: boolean;
    indexedChunkCount: number;
  };
}

export type RetrievalPlanKind =
  | "catalog_overview"
  | "catalog_search"
  | "catalog_count"
  | "catalog_capabilities"
  | "catalog_continue"
  | "catalog_detail"
  | "document_retrieval"
  | "mixed"
  | "none";

export type RetrievalPlan =
  | {
      kind: "catalog_overview";
      reason: string;
    }
  | {
      kind: "catalog_search";
      reason: string;
      terms: CatalogSearchTerm[];
      limit?: number;
      pageAction?: CatalogPageAction;
      allProducts?: boolean;
      scopeSourceIds?: string[];
    }
  | {
      kind: "catalog_count";
      reason: string;
      terms: CatalogSearchTerm[];
      scopeSourceIds?: string[];
    }
  | {
      kind: "catalog_capabilities";
      reason: string;
      requestedField?: string;
    }
  | {
      kind: "catalog_continue";
      reason: string;
    }
  | {
      kind: "catalog_detail";
      reason: string;
      products: CatalogProductReference[];
    }
  | {
      kind: "document_retrieval";
      reason: string;
      query?: string;
    }
  | {
      kind: "mixed";
      reason: string;
      plans: RetrievalPlan[];
    }
  | {
      kind: "none";
      reason: string;
    };

export type PlannerFallbackReason =
  | "planner_timeout"
  | "planner_invalid_json"
  | "planner_invalid_shape"
  | "planner_unavailable"
  | "catalog_unavailable"
  | "documents_unavailable";

export interface PlannerDiagnostics {
  attempted: boolean;
  model?: string;
  planKind?: RetrievalPlanKind;
  reason?: string;
  fallbackReason?: PlannerFallbackReason;
  rawText?: string;
}

export interface CatalogProductEvidence {
  productId: string;
  sourceId: string;
  recordKey: string;
  title: string;
  facts: Array<{ fieldPath: string; value: string }>;
}

export type CatalogValidationErrorCode =
  | "catalog_unavailable"
  | "empty_terms"
  | "no_match"
  | "ambiguous_product"
  | "continuation_unavailable"
  | "unsupported_plan";

export type CatalogEvidence =
  | {
      kind: "overview";
      totalActiveProducts: number;
      filterValueSummaries: CatalogFilterValueSummary[];
      fieldCapabilities: CatalogFieldCapability[];
    }
  | {
      kind: "product_page";
      terms: CatalogSearchTerm[];
      scopeSourceIds?: string[];
      scopeLabel?: string;
      totalActiveProducts: number;
      matchedProducts: number;
      products: CatalogProductEvidence[];
      offset: number;
      limit: number;
      nextOffset: number;
      hasMore: boolean;
      complete: boolean;
    }
  | {
      kind: "count";
      terms: CatalogSearchTerm[];
      scopeSourceIds?: string[];
      scopeLabel?: string;
      totalActiveProducts: number;
      matchedProducts: number;
    }
  | {
      kind: "product_detail";
      products: CatalogProductEvidence[];
      totalActiveProducts: number;
      matchedProducts: number;
    }
  | {
      kind: "product_clarification";
      totalActiveProducts: number;
      references: Array<{
        requested: CatalogProductReference;
        candidates: CatalogProductEvidence[];
      }>;
      message: string;
    }
  | {
      kind: "capabilities";
      totalActiveProducts: number;
      filterValueSummaries: CatalogFilterValueSummary[];
      fieldCapabilities: CatalogFieldCapability[];
      requestedField?: string;
    }
  | {
      kind: "no_match";
      terms: CatalogSearchTerm[];
      totalActiveProducts: number;
      code: CatalogValidationErrorCode;
      message: string;
    };

export interface CatalogEvidenceDiagnostics {
  attempted: boolean;
  evidenceKind?: CatalogEvidence["kind"];
  validationResult?:
    | "validated"
    | "no_match"
    | "needs_clarification"
    | "skipped"
    | "invalid_plan";
  errorCode?: CatalogValidationErrorCode;
  matchedProducts?: number;
  returnedProducts?: number;
  offset?: number;
  limit?: number;
  nextOffset?: number;
  hasMore?: boolean;
  searchMode?: CatalogSearchMode;
  pageAction?: CatalogPageAction;
  productResolutions?: CatalogProductResolutionDiagnostics[];
}

export interface DocumentEvidence {
  chunks: Array<{
    content: string;
    sourceId: string;
    score: number;
    metadata?: Record<string, unknown>;
  }>;
}

export interface DocumentEvidenceDiagnostics {
  keywords: string[];
  vectorResultsCount: number;
  ftsResultsCount: number;
  vectorSearchMode?:
    | "unfiltered"
    | "direct_filtered_query"
    | "broad_namespace_query"
    | "broad_query_plus_app_filter";
  vectorFilterCapability?: "unknown" | "available" | "unavailable";
  vectorFilterApplied?: boolean;
  vectorFilterReason?: string;
  vectorFallbackTopK?: number;
  rerankEnabled: boolean;
  rerankModel?: string;
  timing: {
    vectorSearchMs: number;
    ftsSearchMs: number;
    hybridSearchMs: number;
    rerankMs?: number;
    enrichmentMs?: number;
  };
  chunks: Array<{
    id: string;
    content: string;
    score: number;
    vectorScore?: number;
    rerankScore?: number;
    sourceId?: string;
    metadata?: Record<string, unknown>;
  }>;
}

export interface RetrievalDiagnostics {
  planner: PlannerDiagnostics;
  catalog?: CatalogEvidenceDiagnostics;
  documents?: DocumentEvidenceDiagnostics;
}
