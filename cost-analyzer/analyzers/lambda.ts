import {
  LambdaClient,
  ListFunctionsCommand,
  GetFunctionCommand,
} from "@aws-sdk/client-lambda";
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from "@aws-sdk/client-cloudwatch";
import type { Analyzer, AnalyzerConfig, AnalyzerResult, Finding } from "../types.js";

export class LambdaAnalyzer implements Analyzer {
  name = "Lambda";

  async analyze(config: AnalyzerConfig): Promise<AnalyzerResult> {
    const startTime = Date.now();
    const findings: Finding[] = [];
    const lambdaClient = new LambdaClient({ region: config.region });
    const cloudWatchClient = new CloudWatchClient({ region: config.region });

    try {
      let marker: string | undefined;

      do {
        const command = new ListFunctionsCommand({ Marker: marker });
        const response = await lambdaClient.send(command);

        if (response.Functions) {
          for (const func of response.Functions) {
            if (!func.FunctionName) continue;

            // Skip ControlTower lambdas
            if (func.FunctionName.match(/ControlTower/i)) continue;

            try {
              await this.analyzeLambdaFunction(
                lambdaClient,
                cloudWatchClient,
                func.FunctionName,
                config,
                findings
              );
            } catch (error) {
              console.error(
                `Error analyzing Lambda function ${func.FunctionName}:`,
                error
              );
            }
          }
        }

        marker = response.NextMarker;
      } while (marker);

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

  private async analyzeLambdaFunction(
    lambdaClient: LambdaClient,
    cloudWatchClient: CloudWatchClient,
    functionName: string,
    config: AnalyzerConfig,
    findings: Finding[]
  ): Promise<void> {
    // Get function details
    const getFunctionCommand = new GetFunctionCommand({
      FunctionName: functionName,
    });
    const functionResponse = await lambdaClient.send(getFunctionCommand);
    const functionConfig = functionResponse.Configuration;

    if (!functionConfig) return;

    const memorySize = functionConfig.MemorySize || 128;
    const timeout = functionConfig.Timeout || 3;

    // Check invocation metrics over the last 30 days
    const endTime = new Date();
    const startTime = new Date(
      endTime.getTime() - config.thresholds.inactiveDays * 24 * 60 * 60 * 1000
    );

    const invocationsCommand = new GetMetricStatisticsCommand({
      Namespace: "AWS/Lambda",
      MetricName: "Invocations",
      Dimensions: [
        {
          Name: "FunctionName",
          Value: functionName,
        },
      ],
      StartTime: startTime,
      EndTime: endTime,
      Period: 86400, // 1 day
      Statistics: ["Sum"],
    });

    const invocationsResponse = await cloudWatchClient.send(invocationsCommand);
    const totalInvocations =
      invocationsResponse.Datapoints?.reduce(
        (sum, dp) => sum + (dp.Sum || 0),
        0
      ) || 0;

    // Check for unused functions
    if (totalInvocations === 0) {
      findings.push({
        service: "Lambda",
        resourceId: functionName,
        resourceType: "Lambda Function",
        region: config.region,
        issue: `No invocations in the last ${config.thresholds.inactiveDays} days`,
        recommendation: "Delete function if no longer needed",
        estimatedMonthlyCost: 0, // No invocations = minimal cost
        potentialMonthlySavings: 0.1, // Nominal savings (storage, etc.)
        priority: "low",
        metadata: {
          functionName,
          memorySize,
          timeout,
          runtime: functionConfig.Runtime,
          lastModified: functionConfig.LastModified,
        },
      });
    } else {
      // Check memory utilization
      const durationCommand = new GetMetricStatisticsCommand({
        Namespace: "AWS/Lambda",
        MetricName: "Duration",
        Dimensions: [
          {
            Name: "FunctionName",
            Value: functionName,
          },
        ],
        StartTime: startTime,
        EndTime: endTime,
        Period: 86400,
        Statistics: ["Average", "Maximum"],
      });

      const durationResponse = await cloudWatchClient.send(durationCommand);

      // If function is using high memory but low duration, might be over-provisioned
      if (memorySize >= 1024) {
        const avgDuration =
          (durationResponse.Datapoints?.reduce(
            (sum, dp) => sum + (dp.Average || 0),
            0
          ) || 0) / (durationResponse.Datapoints?.length || 1);

        // If average duration is less than 50% of timeout, function might be over-provisioned
        if (avgDuration < timeout * 500) {
          // 500ms = 50% of 1 second
          findings.push({
            service: "Lambda",
            resourceId: functionName,
            resourceType: "Lambda Function",
            region: config.region,
            issue: `High memory allocation (${memorySize} MB) with low utilization`,
            recommendation:
              "Test with lower memory settings (e.g., 512 MB or 768 MB) to reduce costs",
            estimatedMonthlyCost: 0, // Hard to estimate without detailed metrics
            potentialMonthlySavings: 0, // Conservative
            priority: "low",
            metadata: {
              functionName,
              memorySize,
              timeout,
              avgDuration: avgDuration.toFixed(2),
              invocations: totalInvocations,
            },
          });
        }
      }

      // Check for functions with very high timeout but low actual duration
      if (timeout >= 60) {
        const maxDuration =
          durationResponse.Datapoints?.reduce(
            (max, dp) => Math.max(max, dp.Maximum || 0),
            0
          ) || 0;

        if (maxDuration < timeout * 500) {
          // Less than 50% of timeout
          findings.push({
            service: "Lambda",
            resourceId: functionName,
            resourceType: "Lambda Function",
            region: config.region,
            issue: `High timeout setting (${timeout}s) but low actual duration`,
            recommendation: `Consider reducing timeout to ${Math.ceil(maxDuration / 1000) + 10}s`,
            estimatedMonthlyCost: 0,
            potentialMonthlySavings: 0,
            priority: "low",
            metadata: {
              functionName,
              timeout,
              maxDuration: (maxDuration / 1000).toFixed(2) + "s",
              invocations: totalInvocations,
            },
          });
        }
      }
    }
  }
}
