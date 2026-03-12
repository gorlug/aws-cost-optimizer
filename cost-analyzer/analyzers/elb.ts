import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
  DescribeTargetHealthCommand,
  DescribeTargetGroupsCommand,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import {
  ElasticLoadBalancingClient,
  DescribeLoadBalancersCommand as DescribeClassicLoadBalancersCommand,
} from "@aws-sdk/client-elastic-load-balancing";
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from "@aws-sdk/client-cloudwatch";
import type { Analyzer, AnalyzerConfig, AnalyzerResult, Finding } from "../types.js";
import { calculateLoadBalancerMonthlyCost } from "../utils/cost-calculator.js";

export class ELBAnalyzer implements Analyzer {
  name = "ELB";

  async analyze(config: AnalyzerConfig): Promise<AnalyzerResult> {
    const startTime = Date.now();
    const findings: Finding[] = [];
    const elbv2Client = new ElasticLoadBalancingV2Client({ region: config.region });
    const elbClient = new ElasticLoadBalancingClient({ region: config.region });
    const cloudWatchClient = new CloudWatchClient({ region: config.region });

    try {
      // Check ALB/NLB (v2)
      await this.checkALBNLB(elbv2Client, cloudWatchClient, config, findings);

      // Check Classic Load Balancers
      await this.checkClassicLB(elbClient, cloudWatchClient, config, findings);

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

  private async checkALBNLB(
    elbv2Client: ElasticLoadBalancingV2Client,
    cloudWatchClient: CloudWatchClient,
    config: AnalyzerConfig,
    findings: Finding[]
  ): Promise<void> {
    try {
      const command = new DescribeLoadBalancersCommand({});
      const response = await elbv2Client.send(command);

      if (response.LoadBalancers) {
        for (const lb of response.LoadBalancers) {
          if (!lb.LoadBalancerArn || !lb.LoadBalancerName) continue;

          const lbType = lb.Type === "network" ? "NLB" : "ALB";
          const monthlyCost = calculateLoadBalancerMonthlyCost(lbType);

          // Check if load balancer has any targets
          const targetGroupsCommand = new DescribeTargetGroupsCommand({
            LoadBalancerArn: lb.LoadBalancerArn,
          });

          const targetGroupsResponse = await elbv2Client.send(targetGroupsCommand);
          const hasTargetGroups =
            (targetGroupsResponse.TargetGroups?.length || 0) > 0;

          let hasHealthyTargets = false;

          if (hasTargetGroups && targetGroupsResponse.TargetGroups) {
            for (const tg of targetGroupsResponse.TargetGroups) {
              try {
                const healthCommand = new DescribeTargetHealthCommand({
                  TargetGroupArn: tg.TargetGroupArn,
                });
                const healthResponse = await elbv2Client.send(healthCommand);

                if (
                  healthResponse.TargetHealthDescriptions?.some(
                    (t) => t.TargetHealth?.State === "healthy"
                  )
                ) {
                  hasHealthyTargets = true;
                  break;
                }
              } catch (error) {
                console.error(`Error checking target health:`, error);
              }
            }
          }

          if (!hasHealthyTargets) {
            findings.push({
              service: "ELB",
              resourceId: lb.LoadBalancerName,
              resourceType: lbType,
              region: config.region,
              issue: "No healthy targets registered",
              recommendation: "Delete load balancer if no longer needed",
              estimatedMonthlyCost: monthlyCost,
              potentialMonthlySavings: monthlyCost,
              priority: "high",
              metadata: {
                loadBalancerName: lb.LoadBalancerName,
                loadBalancerArn: lb.LoadBalancerArn,
                type: lb.Type,
                scheme: lb.Scheme,
                createdTime: lb.CreatedTime?.toISOString(),
              },
            });
          } else {
            // Check request count to see if it's actually being used
            const endTime = new Date();
            const startTime = new Date(
              endTime.getTime() - config.thresholds.inactiveDays * 24 * 60 * 60 * 1000
            );

            const metricName =
              lbType === "ALB" ? "RequestCount" : "ProcessedBytes";

            const requestsCommand = new GetMetricStatisticsCommand({
              Namespace: "AWS/ApplicationELB",
              MetricName: metricName,
              Dimensions: [
                {
                  Name: "LoadBalancer",
                  Value: lb.LoadBalancerArn.split("/").slice(-3).join("/"),
                },
              ],
              StartTime: startTime,
              EndTime: endTime,
              Period: 86400,
              Statistics: ["Sum"],
            });

            const requestsResponse = await cloudWatchClient.send(requestsCommand);
            const totalRequests =
              requestsResponse.Datapoints?.reduce(
                (sum, dp) => sum + (dp.Sum || 0),
                0
              ) || 0;

            if (totalRequests === 0) {
              findings.push({
                service: "ELB",
                resourceId: lb.LoadBalancerName,
                resourceType: lbType,
                region: config.region,
                issue: `No traffic in the last ${config.thresholds.inactiveDays} days`,
                recommendation:
                  "Delete load balancer if no longer needed, or investigate why it's not receiving traffic",
                estimatedMonthlyCost: monthlyCost,
                potentialMonthlySavings: monthlyCost,
                priority: "high",
                metadata: {
                  loadBalancerName: lb.LoadBalancerName,
                  type: lb.Type,
                  hasHealthyTargets,
                },
              });
            }
          }
        }
      }
    } catch (error) {
      console.error("Error checking ALB/NLB:", error);
    }
  }

  private async checkClassicLB(
    elbClient: ElasticLoadBalancingClient,
    cloudWatchClient: CloudWatchClient,
    config: AnalyzerConfig,
    findings: Finding[]
  ): Promise<void> {
    try {
      const command = new DescribeClassicLoadBalancersCommand({});
      const response = await elbClient.send(command);

      if (response.LoadBalancerDescriptions) {
        for (const lb of response.LoadBalancerDescriptions) {
          if (!lb.LoadBalancerName) continue;

          const monthlyCost = calculateLoadBalancerMonthlyCost("CLB");

          // Classic load balancers are deprecated - recommend migration
          findings.push({
            service: "ELB",
            resourceId: lb.LoadBalancerName,
            resourceType: "Classic Load Balancer",
            region: config.region,
            issue: "Using deprecated Classic Load Balancer",
            recommendation:
              "Migrate to ALB or NLB for better features and cost efficiency",
            estimatedMonthlyCost: monthlyCost,
            potentialMonthlySavings: monthlyCost * 0.1, // ALB/NLB can be slightly cheaper
            priority: "medium",
            metadata: {
              loadBalancerName: lb.LoadBalancerName,
              dnsName: lb.DNSName,
              scheme: lb.Scheme,
              createdTime: lb.CreatedTime?.toISOString(),
              instanceCount: lb.Instances?.length || 0,
            },
          });

          // Check if it has no instances
          if ((lb.Instances?.length || 0) === 0) {
            findings.push({
              service: "ELB",
              resourceId: lb.LoadBalancerName,
              resourceType: "Classic Load Balancer",
              region: config.region,
              issue: "No instances registered",
              recommendation: "Delete load balancer if no longer needed",
              estimatedMonthlyCost: monthlyCost,
              potentialMonthlySavings: monthlyCost,
              priority: "high",
              metadata: {
                loadBalancerName: lb.LoadBalancerName,
              },
            });
          }
        }
      }
    } catch (error) {
      console.error("Error checking Classic Load Balancers:", error);
    }
  }
}
