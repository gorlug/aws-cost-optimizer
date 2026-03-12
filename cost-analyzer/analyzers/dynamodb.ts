import {
  DynamoDBClient,
  ListTablesCommand,
  DescribeTableCommand,
} from "@aws-sdk/client-dynamodb";
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from "@aws-sdk/client-cloudwatch";
import type { Analyzer, AnalyzerConfig, AnalyzerResult, Finding } from "../types.js";

export class DynamoDBAnalyzer implements Analyzer {
  name = "DynamoDB";

  async analyze(config: AnalyzerConfig): Promise<AnalyzerResult> {
    const startTime = Date.now();
    const findings: Finding[] = [];
    const dynamoDBClient = new DynamoDBClient({ region: config.region });
    const cloudWatchClient = new CloudWatchClient({ region: config.region });

    try {
      let lastEvaluatedTableName: string | undefined;

      do {
        const command = new ListTablesCommand({
          ExclusiveStartTableName: lastEvaluatedTableName,
        });
        const response = await dynamoDBClient.send(command);

        if (response.TableNames) {
          for (const tableName of response.TableNames) {
            try {
              await this.analyzeTable(
                dynamoDBClient,
                cloudWatchClient,
                tableName,
                config,
                findings
              );
            } catch (error) {
              console.error(
                `Error analyzing DynamoDB table ${tableName}:`,
                error
              );
            }
          }
        }

        lastEvaluatedTableName = response.LastEvaluatedTableName;
      } while (lastEvaluatedTableName);

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

  private async analyzeTable(
    dynamoDBClient: DynamoDBClient,
    cloudWatchClient: CloudWatchClient,
    tableName: string,
    config: AnalyzerConfig,
    findings: Finding[]
  ): Promise<void> {
    // Get table details
    const describeCommand = new DescribeTableCommand({
      TableName: tableName,
    });
    const tableResponse = await dynamoDBClient.send(describeCommand);
    const table = tableResponse.Table;

    if (!table) return;

    const billingMode = table.BillingModeSummary?.BillingMode || "PROVISIONED";
    const tableStatus = table.TableStatus;

    // Skip tables that are being deleted
    if (tableStatus === "DELETING") return;

    // Check for provisioned tables with low utilization
    if (billingMode === "PROVISIONED") {
      const provisionedRead = table.ProvisionedThroughput?.ReadCapacityUnits || 0;
      const provisionedWrite = table.ProvisionedThroughput?.WriteCapacityUnits || 0;

      // Get read/write metrics over the last 30 days
      const endTime = new Date();
      const startTime = new Date(
        endTime.getTime() - config.thresholds.inactiveDays * 24 * 60 * 60 * 1000
      );

      // Check consumed read capacity
      const readCommand = new GetMetricStatisticsCommand({
        Namespace: "AWS/DynamoDB",
        MetricName: "ConsumedReadCapacityUnits",
        Dimensions: [
          {
            Name: "TableName",
            Value: tableName,
          },
        ],
        StartTime: startTime,
        EndTime: endTime,
        Period: 86400, // 1 day
        Statistics: ["Average", "Maximum"],
      });

      const readResponse = await cloudWatchClient.send(readCommand);
      const avgReadCapacity =
        (readResponse.Datapoints?.reduce(
          (sum, dp) => sum + (dp.Average || 0),
          0
        ) ?? 0) / (readResponse.Datapoints?.length || 1);

      const maxReadCapacity =
        readResponse.Datapoints?.reduce(
          (max, dp) => Math.max(max, dp.Maximum || 0),
          0
        ) || 0;

      // Check consumed write capacity
      const writeCommand = new GetMetricStatisticsCommand({
        Namespace: "AWS/DynamoDB",
        MetricName: "ConsumedWriteCapacityUnits",
        Dimensions: [
          {
            Name: "TableName",
            Value: tableName,
          },
        ],
        StartTime: startTime,
        EndTime: endTime,
        Period: 86400,
        Statistics: ["Average", "Maximum"],
      });

      const writeResponse = await cloudWatchClient.send(writeCommand);
      const avgWriteCapacity =
        (writeResponse.Datapoints?.reduce(
          (sum, dp) => sum + (dp.Average || 0),
          0
        ) ?? 0) / (writeResponse.Datapoints?.length || 1);

      const maxWriteCapacity =
        writeResponse.Datapoints?.reduce(
          (max, dp) => Math.max(max, dp.Maximum || 0),
          0
        ) || 0;

      // Calculate utilization percentages
      const readUtilization = provisionedRead > 0 ? (avgReadCapacity / provisionedRead) * 100 : 0;
      const writeUtilization = provisionedWrite > 0 ? (avgWriteCapacity / provisionedWrite) * 100 : 0;

      // If table has no activity, it's unused
      if (maxReadCapacity === 0 && maxWriteCapacity === 0) {
        const monthlyCost = this.estimateProvisionedCost(provisionedRead, provisionedWrite);
        findings.push({
          service: "DynamoDB",
          resourceId: tableName,
          resourceType: "DynamoDB Table",
          region: config.region,
          issue: `No read/write activity in the last ${config.thresholds.inactiveDays} days`,
          recommendation: "Delete table if no longer needed, or switch to on-demand billing",
          estimatedMonthlyCost: monthlyCost,
          potentialMonthlySavings: monthlyCost,
          priority: "high",
          metadata: {
            tableName,
            billingMode,
            provisionedRead,
            provisionedWrite,
            tableStatus,
          },
        });
      }
      // If utilization is very low (< 10%), recommend optimization
      else if (readUtilization < 10 || writeUtilization < 10) {
        const monthlyCost = this.estimateProvisionedCost(provisionedRead, provisionedWrite);
        const recommendedRead = Math.ceil(maxReadCapacity * 1.2); // 20% buffer
        const recommendedWrite = Math.ceil(maxWriteCapacity * 1.2);
        const optimizedCost = this.estimateProvisionedCost(recommendedRead, recommendedWrite);
        const savings = monthlyCost - optimizedCost;

        if (savings > config.thresholds.minMonthlySavings) {
          findings.push({
            service: "DynamoDB",
            resourceId: tableName,
            resourceType: "DynamoDB Table",
            region: config.region,
            issue: `Low provisioned capacity utilization (Read: ${readUtilization.toFixed(1)}%, Write: ${writeUtilization.toFixed(1)}%)`,
            recommendation: `Reduce provisioned capacity to ${recommendedRead} RCU / ${recommendedWrite} WCU, or switch to on-demand billing`,
            estimatedMonthlyCost: monthlyCost,
            potentialMonthlySavings: savings,
            priority: savings > 10 ? "high" : "medium",
            metadata: {
              tableName,
              billingMode,
              currentRead: provisionedRead,
              currentWrite: provisionedWrite,
              recommendedRead,
              recommendedWrite,
              readUtilization: readUtilization.toFixed(1) + "%",
              writeUtilization: writeUtilization.toFixed(1) + "%",
            },
          });
        }
      }
      // Check if table should switch to on-demand
      else if (this.shouldSwitchToOnDemand(avgReadCapacity, avgWriteCapacity, provisionedRead, provisionedWrite)) {
        const provisionedCost = this.estimateProvisionedCost(provisionedRead, provisionedWrite);
        const onDemandCost = this.estimateOnDemandCost(avgReadCapacity * 30, avgWriteCapacity * 30);
        const savings = provisionedCost - onDemandCost;

        if (savings > config.thresholds.minMonthlySavings) {
          findings.push({
            service: "DynamoDB",
            resourceId: tableName,
            resourceType: "DynamoDB Table",
            region: config.region,
            issue: "Table has unpredictable traffic patterns",
            recommendation: "Switch to on-demand billing for better cost optimization",
            estimatedMonthlyCost: provisionedCost,
            potentialMonthlySavings: savings,
            priority: savings > 20 ? "high" : "medium",
            metadata: {
              tableName,
              currentBillingMode: billingMode,
              recommendedBillingMode: "PAY_PER_REQUEST",
              avgReadCapacity: avgReadCapacity.toFixed(2),
              avgWriteCapacity: avgWriteCapacity.toFixed(2),
            },
          });
        }
      }
    }

    // Check for Global Secondary Indexes (GSI) with low utilization
    if (table.GlobalSecondaryIndexes) {
      for (const gsi of table.GlobalSecondaryIndexes) {
        if (!gsi.IndexName) continue;

        if (billingMode === "PROVISIONED" && gsi.ProvisionedThroughput) {
          const gsiRead = gsi.ProvisionedThroughput.ReadCapacityUnits || 0;
          const gsiWrite = gsi.ProvisionedThroughput.WriteCapacityUnits || 0;

          // Check GSI metrics
          const endTime = new Date();
          const startTime = new Date(
            endTime.getTime() - config.thresholds.inactiveDays * 24 * 60 * 60 * 1000
          );

          const gsiReadCommand = new GetMetricStatisticsCommand({
            Namespace: "AWS/DynamoDB",
            MetricName: "ConsumedReadCapacityUnits",
            Dimensions: [
              { Name: "TableName", Value: tableName },
              { Name: "GlobalSecondaryIndexName", Value: gsi.IndexName },
            ],
            StartTime: startTime,
            EndTime: endTime,
            Period: 86400,
            Statistics: ["Maximum"],
          });

          const gsiReadResponse = await cloudWatchClient.send(gsiReadCommand);
          const maxGsiRead = gsiReadResponse.Datapoints?.reduce(
            (max, dp) => Math.max(max, dp.Maximum || 0),
            0
          ) || 0;

          if (maxGsiRead === 0 && gsiRead > 1) {
            const gsiCost = this.estimateProvisionedCost(gsiRead, gsiWrite);
            findings.push({
              service: "DynamoDB",
              resourceId: `${tableName}/${gsi.IndexName}`,
              resourceType: "DynamoDB GSI",
              region: config.region,
              issue: `GSI has no read activity in the last ${config.thresholds.inactiveDays} days`,
              recommendation: "Delete unused GSI or reduce provisioned capacity to minimum (1 RCU/WCU)",
              estimatedMonthlyCost: gsiCost,
              potentialMonthlySavings: gsiCost,
              priority: "medium",
              metadata: {
                tableName,
                indexName: gsi.IndexName,
                provisionedRead: gsiRead,
                provisionedWrite: gsiWrite,
              },
            });
          }
        }
      }
    }

    // Check for Point-in-Time Recovery (PITR) on inactive tables
    if (table.ArchivalSummary && table.ArchivalSummary.ArchivalDateTime) {
      findings.push({
        service: "DynamoDB",
        resourceId: tableName,
        resourceType: "DynamoDB Table",
        region: config.region,
        issue: "Table is archived but still incurs storage costs",
        recommendation: "Review if archived table is still needed and delete if not",
        estimatedMonthlyCost: 0.1, // Minimal storage cost
        potentialMonthlySavings: 0.1,
        priority: "low",
        metadata: {
          tableName,
          archivedAt: table.ArchivalSummary.ArchivalDateTime.toISOString(),
        },
      });
    }
  }

  private estimateProvisionedCost(readCapacity: number, writeCapacity: number): number {
    // EU-Central-1 pricing (approximate)
    const readCostPerUnit = 0.00013 * 730; // $0.00013 per hour * 730 hours
    const writeCostPerUnit = 0.00065 * 730; // $0.00065 per hour * 730 hours

    return (readCapacity * readCostPerUnit) + (writeCapacity * writeCostPerUnit);
  }

  private estimateOnDemandCost(monthlyReads: number, monthlyWrites: number): number {
    // EU-Central-1 pricing (approximate)
    const readCostPer1M = 0.285; // $0.285 per million read request units
    const writeCostPer1M = 1.4275; // $1.4275 per million write request units

    return (monthlyReads / 1000000 * readCostPer1M) + (monthlyWrites / 1000000 * writeCostPer1M);
  }

  private shouldSwitchToOnDemand(
    avgRead: number,
    avgWrite: number,
    provisionedRead: number,
    provisionedWrite: number
  ): boolean {
    // If average usage is less than 50% of provisioned and highly variable,
    // on-demand might be better
    const readRatio = avgRead / provisionedRead;
    const writeRatio = avgWrite / provisionedWrite;

    return (readRatio < 0.5 || writeRatio < 0.5) && (readRatio > 0.1 || writeRatio > 0.1);
  }
}
