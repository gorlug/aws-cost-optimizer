import {
  RDSClient,
  DescribeDBInstancesCommand,
  DescribeDBSnapshotsCommand,
} from "@aws-sdk/client-rds";
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from "@aws-sdk/client-cloudwatch";
import type { Analyzer, AnalyzerConfig, AnalyzerResult, Finding } from "../types.js";
import { calculateSnapshotCost } from "../utils/cost-calculator.js";

export class RDSAnalyzer implements Analyzer {
  name = "RDS";

  async analyze(config: AnalyzerConfig): Promise<AnalyzerResult> {
    const startTime = Date.now();
    const findings: Finding[] = [];
    const rdsClient = new RDSClient({ region: config.region });
    const cloudWatchClient = new CloudWatchClient({ region: config.region });

    try {
      // Check for idle databases
      await this.checkIdleDatabases(rdsClient, cloudWatchClient, config, findings);

      // Check for old snapshots
      await this.checkOldSnapshots(rdsClient, config, findings);

      // Check for stopped instances
      await this.checkStoppedInstances(rdsClient, config, findings);

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

  private async checkIdleDatabases(
    rdsClient: RDSClient,
    cloudWatchClient: CloudWatchClient,
    config: AnalyzerConfig,
    findings: Finding[]
  ): Promise<void> {
    try {
      const command = new DescribeDBInstancesCommand({});
      const response = await rdsClient.send(command);

      if (response.DBInstances) {
        for (const instance of response.DBInstances) {
          if (!instance.DBInstanceIdentifier || instance.DBInstanceStatus !== "available")
            continue;

          const endTime = new Date();
          const startTime = new Date(
            endTime.getTime() - config.thresholds.inactiveDays * 24 * 60 * 60 * 1000
          );

          // Check database connections
          const connectionsCommand = new GetMetricStatisticsCommand({
            Namespace: "AWS/RDS",
            MetricName: "DatabaseConnections",
            Dimensions: [
              {
                Name: "DBInstanceIdentifier",
                Value: instance.DBInstanceIdentifier,
              },
            ],
            StartTime: startTime,
            EndTime: endTime,
            Period: 86400, // 1 day
            Statistics: ["Maximum", "Average"],
          });

          const connectionsResponse = await cloudWatchClient.send(connectionsCommand);
          const maxConnections =
            connectionsResponse.Datapoints?.reduce(
              (max, dp) => Math.max(max, dp.Maximum || 0),
              0
            ) || 0;

          if (maxConnections === 0) {
            findings.push({
              service: "RDS",
              resourceId: instance.DBInstanceIdentifier,
              resourceType: "RDS Instance",
              region: config.region,
              issue: `No connections in the last ${config.thresholds.inactiveDays} days`,
              recommendation: "Take final snapshot and delete if no longer needed",
              estimatedMonthlyCost: 0, // RDS pricing is complex, would need instance type
              potentialMonthlySavings: 0,
              priority: "high",
              metadata: {
                instanceId: instance.DBInstanceIdentifier,
                instanceClass: instance.DBInstanceClass,
                engine: instance.Engine,
                engineVersion: instance.EngineVersion,
                allocatedStorage: instance.AllocatedStorage,
                multiAZ: instance.MultiAZ,
              },
            });
          } else {
            // Check CPU utilization
            const cpuCommand = new GetMetricStatisticsCommand({
              Namespace: "AWS/RDS",
              MetricName: "CPUUtilization",
              Dimensions: [
                {
                  Name: "DBInstanceIdentifier",
                  Value: instance.DBInstanceIdentifier,
                },
              ],
              StartTime: startTime,
              EndTime: endTime,
              Period: 86400,
              Statistics: ["Average", "Maximum"],
            });

            const cpuResponse = await cloudWatchClient.send(cpuCommand);
            const avgCPU =
              (cpuResponse.Datapoints?.reduce(
                (sum, dp) => sum + (dp.Average || 0),
                0
              ) || 0) / (cpuResponse.Datapoints?.length || 1);

            // If average CPU is very low, instance might be oversized
            if (avgCPU < 10) {
              findings.push({
                service: "RDS",
                resourceId: instance.DBInstanceIdentifier,
                resourceType: "RDS Instance",
                region: config.region,
                issue: `Very low CPU utilization (${avgCPU.toFixed(1)}% average)`,
                recommendation: "Consider downsizing to smaller instance class",
                estimatedMonthlyCost: 0,
                potentialMonthlySavings: 0,
                priority: "medium",
                metadata: {
                  instanceId: instance.DBInstanceIdentifier,
                  instanceClass: instance.DBInstanceClass,
                  avgCPU: avgCPU.toFixed(2),
                  maxConnections,
                },
              });
            }
          }
        }
      }
    } catch (error) {
      console.error("Error checking idle databases:", error);
    }
  }

  private async checkOldSnapshots(
    rdsClient: RDSClient,
    config: AnalyzerConfig,
    findings: Finding[]
  ): Promise<void> {
    try {
      const command = new DescribeDBSnapshotsCommand({
        SnapshotType: "manual", // Only check manual snapshots
      });
      const response = await rdsClient.send(command);

      if (response.DBSnapshots) {
        const oldSnapshotThreshold =
          Date.now() - config.thresholds.oldSnapshotDays * 24 * 60 * 60 * 1000;

        for (const snapshot of response.DBSnapshots) {
          const createTime = snapshot.SnapshotCreateTime?.getTime();
          if (!createTime || createTime > oldSnapshotThreshold) continue;

          const allocatedStorage = snapshot.AllocatedStorage || 0;
          const monthlyCost = calculateSnapshotCost(allocatedStorage, true);
          const ageInDays = Math.floor((Date.now() - createTime) / (24 * 60 * 60 * 1000));

          findings.push({
            service: "RDS",
            resourceId: snapshot.DBSnapshotIdentifier || "unknown",
            resourceType: "RDS Snapshot",
            region: config.region,
            issue: `Old manual snapshot (${ageInDays} days, ${allocatedStorage} GB)`,
            recommendation: "Delete if no longer needed for backup or recovery",
            estimatedMonthlyCost: monthlyCost,
            potentialMonthlySavings: monthlyCost,
            priority: monthlyCost > 5 ? "medium" : "low",
            metadata: {
              snapshotId: snapshot.DBSnapshotIdentifier,
              dbInstanceId: snapshot.DBInstanceIdentifier,
              allocatedStorage,
              createTime: snapshot.SnapshotCreateTime?.toISOString(),
              ageInDays,
              engine: snapshot.Engine,
            },
          });
        }
      }
    } catch (error) {
      console.error("Error checking old RDS snapshots:", error);
    }
  }

  private async checkStoppedInstances(
    rdsClient: RDSClient,
    config: AnalyzerConfig,
    findings: Finding[]
  ): Promise<void> {
    try {
      const command = new DescribeDBInstancesCommand({});
      const response = await rdsClient.send(command);

      if (response.DBInstances) {
        for (const instance of response.DBInstances) {
          if (instance.DBInstanceStatus === "stopped") {
            findings.push({
              service: "RDS",
              resourceId: instance.DBInstanceIdentifier || "unknown",
              resourceType: "RDS Instance (Stopped)",
              region: config.region,
              issue: "Stopped instance (can only be stopped for 7 days)",
              recommendation:
                "Take snapshot and delete if long-term stop needed, or start instance",
              estimatedMonthlyCost: 0, // Stopped instances still incur storage costs
              potentialMonthlySavings: 0,
              priority: "medium",
              metadata: {
                instanceId: instance.DBInstanceIdentifier,
                instanceClass: instance.DBInstanceClass,
                engine: instance.Engine,
                allocatedStorage: instance.AllocatedStorage,
              },
            });
          }
        }
      }
    } catch (error) {
      console.error("Error checking stopped RDS instances:", error);
    }
  }
}
