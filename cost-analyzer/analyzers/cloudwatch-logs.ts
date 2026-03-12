import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  DescribeLogStreamsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import type { Analyzer, AnalyzerConfig, AnalyzerResult, Finding } from "../types.js";
import { calculateCloudWatchLogsStorageCost } from "../utils/cost-calculator.js";

export class CloudWatchLogsAnalyzer implements Analyzer {
  name = "CloudWatch Logs";

  async analyze(config: AnalyzerConfig): Promise<AnalyzerResult> {
    const startTime = Date.now();
    const findings: Finding[] = [];
    const client = new CloudWatchLogsClient({ region: config.region });

    try {
      const inactiveThreshold = Date.now() - config.thresholds.inactiveDays * 24 * 60 * 60 * 1000;
      let nextToken: string | undefined;

      do {
        const command = new DescribeLogGroupsCommand({ nextToken });
        const response = await client.send(command);

        if (response.logGroups) {
          for (const logGroup of response.logGroups) {
            if (!logGroup.logGroupName) continue;

            try {
              // Get the most recent log stream
              const streamsCommand = new DescribeLogStreamsCommand({
                logGroupName: logGroup.logGroupName,
                orderBy: "LastEventTime",
                descending: true,
                limit: 1,
              });

              const streamsResponse = await client.send(streamsCommand);
              const lastEventTime = streamsResponse.logStreams?.[0]?.lastIngestionTime;
              const storedBytes = logGroup.storedBytes || 0;
              const storedGB = storedBytes / (1024 * 1024 * 1024);
              const monthlyCost = calculateCloudWatchLogsStorageCost(storedGB);

              // Check for inactive log groups
              if (!lastEventTime || lastEventTime < inactiveThreshold) {
                const daysSinceLastEvent = lastEventTime
                  ? Math.floor((Date.now() - lastEventTime) / (24 * 60 * 60 * 1000))
                  : null;

                findings.push({
                  service: "CloudWatch Logs",
                  resourceId: logGroup.logGroupName,
                  resourceType: "Log Group",
                  region: config.region,
                  issue: daysSinceLastEvent
                    ? `Inactive for ${daysSinceLastEvent} days`
                    : "No events recorded",
                  recommendation: `Delete unused log group to save on storage costs`,
                  estimatedMonthlyCost: monthlyCost,
                  potentialMonthlySavings: monthlyCost,
                  priority: monthlyCost > 5 ? "high" : monthlyCost > 1 ? "medium" : "low",
                  metadata: {
                    lastEventTime,
                    daysSinceLastEvent,
                    storedGB: storedGB.toFixed(2),
                    retentionInDays: logGroup.retentionInDays,
                  },
                });
              }
              // Check for log groups without retention policy
              else if (!logGroup.retentionInDays) {
                findings.push({
                  service: "CloudWatch Logs",
                  resourceId: logGroup.logGroupName,
                  resourceType: "Log Group",
                  region: config.region,
                  issue: "No retention policy set (logs stored indefinitely)",
                  recommendation: "Set a retention policy (e.g., 7, 30, 90, or 365 days)",
                  estimatedMonthlyCost: monthlyCost,
                  potentialMonthlySavings: monthlyCost * 0.5, // Assuming 50% reduction with retention
                  priority: monthlyCost > 10 ? "high" : monthlyCost > 2 ? "medium" : "low",
                  metadata: {
                    storedGB: storedGB.toFixed(2),
                    lastEventTime,
                  },
                });
              }
              // Check for large log groups that might benefit from optimization
              else if (storedGB > 50) {
                findings.push({
                  service: "CloudWatch Logs",
                  resourceId: logGroup.logGroupName,
                  resourceType: "Log Group",
                  region: config.region,
                  issue: `Large log group (${storedGB.toFixed(2)} GB)`,
                  recommendation:
                    "Review log verbosity, consider shorter retention, or export to S3",
                  estimatedMonthlyCost: monthlyCost,
                  potentialMonthlySavings: monthlyCost * 0.3, // Assuming 30% reduction
                  priority: "medium",
                  metadata: {
                    storedGB: storedGB.toFixed(2),
                    retentionInDays: logGroup.retentionInDays,
                  },
                });
              }
            } catch (error) {
              console.error(`Error analyzing log group ${logGroup.logGroupName}:`, error);
            }
          }
        }

        nextToken = response.nextToken;
      } while (nextToken);

      const totalPotentialSavings = findings.reduce(
        (sum, f) => sum + f.potentialMonthlySavings,
        0
      );

      return {
        analyzerName: this.name,
        region: config.region,
        findings,
        totalPotentialSavings,
        executionTimeMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        analyzerName: this.name,
        region: config.region,
        findings: [],
        totalPotentialSavings: 0,
        executionTimeMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
