import * as fs from "fs";
import { loadConfig } from "./config.js";
import type {Analyzer, AnalyzerConfig, AnalyzerResult, CostReport} from './types.js'
import { formatConsoleReport, generateHTMLReport } from "./utils/report-formatter.js";

// Import all analyzers
import { CloudWatchLogsAnalyzer } from "./analyzers/cloudwatch-logs.js";
import { KMSAnalyzer } from "./analyzers/kms.js";
import { EC2EBSAnalyzer } from "./analyzers/ec2-ebs.js";
import { S3Analyzer } from "./analyzers/s3.js";
import { LambdaAnalyzer } from "./analyzers/lambda.js";
import { RDSAnalyzer } from "./analyzers/rds.js";
import { ELBAnalyzer } from "./analyzers/elb.js";
import { DynamoDBAnalyzer } from "./analyzers/dynamodb.js";

async function main() {
  console.log("╔═══════════════════════════════════════════════════════════════════════╗");
  console.log("║           AWS COST OPTIMIZATION ANALYZER                              ║");
  console.log("╚═══════════════════════════════════════════════════════════════════════╝");
  console.log("");

  const config = loadConfig();
  console.log(`Analyzing ${config.regions.length} region(s): ${config.regions.join(", ")}`);
  console.log(`Thresholds: ${config.thresholds.inactiveDays} days inactivity`);
  console.log("");

  // Initialize analyzers
  const analyzers: Analyzer[] = [];

  if (config.analyzers.cloudwatchLogs) {
    analyzers.push(new CloudWatchLogsAnalyzer());
  }
  if (config.analyzers.kms) {
    analyzers.push(new KMSAnalyzer());
  }
  if (config.analyzers.ec2 || config.analyzers.ebs) {
    analyzers.push(new EC2EBSAnalyzer());
  }
  if (config.analyzers.s3) {
    analyzers.push(new S3Analyzer());
  }
  if (config.analyzers.lambda) {
    analyzers.push(new LambdaAnalyzer());
  }
  if (config.analyzers.rds) {
    analyzers.push(new RDSAnalyzer());
  }
  if (config.analyzers.elb) {
    analyzers.push(new ELBAnalyzer());
  }
  if (config.analyzers.dynamodb) {
    analyzers.push(new DynamoDBAnalyzer());
  }

  console.log(`Running ${analyzers.length} analyzer(s)...`);
  console.log("");

  const allResults: AnalyzerResult[] = [];

  // Run analyzers for each region
  for (const region of config.regions) {
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`Region: ${region}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    const analyzerConfig: AnalyzerConfig = {
      region,
      thresholds: config.thresholds,
    };

    // Run all analyzers in parallel for this region
    const results = await Promise.all(
      analyzers.map(async (analyzer) => {
        console.log(`  Running ${analyzer.name}...`);
        const result = await analyzer.analyze(analyzerConfig);

        if (result.error) {
          console.log(`  ✗ ${analyzer.name}: ERROR - ${result.error}`);
        } else {
          console.log(
            `  ✓ ${analyzer.name}: ${result.findings.length} findings (${(result.executionTimeMs / 1000).toFixed(2)}s)`
          );
        }

        return result;
      })
    );

    allResults.push(...results);
    console.log("");
  }

  // Generate report
  const report: CostReport = generateReport(allResults, config.regions, analyzers);

  // Save JSON report
  const timestamp = new Date().toISOString().split("T")[0];
  const profileSuffix = process.env.AWS_PROFILE ? `-${process.env.AWS_PROFILE}` : "";
  const jsonFilename = `cost-optimization-report-${timestamp}${profileSuffix}.json`;
  fs.writeFileSync(jsonFilename, JSON.stringify(report, null, 2));

  // Save HTML report
  const htmlFilename = `cost-optimization-report-${timestamp}${profileSuffix}.html`;
  fs.writeFileSync(htmlFilename, generateHTMLReport(report));

  // Print console report
  console.log(formatConsoleReport(report));

  console.log("");
  console.log(`✓ JSON report saved: ${jsonFilename}`);
  console.log(`✓ HTML report saved: ${htmlFilename}`);
}

function generateReport(
  results: AnalyzerResult[],
  regions: string[],
  analyzers: Analyzer[]
): CostReport {
  const allFindings = results.flatMap((r) => r.findings);
  const totalPotentialSavings = results.reduce(
    (sum, r) => sum + r.totalPotentialSavings,
    0
  );

  // Count findings by priority
  const findingsByPriority = {
    high: allFindings.filter((f) => f.priority === "high").length,
    medium: allFindings.filter((f) => f.priority === "medium").length,
    low: allFindings.filter((f) => f.priority === "low").length,
  };

  // Calculate savings by service
  const savingsByService: Record<string, number> = {};
  for (const finding of allFindings) {
    if (!savingsByService[finding.service]) {
      savingsByService[finding.service] = 0;
    }
    savingsByService[finding.service]! += finding.potentialMonthlySavings;
  }

  // Get top recommendations sorted by potential savings
  const topRecommendations = [...allFindings]
    .sort((a, b) => b.potentialMonthlySavings - a.potentialMonthlySavings)
    .slice(0, 20);

  return {
    generatedAt: new Date().toISOString(),
    regions,
    analyzers: analyzers.map((a) => a.name),
    summary: {
      totalFindings: allFindings.length,
      totalPotentialMonthlySavings: totalPotentialSavings,
      findingsByPriority,
      savingsByService,
    },
    results,
    topRecommendations,
  };
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
