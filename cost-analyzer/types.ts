export interface Finding {
  service: string;
  resourceId: string;
  resourceType: string;
  region: string;
  issue: string;
  recommendation: string;
  estimatedMonthlyCost: number;
  potentialMonthlySavings: number;
  priority: "high" | "medium" | "low";
  metadata?: Record<string, any>;
}

export interface AnalyzerResult {
  analyzerName: string;
  region: string;
  findings: Finding[];
  totalPotentialSavings: number;
  executionTimeMs: number;
  error?: string;
}

export interface CostReport {
  generatedAt: string;
  regions: string[];
  analyzers: string[];
  summary: {
    totalFindings: number;
    totalPotentialMonthlySavings: number;
    findingsByPriority: {
      high: number;
      medium: number;
      low: number;
    };
    savingsByService: Record<string, number>;
  };
  results: AnalyzerResult[];
  topRecommendations: Finding[];
}

export interface AnalyzerConfig {
  region: string;
  thresholds: {
    inactiveDays: number;
    minMonthlySavings: number;
    oldSnapshotDays: number;
    minEBSVolumeGB: number;
  };
}

export interface Analyzer {
  name: string;
  analyze(config: AnalyzerConfig): Promise<AnalyzerResult>;
}
